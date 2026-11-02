"use client";

import { useCallback, useRef } from "react";
import type { Dispatch } from "react";
import type {
  BuildStatus,
  LeanProofAttempt,
  MethodOption,
  MethodScore,
  NaturalLanguageSolution,
  ProofStep,
  StepStatus,
} from "@/lib/types";
import type { RunMetrics } from "@/lib/llm/usage-tracker";
import type { Action, ProofSessionState } from "./useProofSession";
import { useI18n } from "@/lib/i18n";

type ApiErrorBody = { error?: string };

async function readJson<T>(res: Response): Promise<T> {
  const data = (await res.json()) as T & ApiErrorBody;
  if (!res.ok) {
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
  return data;
}

function mergeStep(steps: ProofStep[], step: ProofStep): ProofStep[] {
  return steps
    .map((s) => (s.index === step.index ? step : s))
    .sort((a, b) => a.index - b.index);
}

// ── Hook ───────────────────────────────────────────────────────────────

export function useProofActions(
  state: ProofSessionState,
  dispatch: Dispatch<Action>,
) {
  const { tr } = useI18n();
  // Track last action for retry
  const lastActionRef = useRef<(() => Promise<void>) | null>(null);

  // ── Enumerate ────────────────────────────────────────────────────

  // Figures go along only while the problem text is the one they belong to.
  const current = state.problemFigures && state.problemFigures.text === state.problemText ? state.problemFigures : null;
  const figures = current?.refs.length ? current.refs : undefined;
  const figureText = current?.description;

  const enumerate = useCallback(async () => {
    lastActionRef.current = enumerate;
    dispatch({ type: "RESET_ALL" });
    dispatch({ type: "REQUEST", operation: "enumerate" });
    try {
      const data = await readJson<{
        session_id: string;
        methods: MethodOption[];
        comparison_summary?: string;
        out_of_domain_warning?: string | null;
        figure_description?: string;
      }>(
        await fetch("/api/enumerate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ problem_text: state.problemText, ...(figures ? { figures } : {}), ...(figureText ? { figure_text: figureText } : {}) }),
        }),
      );
      dispatch({
        type: "ENUMERATE_OK",
        sessionId: data.session_id,
        methods: data.methods,
        comparisonSummary: data.comparison_summary,
        outOfDomainWarning: data.out_of_domain_warning ?? null,
        figureDescription: data.figure_description,
      });
    } catch (e) {
      dispatch({
        type: "REQUEST_ERROR",
        message: e instanceof Error ? e.message : tr("枚举失败", "Failed to enumerate methods"),
      });
    }
  }, [dispatch, state.problemText, figures, figureText, tr]);

  // ── Plan method ──────────────────────────────────────────────────

  const planMethod = useCallback(
    async (methodId: string) => {
      if (!state.sessionId) return;
      lastActionRef.current = () => planMethod(methodId);
      dispatch({ type: "RESET_PROOF" });
      dispatch({ type: "SELECT_METHOD", methodId });
      dispatch({ type: "REQUEST", operation: "plan" });
      try {
        const data = await readJson<{
          session_id: string;
          steps: ProofStep[];
          nl_solution?: NaturalLanguageSolution;
        }>(
          await fetch("/api/plan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              session_id: state.sessionId,
              method_id: methodId,
            }),
          }),
        );
        dispatch({
          type: "PLAN_OK",
          steps: data.steps,
          nlSolution: data.nl_solution,
        });
      } catch (e) {
        dispatch({
          type: "REQUEST_ERROR",
          message: e instanceof Error ? e.message : tr("规划失败", "Failed to plan proof"),
        });
      }
    },
    [dispatch, state.sessionId, tr],
  );

  // ── Prove step ───────────────────────────────────────────────────

  const proveStepAt = useCallback(
    async (stepIndex: number, asRetry = false) => {
      if (!state.sessionId) return;
      dispatch({ type: "SELECT_STEP", index: stepIndex });
      dispatch({ type: "REQUEST", operation: asRetry ? "retry" : "prove" });
      try {
        const data = await readJson<{
          session_id: string;
          step: ProofStep;
          assembled_lean: string;
          build_status: BuildStatus;
        }>(
          await fetch("/api/prove-step", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              session_id: state.sessionId,
              step_index: stepIndex,
            }),
          }),
        );
        const buildLog =
          data.build_status === "unavailable"
            ? data.step.build_log ??
              "Lean/lake unavailable. Install elan/Lean and ensure lean-sandbox builds."
            : data.step.build_log;
        dispatch({
          type: "STEP_UPDATED",
          step: data.step,
          assembledLean: data.assembled_lean,
          buildStatus: data.build_status,
          buildLog,
        });
        dispatch({ type: "REQUEST_DONE" });
      } catch (e) {
        dispatch({
          type: "REQUEST_ERROR",
          message: e instanceof Error ? e.message : tr("证明本步失败", "Failed to prove step"),
        });
      }
    },
    [dispatch, state.sessionId, tr],
  );

  // ── Prove all ────────────────────────────────────────────────────

  const proveAll = useCallback(async () => {
    if (!state.sessionId || state.steps.length === 0) return;
    dispatch({ type: "REQUEST", operation: "prove-all" });
    let current = [...state.steps];
    try {
      for (const step of current) {
        if (step.status === "ok" && step.lean_code.trim()) continue;
        dispatch({ type: "SELECT_STEP", index: step.index });
        const data = await readJson<{
          step: ProofStep;
          assembled_lean: string;
          build_status: BuildStatus;
        }>(
          await fetch("/api/prove-step", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              session_id: state.sessionId,
              step_index: step.index,
            }),
          }),
        );
        current = mergeStep(current, data.step);
        // Dispatch incremental update for UI feedback
        dispatch({
          type: "STEP_UPDATED",
          step: data.step,
          assembledLean: data.assembled_lean,
          buildStatus: data.build_status,
          buildLog:
            data.build_status === "unavailable"
              ? data.step.build_log ??
                "Lean/lake unavailable. Install elan/Lean and ensure lean-sandbox builds."
              : data.step.build_log,
        });
        if (data.build_status === "unavailable") break;
        if (data.step.status === "fail") break;
      }
      dispatch({ type: "REQUEST_DONE" });
    } catch (e) {
      dispatch({
        type: "REQUEST_ERROR",
        message: e instanceof Error ? e.message : tr("逐步生成失败", "Failed to prove steps"),
      });
    }
  }, [dispatch, state.sessionId, state.steps, tr]);

  // ── Verify ───────────────────────────────────────────────────────

  const verify = useCallback(async () => {
    if (!state.sessionId) return;
    dispatch({ type: "REQUEST", operation: "verify" });
    try {
      const data = await readJson<{
        ok: boolean;
        log: string;
        build_status: BuildStatus;
        assembled_lean: string;
        lean_proof_attempt?: LeanProofAttempt;
      }>(
        await fetch("/api/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: state.sessionId }),
        }),
      );
      dispatch({
        type: "VERIFY_OK",
        assembledLean: data.assembled_lean,
        buildStatus: data.build_status,
        buildLog: data.log,
        leanProofAttempt: data.lean_proof_attempt,
      });
    } catch (e) {
      dispatch({
        type: "REQUEST_ERROR",
        message: e instanceof Error ? e.message : tr("验证失败", "Verification failed"),
      });
    }
  }, [dispatch, state.sessionId, tr]);

  // ── The solve stream (SSE): started by solveAll, or followed again after a reload (resumeSolve) ──

  /** Reads frames until the result / cancel / error; `ended` false when the connection dropped first. */
  const readSolveStream = useCallback(async (res: Response): Promise<{ ended: boolean; jobId?: string }> => {
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";
      let ended = false;
      let jobId: string | undefined;

      while (true) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch {
          break; // network error: the connection is gone
        }
        const { done, value } = chunk;
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE frames
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? ""; // Keep incomplete frame in buffer

        for (const frame of frames) {
          const dataLine = frame
            .split("\n")
            .find((line) => line.startsWith("data: "));
          if (!dataLine) continue;

          try {
            const event = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;

            if (event.type === "job") {
              jobId = event.job_id as string;
              dispatch({ type: "SOLVE_JOB", jobId: event.job_id as string, sessionId: event.session_id as string | undefined, problemText: event.problem_text as string | undefined });
            } else if (event.type === "cancelled") {
              dispatch({ type: "SOLVE_CANCELLED", detail: (event.detail as string) ?? tr("已取消", "Cancelled") });
              return { ended: true, jobId };
            } else if (event.type === "progress") {
              dispatch({
                type: "SOLVE_PROGRESS",
                stage: event.stage as string,
                detail: event.detail as string,
                position: event.position as number | undefined,
              });
            } else if (event.type === "result") {
              ended = true;
              const data = event.data as Record<string, unknown>;

              // Handle autoformalize_failed in result
              if (data.error === "autoformalize_failed") {
                dispatch({
                  type: "REQUEST_ERROR",
                  message: "autoformalize_failed",
                  autoformalizeDetail: (data.detail as string) ?? undefined,
                  validationResults:
                    (data.validation_results as Array<{
                      layer: number;
                      pass: boolean;
                      detail: string;
                    }>) ?? undefined,
                });
                return { ended: true, jobId };
              }

              dispatch({
                type: "SOLVE_OK",
                sessionId: data.session_id as string,
                problemType: data.problem_type as "computational" | "theorem",
                nlSolution: data.nl_solution as NaturalLanguageSolution | undefined,
                leanProofAttempt: data.lean_proof_attempt as LeanProofAttempt | undefined,
                methods: data.methods as MethodOption[] | undefined,
                methodScores: data.method_scores as MethodScore[] | undefined,
                recommendedMethodId:
                  (data.recommended_method_id as string) ?? undefined,
                steps: data.steps as ProofStep[] | undefined,
                assembledLean: data.assembled_lean as string | undefined,
                buildStatus: data.build_status as BuildStatus | undefined,
                buildLog: data.build_log as string | undefined,
                solveEvents: (data.pipeline_events as Array<{ stage: string; detail: string }> | undefined) ?? [],
                metrics: data.metrics as RunMetrics | undefined,
                figureDescription: data.figure_description as string | undefined,
              });
            } else if (event.type === "error") {
              throw new Error((event.error as string) ?? "solve pipeline failed");
            }
          } catch (parseError) {
            // If it's a re-thrown error from the error event, propagate it
            if (parseError instanceof SyntaxError) continue;
            throw parseError;
          }
        }
      }
      return { ended, jobId };
  }, [dispatch, tr]);

  /**
   * Follow a solve stream to its end. When the connection drops first, the job is still running on the
   * server for a while (SOLVE_DETACH_GRACE_MS): its frames are fetched again from GET /api/jobs/:id/events
   * (a few tries), the timeline rebuilt from the replay.
   */
  const followSolveStream = useCallback(
    async (first: Response): Promise<void> => {
      let res = first;
      let known: string | undefined;
      for (;;) {
        const r = await readSolveStream(res);
        if (r.ended) return;
        known = r.jobId ?? known;
        let next: Response | null = null;
        for (let attempt = 1; known && attempt <= 5 && !next; attempt++) {
          await new Promise((ok) => setTimeout(ok, 1500 * attempt));
          const again = await fetch(`/api/jobs/${encodeURIComponent(known)}/events`).catch(() => null);
          if (again?.ok && again.headers.get("content-type")?.includes("text/event-stream")) next = again;
          else if (again?.status === 404) break; // the server no longer has it
        }
        if (!next) {
          throw new Error(
            tr(
              "与服务器的连接中断了，求解没能接着进行。可以重新求解，已完成的结果在历史记录里。",
              "The connection to the server was lost and the solve could not be followed. Solve again; finished results are in the history.",
            ),
          );
        }
        dispatch({ type: "SOLVE_REPLAY" });
        res = next;
      }
    },
    [dispatch, readSolveStream, tr],
  );

  // ── Solve all (one-click, streaming) ─────────────────────────────

  const solveAll = useCallback(async () => {
    lastActionRef.current = solveAll;
    dispatch({ type: "RESET_ALL" });
    dispatch({ type: "REQUEST", operation: "solve-all" });
    try {
      const res = await fetch("/api/solve-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ problem_text: state.problemText, ...(figures ? { figures } : {}), ...(figureText ? { figure_text: figureText } : {}) }),
      });

      // Non-SSE response (error before stream starts)
      if (!res.ok || !res.headers.get("content-type")?.includes("text/event-stream")) {
        const body = (await res.json()) as Record<string, unknown>;
        if (body.error === "autoformalize_failed") {
          dispatch({
            type: "REQUEST_ERROR",
            message: "autoformalize_failed",
            autoformalizeDetail: (body.detail as string) ?? undefined,
            validationResults:
              (body.validation_results as Array<{
                layer: number;
                pass: boolean;
                detail: string;
              }>) ?? undefined,
          });
          return;
        }
        throw new Error(
          (body.error as string) ?? `Request failed (${res.status})`,
        );
      }

      await followSolveStream(res);
    } catch (e) {
      dispatch({
        type: "REQUEST_ERROR",
        message: e instanceof Error ? e.message : tr("求解失败", "Failed to solve"),
      });
    }
  }, [dispatch, state.problemText, figures, figureText, tr, followSolveStream]);

  // ── Follow a running solve again (the page was reloaded or reopened) ──
  // The server keeps a solve running for a while after its page went away (SOLVE_DETACH_GRACE_MS);
  // GET /api/jobs/:id/events replays its frames and follows the rest. False when the job is gone.

  const resumeSolve = useCallback(
    async (jobId: string): Promise<boolean> => {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/events`).catch(() => null);
      if (!res?.ok || !res.headers.get("content-type")?.includes("text/event-stream")) return false;
      lastActionRef.current = solveAll;
      dispatch({ type: "REQUEST", operation: "solve-all" });
      dispatch({ type: "SOLVE_REPLAY" });
      try {
        await followSolveStream(res);
      } catch (e) {
        dispatch({
          type: "REQUEST_ERROR",
          message: e instanceof Error ? e.message : tr("求解失败", "Failed to solve"),
        });
      }
      return true;
    },
    [dispatch, followSolveStream, solveAll, tr],
  );

  // ── Cancel the running solve ─────────────────────────────────────
  // The server stops the job at its next model call or stage; the stream then ends with `cancelled`.

  const cancelSolve = useCallback(async () => {
    if (!state.jobId) return;
    dispatch({ type: "SOLVE_CANCELLING" });
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(state.jobId)}/cancel`, { method: "POST" });
      // Already ended (or unknown): nothing left to wait for.
      if (!res.ok) dispatch({ type: "SOLVE_CANCELLED", detail: tr("已取消", "Cancelled") });
    } catch {
      dispatch({ type: "SOLVE_CANCELLED", detail: tr("已取消", "Cancelled") });
    }
  }, [dispatch, state.jobId, tr]);

  // ── Switch method ────────────────────────────────────────────────

  const switchMethod = useCallback(() => {
    dispatch({ type: "RESET_METHOD" });
  }, [dispatch]);

  // ── Use generated problem ────────────────────────────────────────

  const useGeneratedProblem = useCallback(
    (text: string) => {
      dispatch({ type: "RESET_ALL", problemText: text });
    },
    [dispatch],
  );

  // ── Lean formalization (last solving step, started by hand) ─────

  const attemptLean = useCallback(async () => {
    if (!state.sessionId) return;
    lastActionRef.current = attemptLean;
    dispatch({ type: "REQUEST", operation: "lean-attempt" });
    try {
      const res = await fetch("/api/lean-attempt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: state.sessionId }),
      });
      const data = await readJson<{ lean_proof_attempt: LeanProofAttempt }>(res);
      dispatch({ type: "LEAN_ATTEMPT_OK", leanProofAttempt: data.lean_proof_attempt });
    } catch (e) {
      dispatch({
        type: "REQUEST_ERROR",
        message: e instanceof Error ? e.message : tr("形式化证明失败", "Formalization failed"),
      });
    }
  }, [dispatch, state.sessionId, tr]);

  // ── Load session from history ────────────────────────────────────

  /**
   * A formal proof that was still running when the page went away (the request goes on without it):
   * shown as running, the session is read again every few seconds until the result is stored.
   */
  const waitForLeanAttempt = useCallback(
    async (sessionId: string) => {
      dispatch({ type: "REQUEST", operation: "lean-attempt" });
      const until = Date.now() + 45 * 60_000; // the attempt has its own limits; a stage left by a server restart must not hang the page
      while (Date.now() < until) {
        await new Promise((ok) => setTimeout(ok, 5000));
        const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}`).catch(() => null);
        if (!res) continue;
        if (!res.ok) break;
        const s = (await res.json()) as { pipeline_stage?: string; lean_proof_attempt?: LeanProofAttempt };
        if (s.pipeline_stage === "lean_attempting") continue;
        if (s.lean_proof_attempt) dispatch({ type: "LEAN_ATTEMPT_OK", leanProofAttempt: s.lean_proof_attempt });
        else dispatch({ type: "REQUEST_DONE" });
        return;
      }
      dispatch({ type: "REQUEST_ERROR", message: tr("形式化证明中断了，可以再试一次", "The formal proof was interrupted; try again") });
    },
    [dispatch, tr],
  );

  /** Opens a stored session; returns its pipeline stage (undefined when it could not be loaded). */
  const loadSession = useCallback(
    async (sessionId: string): Promise<string | undefined> => {
      dispatch({ type: "REQUEST", operation: "load-session" });
      try {
        const res = await fetch(`/api/session/${sessionId}`);
        const data = await readJson<{
          id: string;
          problem_text: string;
          methods: MethodOption[];
          method_scores?: MethodScore[];
          recommended_method_id?: string;
          selected_method_id?: string;
          comparison_summary?: string;
          steps: ProofStep[];
          assembled_lean: string;
          build_status: BuildStatus;
          nl_solution?: NaturalLanguageSolution;
          lean_proof_attempt?: LeanProofAttempt;
          computation_result?: unknown;
          pipeline_stage?: string;
        }>(res);

        const solvedProblemType: "computational" | "theorem" | null =
          data.lean_proof_attempt
            ? "theorem"
            : data.computation_result || data.nl_solution
              ? "computational"
              : null;

        dispatch({
          type: "LOAD_SESSION",
          sessionId: data.id,
          problemText: data.problem_text,
          methods: data.methods ?? [],
          methodScores: data.method_scores ?? [],
          recommendedMethodId: data.recommended_method_id ?? null,
          selectedMethodId: data.selected_method_id ?? null,
          comparisonSummary: data.comparison_summary ?? null,
          steps: data.steps ?? [],
          assembledLean: data.assembled_lean ?? "",
          buildStatus: data.build_status ?? "idle",
          buildLog: "",
          nlSolution: data.nl_solution ?? null,
          leanProofAttempt: data.lean_proof_attempt ?? null,
          solvedProblemType,
          solveEvents: [],
        });
        return data.pipeline_stage ?? "idle";
      } catch (e) {
        dispatch({
          type: "REQUEST_ERROR",
          message: e instanceof Error ? e.message : tr("加载会话失败", "Failed to load session"),
        });
        return undefined;
      }
    },
    [dispatch, tr],
  );

  // ── Retry last action ──────────────────────────────────────────

  const retryLastAction = useCallback(async () => {
    if (lastActionRef.current) {
      await lastActionRef.current();
    }
  }, []);

  return {
    enumerate,
    planMethod,
    proveStepAt,
    proveAll,
    verify,
    solveAll,
    cancelSolve,
    attemptLean,
    switchMethod,
    useGeneratedProblem,
    loadSession,
    resumeSolve,
    waitForLeanAttempt,
    retryLastAction,
  };
}
