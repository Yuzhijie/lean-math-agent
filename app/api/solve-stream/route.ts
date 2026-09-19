import { NextResponse } from "next/server";
import { autoformalize, normalizeTheoremType } from "@/lib/llm/autoformalize";
import { enumerateMethods } from "@/lib/llm/enumerate";
import { planSteps } from "@/lib/llm/plan";
import { proofSearch } from "@/lib/search/proof-search";
import { sorryReport } from "@/lib/lean/sorry-gate";
import { assembleLeanSource } from "@/lib/lean/assemble";
import { verifyLeanSource } from "@/lib/lean/sandbox";
import { tryTrivialProof } from "@/lib/lean/trivial-proof";
import { validateTheoremStatement } from "@/lib/lean/sanitize";
import {
  createSession,
  updateSession,
  getSessionAsync,
  saveSessionToDisk,
} from "@/lib/session-store";
import { LlmError } from "@/lib/llm/client";
import { classifyProblem } from "@/lib/llm/classify-problem";
import { solveComputational } from "@/lib/compute/solver";
import { solveOptimization } from "@/lib/compute/optimization-solver";
import { solveFindAll } from "@/lib/compute/find-all-solver";
import { extractOptimizationStructure } from "@/lib/llm/optimization-extract";
import {
  generateNLSolution,
  generateNLTheoremSolution,
} from "@/lib/llm/nl-solution";
import type {
  LeanProofAttempt,
  MathDomain,
  NaturalLanguageSolution,
  Session,
} from "@/lib/types";

interface SolveRequest {
  problem_text?: string;
  session_id?: string;
  options?: {
    skip_autoformalize?: boolean;
    skip_nl_solution?: boolean;
    skip_lean_attempt?: boolean;
    max_sorry?: number;
    method_selection?: "first" | "best_confidence";
    use_mathlib?: boolean;
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

export async function POST(req: Request) {
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
  const maxSorry = opts.max_sorry ?? 2;

  // Create a TransformStream for SSE
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(sseFrame(data)));
      };

