import { getSessionForRequest, createSessionForRequest } from "@/lib/session-access";
import { NextResponse } from "next/server";
import { getSession, updateSession, saveSessionToDisk } from "@/lib/session-store";
import { LlmError } from "@/lib/llm/client";
import { CancelledError, runJob, TooManyJobsError } from "@/lib/jobs";
import { admitSolve, recordSpend, runCostCap } from "@/lib/quota";
import { withUsageScope } from "@/lib/llm/usage-tracker";
import { classifyProblem } from "@/lib/llm/classify-problem";
import { solveComputational } from "@/lib/compute/solver";
import { solveOptimization } from "@/lib/compute/optimization-solver";
import { reconcileWithSolution } from "@/lib/compute/reconcile";
import { solveFindAll } from "@/lib/compute/find-all-solver";
import { extractOptimizationStructure } from "@/lib/llm/optimization-extract";
import { generateNLSolution } from "@/lib/llm/nl-solution";
import { runTheoremPipeline, type TheoremPipelineOptions } from "@/lib/pipeline/theorem-pipeline";
import { answerCandidates, attemptLeanFormalization, manualLeanAttempt, shouldAutoAttemptLean } from "@/lib/pipeline/lean-attempt";
import type {
  LeanProofAttempt,
  MathDomain,
  NaturalLanguageSolution,
  Session,
} from "@/lib/types";
import { lt, withRequestLocale } from "@/lib/llm/output-locale";
import { requestOwner } from "@/lib/bank/http";
import { describeProblemFigures, figureRefsSchema, figureTextOf, problemWithFigure, type FigureRef } from "@/lib/bank/problem-figures";

interface SolveRequest {
  problem_text?: string;
  session_id?: string;
  /** Figures of the problem (question bank images): read by the vision model and appended to the text before solving. */
  figures?: FigureRef[];
  /** The figure's description when it is already known (a generated question's figure): appended as is. */
  figure_text?: string;
  options?: TheoremPipelineOptions & {
    /** Run the Lean formalization step automatically (default: no — started by hand via /api/lean-attempt). */
    lean_attempt?: boolean;
    skip_lean_attempt?: boolean;
    force_type?: "computational" | "theorem" | "optimization" | "find_all_values";
    skip_cross_validation?: boolean;
    find_all_search_range?: { min: number; max: number };
  };
}

// ── SSE Helpers ─────────────────────────────────────────────────────────

