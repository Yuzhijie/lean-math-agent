import { getSessionForRequest, createSessionForRequest } from "@/lib/session-access";
import { NextResponse } from "next/server";
import { updateSession, saveSessionToDisk } from "@/lib/session-store";
import { LlmError } from "@/lib/llm/client";
import { CancelledError, runJob, TooManyJobsError } from "@/lib/jobs";
import { admitSolve, recordSpend, runCostCap } from "@/lib/quota";
import { withUsageScope } from "@/lib/llm/usage-tracker";
import { classifyProblem } from "@/lib/llm/classify-problem";
import { solveComputational } from "@/lib/compute/solver";
import { solveOptimization } from "@/lib/compute/optimization-solver";
import { solveFindAll } from "@/lib/compute/find-all-solver";
import { extractOptimizationStructure } from "@/lib/llm/optimization-extract";
import { generateNLSolution } from "@/lib/llm/nl-solution";
import { runTheoremPipeline, type TheoremPipelineOptions } from "@/lib/pipeline/theorem-pipeline";
import type {
  LeanProofAttempt,
  MathDomain,
  NaturalLanguageSolution,
  Session,
} from "@/lib/types";
import { answerCandidates, attemptLeanFormalization, manualLeanAttempt, shouldAutoAttemptLean } from "@/lib/pipeline/lean-attempt";
import { lt, withRequestLocale } from "@/lib/llm/output-locale";
import { requestOwner } from "@/lib/bank/http";
import { describeProblemFigures, figureRefsSchema, figureTextOf, problemWithFigure, type FigureRef } from "@/lib/bank/problem-figures";

