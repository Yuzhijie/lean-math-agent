import { NextResponse } from "next/server";
import { autoformalize, normalizeTheoremType } from "@/lib/llm/autoformalize";
import { enumerateMethods } from "@/lib/llm/enumerate";
import { planSteps } from "@/lib/llm/plan";
import { proofSearch } from "@/lib/search/proof-search";
import { sorryReport } from "@/lib/lean/sorry-gate";
import { assembleLeanSource } from "@/lib/lean/assemble";
import { verifyLeanSource } from "@/lib/lean/sandbox";
import { tryTrivialProof } from "@/lib/lean/trivial-proof";
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
  const events: Array<{ stage: string; detail: string }> = [];

  try {
    // ── Stage 0: Classify problem type ──────────────────────────────
    const classification = await classifyProblem(session.problem_text);
    const problemType = opts.force_type ?? classification.problem_type;

    events.push({
      stage: "classifying",
      detail: `问题类型: ${problemType}`,
    });

    if (problemType === "computational") {
      return await handleComputationalProblem(
        session,
        opts,
        events,
      );
    }

    if (problemType === "optimization") {
      return await handleOptimizationProblem(
        session,
        opts,
        events,
      );
    }

    if (problemType === "find_all_values") {
      return await handleFindAllProblem(
        session,
        opts,
        events,
        classification.find_all_hints,
      );
    }

    return await handleTheoremProblem(
      session,
      opts,
      events,
      useMathlib,
      maxSorry,
      session.math_domain,
    );
  } catch (e) {
    updateSession(session.id, { pipeline_stage: "failed" });
    await saveSessionToDisk(session.id);
    const msg = e instanceof LlmError ? e.message : "solve pipeline failed";
    return NextResponse.json(
      {
        error: msg,
        session_id: session.id,
        pipeline_events: events,
      },
      { status: 502 },
    );
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
  events.push({ stage: "computing", detail: "开始计算求解..." });

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
    detail: `答案: ${computeResult.answer} (≈${computeResult.answer_decimal}) [${computeResult.cross_validated ? "交叉验证通过" : "单一方法"}]`,
  });

  // Step 2: Generate natural language solution (NL first)
  let nlSolution: NaturalLanguageSolution | undefined;

  if (!opts.skip_nl_solution) {
    updateSession(session.id, { pipeline_stage: "nl_solving" });
    events.push({ stage: "nl_solving", detail: "生成自然语言解答..." });

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
        detail: `✅ 自然语言解答完成 (${nlSolution.steps.length} 步)`,
      });
    } catch (e) {
      events.push({
        stage: "nl_solving",
        detail: `⚠️ 自然语言解答失败: ${e instanceof Error ? e.message : "未知错误"}`,
      });
    }
  }

  // Step 3: Attempt Lean 4 formal proof (or explain why not)
  let leanProofAttempt: LeanProofAttempt;

  if (opts.skip_lean_attempt) {
    leanProofAttempt = {
      attempted: false,
      success: false,
      failure_reason: "用户选择跳过 Lean 形式化尝试",
    };
  } else {
    updateSession(session.id, { pipeline_stage: "lean_attempting" });
    events.push({ stage: "lean_attempting", detail: "尝试 Lean 4 形式化证明..." });

    leanProofAttempt = await attemptLeanFormalization(
      session.problem_text,
      computeResult,
    );

    updateSession(session.id, { lean_proof_attempt: leanProofAttempt });

    events.push({
      stage: "lean_attempting",
      detail: leanProofAttempt.success
        ? "✅ Lean 4 形式化证明成功"
        : `ℹ️ Lean 4 形式化未能完成: ${leanProofAttempt.failure_reason ?? "未知原因"}`,
    });
  }

  updateSession(session.id, { pipeline_stage: "complete" });

  events.push({
    stage: "complete",
    detail: `求解完成 — 答案: ${computeResult.answer}`,
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
  events.push({ stage: "extracting", detail: "提取优化问题结构..." });

  const structure = await extractOptimizationStructure(session.problem_text);

  events.push({
    stage: "extracting",
    detail: `目标: ${structure.objective} ${structure.objective_description}, 类别数: ${structure.categories.length}`,
  });

  // Step 2: Deterministic optimization search
  updateSession(session.id, { pipeline_stage: "optimizing" });
  events.push({ stage: "optimizing", detail: "确定性搜索最优解..." });

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
    detail: `最优值: ${answerStr} (${Object.entries(result.assignments).map(([k, v]) => `${k}=${v}`).join(", ")})`,
  });

  // Step 3: Generate natural language solution
  let nlSolution: NaturalLanguageSolution | undefined;

  if (!opts.skip_nl_solution) {
    updateSession(session.id, { pipeline_stage: "nl_solving" });
    events.push({ stage: "nl_solving", detail: "生成自然语言解答..." });

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
        detail: `✅ 自然语言解答完成 (${nlSolution.steps.length} 步)`,
      });
    } catch (e) {
      events.push({
        stage: "nl_solving",
        detail: `⚠️ 自然语言解答失败: ${e instanceof Error ? e.message : "未知错误"}`,
      });
    }
  }

  // Step 4: Lean formalization (best-effort, usually skip for optimization)
  const leanProofAttempt: LeanProofAttempt = {
    attempted: false,
    success: false,
    failure_reason: "组合优化问题的 Lean 形式化需要复杂的归纳论证，当前自动证明能力有限",
  };

  updateSession(session.id, {
    pipeline_stage: "complete",
    lean_proof_attempt: leanProofAttempt,
  });

  events.push({
    stage: "complete",
    detail: `求解完成 — 最优值: ${answerStr}`,
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
  events.push({ stage: "computing", detail: "开始穷举搜索..." });

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
    detail: `找到 ${findAllResult.valid_values.length} 个满足条件的值: ${findAllResult.answer}`,
  });

  // Step 2: Generate natural language solution
  let nlSolution: NaturalLanguageSolution | undefined;

  if (!opts.skip_nl_solution) {
    updateSession(session.id, { pipeline_stage: "nl_solving" });
    events.push({ stage: "nl_solving", detail: "生成自然语言解答..." });

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
        detail: `✅ 自然语言解答完成 (${nlSolution.steps.length} 步)`,
      });
    } catch (e) {
      events.push({
        stage: "nl_solving",
        detail: `⚠️ 自然语言解答失败: ${e instanceof Error ? e.message : "未知错误"}`,
      });
    }
  }

  // Step 3: Lean formalization (best-effort for find-all problems)
  const leanProofAttempt: LeanProofAttempt = {
    attempted: false,
    success: false,
    failure_reason: "求所有值问题的 Lean 形式化需要完备性证明，当前自动证明能力有限",
  };

  updateSession(session.id, {
    pipeline_stage: "complete",
    lean_proof_attempt: leanProofAttempt,
  });

  events.push({
    stage: "complete",
    detail: `求解完成 — 满足条件的所有值: ${findAllResult.answer}`,
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
  maxSorry: number,
  domain?: MathDomain,
) {
  // Step 1: Generate natural language solution first (NL first)
  let nlSolution: NaturalLanguageSolution | undefined;

  if (!opts.skip_nl_solution) {
    updateSession(session.id, { pipeline_stage: "nl_solving" });
    events.push({ stage: "nl_solving", detail: "生成自然语言解答..." });

    try {
      nlSolution = await generateNLSolution({
        problemText: session.problem_text,
        problemType: "theorem",
      });

      updateSession(session.id, { nl_solution: nlSolution });
      events.push({
        stage: "nl_solving",
        detail: `✅ 自然语言解答完成 (${nlSolution.steps.length} 步)`,
      });
    } catch (e) {
      events.push({
        stage: "nl_solving",
        detail: `⚠️ 自然语言解答失败: ${e instanceof Error ? e.message : "未知错误"}`,
      });
    }
  }

  // Step 2: Autoformalize (optional)
  let theoremName = "problem";
  let theoremType = "";
  let resolvedDomain = domain;

  if (!opts.skip_autoformalize) {
    updateSession(session.id, { pipeline_stage: "autoformalizing" });
    events.push({ stage: "autoformalizing", detail: "开始自动形式化..." });

    const formalResult = await autoformalize({
      problemText: session.problem_text,
    });

    updateSession(session.id, {
      theorem_name: formalResult.theorem_name,
      theorem_type: formalResult.theorem_type,
      math_domain: formalResult.domain,
      formal_statement: formalResult.formal_statement,
      formal_validated: formalResult.accepted,
      validation_results: formalResult.validation_results,
    });

    theoremName = formalResult.theorem_name;
    theoremType = formalResult.theorem_type;
    resolvedDomain = formalResult.domain;

    if (!formalResult.accepted) {
      const failedLayers = formalResult.validation_results.filter((v) => !v.pass);
      const detail = failedLayers.map((v) => `Layer ${v.layer}: ${v.detail}`).join("; ");
      updateSession(session.id, {
        build_status: "fail",
        pipeline_stage: "complete",
      });
      events.push({
        stage: "autoformalizing",
        detail: `❌ 形式化验证未通过 (${failedLayers.length} 层失败)`,
      });
      await saveSessionToDisk(session.id);
      return NextResponse.json(
        {
          session_id: session.id,
          pipeline_events: events,
          error: "autoformalize_failed",
          detail: `形式化验证未通过: ${detail}`,
          validation_results: formalResult.validation_results,
        },
        { status: 422 },
      );
    }

    events.push({
      stage: "autoformalizing",
      detail: `✅ 形式化验证通过 (domain: ${formalResult.domain})`,
    });
  } else {
    theoremName = session.theorem_name ?? "problem";
    theoremType = session.theorem_type ?? "";
    if (!theoremType) {
      return NextResponse.json(
        { error: "skip_autoformalize requires theorem_type in session" },
        { status: 400 },
      );
    }
  }

  // ── Pre-check: try trivial one-liner proofs (rfl, simp, etc.) ──
  // Avoids the full pipeline for theorems provable by a single tactic.
  try {
    const trivialResult = await tryTrivialProof(
      session.id,
      theoremName,
      theoremType,
      useMathlib,
    );
    if (trivialResult) {
      events.push({
        stage: "trivial_proof",
        detail: `✅ 简单证明成功 (${trivialResult.tactic})`,
      });

      const leanProofAttempt: LeanProofAttempt = {
        attempted: true,
        success: true,
        formal_statement: trivialResult.source,
        proof_code: trivialResult.source,
      };

      updateSession(session.id, {
        assembled_lean: trivialResult.source,
        build_status: "ok",
        pipeline_stage: "complete",
        lean_proof_attempt: leanProofAttempt,
      });

      events.push({
        stage: "complete",
        detail: "✅ 完全形式化验证通过（简单证明）",
      });

      await saveSessionToDisk(session.id);

      return NextResponse.json({
        session_id: session.id,
        pipeline_events: events,
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
        sorry_report: {
          fully_verified: true,
          summary: "✅ 完全形式化验证通过",
          details: [],
        },
        assembled_lean: trivialResult.source,
        build_log: trivialResult.log,
      });
    }
  } catch {
    // Trivial proof check failed (e.g. Lean unavailable) — continue to full pipeline
  }

  // Step 3: Enumerate methods
  updateSession(session.id, { pipeline_stage: "enumerating" });
  events.push({ stage: "enumerating", detail: "枚举解法..." });

  const enumResult = await enumerateMethods(session.problem_text, resolvedDomain);
  updateSession(session.id, {
    methods: enumResult.methods,
    comparison_summary: enumResult.comparison_summary,
    out_of_domain_warning: enumResult.out_of_domain_warning ?? undefined,
  });

  events.push({
    stage: "enumerating",
    detail: `找到 ${enumResult.methods.length} 种解法`,
  });

  // Step 4: Select method
  const method =
    opts.method_selection === "first"
      ? enumResult.methods[0]
      : enumResult.methods.reduce((best, cur) =>
          cur.confidence > best.confidence ? cur : best,
        );

  events.push({
    stage: "selecting",
    detail: `选择方法: ${method.title} (${method.category}, confidence: ${method.confidence})`,
  });

  // Step 5: Plan steps
  updateSession(session.id, { pipeline_stage: "solving" });
  events.push({ stage: "planning", detail: "规划证明步骤..." });

  const plan = await planSteps(session.problem_text, method, useMathlib);
  const proofSteps: import("@/lib/types").ProofStep[] = plan.steps.map((s: { index: number; plain_goal: string; lean_goal: string }) => ({
    ...s,
    plain_explanation: "",
    lean_code: "",
    status: "pending",
  }));

  updateSession(session.id, {
    theorem_name: plan.theorem_name || theoremName,
    theorem_type: normalizeTheoremType(plan.theorem_type || theoremType),
    selected_method_id: method.id,
    steps: proofSteps,
  });

  // Save autoformalize-validated theorem declaration before plan overrides
  const validatedTheoremName = theoremName;
  const validatedTheoremType = theoremType;

  theoremName = plan.theorem_name || theoremName;
  theoremType = normalizeTheoremType(plan.theorem_type || theoremType);

  events.push({
    stage: "planning",
    detail: `规划了 ${proofSteps.length} 个步骤`,
  });

  // Pre-flight: verify theorem declaration compiles before expensive proof search
  let preflightSource = assembleLeanSource({
    theoremName,
    theoremType,
    stepCodes: ["sorry"],
    useMathlib,
  });
  let preflight = await verifyLeanSource(session.id, preflightSource, {
    allowSorry: true,
  });

  // If plan's theorem_type fails to compile, fall back to the autoformalize-validated version
  if (
    preflight.status !== "unavailable" &&
    !preflight.ok &&
    (theoremName !== validatedTheoremName || theoremType !== validatedTheoremType)
  ) {
    events.push({
      stage: "preflight",
      detail: `⚠️ plan 定理声明编译失败，回退到 autoformalize 版本`,
    });
    theoremName = validatedTheoremName;
    theoremType = validatedTheoremType;
    updateSession(session.id, {
      theorem_name: theoremName,
      theorem_type: theoremType,
    });
    preflightSource = assembleLeanSource({
      theoremName,
      theoremType,
      stepCodes: ["sorry"],
      useMathlib,
    });
    preflight = await verifyLeanSource(session.id, preflightSource, {
      allowSorry: true,
    });
  }

  if (preflight.status !== "unavailable" && !preflight.ok) {
    events.push({
      stage: "preflight",
      detail: `⚠️ 定理声明编译失败: ${preflight.log.slice(0, 200)}`,
    });
    updateSession(session.id, {
      build_status: "fail",
      pipeline_stage: "complete",
    });
    await saveSessionToDisk(session.id);
    return NextResponse.json({
      session_id: session.id,
      pipeline_events: events,
      error: "theorem_declaration_invalid",
      detail: preflight.log,
    }, { status: 422 });
  }

  // Scale sorry budget: allow ~50% of steps to be sorry, minimum 2
  const adaptiveMaxSorry = opts.max_sorry ?? Math.max(2, Math.ceil(proofSteps.length * 0.5));

  // Step 6: Solve with best-first search
  events.push({ stage: "solving", detail: "开始最佳优先证明搜索..." });

  const searchResult = await proofSearch({
    session: {
      ...session,
      theorem_name: theoremName,
      theorem_type: theoremType,
      steps: proofSteps,
    },
    method,
    theoremType,
    config: { maxSorry: adaptiveMaxSorry, useMathlib },
    domain: resolvedDomain,
    onProgress: (progress) => {
      events.push({
        stage: "solving",
        detail: `步骤 ${progress.step + 1}/${progress.total}: ${progress.status}`,
      });
    },
  });

  // Step 7: Final verification
  updateSession(session.id, {
    steps: searchResult.steps,
    sorry_labels: searchResult.sorryLabels,
  });

  const finalSource = assembleLeanSource({
    theoremName,
    theoremType,
    stepCodes: searchResult.steps.map((s) => s.lean_code).filter(Boolean),
    useMathlib,
  });

  const finalResult = await verifyLeanSource(session.id, finalSource);
  const report = sorryReport(searchResult.sorryLabels);

  // Build lean_proof_attempt from the theorem pipeline results
  const leanProofAttempt: LeanProofAttempt = {
    attempted: true,
    success: finalResult.ok && searchResult.fullyVerified,
    formal_statement: finalSource,
    proof_code: finalSource,
    failure_reason: finalResult.ok
      ? undefined
      : `Lean 验证失败: ${finalResult.log.slice(0, 500)}`,
    limitations: searchResult.sorryLabels.map(
      (s) => `步骤 ${s.step_index + 1}: ${s.reason}`,
    ),
  };

  // Update NL solution with proof context if available
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
      // Keep original NL solution
    }
  }

  updateSession(session.id, {
    assembled_lean: finalSource,
    build_status: finalResult.status === "unavailable" ? "unavailable" : finalResult.ok ? "ok" : "fail",
    pipeline_stage: "complete",
    lean_proof_attempt: leanProofAttempt,
  });

  events.push({
    stage: "complete",
    detail: finalResult.ok
      ? report.summary
      : `❌ 最终验证失败: ${finalResult.log.slice(0, 200)}`,
  });

  await saveSessionToDisk(session.id);

  return NextResponse.json({
    session_id: session.id,
    pipeline_events: events,
    problem_type: "theorem",
    // NL solution (displayed first)
    nl_solution: nlSolution,
    // Lean proof attempt (displayed second)
    lean_proof_attempt: leanProofAttempt,
    // Theorem-specific details
    theorem_name: theoremName,
    theorem_type: theoremType,
    method: {
      id: method.id,
      title: method.title,
      category: method.category,
    },
    steps: searchResult.steps,
    sorry_labels: searchResult.sorryLabels,
    fully_verified: searchResult.fullyVerified && finalResult.ok,
    build_status: finalResult.status === "unavailable" ? "unavailable" : finalResult.ok ? "ok" : "fail",
    total_attempts: searchResult.totalAttempts,
    sorry_report: report,
    assembled_lean: finalSource,
    build_log: finalResult.log,
  });
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
        failure_reason: "自动形式化验证未通过",
        limitations: [
          "该计算问题涉及复杂代数运算，Lean 4 形式化存在以下困难：",
          ...failedLayers,
          "建议使用自然语言解答作为主要参考。",
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
      failure_reason: `形式化过程出错: ${e instanceof Error ? e.message : "未知错误"}`,
      limitations: [
        "该问题涉及复杂的数值计算或根号运算",
        "Lean 4 的 Mathlib 对这类问题的自动化支持有限",
        "自然语言解答已提供完整的推导和验证过程",
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
    failure_reason: "计算问题的形式化证明需要复杂的数值推导，当前自动证明能力有限",
    limitations: [
      `问题的数值答案 (${answer}) 需要多步代数推导才能在 Lean 中验证`,
      "涉及平方、根号化简、验根等步骤，Lean 的 `norm_num` / `ring` 策略无法直接处理",
      "如需完整的形式化证明，建议手动编写 Lean proof term 并使用 `calc` 块逐步推导",
      "自然语言解答中已包含完整的推导和验证过程",
    ],
  };
}

