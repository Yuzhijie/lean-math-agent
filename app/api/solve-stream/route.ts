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
import { lt, withRequestLocale } from "@/lib/llm/output-locale";

interface SolveRequest {
  problem_text?: string;
  session_id?: string;
  options?: TheoremPipelineOptions & {
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

  // Get or create session
  let session;
  if (body.session_id) {
    session = await getSessionAsync(body.session_id);
    if (!session) {
      return NextResponse.json({ error: "session not found" }, { status: 404 });
    }
  } else if (body.problem_text?.trim()) {
    session = createSession(body.problem_text.trim());
  } else {
    return NextResponse.json(
      { error: "problem_text or session_id required" },
      { status: 400 },
    );
  }

  const opts = body.options ?? {};
  const useMathlib = opts.use_mathlib ?? true;
  const sess: Session = session;

  // Create a TransformStream for SSE
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(sseFrame(data)));
      };

      // One usage scope per run: LLM calls and Lean verifications are
      // attributed to it and reported as `metrics` in the result frame.
      await withUsageScope(async (metrics) => {
        try {
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
          emit({ type: "result", data: { ...resultData, metrics: m } });
        } catch (e) {
          updateSession(sess.id, { pipeline_stage: "failed", metrics: metrics() });
          await saveSessionToDisk(sess.id);
          const msg = e instanceof LlmError ? e.message : "solve pipeline failed";
          emit({ type: "error", error: msg });
        } finally {
          controller.close();
        }
      });
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
    },
  });

  emit({
    stage: "computing",
    type: "progress",
    detail: lt(`答案: ${computeResult.answer} (≈${computeResult.answer_decimal}) [${computeResult.cross_validated ? "交叉验证通过" : "单一方法"}]`, `Answer: ${computeResult.answer} (≈${computeResult.answer_decimal}) [${computeResult.cross_validated ? "cross-validated" : "single method"}]`),
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

  // Lean attempt
  let leanProofAttempt: LeanProofAttempt;
  if (opts.skip_lean_attempt) {
    leanProofAttempt = { attempted: false, success: false, failure_reason: lt("用户选择跳过 Lean 形式化尝试", "Lean formalization skipped at the user's request") };
  } else {
    updateSession(session.id, { pipeline_stage: "lean_attempting" });
    emit({ stage: "lean_attempting", type: "progress", detail: lt("尝试 Lean 4 形式化证明...", "Attempting a Lean 4 formal proof...") });

    leanProofAttempt = await attemptLeanFormalization(session.problem_text, computeResult);
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

  const leanProofAttempt: LeanProofAttempt = {
    attempted: false,
    success: false,
    failure_reason: lt("组合优化问题的 Lean 形式化需要复杂的归纳论证，当前自动证明能力有限", "Formalizing combinatorial optimization problems in Lean requires intricate inductive arguments, beyond current automated proving"),
  };

  updateSession(session.id, { pipeline_stage: "complete", lean_proof_attempt: leanProofAttempt });
  emit({ stage: "complete", type: "progress", detail: lt(`求解完成 — 最优值: ${answerStr}`, `Solved — optimal value: ${answerStr}`) });

  return {
    session_id: session.id,
    pipeline_events: [],
    problem_type: "optimization",
    nl_solution: nlSolution,
    lean_proof_attempt: leanProofAttempt,
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

// ── Lean Formalization Attempt (shared from solve/route) ────────────────

async function attemptLeanFormalization(
  problemText: string,
  computeResult: { answer: string; answer_exact: string },
): Promise<LeanProofAttempt> {
  try {
    const formalResult = await autoformalize({ problemText });

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

    return {
      attempted: true,
      success: false,
      formal_statement: formalResult.formal_statement,
      failure_reason: lt("计算问题的形式化证明需要复杂的数值推导，当前自动证明能力有限", "A formal proof of this computational problem requires involved numerical derivation, beyond current automated proving"),
      limitations: [
        lt("问题的数值答案需要多步代数推导才能在 Lean 中验证", "Verifying the numerical answer in Lean requires a multi-step algebraic derivation"),
        lt("涉及平方、根号化简、验根等步骤，Lean 的 norm_num / ring 策略无法直接处理", "It involves squaring, simplifying radicals and checking roots, which Lean's norm_num / ring tactics cannot handle directly"),
        lt("自然语言解答中已提供完整的推导和验证过程", "The natural-language solution gives the full derivation and verification"),
      ],
    };
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

// Server messages and model output follow the UI language (lib/llm/output-locale.ts).
export const POST = withRequestLocale(handlePOST);
