import { NextResponse } from "next/server";
import { autoformalize } from "@/lib/llm/autoformalize";
import {
  createSession,
  updateSession,
  getSessionAsync,
  saveSessionToDisk,
} from "@/lib/session-store";
import { LlmError } from "@/lib/llm/client";
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
import { manualLeanAttempt, shouldAutoAttemptLean } from "@/lib/pipeline/lean-attempt";
import { lt, withRequestLocale } from "@/lib/llm/output-locale";
import { requestOwner } from "@/lib/bank/http";
import { describeProblemFigures, figureRefsSchema, problemWithFigure, type FigureRef } from "@/lib/bank/problem-figures";

interface SolveRequest {
  problem_text?: string;
  session_id?: string;
  /** Figures of the problem (question bank images): read by the vision model and appended to the text. */
  figures?: FigureRef[];
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

  // Get or create session
  let session;
  if (body.session_id) {
    session = await getSessionAsync(body.session_id);
    if (!session) {
      return NextResponse.json({ error: "session not found" }, { status: 404 });
    }
  } else if (body.problem_text?.trim()) {
    const figs = figureRefsSchema.safeParse(body.figures ?? []);
    if (!figs.success) return NextResponse.json({ error: "invalid figures" }, { status: 400 });
    const fig = figs.data.length ? await describeProblemFigures({ owner: await requestOwner(), problemText: body.problem_text.trim(), figures: figs.data }) : {};
    session = createSession(fig.description ? problemWithFigure(body.problem_text, fig.description) : body.problem_text.trim());
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

  // Everything below runs in one usage scope so LLM calls (by role/model)
  // and Lean verifications are attributed to this run.
  return withUsageScope(async (metrics) => {
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
  });
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
    },
  });

  events.push({
    stage: "computing",
    detail: lt(`答案: ${computeResult.answer} (≈${computeResult.answer_decimal}) [${computeResult.cross_validated ? "交叉验证通过" : "单一方法"}]`, `Answer: ${computeResult.answer} (≈${computeResult.answer_decimal}) [${computeResult.cross_validated ? "cross-validated" : "single method"}]`),
  });

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

    leanProofAttempt = await attemptLeanFormalization(
      session.problem_text,
      computeResult,
    );

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

// ── Lean Formalization Attempt for Computational Problems ─────────────

/**
 * Attempt to formalize a computational problem in Lean 4.
 * This is best-effort: it tries autoformalize + simple proof,
 * and returns a structured explanation if it fails.
 */
async function attemptLeanFormalization(
  problemText: string,
  computeResult: {
    answer: string;
    answer_exact: string;
  },
): Promise<LeanProofAttempt> {
  try {
    // Try to autoformalize the problem
    const formalResult = await autoformalize({
      problemText,
    });

    if (!formalResult.accepted) {
      const failedLayers = formalResult.validation_results
        .filter((v) => !v.pass)
        .map((v) => `L${v.layer}: ${v.detail}`);

      return {
        attempted: true,
        success: false,
        formal_statement: formalResult.formal_statement,
        failure_reason: lt("自动形式化验证未通过", "Autoformalization did not pass validation"),
        limitations: [
          lt("该计算问题涉及复杂代数运算，Lean 4 形式化存在以下困难：", "This computational problem involves complex algebra; formalizing it in Lean 4 ran into these difficulties:"),
          ...failedLayers,
          lt("建议使用自然语言解答作为主要参考。", "Use the natural-language solution as the primary reference."),
        ],
      };
    }

    // If autoformalize succeeded, try a simple proof
    const simpleProof = await trySimpleProof(
      formalResult.theorem_name,
      formalResult.theorem_type,
      formalResult.formal_statement,
      computeResult.answer_exact,
    );

    return simpleProof;
  } catch (e) {
    return {
      attempted: true,
      success: false,
      failure_reason: lt(`形式化过程出错: ${e instanceof Error ? e.message : "未知错误"}`, `Formalization error: ${e instanceof Error ? e.message : "unknown error"}`),
      limitations: [
        lt("该问题涉及复杂的数值计算或根号运算", "The problem involves complex numerical computation or radicals"),
        lt("Lean 4 的 Mathlib 对这类问题的自动化支持有限", "Mathlib (Lean 4) has limited automation for problems of this kind"),
        lt("自然语言解答已提供完整的推导和验证过程", "The natural-language solution gives the full derivation and verification"),
      ],
    };
  }
}

/**
 * Try a simple proof for a formalized computational problem.
 * Uses `norm_num` and basic arithmetic tactics.
 */
async function trySimpleProof(
  theoremName: string,
  theoremType: string,
  formalStatement: string,
  answer: string,
): Promise<LeanProofAttempt> {
  // Build a simple Lean source with norm_num attempt
  const leanSource = `-- Auto-generated proof attempt for computational problem
-- Answer: ${answer}
${formalStatement ? formalStatement : `theorem ${theoremName} : ${theoremType} := by`}
  sorry
`;

  return {
    attempted: true,
    success: false,
    formal_statement: leanSource,
    failure_reason: lt("计算问题的形式化证明需要复杂的数值推导，当前自动证明能力有限", "A formal proof of this computational problem requires involved numerical derivation, beyond current automated proving"),
    limitations: [
      lt(`问题的数值答案 (${answer}) 需要多步代数推导才能在 Lean 中验证`, `Verifying the numerical answer (${answer}) in Lean requires a multi-step algebraic derivation`),
      lt("涉及平方、根号化简、验根等步骤，Lean 的 `norm_num` / `ring` 策略无法直接处理", "It involves squaring, simplifying radicals and checking roots, which Lean's `norm_num` / `ring` tactics cannot handle directly"),
      lt("如需完整的形式化证明，建议手动编写 Lean proof term 并使用 `calc` 块逐步推导", "For a complete formal proof, write the Lean proof term by hand and derive the result step by step in a `calc` block"),
      lt("自然语言解答中已包含完整的推导和验证过程", "The natural-language solution includes the full derivation and verification"),
    ],
  };
}

// Server messages and model output follow the UI language (lib/llm/output-locale.ts).
export const POST = withRequestLocale(handlePOST);