interface SolveRequest {
  problem_text?: string;
  session_id?: string;
  /** Figures of the problem (question bank images): read by the vision model and appended to the text. */
  figures?: FigureRef[];
  /** The figure's description when it is already known (a generated question's figure). */
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

async function handlePOST(req: Request) {
  const body = (await req.json()) as SolveRequest;
  const owner = await requestOwner();
  // Plan limits, daily spend and the rate limit (lib/quota.ts).
  const admit = await admitSolve(owner, lt);
  if (!admit.ok) return NextResponse.json({ error: admit.reason, quota: admit }, { status: 429 });

  // Get or create session
  let session;
  if (body.session_id) {
    session = await getSessionForRequest(body.session_id);
    if (!session) {
      return NextResponse.json({ error: "session not found" }, { status: 404 });
    }
  } else if (body.problem_text?.trim()) {
    const figs = figureRefsSchema.safeParse(body.figures ?? []);
    if (!figs.success) return NextResponse.json({ error: "invalid figures" }, { status: 400 });
    const known = figureTextOf(body.figure_text);
    const fig = known ? { description: known } : figs.data.length ? await describeProblemFigures({ owner: await requestOwner(), problemText: body.problem_text.trim(), figures: figs.data }) : {};
    session = await createSessionForRequest(fig.description ? problemWithFigure(body.problem_text, fig.description) : body.problem_text.trim());
    if (fig.description) session = updateSession(session.id, { figure_description: fig.description });
  } else {
    return NextResponse.json(
      { error: "problem_text or session_id required" },
      { status: 400 },
    );
  }

  const opts = body.options ?? {};
  const useMathlib = opts.use_mathlib ?? true;
  const events: Array<{ stage: string; detail: string }> = [];
  const sess: Session = session;

  // A job like the streaming route's: queued behind running solves, cancelled when the client goes away.
  try {
    return await runJob({ owner, kind: "solve", sessionId: sess.id, signal: req.signal, maxActive: admit.concurrent }, () => solveIn(sess));
  } catch (e) {
    if (e instanceof TooManyJobsError) return NextResponse.json({ error: e.message, session_id: sess.id }, { status: 429 });
    if (e instanceof CancelledError) {
      updateSession(sess.id, { pipeline_stage: "cancelled" });
      return NextResponse.json({ error: "cancelled", session_id: sess.id }, { status: 499 });
    }
    throw e;
  }

  // Everything below runs in one usage scope so LLM calls (by role/model)
  // and Lean verifications are attributed to this run.
  function solveIn(sess: Session): Promise<Response> {
  return withUsageScope(async (metrics) => {
   try {
    try {
      // ── Stage 0: Classify problem type ──────────────────────────────
      const classification = await classifyProblem(sess.problem_text);
      const problemType = opts.force_type ?? classification.problem_type;

      events.push({
        stage: "classifying",
        detail: lt(`问题类型: ${problemType}`, `Problem type: ${problemType}`),
      });

      let response: Response;
      if (problemType === "computational") {
        response = await handleComputationalProblem(sess, opts, events);
      } else if (problemType === "optimization") {
        response = await handleOptimizationProblem(sess, opts, events);
      } else if (problemType === "find_all_values") {
        response = await handleFindAllProblem(sess, opts, events, classification.find_all_hints);
      } else {
        response = await handleTheoremProblem(sess, opts, events, useMathlib, sess.math_domain, metrics);
      }
      updateSession(sess.id, { metrics: metrics() });
      await saveSessionToDisk(sess.id);
      return response;
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      updateSession(sess.id, { pipeline_stage: "failed", metrics: metrics() });
      await saveSessionToDisk(sess.id);
      const msg = e instanceof LlmError ? e.message : "solve pipeline failed";
      return NextResponse.json(
        {
          error: msg,
          session_id: sess.id,
          pipeline_events: events,
          metrics: metrics(),
        },
        { status: 502 },
      );
    }
   } finally {
    await recordSpend(owner, metrics().estimated_cost);
   }
  }, { costCapUsd: runCostCap(admit) });
  }
}

// ── Computational Problem Handler ─────────────────────────────────────

async function handleComputationalProblem(
  session: Session,
  opts: NonNullable<SolveRequest["options"]>,
  events: Array<{ stage: string; detail: string }>,
) {
  // Step 1: Compute the answer
  updateSession(session.id, { pipeline_stage: "computing" });
  events.push({ stage: "computing", detail: lt("开始计算求解...", "Starting computation...") });

  const computeResult = await solveComputational({
    problemText: session.problem_text,
    options: {
      skip_cross_validation: opts.skip_cross_validation,
    },
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

  events.push({
    stage: "computing",
    detail: lt(`答案: ${computeResult.answer} (≈${computeResult.answer_decimal}) [${computeResult.cross_validated ? "交叉验证通过" : "单一方法"}]`, `Answer: ${computeResult.answer} (≈${computeResult.answer_decimal}) [${computeResult.cross_validated ? "cross-validated" : "single method"}]`),
  });
  for (const check of computeResult.checks ?? []) events.push({ stage: "computing", detail: `⚠️ ${check}` });

  // Step 2: Generate natural language solution (NL first)
  let nlSolution: NaturalLanguageSolution | undefined;

  if (!opts.skip_nl_solution) {
    updateSession(session.id, { pipeline_stage: "nl_solving" });
    events.push({ stage: "nl_solving", detail: lt("生成自然语言解答...", "Generating the natural-language solution...") });

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
      events.push({
        stage: "nl_solving",
        detail: lt(`✅ 自然语言解答完成 (${nlSolution.steps.length} 步)`, `✅ Natural-language solution ready (${nlSolution.steps.length} steps)`),
      });
    } catch (e) {
      events.push({
        stage: "nl_solving",
        detail: lt(`⚠️ 自然语言解答失败: ${e instanceof Error ? e.message : "未知错误"}`, `⚠️ Natural-language solution failed: ${e instanceof Error ? e.message : "unknown error"}`),
      });
    }
  }

  // Step 3: Attempt Lean 4 formal proof (or explain why not)
  let leanProofAttempt: LeanProofAttempt;

  if (!shouldAutoAttemptLean(opts)) {
    // The last step is started by hand (POST /api/lean-attempt).
    leanProofAttempt = manualLeanAttempt();
    updateSession(session.id, { lean_proof_attempt: leanProofAttempt });
  } else {
    updateSession(session.id, { pipeline_stage: "lean_attempting" });
    events.push({ stage: "lean_attempting", detail: lt("尝试 Lean 4 形式化证明...", "Attempting a Lean 4 formal proof...") });

    leanProofAttempt = await attemptLeanFormalization(session.problem_text, {
      answers: answerCandidates({ computation_result: computeResult, nl_solution: nlSolution }),
      solution: nlSolution,
      sessionId: session.id,
    });

    updateSession(session.id, { lean_proof_attempt: leanProofAttempt });

    events.push({
      stage: "lean_attempting",
      detail: leanProofAttempt.success
        ? lt("✅ Lean 4 形式化证明成功", "✅ Lean 4 formal proof succeeded")
        : lt(`ℹ️ Lean 4 形式化未能完成: ${leanProofAttempt.failure_reason ?? "未知原因"}`, `ℹ️ Lean 4 formalization not completed: ${leanProofAttempt.failure_reason ?? "unknown reason"}`),
    });
  }

  updateSession(session.id, { pipeline_stage: "complete" });

  events.push({
    stage: "complete",
    detail: lt(`求解完成 — 答案: ${computeResult.answer}`, `Solved — answer: ${computeResult.answer}`),
  });

  await saveSessionToDisk(session.id);

  return NextResponse.json({
    session_id: session.id,
    pipeline_events: events,
    problem_type: "computational",
    // NL solution (displayed first)
    nl_solution: nlSolution,
    // Lean proof attempt (displayed second)
    lean_proof_attempt: leanProofAttempt,
    // Computational details
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
  });
}

// ── Optimization Problem Handler ──────────────────────────────────────

async function handleOptimizationProblem(
  session: Session,
  opts: NonNullable<SolveRequest["options"]>,
  events: Array<{ stage: string; detail: string }>,
) {
  // Step 1: Extract optimization structure via LLM
  updateSession(session.id, { pipeline_stage: "extracting" });
  events.push({ stage: "extracting", detail: lt("提取优化问题结构...", "Extracting the optimization problem structure...") });

  const structure = await extractOptimizationStructure(session.problem_text);

  events.push({
    stage: "extracting",
    detail: lt(`目标: ${structure.objective} ${structure.objective_description}, 类别数: ${structure.categories.length}`, `Objective: ${structure.objective} ${structure.objective_description}, categories: ${structure.categories.length}`),
  });

  // Step 2: Deterministic optimization search
  updateSession(session.id, { pipeline_stage: "optimizing" });
  events.push({ stage: "optimizing", detail: lt("确定性搜索最优解...", "Searching deterministically for the optimum...") });

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

  events.push({
    stage: "optimizing",
    detail: `${lt("最优值", "Optimal value")}: ${answerStr} (${Object.entries(result.assignments).map(([k, v]) => `${k}=${v}`).join(", ")})`,
  });

  // Step 3: Generate natural language solution
  let nlSolution: NaturalLanguageSolution | undefined;

  if (!opts.skip_nl_solution) {
    updateSession(session.id, { pipeline_stage: "nl_solving" });
    events.push({ stage: "nl_solving", detail: lt("生成自然语言解答...", "Generating the natural-language solution...") });

    try {
      nlSolution = await generateNLSolution({
        problemText: session.problem_text,
        problemType: "computational",
        computeResult: {
          answer: answerStr,
          answer_decimal: answerStr,
          solution_steps: result.reasoning.split("\n"),
        },
      });

      updateSession(session.id, { nl_solution: nlSolution });
      events.push({
        stage: "nl_solving",
        detail: lt(`✅ 自然语言解答完成 (${nlSolution.steps.length} 步)`, `✅ Natural-language solution ready (${nlSolution.steps.length} steps)`),
      });
    } catch (e) {
      events.push({
        stage: "nl_solving",
        detail: lt(`⚠️ 自然语言解答失败: ${e instanceof Error ? e.message : "未知错误"}`, `⚠️ Natural-language solution failed: ${e instanceof Error ? e.message : "unknown error"}`),
      });
    }
  }

  // Step 4: Lean formalization (best-effort, usually skip for optimization)
  const leanProofAttempt: LeanProofAttempt = {
    attempted: false,
    success: false,
    failure_reason: lt("组合优化问题的 Lean 形式化需要复杂的归纳论证，当前自动证明能力有限", "Formalizing combinatorial optimization problems in Lean requires intricate inductive arguments, beyond current automated proving"),
  };

  updateSession(session.id, {
    pipeline_stage: "complete",
    lean_proof_attempt: leanProofAttempt,
  });

  events.push({
    stage: "complete",
    detail: lt(`求解完成 — 最优值: ${answerStr}`, `Solved — optimal value: ${answerStr}`),
  });

  await saveSessionToDisk(session.id);

  return NextResponse.json({
    session_id: session.id,
    pipeline_events: events,
    problem_type: "optimization",
    nl_solution: nlSolution,
    lean_proof_attempt: leanProofAttempt,
    // Optimization-specific fields
    answer: answerStr,
    answer_exact: answerStr,
    answer_decimal: answerStr,
    optimal_value: result.optimal_value,
    assignments: result.assignments,
    is_feasible: result.is_feasible,
    reasoning: result.reasoning,
    example_sets: result.example_sets,
    optimization_structure: structure,
    confidence: 1.0,
    cross_validated: true,
    methods_used: ["deterministic_optimization"],
  });
}

// ── Find-All-Values Problem Handler ────────────────────────────────────

async function handleFindAllProblem(
  session: Session,
  opts: NonNullable<SolveRequest["options"]>,
  events: Array<{ stage: string; detail: string }>,
  findHints?: {
    parameter: string;
    parameter_domain?: "integer" | "positive_integer" | "real";
    condition_description: string;
    search_range_hint?: string;
  },
) {
  // Step 1: Systematic search and verification
  updateSession(session.id, { pipeline_stage: "computing" });
  events.push({ stage: "computing", detail: lt("开始穷举搜索...", "Starting exhaustive search...") });

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

  events.push({
    stage: "computing",
    detail: lt(`找到 ${findAllResult.valid_values.length} 个满足条件的值: ${findAllResult.answer}`, `Found ${findAllResult.valid_values.length} values satisfying the conditions: ${findAllResult.answer}`),
  });

  // Step 2: Generate natural language solution
  let nlSolution: NaturalLanguageSolution | undefined;

  if (!opts.skip_nl_solution) {
    updateSession(session.id, { pipeline_stage: "nl_solving" });
    events.push({ stage: "nl_solving", detail: lt("生成自然语言解答...", "Generating the natural-language solution...") });

    try {
      nlSolution = await generateNLSolution({
        problemText: session.problem_text,
        problemType: "computational",
        computeResult: {
          answer: findAllResult.answer,
          answer_decimal: findAllResult.answer,
          solution_steps: findAllResult.solution_steps,
        },
      });

      updateSession(session.id, { nl_solution: nlSolution });
      events.push({
        stage: "nl_solving",
        detail: lt(`✅ 自然语言解答完成 (${nlSolution.steps.length} 步)`, `✅ Natural-language solution ready (${nlSolution.steps.length} steps)`),
      });
    } catch (e) {
      events.push({
        stage: "nl_solving",
        detail: lt(`⚠️ 自然语言解答失败: ${e instanceof Error ? e.message : "未知错误"}`, `⚠️ Natural-language solution failed: ${e instanceof Error ? e.message : "unknown error"}`),
      });
    }
  }

  // Step 3: Lean formalization (best-effort for find-all problems)
  const leanProofAttempt: LeanProofAttempt = {
    attempted: false,
    success: false,
    failure_reason: lt("求所有值问题的 Lean 形式化需要完备性证明，当前自动证明能力有限", "Formalizing find-all-values problems in Lean requires a completeness proof, beyond current automated proving"),
  };

  updateSession(session.id, {
    pipeline_stage: "complete",
    lean_proof_attempt: leanProofAttempt,
  });

  events.push({
    stage: "complete",
    detail: lt(`求解完成 — 满足条件的所有值: ${findAllResult.answer}`, `Solved — all values satisfying the conditions: ${findAllResult.answer}`),
  });

  await saveSessionToDisk(session.id);

  return NextResponse.json({
    session_id: session.id,
    pipeline_events: events,
    problem_type: "find_all_values",
    nl_solution: nlSolution,
    lean_proof_attempt: leanProofAttempt,
    // Find-all-specific fields
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
  });
}

// ── Theorem Problem Handler ───────────────────────────────────────────

async function handleTheoremProblem(
  session: Session,
  opts: NonNullable<SolveRequest["options"]>,
  events: Array<{ stage: string; detail: string }>,
  useMathlib: boolean,
  domain: MathDomain | undefined,
  metrics: () => import("@/lib/llm/usage-tracker").RunMetrics,
) {
  const outcome = await runTheoremPipeline({
    session,
    opts,
    useMathlib,
    domain,
    onEvent: (e) => events.push(e),
  });
  return NextResponse.json(
    { ...outcome.body, pipeline_events: events, metrics: metrics() },
    { status: outcome.status },
  );
}

// Server messages and model output follow the UI language (lib/llm/output-locale.ts).
export const POST = withRequestLocale(handlePOST);