function sseFrame(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

// ── Streaming POST Handler ─────────────────────────────────────────────

async function handlePOST(req: Request) {
  const body = (await req.json()) as SolveRequest;
  const jobOwner = await requestOwner();
  // Plan limits, daily spend and the rate limit (lib/quota.ts) — before anything is created or spent.
  const admit = await admitSolve(jobOwner, lt);
  if (!admit.ok) return NextResponse.json({ error: admit.reason, quota: admit }, { status: 429 });

  // Get or create session
  let session;
  if (body.session_id) {
    session = await getSessionForRequest(body.session_id);
    if (!session) {
      return NextResponse.json({ error: "session not found" }, { status: 404 });
    }
  } else if (body.problem_text?.trim()) {
    session = await createSessionForRequest(body.problem_text.trim());
  } else {
    return NextResponse.json(
      { error: "problem_text or session_id required" },
      { status: 400 },
    );
  }

  const figs = figureRefsSchema.safeParse(body.figures ?? []);
  if (!figs.success) return NextResponse.json({ error: "invalid figures" }, { status: 400 });
  const figures = body.session_id ? [] : figs.data;
  const owner = jobOwner;

  const opts = body.options ?? {};
  const useMathlib = opts.use_mathlib ?? true;
  let sess: Session = session;

  // Create a TransformStream for SSE
  const encoder = new TextEncoder();
  // Cancelled when the client goes away (stream cancelled / request aborted) or via /api/jobs/:id/cancel.
  const gone = new AbortController();
  const stream = new ReadableStream({
    cancel() {
      gone.abort();
    },
    async start(controller) {
      let closed = false;
      const emit = (data: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sseFrame(data)));
        } catch {
          closed = true; // the client went away
        }
      };
      req.signal?.addEventListener("abort", () => gone.abort(), { once: true });

      try {
        await runJob(
          {
            owner: jobOwner,
            kind: "solve",
            sessionId: sess.id,
            signal: gone.signal,
            maxActive: admit.concurrent,
            onStart: (job) => emit({ type: "job", job_id: job.id, session_id: sess.id }),
            onQueued: (position) => {
              updateSession(sess.id, { pipeline_stage: "queued" });
              emit({ type: "progress", stage: "queued", position, detail: lt(`排队中：前面还有 ${position - 1} 个求解`, `Queued: ${position - 1} solve(s) ahead`) });
            },
          },
          () => runSolve(),
        );
      } catch (e) {
        if (e instanceof CancelledError) {
          updateSession(sess.id, { pipeline_stage: "cancelled" });
          await saveSessionToDisk(sess.id);
          emit({ type: "cancelled", detail: lt("已取消", "Cancelled") });
        } else if (e instanceof TooManyJobsError) {
          emit({ type: "error", error: lt(`同时最多进行 ${e.limit} 个求解，请等前面的完成或取消`, `At most ${e.limit} solves at a time; wait for one to finish or cancel it`) });
        } else {
          emit({ type: "error", error: "solve pipeline failed" });
        }
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }

      // One usage scope per run: LLM calls and Lean verifications are
      // attributed to it and reported as `metrics` in the result frame.
      async function runSolve(): Promise<void> {
      await withUsageScope(async (metrics) => {
       try {
        try {
          // ── Figures: read once by the vision model, appended to the problem text ──
          let figureDescription: string | undefined;
          const knownFigure = body.session_id ? undefined : figureTextOf(body.figure_text);
          if (knownFigure) {
            figureDescription = knownFigure;
            sess = updateSession(sess.id, { problem_text: problemWithFigure(sess.problem_text, knownFigure), figure_description: knownFigure });
          } else if (figures.length) {
            emit({ type: "progress", stage: "reading_figure", detail: lt("模型正在读取题目图形...", "The model is reading the problem's figure...") });
            const fig = await describeProblemFigures({ owner, problemText: sess.problem_text, figures });
            if (fig.description) {
              figureDescription = fig.description;
              sess = updateSession(sess.id, { problem_text: problemWithFigure(sess.problem_text, fig.description), figure_description: fig.description });
              emit({ type: "progress", stage: "reading_figure", detail: lt(`✅ 已读取图形：${fig.description.slice(0, 80)}…`, `✅ Figure read: ${fig.description.slice(0, 80)}…`) });
            } else if (fig.note) {
              emit({ type: "progress", stage: "reading_figure", detail: `⚠️ ${fig.note}` });
            }
          }

          // ── Stage 0: Classify ────────────────────────────────────────
          emit({ type: "progress", stage: "classifying", detail: lt("正在分析问题类型...", "Analyzing the problem type...") });

          const classification = await classifyProblem(sess.problem_text);
          const problemType = opts.force_type ?? classification.problem_type;

          emit({
            type: "progress",
            stage: "classifying",
            detail: lt(`问题类型: ${problemType}`, `Problem type: ${problemType}`),
          });

          // Dispatch to handler based on type
          let resultData: Record<string, unknown>;

          if (problemType === "computational") {
            resultData = await handleComputational(sess, opts, emit);
          } else if (problemType === "optimization") {
            resultData = await handleOptimization(sess, opts, emit);
          } else if (problemType === "find_all_values") {
            resultData = await handleFindAll(sess, opts, emit, classification.find_all_hints);
          } else {
            resultData = await handleTheorem(sess, opts, emit, useMathlib, sess.math_domain);
          }

          const m = metrics();
          updateSession(sess.id, { metrics: m });
          await saveSessionToDisk(sess.id);

          // Emit final result
          emit({ type: "result", data: { ...resultData, ...(figureDescription ? { figure_description: figureDescription } : {}), metrics: m } });
        } catch (e) {
          if (e instanceof CancelledError) {
            updateSession(sess.id, { metrics: metrics() });
            throw e;
          }
          updateSession(sess.id, { pipeline_stage: "failed", metrics: metrics() });
          await saveSessionToDisk(sess.id);
          const msg = e instanceof LlmError ? e.message : "solve pipeline failed";
          emit({ type: "error", error: msg });
        }
       } finally {
        // The run's spend counts against the owner's daily limit, whatever the outcome.
        await recordSpend(jobOwner, metrics().estimated_cost);
       }
      }, { costCapUsd: runCostCap(admit) });
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ── Computational Handler ───────────────────────────────────────────────

async function handleComputational(
  session: Session,
  opts: NonNullable<SolveRequest["options"]>,
  emit: (data: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  updateSession(session.id, { pipeline_stage: "computing" });
  emit({ stage: "computing", type: "progress", detail: lt("开始计算求解...", "Starting computation...") });

  const computeResult = await solveComputational({
    problemText: session.problem_text,
    options: { skip_cross_validation: opts.skip_cross_validation },
  });

  updateSession(session.id, {
    pipeline_stage: "computing",
    computation_result: {
      answer: computeResult.answer,
      answer_exact: computeResult.answer_exact,
      answer_decimal: computeResult.answer_decimal,
      cross_validated: computeResult.cross_validated,
      methods_used: computeResult.methods_used,
      solution_steps: computeResult.solution_steps,
      ...(computeResult.checks?.length ? { checks: computeResult.checks } : {}),
    },
  });

  emit({
    stage: "computing",
    type: "progress",
    detail: lt(`答案: ${computeResult.answer} (≈${computeResult.answer_decimal}) [${computeResult.cross_validated ? "交叉验证通过" : "单一方法"}]`, `Answer: ${computeResult.answer} (≈${computeResult.answer_decimal}) [${computeResult.cross_validated ? "cross-validated" : "single method"}]`),
  });
  for (const check of computeResult.checks ?? []) emit({ stage: "computing", type: "progress", detail: `⚠️ ${check}` });

  // NL Solution
  let nlSolution: NaturalLanguageSolution | undefined;
  if (!opts.skip_nl_solution) {
    updateSession(session.id, { pipeline_stage: "nl_solving" });
    emit({ stage: "nl_solving", type: "progress", detail: lt("生成自然语言解答...", "Generating the natural-language solution...") });

    try {
      nlSolution = await generateNLSolution({
        problemText: session.problem_text,
        problemType: "computational",
        computeResult: {
          answer: computeResult.answer,
          answer_decimal: computeResult.answer_decimal,
          solution_steps: computeResult.solution_steps,
        },
      });
      updateSession(session.id, { nl_solution: nlSolution });
      emit({
        stage: "nl_solving",
        type: "progress",
        detail: lt(`✅ 自然语言解答完成 (${nlSolution.steps.length} 步)`, `✅ Natural-language solution ready (${nlSolution.steps.length} steps)`),
      });
    } catch (e) {
      emit({
        stage: "nl_solving",
        type: "progress",
        detail: lt(`⚠️ 自然语言解答失败: ${e instanceof Error ? e.message : "未知错误"}`, `⚠️ Natural-language solution failed: ${e instanceof Error ? e.message : "unknown error"}`),
      });
    }
  }

  // Lean attempt: the last step, started by hand from the Lean tab unless requested here.
  let leanProofAttempt: LeanProofAttempt;
  if (!shouldAutoAttemptLean(opts)) {
    leanProofAttempt = manualLeanAttempt();
    updateSession(session.id, { lean_proof_attempt: leanProofAttempt });
  } else {
    updateSession(session.id, { pipeline_stage: "lean_attempting" });
    emit({ stage: "lean_attempting", type: "progress", detail: lt("尝试 Lean 4 形式化证明...", "Attempting a Lean 4 formal proof...") });

    const solved = getSession(session.id) ?? session;
    leanProofAttempt = await attemptLeanFormalization(session.problem_text, {
      answers: answerCandidates(solved),
      solution: solved.nl_solution,
      sessionId: session.id,
    });
    updateSession(session.id, { lean_proof_attempt: leanProofAttempt });

    emit({
      stage: "lean_attempting",
      type: "progress",
      detail: leanProofAttempt.success
        ? lt("✅ Lean 4 形式化证明成功", "✅ Lean 4 formal proof succeeded")
        : lt(`ℹ️ Lean 4 形式化未能完成: ${leanProofAttempt.failure_reason ?? "未知原因"}`, `ℹ️ Lean 4 formalization not completed: ${leanProofAttempt.failure_reason ?? "unknown reason"}`),
    });
  }

  updateSession(session.id, { pipeline_stage: "complete" });
  emit({ stage: "complete", type: "progress", detail: lt(`求解完成 — 答案: ${computeResult.answer}`, `Solved — answer: ${computeResult.answer}`) });

  return {
    session_id: session.id,
    pipeline_events: [],
    problem_type: "computational",
    nl_solution: nlSolution,
    lean_proof_attempt: leanProofAttempt,
    answer: computeResult.answer,
    answer_exact: computeResult.answer_exact,
    answer_decimal: computeResult.answer_decimal,
    cross_validated: computeResult.cross_validated,
    confidence: computeResult.confidence,
    methods_used: computeResult.methods_used,
    solution_steps: computeResult.solution_steps,
    checks: computeResult.checks,
    method_results: computeResult.method_results,
    validation: computeResult.validation,
    equation_setup: computeResult.equation_setup,
    sympy_available: computeResult.sympy_available,
  };
}

// ── Optimization Handler ────────────────────────────────────────────────

async function handleOptimization(
  session: Session,
  opts: NonNullable<SolveRequest["options"]>,
  emit: (data: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  updateSession(session.id, { pipeline_stage: "extracting" });
  emit({ stage: "extracting", type: "progress", detail: lt("提取优化问题结构...", "Extracting the optimization problem structure...") });

  const structure = await extractOptimizationStructure(session.problem_text);
  emit({
    stage: "extracting",
    type: "progress",
    detail: lt(`目标: ${structure.objective}, 类别数: ${structure.categories.length}`, `Objective: ${structure.objective}, categories: ${structure.categories.length}`),
  });

  updateSession(session.id, { pipeline_stage: "optimizing" });
  emit({ stage: "optimizing", type: "progress", detail: lt("确定性搜索最优解...", "Searching deterministically for the optimum...") });

  const result = solveOptimization(structure);
  const answerStr = String(result.optimal_value);

  updateSession(session.id, {
    pipeline_stage: "optimizing",
    computation_result: {
      answer: answerStr,
      answer_exact: answerStr,
      answer_decimal: answerStr,
      cross_validated: true,
      methods_used: ["deterministic_optimization"],
      solution_steps: result.reasoning.split("\n"),
    },
  });

  emit({
    stage: "optimizing",
    type: "progress",
    detail: `${lt("最优值", "Optimal value")}: ${answerStr} (${Object.entries(result.assignments).map(([k, v]) => `${k}=${v}`).join(", ")})`,
  });

  // NL Solution
  let nlSolution: NaturalLanguageSolution | undefined;
  if (!opts.skip_nl_solution) {
    updateSession(session.id, { pipeline_stage: "nl_solving" });
    emit({ stage: "nl_solving", type: "progress", detail: lt("生成自然语言解答...", "Generating the natural-language solution...") });

    try {
      nlSolution = await generateNLSolution({
        problemText: session.problem_text,
        problemType: "computational",
        computeResult: { answer: answerStr, answer_decimal: answerStr, solution_steps: result.reasoning.split("\n") },
      });
      updateSession(session.id, { nl_solution: nlSolution });
      emit({ stage: "nl_solving", type: "progress", detail: lt(`✅ 自然语言解答完成 (${nlSolution.steps.length} 步)`, `✅ Natural-language solution ready (${nlSolution.steps.length} steps)`) });
    } catch (e) {
      emit({ stage: "nl_solving", type: "progress", detail: lt(`⚠️ 自然语言解答失败: ${e instanceof Error ? e.message : "未知错误"}`, `⚠️ Natural-language solution failed: ${e instanceof Error ? e.message : "unknown error"}`) });
    }
  }

  // The search answers the structure the model extracted, which may be the wrong problem:
  // the written solution is a second opinion, and a disagreement is re-checked.
  let answer = answerStr;
  let crossValidated = true;
  const checks: string[] = [];
  if (nlSolution) {
    const rec = await reconcileWithSolution(session.problem_text, answerStr, nlSolution.final_answer);
    if (!rec.agreed) {
      answer = rec.answer;
      crossValidated = false;
      if (rec.check) {
        checks.push(rec.check);
        emit({ stage: "nl_solving", type: "progress", detail: `⚠️ ${rec.check}` });
      }
      if (rec.solutionStale) {
        try {
          nlSolution = await generateNLSolution({ problemText: session.problem_text, problemType: "computational", computeResult: { answer, answer_decimal: answer, solution_steps: [] } });
          updateSession(session.id, { nl_solution: nlSolution });
        } catch {
          /* keep the first solution; the checks say which answer was chosen */
        }
      }
      updateSession(session.id, {
        computation_result: { answer, answer_exact: answer, answer_decimal: answer, cross_validated: false, methods_used: ["deterministic_optimization", "answer_recheck"], solution_steps: result.reasoning.split("\n"), checks },
      });
    }
  }

  const leanProofAttempt: LeanProofAttempt = {
    attempted: false,
    success: false,
    failure_reason: lt("组合优化问题的 Lean 形式化需要复杂的归纳论证，当前自动证明能力有限", "Formalizing combinatorial optimization problems in Lean requires intricate inductive arguments, beyond current automated proving"),
  };

  updateSession(session.id, { pipeline_stage: "complete", lean_proof_attempt: leanProofAttempt });
  emit({ stage: "complete", type: "progress", detail: crossValidated ? lt(`求解完成 — 最优值: ${answer}`, `Solved — optimal value: ${answer}`) : lt(`求解完成 — 答案: ${answer}`, `Solved — answer: ${answer}`) });

  return {
    session_id: session.id,
    pipeline_events: [],
    problem_type: "optimization",
    nl_solution: nlSolution,
    lean_proof_attempt: leanProofAttempt,
    answer,
    answer_exact: answer,
    answer_decimal: answer,
    optimal_value: result.optimal_value,
    assignments: result.assignments,
    is_feasible: result.is_feasible,
    reasoning: result.reasoning,
    example_sets: result.example_sets,
    optimization_structure: structure,
    confidence: crossValidated ? 1.0 : 0.5,
    cross_validated: crossValidated,
    checks,
    methods_used: crossValidated ? ["deterministic_optimization"] : ["deterministic_optimization", "answer_recheck"],
  };
}

// ── Find-All Handler ────────────────────────────────────────────────────

async function handleFindAll(
  session: Session,
  opts: NonNullable<SolveRequest["options"]>,
  emit: (data: Record<string, unknown>) => void,
  findHints?: { parameter: string; parameter_domain?: "integer" | "positive_integer" | "real"; condition_description: string; search_range_hint?: string },
): Promise<Record<string, unknown>> {
  updateSession(session.id, { pipeline_stage: "computing" });
  emit({ stage: "computing", type: "progress", detail: lt("开始穷举搜索...", "Starting exhaustive search...") });

  const findAllResult = await solveFindAll({
    problemText: session.problem_text,
    hints: findHints,
    searchRange: opts.find_all_search_range,
  });

  updateSession(session.id, {
    pipeline_stage: "computing",
    computation_result: {
      answer: findAllResult.answer,
      answer_exact: findAllResult.answer,
      answer_decimal: findAllResult.answer,
      cross_validated: true,
      methods_used: ["find_all_search"],
      solution_steps: findAllResult.solution_steps,
    },
  });

  emit({
    stage: "computing",
    type: "progress",
    detail: lt(`找到 ${findAllResult.valid_values.length} 个满足条件的值: ${findAllResult.answer}`, `Found ${findAllResult.valid_values.length} values satisfying the conditions: ${findAllResult.answer}`),
  });

  // NL Solution
  let nlSolution: NaturalLanguageSolution | undefined;
  if (!opts.skip_nl_solution) {
    updateSession(session.id, { pipeline_stage: "nl_solving" });
    emit({ stage: "nl_solving", type: "progress", detail: lt("生成自然语言解答...", "Generating the natural-language solution...") });

    try {
      nlSolution = await generateNLSolution({
        problemText: session.problem_text,
        problemType: "computational",
        computeResult: { answer: findAllResult.answer, answer_decimal: findAllResult.answer, solution_steps: findAllResult.solution_steps },
      });
      updateSession(session.id, { nl_solution: nlSolution });
      emit({ stage: "nl_solving", type: "progress", detail: lt(`✅ 自然语言解答完成 (${nlSolution.steps.length} 步)`, `✅ Natural-language solution ready (${nlSolution.steps.length} steps)`) });
    } catch (e) {
      emit({ stage: "nl_solving", type: "progress", detail: lt(`⚠️ 自然语言解答失败: ${e instanceof Error ? e.message : "未知错误"}`, `⚠️ Natural-language solution failed: ${e instanceof Error ? e.message : "unknown error"}`) });
    }
  }

  const leanProofAttempt: LeanProofAttempt = {
    attempted: false,
    success: false,
    failure_reason: lt("求所有值问题的 Lean 形式化需要完备性证明，当前自动证明能力有限", "Formalizing find-all-values problems in Lean requires a completeness proof, beyond current automated proving"),
  };

  updateSession(session.id, { pipeline_stage: "complete", lean_proof_attempt: leanProofAttempt });
  emit({ stage: "complete", type: "progress", detail: lt(`求解完成 — 满足条件的所有值: ${findAllResult.answer}`, `Solved — all values satisfying the conditions: ${findAllResult.answer}`) });

  return {
    session_id: session.id,
    pipeline_events: [],
    problem_type: "find_all_values",
    nl_solution: nlSolution,
    lean_proof_attempt: leanProofAttempt,
    answer: findAllResult.answer,
    answer_exact: findAllResult.answer,
    answer_decimal: findAllResult.answer,
    valid_values: findAllResult.valid_values,
    checked_range: findAllResult.checked_range,
    candidates: findAllResult.candidates,
    completeness_argument: findAllResult.completeness_argument,
    confidence: findAllResult.confidence,
    cross_validated: true,
    methods_used: ["find_all_search"],
    solution_steps: findAllResult.solution_steps,
  };
}

// ── Theorem Handler ─────────────────────────────────────────────────────

async function handleTheorem(
  session: Session,
  opts: NonNullable<SolveRequest["options"]>,
  emit: (data: Record<string, unknown>) => void,
  useMathlib: boolean,
  domain?: MathDomain,
): Promise<Record<string, unknown>> {
  const events: Array<{ stage: string; detail: string }> = [];
  const outcome = await runTheoremPipeline({
    session,
    opts,
    useMathlib,
    domain,
    onEvent: (e) => {
      events.push(e);
      emit({ type: "progress", stage: e.stage, detail: e.detail });
    },
  });
  return { ...outcome.body, pipeline_events: events };
}

// Server messages and model output follow the UI language (lib/llm/output-locale.ts).
export const POST = withRequestLocale(handlePOST);
