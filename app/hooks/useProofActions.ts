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
  const figures = state.problemFigures && state.problemFigures.text === state.problemText ? state.problemFigures.refs : undefined;

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
          body: JSON.stringify({ problem_text: state.problemText, ...(figures ? { figures } : {}) }),
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
  }, [dispatch, state.problemText, figures, tr]);

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

  // ── Solve all (one-click, streaming) ─────────────────────────────

  const solveAll = useCallback(async () => {
    lastActionRef.current = solveAll;
    dispatch({ type: "RESET_ALL" });
    dispatch({ type: "REQUEST", operation: "solve-all" });
    try {
      const res = await fetch("/api/solve-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ problem_text: state.problemText, ...(figures ? { figures } : {}) }),
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

      // Read SSE stream
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
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

            if (event.type === "progress") {
              dispatch({
                type: "SOLVE_PROGRESS",
                stage: event.stage as string,
                detail: event.detail as string,
              });
            } else if (event.type === "result") {
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
                return;
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
    } catch (e) {
      dispatch({
        type: "REQUEST_ERROR",
        message: e instanceof Error ? e.message : tr("求解失败", "Failed to solve"),
      });
    }
  }, [dispatch, state.problemText, figures, tr]);

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

  const loadSession = useCallback(
    async (sessionId: string) => {
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
      } catch (e) {
        dispatch({
          type: "REQUEST_ERROR",
          message: e instanceof Error ? e.message : tr("加载会话失败", "Failed to load session"),
        });
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
    attemptLean,
    switchMethod,
    useGeneratedProblem,
    loadSession,
    retryLastAction,
  };
}