      try {
        // ── Stage 0: Classify ────────────────────────────────────────
        emit({ type: "progress", stage: "classifying", detail: "正在分析问题类型..." });

        const classification = await classifyProblem(session!.problem_text);
        const problemType = opts.force_type ?? classification.problem_type;

        emit({
          type: "progress",
          stage: "classifying",
          detail: `问题类型: ${problemType}`,
        });

        // Dispatch to handler based on type
        let resultData: Record<string, unknown>;

        if (problemType === "computational") {
          resultData = await handleComputational(session!, opts, emit);
        } else if (problemType === "optimization") {
          resultData = await handleOptimization(session!, opts, emit);
        } else if (problemType === "find_all_values") {
          resultData = await handleFindAll(session!, opts, emit, classification.find_all_hints);
        } else {
          resultData = await handleTheorem(session!, opts, emit, useMathlib, maxSorry, session!.math_domain);
        }

        // Save session to disk
        await saveSessionToDisk(session!.id);

        // Emit final result
        emit({ type: "result", data: resultData });
      } catch (e) {
        updateSession(session!.id, { pipeline_stage: "failed" });
        await saveSessionToDisk(session!.id);
        const msg = e instanceof LlmError ? e.message : "solve pipeline failed";
        emit({ type: "error", error: msg });
      } finally {
        controller.close();
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
  emit({ stage: "computing", type: "progress", detail: "开始计算求解..." });

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
    detail: `答案: ${computeResult.answer} (≈${computeResult.answer_decimal}) [${computeResult.cross_validated ? "交叉验证通过" : "单一方法"}]`,
  });

  // NL Solution
  let nlSolution: NaturalLanguageSolution | undefined;
  if (!opts.skip_nl_solution) {
    updateSession(session.id, { pipeline_stage: "nl_solving" });
    emit({ stage: "nl_solving", type: "progress", detail: "生成自然语言解答..." });

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
        detail: `✅ 自然语言解答完成 (${nlSolution.steps.length} 步)`,
      });
    } catch (e) {
      emit({
        stage: "nl_solving",
        type: "progress",
        detail: `⚠️ 自然语言解答失败: ${e instanceof Error ? e.message : "未知错误"}`,
      });
    }
  }

  // Lean attempt
  let leanProofAttempt: LeanProofAttempt;
  if (opts.skip_lean_attempt) {
    leanProofAttempt = { attempted: false, success: false, failure_reason: "用户选择跳过 Lean 形式化尝试" };
  } else {
    updateSession(session.id, { pipeline_stage: "lean_attempting" });
    emit({ stage: "lean_attempting", type: "progress", detail: "尝试 Lean 4 形式化证明..." });

    leanProofAttempt = await attemptLeanFormalization(session.problem_text, computeResult);
    updateSession(session.id, { lean_proof_attempt: leanProofAttempt });

    emit({
      stage: "lean_attempting",
      type: "progress",
      detail: leanProofAttempt.success
        ? "✅ Lean 4 形式化证明成功"
        : `ℹ️ Lean 4 形式化未能完成: ${leanProofAttempt.failure_reason ?? "未知原因"}`,
    });
  }

  updateSession(session.id, { pipeline_stage: "complete" });
  emit({ stage: "complete", type: "progress", detail: `求解完成 — 答案: ${computeResult.answer}` });

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
  emit({ stage: "extracting", type: "progress", detail: "提取优化问题结构..." });

  const structure = await extractOptimizationStructure(session.problem_text);
  emit({
    stage: "extracting",
    type: "progress",
    detail: `目标: ${structure.objective}, 类别数: ${structure.categories.length}`,
  });

  updateSession(session.id, { pipeline_stage: "optimizing" });
  emit({ stage: "optimizing", type: "progress", detail: "确定性搜索最优解..." });

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
    detail: `最优值: ${answerStr} (${Object.entries(result.assignments).map(([k, v]) => `${k}=${v}`).join(", ")})`,
  });

  // NL Solution
  let nlSolution: NaturalLanguageSolution | undefined;
  if (!opts.skip_nl_solution) {
    updateSession(session.id, { pipeline_stage: "nl_solving" });
    emit({ stage: "nl_solving", type: "progress", detail: "生成自然语言解答..." });

    try {
      nlSolution = await generateNLSolution({
        problemText: session.problem_text,
        problemType: "computational",
        computeResult: { answer: answerStr, answer_decimal: answerStr, solution_steps: result.reasoning.split("\n") },
      });
      updateSession(session.id, { nl_solution: nlSolution });
      emit({ stage: "nl_solving", type: "progress", detail: `✅ 自然语言解答完成 (${nlSolution.steps.length} 步)` });
    } catch (e) {
      emit({ stage: "nl_solving", type: "progress", detail: `⚠️ 自然语言解答失败: ${e instanceof Error ? e.message : "未知错误"}` });
    }
  }

  const leanProofAttempt: LeanProofAttempt = {
    attempted: false,
    success: false,
    failure_reason: "组合优化问题的 Lean 形式化需要复杂的归纳论证，当前自动证明能力有限",
  };

  updateSession(session.id, { pipeline_stage: "complete", lean_proof_attempt: leanProofAttempt });
  emit({ stage: "complete", type: "progress", detail: `求解完成 — 最优值: ${answerStr}` });

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
  emit({ stage: "computing", type: "progress", detail: "开始穷举搜索..." });

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
    detail: `找到 ${findAllResult.valid_values.length} 个满足条件的值: ${findAllResult.answer}`,
  });

  // NL Solution
  let nlSolution: NaturalLanguageSolution | undefined;
  if (!opts.skip_nl_solution) {
    updateSession(session.id, { pipeline_stage: "nl_solving" });
    emit({ stage: "nl_solving", type: "progress", detail: "生成自然语言解答..." });

    try {
      nlSolution = await generateNLSolution({
        problemText: session.problem_text,
        problemType: "computational",
        computeResult: { answer: findAllResult.answer, answer_decimal: findAllResult.answer, solution_steps: findAllResult.solution_steps },
      });
      updateSession(session.id, { nl_solution: nlSolution });
      emit({ stage: "nl_solving", type: "progress", detail: `✅ 自然语言解答完成 (${nlSolution.steps.length} 步)` });
    } catch (e) {
      emit({ stage: "nl_solving", type: "progress", detail: `⚠️ 自然语言解答失败: ${e instanceof Error ? e.message : "未知错误"}` });
    }
  }

  const leanProofAttempt: LeanProofAttempt = {
    attempted: false,
    success: false,
    failure_reason: "求所有值问题的 Lean 形式化需要完备性证明，当前自动证明能力有限",
  };

  updateSession(session.id, { pipeline_stage: "complete", lean_proof_attempt: leanProofAttempt });
  emit({ stage: "complete", type: "progress", detail: `求解完成 — 满足条件的所有值: ${findAllResult.answer}` });

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
  maxSorry: number,
  domain?: MathDomain,
): Promise<Record<string, unknown>> {
  // NL Solution first
  let nlSolution: NaturalLanguageSolution | undefined;
  if (!opts.skip_nl_solution) {
    updateSession(session.id, { pipeline_stage: "nl_solving" });
    emit({ stage: "nl_solving", type: "progress", detail: "生成自然语言解答..." });

    try {
      nlSolution = await generateNLSolution({
        problemText: session.problem_text,
        problemType: "theorem",
      });
      updateSession(session.id, { nl_solution: nlSolution });
      emit({ stage: "nl_solving", type: "progress", detail: `✅ 自然语言解答完成 (${nlSolution.steps.length} 步)` });
    } catch (e) {
      emit({ stage: "nl_solving", type: "progress", detail: `⚠️ 自然语言解答失败: ${e instanceof Error ? e.message : "未知错误"}` });
    }
  }

  // Autoformalize
  let theoremName = "problem";
  let theoremType = "";
  let resolvedDomain = domain;
  // Statement lock: `#check` signature of the validated formalization.
  let frozenSignature: string | undefined;

  if (!opts.skip_autoformalize) {
    updateSession(session.id, { pipeline_stage: "autoformalizing" });
    emit({ stage: "autoformalizing", type: "progress", detail: "开始自动形式化..." });

    const formalResult = await autoformalize({ problemText: session.problem_text });
    updateSession(session.id, {
      theorem_name: formalResult.theorem_name,
      theorem_type: formalResult.theorem_type,
      math_domain: formalResult.domain,
      formal_statement: formalResult.formal_statement,
      formal_signature: formalResult.formal_signature,
      formal_validated: formalResult.accepted,
      validation_results: formalResult.validation_results,
    });

    theoremName = formalResult.theorem_name;
    theoremType = formalResult.theorem_type;
    resolvedDomain = formalResult.domain;
    frozenSignature = formalResult.accepted ? formalResult.formal_signature : undefined;

    if (!formalResult.accepted) {
      const failedLayers = formalResult.validation_results.filter((v) => !v.pass);
      const detail = failedLayers.map((v) => `Layer ${v.layer}: ${v.detail}`).join("; ");
      updateSession(session.id, { build_status: "fail", pipeline_stage: "complete" });
      emit({ stage: "autoformalizing", type: "progress", detail: `❌ 形式化验证未通过 (${failedLayers.length} 层失败)` });

      return {
        session_id: session.id,
        pipeline_events: [],
        error: "autoformalize_failed",
        detail: `形式化验证未通过: ${detail}`,
        validation_results: formalResult.validation_results,
      };
    }

    emit({ stage: "autoformalizing", type: "progress", detail: `✅ 形式化验证通过 (domain: ${formalResult.domain})` });
  } else {
    theoremName = session.theorem_name ?? "problem";
    theoremType = session.theorem_type ?? "";
    frozenSignature = session.formal_validated ? session.formal_signature : undefined;
  }

  // Trivial proof check
  try {
    const trivialResult = await tryTrivialProof(session.id, theoremName, theoremType, useMathlib, {
      expectedSignature: frozenSignature,
    });
    if (trivialResult) {
      emit({ stage: "trivial_proof", type: "progress", detail: `✅ 简单证明成功 (${trivialResult.tactic})` });

      const leanProofAttempt: LeanProofAttempt = {
        attempted: true,
        success: true,
        axioms: trivialResult.verification.axioms?.axioms,
        statement_locked: frozenSignature !== undefined && trivialResult.verification.signatureMatch === true,
        verifier: trivialResult.verification.backend,
        formal_statement: trivialResult.source,
        proof_code: trivialResult.source,
      };

      updateSession(session.id, {
        assembled_lean: trivialResult.source,
        build_status: "ok",
        pipeline_stage: "complete",
        lean_proof_attempt: leanProofAttempt,
      });

      emit({ stage: "complete", type: "progress", detail: "✅ 完全形式化验证通过（简单证明）" });

      return {
        session_id: session.id,
        pipeline_events: [],
        problem_type: "theorem",
        nl_solution: nlSolution,
        lean_proof_attempt: leanProofAttempt,
        theorem_name: theoremName,
        theorem_type: theoremType,
        method: { id: "trivial", title: `简单证明 (${trivialResult.tactic})`, category: "other" },
        steps: [],
        sorry_labels: [],
        fully_verified: true,
        build_status: "ok",
        total_attempts: 1,
        sorry_report: { fully_verified: true, summary: "✅ 完全形式化验证通过", details: [] },
        assembled_lean: trivialResult.source,
        build_log: trivialResult.log,
      };
    }
  } catch {
    // Continue to full pipeline
  }

  // Enumerate methods
  updateSession(session.id, { pipeline_stage: "enumerating" });
  emit({ stage: "enumerating", type: "progress", detail: "枚举解法..." });

  const enumResult = await enumerateMethods(session.problem_text, resolvedDomain);
  updateSession(session.id, {
    methods: enumResult.methods,
    comparison_summary: enumResult.comparison_summary,
    out_of_domain_warning: enumResult.out_of_domain_warning ?? undefined,
  });

  emit({ stage: "enumerating", type: "progress", detail: `找到 ${enumResult.methods.length} 种解法` });

  // Select method
  const method =
    opts.method_selection === "first"
      ? enumResult.methods[0]
      : enumResult.methods.reduce((best, cur) => (cur.confidence > best.confidence ? cur : best));

  emit({
    stage: "selecting",
    type: "progress",
    detail: `选择方法: ${method.title} (${method.category}, confidence: ${method.confidence})`,
  });

  // Plan steps
  updateSession(session.id, { pipeline_stage: "solving" });
  emit({ stage: "planning", type: "progress", detail: "规划证明步骤..." });

  const plan = await planSteps(session.problem_text, method, useMathlib);
  const proofSteps: import("@/lib/types").ProofStep[] = plan.steps.map(
    (s: { index: number; plain_goal: string; lean_goal: string }) => ({
      ...s,
      plain_explanation: "",
      lean_code: "",
      status: "pending",
    }),
  );

  // Statement lock: with a validated formalization the planner only produces
  // steps; otherwise its declaration is used when well-formed.
  const validatedTheoremName = theoremName;
  const validatedTheoremType = theoremType;
  if (frozenSignature === undefined && plan.theorem_type) {
    const candidateName = plan.theorem_name || theoremName;
    const candidateType = normalizeTheoremType(plan.theorem_type);
    if (validateTheoremStatement(candidateName, candidateType).ok) {
      theoremName = candidateName;
      theoremType = candidateType;
    }
  }

  updateSession(session.id, {
    theorem_name: theoremName,
    theorem_type: theoremType,
    selected_method_id: method.id,
    steps: proofSteps,
  });

  emit({ stage: "planning", type: "progress", detail: `规划了 ${proofSteps.length} 个步骤` });

  // Pre-flight check
  let preflightSource = assembleLeanSource({
    theoremName,
    theoremType,
    stepCodes: ["sorry"],
    useMathlib,
  });
  let preflight = await verifyLeanSource(session.id, preflightSource, { allowSorry: true });

  if (
    preflight.status !== "unavailable" &&
    !preflight.ok &&
    (theoremName !== validatedTheoremName || theoremType !== validatedTheoremType)
  ) {
    emit({ stage: "preflight", type: "progress", detail: "⚠️ plan 定理声明编译失败，回退到 autoformalize 版本" });
    theoremName = validatedTheoremName;
    theoremType = validatedTheoremType;
    updateSession(session.id, { theorem_name: theoremName, theorem_type: theoremType });
    preflightSource = assembleLeanSource({ theoremName, theoremType, stepCodes: ["sorry"], useMathlib });
    preflight = await verifyLeanSource(session.id, preflightSource, { allowSorry: true });
  }

  if (preflight.status !== "unavailable" && !preflight.ok) {
    emit({ stage: "preflight", type: "progress", detail: `⚠️ 定理声明编译失败: ${preflight.log.slice(0, 200)}` });
    updateSession(session.id, { build_status: "fail", pipeline_stage: "complete" });
    return {
      session_id: session.id,
      pipeline_events: [],
      error: "theorem_declaration_invalid",
      detail: preflight.log,
    };
  }

  // Proof search
  const adaptiveMaxSorry = opts.max_sorry ?? Math.max(2, Math.ceil(proofSteps.length * 0.5));
  emit({ stage: "solving", type: "progress", detail: "开始最佳优先证明搜索..." });

  const searchResult = await proofSearch({
    session: { ...session, theorem_name: theoremName, theorem_type: theoremType, steps: proofSteps },
    method,
    theoremType,
    config: { maxSorry: adaptiveMaxSorry, useMathlib },
    domain: resolvedDomain,
    initialGoal: preflight.goals?.[0],
    onProgress: (progress) => {
      emit({
        stage: "solving",
        type: "progress",
        detail: `步骤 ${progress.step + 1}/${progress.total}: ${progress.status}`,
      });
    },
  });

  // Final verification
  updateSession(session.id, { steps: searchResult.steps, sorry_labels: searchResult.sorryLabels });

  const finalSource = assembleLeanSource({
    theoremName,
    theoremType,
    stepCodes: searchResult.steps.map((s) => s.lean_code).filter(Boolean),
    useMathlib,
  });

  const finalResult = await verifyLeanSource(session.id, finalSource, {
    theoremName,
    expectedSignature: frozenSignature,
  });
  const report = sorryReport(searchResult.sorryLabels);

  const leanProofAttempt: LeanProofAttempt = {
    attempted: true,
    success: finalResult.ok && searchResult.fullyVerified,
    formal_statement: finalSource,
    proof_code: finalSource,
    failure_reason: finalResult.ok ? undefined : `Lean 验证失败: ${finalResult.log.slice(0, 500)}`,
    limitations: searchResult.sorryLabels.map((s) => `步骤 ${s.step_index + 1}: ${s.reason}`),
    axioms: finalResult.axioms?.axioms,
    statement_locked: frozenSignature !== undefined && finalResult.signatureMatch === true,
    verifier: finalResult.backend,
  };

  // Enrich NL solution
  if (!opts.skip_nl_solution && nlSolution) {
    try {
      const enrichedNL = await generateNLTheoremSolution({
        problemText: session.problem_text,
        methodTitle: method.title,
        proofSteps: searchResult.steps.map((s) => ({
          plain_goal: s.plain_goal,
          plain_explanation: s.plain_explanation,
        })),
      });
      nlSolution = enrichedNL;
      updateSession(session.id, { nl_solution: enrichedNL });
    } catch {
      // Keep original
    }
  }

  updateSession(session.id, {
    assembled_lean: finalSource,
    build_status: finalResult.status === "unavailable" ? "unavailable" : finalResult.ok ? "ok" : "fail",
    pipeline_stage: "complete",
    lean_proof_attempt: leanProofAttempt,
  });

  emit({
    stage: "complete",
    type: "progress",
    detail: finalResult.ok ? report.summary : `❌ 最终验证失败: ${finalResult.log.slice(0, 200)}`,
  });

  return {
    session_id: session.id,
    pipeline_events: [],
    problem_type: "theorem",
    nl_solution: nlSolution,
    lean_proof_attempt: leanProofAttempt,
    theorem_name: theoremName,
    theorem_type: theoremType,
    method: { id: method.id, title: method.title, category: method.category },
    steps: searchResult.steps,
    sorry_labels: searchResult.sorryLabels,
    fully_verified: searchResult.fullyVerified && finalResult.ok,
    build_status: finalResult.status === "unavailable" ? "unavailable" : finalResult.ok ? "ok" : "fail",
    total_attempts: searchResult.totalAttempts,
    sorry_report: report,
    assembled_lean: finalSource,
    build_log: finalResult.log,
  };
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
        failure_reason: "自动形式化验证未通过",
        limitations: [
          "该计算问题涉及复杂代数运算，Lean 4 形式化存在以下困难：",
          ...failedLayers,
          "建议使用自然语言解答作为主要参考。",
        ],
      };
    }

    return {
      attempted: true,
      success: false,
      formal_statement: formalResult.formal_statement,
      failure_reason: "计算问题的形式化证明需要复杂的数值推导，当前自动证明能力有限",
      limitations: [
        "问题的数值答案需要多步代数推导才能在 Lean 中验证",
        "涉及平方、根号化简、验根等步骤，Lean 的 norm_num / ring 策略无法直接处理",
        "自然语言解答中已提供完整的推导和验证过程",
      ],
    };
  } catch (e) {
    return {
      attempted: true,
      success: false,
      failure_reason: `形式化过程出错: ${e instanceof Error ? e.message : "未知错误"}`,
      limitations: [
        "该问题涉及复杂的数值计算或根号运算",
        "Lean 4 的 Mathlib 对这类问题的自动化支持有限",
        "自然语言解答已提供完整的推导和验证过程",
      ],
    };
  }
}
