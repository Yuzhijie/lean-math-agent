/**
 * Theorem pipeline shared by `/api/solve` and `/api/solve-stream`.
 *
 *   NL solution → autoformalize (statement lock) → trivial one-liners
 *   → whole-proof prover loop (sample k, verify, repair with Lean feedback)
 *   → [multi-agent] method enumeration → plan → preflight
 *   → best-first stepwise search → final verification
 *
 * The routes only differ in how they report progress (collected events vs
 * SSE frames) and how they wrap the outcome, so both call
 * `runTheoremPipeline` with an `onEvent` callback and get back a status
 * code plus a JSON body.
 */
import { runMultiAgentEvaluation } from "../agents/orchestrator";
import { assembleLeanSource } from "../lean/assemble";
import { verifyLeanSource } from "../lean/sandbox";
import { validateTheoremStatement } from "../lean/sanitize";
import { sorryReport } from "../lean/sorry-gate";
import { tryTrivialProof } from "../lean/trivial-proof";
import { autoformalize, normalizeTheoremType } from "../llm/autoformalize";
import { enumerateMethods } from "../llm/enumerate";
import { generateNLSolution, generateNLTheoremSolution } from "../llm/nl-solution";
import { planSteps } from "../llm/plan";
import { budgetPreset } from "../prover/budget";
import { buildProverContext, rememberVerifiedProof } from "../prover/context";
import { proveBySketch, sketchEnabled } from "../prover/sketch";
import { proveWholeTheorem, wholeProofEnabled } from "../prover/whole-proof";
import { hammerTheorem } from "../lean/hammer";
import { proofSearch } from "../search/proof-search";
import { updateSession } from "../session-store";
import type {
  LeanProofAttempt,
  MathDomain,
  MethodOption,
  MethodScore,
  NaturalLanguageSolution,
  ProofStep,
  Session,
} from "../types";

export interface PipelineEvent {
  stage: string;
  detail: string;
}

export interface TheoremPipelineOptions {
  skip_autoformalize?: boolean;
  skip_nl_solution?: boolean;
  max_sorry?: number;
  method_selection?: "first" | "best_confidence";
  use_mathlib?: boolean;
  /** Run the whole-proof prover loop before stepwise search (default: WHOLE_PROOF_ENABLED, true). */
  whole_proof?: boolean;
  /** Proofs sampled per whole-proof round (default WHOLE_PROOF_SAMPLES). */
  whole_proof_samples?: number;
  /** Repair rounds in the whole-proof loop (default WHOLE_PROOF_ROUNDS). */
  whole_proof_rounds?: number;
  /** Enumerate methods with the multi-agent strategists + critic (default: SOLVE_MULTI_AGENT, false). */
  multi_agent?: boolean;
  /** Candidates sampled per step in the stepwise search (default PROOF_SEARCH_SAMPLES). */
  step_samples?: number;
  /** Run the sketch-and-fill stage (default: SKETCH_ENABLED, true). */
  sketch?: boolean;
  /** Search budget preset: low | normal | high (default PROOF_BUDGET, normal). */
  budget?: string;
}

export interface TheoremPipelineArgs {
  session: Session;
  opts: TheoremPipelineOptions;
  useMathlib: boolean;
  domain?: MathDomain;
  onEvent: (event: PipelineEvent) => void;
}

export interface TheoremPipelineOutcome {
  /** HTTP status the JSON route should use (200, 400, 422). */
  status: number;
  body: Record<string, unknown>;
}

export async function runTheoremPipeline(args: TheoremPipelineArgs): Promise<TheoremPipelineOutcome> {
  const { session, opts, useMathlib } = args;
  const emit = (stage: string, detail: string) => args.onEvent({ stage, detail });

  // ── 1. Natural-language solution (shown first in the UI) ─────────────
  let nlSolution: NaturalLanguageSolution | undefined;
  if (!opts.skip_nl_solution) {
    updateSession(session.id, { pipeline_stage: "nl_solving" });
    emit("nl_solving", "生成自然语言解答...");
    try {
      nlSolution = await generateNLSolution({ problemText: session.problem_text, problemType: "theorem" });
      updateSession(session.id, { nl_solution: nlSolution });
      emit("nl_solving", `✅ 自然语言解答完成 (${nlSolution.steps.length} 步)`);
    } catch (e) {
      emit("nl_solving", `⚠️ 自然语言解答失败: ${e instanceof Error ? e.message : "未知错误"}`);
    }
  }

  // ── 2. Autoformalize + statement lock ────────────────────────────────
  let theoremName = "problem";
  let theoremType = "";
  let resolvedDomain = args.domain;
  // `#check` signature of the validated formalization; every complete-proof
  // verification below must reproduce it.
  let frozenSignature: string | undefined;

  if (!opts.skip_autoformalize) {
    updateSession(session.id, { pipeline_stage: "autoformalizing" });
    emit("autoformalizing", "开始自动形式化...");

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
      emit("autoformalizing", `❌ 形式化验证未通过 (${failedLayers.length} 层失败)`);
      return {
        status: 422,
        body: {
          session_id: session.id,
          error: "autoformalize_failed",
          detail: `形式化验证未通过: ${detail}`,
          validation_results: formalResult.validation_results,
          nl_solution: nlSolution,
        },
      };
    }
    emit("autoformalizing", `✅ 形式化验证通过 (domain: ${formalResult.domain})`);
    if (formalResult.vote) {
      emit("autoformalizing", `候选投票：${formalResult.vote.candidates} 个候选，${formalResult.vote.agreeing} 个一致`);
    }
    if (formalResult.refutation?.verdict === "no_counterexample") emit("autoformalizing", "反例检测：随机测试未找到反例");
    else if (formalResult.refutation?.verdict === "confirmed") emit("autoformalizing", "反例检测：陈述可判定为真");
  } else {
    theoremName = session.theorem_name ?? "problem";
    theoremType = session.theorem_type ?? "";
    if (!theoremType) {
      return { status: 400, body: { error: "skip_autoformalize requires theorem_type in session" } };
    }
    frozenSignature = session.formal_validated ? session.formal_signature : undefined;
  }

  const baseBody = {
    session_id: session.id,
    problem_type: "theorem",
    theorem_name: theoremName,
    theorem_type: theoremType,
  };

  const { budget, preset } = budgetPreset(opts.budget);
  emit("budget", `搜索预算：${budget}`);

  // ── 3. Automation first: the hammer on the root goal (REPL tactic mode),
  //       then the single-tactic probes that also work in spawn mode ──────
  try {
    let trivial: { tactic: string; source: string; log: string; verification: Awaited<ReturnType<typeof verifyLeanSource>> } | null = null;
    let strategy: "trivial" | "hammer" = "trivial";
    if (process.env.LEAN_SERVER_MODE !== "spawn") {
      const rootSource = assembleLeanSource({ theoremName, theoremType, stepCodes: ["sorry"], useMathlib });
      const hit = await hammerTheorem(rootSource, { useMathlib });
      if (hit) {
        const source = assembleLeanSource({ theoremName, theoremType, stepCodes: [hit.tactic], useMathlib });
        const verification = await verifyLeanSource(session.id, source, { theoremName, expectedSignature: frozenSignature });
        if (verification.ok) {
          trivial = { tactic: hit.tactic, source, log: verification.log, verification };
          strategy = "hammer";
        }
      }
    }
    trivial ??= await tryTrivialProof(session.id, theoremName, theoremType, useMathlib, {
      expectedSignature: frozenSignature,
    });
    if (trivial) {
      emit("trivial_proof", `✅ 自动化策略直接证明 (${trivial.tactic})`);
      void rememberVerifiedProof({ theoremName, theoremType, tactics: trivial.tactic, strategy, problemText: session.problem_text });
      const leanProofAttempt: LeanProofAttempt = {
        attempted: true,
        success: true,
        formal_statement: trivial.source,
        proof_code: trivial.source,
        axioms: trivial.verification.axioms?.axioms,
        statement_locked: frozenSignature !== undefined && trivial.verification.signatureMatch === true,
        verifier: trivial.verification.backend,
        strategy,
        attempts: 1,
      };
      updateSession(session.id, {
        assembled_lean: trivial.source,
        build_status: "ok",
        pipeline_stage: "complete",
        lean_proof_attempt: leanProofAttempt,
      });
      emit("complete", "✅ 完全形式化验证通过（自动化策略）");
      return {
        status: 200,
        body: {
          ...baseBody,
          nl_solution: nlSolution,
          lean_proof_attempt: leanProofAttempt,
          method: { id: strategy, title: `自动化策略 (${trivial.tactic})`, category: "other" },
          steps: [],
          sorry_labels: [],
          fully_verified: true,
          build_status: "ok",
          total_attempts: 1,
          sorry_report: { fully_verified: true, summary: "✅ 完全形式化验证通过", details: [] },
          assembled_lean: trivial.source,
          build_log: trivial.log,
        },
      };
    }
  } catch {
    // Lean unavailable or similar — continue with the LLM stages.
  }

  // Goal state at the initial `sorry` (also a preflight of the statement).
  const preflightSource = assembleLeanSource({ theoremName, theoremType, stepCodes: ["sorry"], useMathlib });
  const preflight = await verifyLeanSource(session.id, preflightSource, { allowSorry: true });
  if (preflight.status !== "unavailable" && !preflight.ok) {
    emit("preflight", `⚠️ 定理声明编译失败: ${preflight.log.slice(0, 200)}`);
    updateSession(session.id, { build_status: "fail", pipeline_stage: "complete" });
    return {
      status: 422,
      body: { ...baseBody, error: "theorem_declaration_invalid", detail: preflight.log, nl_solution: nlSolution },
    };
  }
  const initialGoal = preflight.goals?.[0];

  // Premises for the initial goal + verified proofs of similar theorems,
  // shared by the whole-proof, sketch and goal-search prompts.
  const proverContext = await buildProverContext({ theoremType, initialGoal, problemText: session.problem_text, useMathlib });
  if (proverContext.premises.length || proverContext.recalled.length) {
    emit("retrieval", `检索到 ${proverContext.premises.length} 条相关引理、${proverContext.recalled.length} 个相似的已验证证明`);
  }

  // ── 4. Whole-proof prover loop ───────────────────────────────────────
  const wholeProofOn = opts.whole_proof ?? wholeProofEnabled();
  let wholeProofSummary: string | undefined;
  if (wholeProofOn && preflight.status !== "unavailable") {
    updateSession(session.id, { pipeline_stage: "solving" });
    emit("whole_proof", "整体证明：采样完整证明并用 Lean 验证...");
    try {
      const whole = await proveWholeTheorem({
        sessionId: session.id,
        theoremName,
        theoremType,
        expectedSignature: frozenSignature,
        problemText: session.problem_text,
        sketch: nlSolution ? sketchFromNL(nlSolution) : undefined,
        initialGoal,
        premises: proverContext.block || undefined,
        config: {
          ...preset.wholeProof,
          useMathlib,
          ...(opts.whole_proof_samples !== undefined ? { samples: opts.whole_proof_samples } : {}),
          ...(opts.whole_proof_rounds !== undefined ? { rounds: opts.whole_proof_rounds } : {}),
        },
        onProgress: (p) => emit("whole_proof", `[第 ${p.round + 1} 轮] ${p.detail}`),
      });
      wholeProofSummary = `${whole.samples} 个候选 / ${whole.rounds} 轮`;
      if (whole.ok && whole.verification && whole.source) {
        void rememberVerifiedProof({ theoremName, theoremType, tactics: whole.tactics ?? "", strategy: "whole_proof", problemText: session.problem_text });
        const leanProofAttempt: LeanProofAttempt = {
          attempted: true,
          success: true,
          formal_statement: whole.source,
          proof_code: whole.source,
          axioms: whole.verification.axioms?.axioms,
          statement_locked: frozenSignature !== undefined && whole.verification.signatureMatch === true,
          verifier: whole.verification.backend,
          strategy: "whole_proof",
          attempts: whole.samples,
          rounds: whole.rounds,
        };
        const step: ProofStep = {
          index: 0,
          plain_goal: "完整证明",
          lean_goal: theoremType,
          plain_explanation: `整体证明（${wholeProofSummary}）`,
          lean_code: whole.tactics ?? "",
          status: "ok",
          build_log: whole.verification.log,
        };
        updateSession(session.id, {
          steps: [step],
          sorry_labels: [],
          assembled_lean: whole.source,
          build_status: "ok",
          pipeline_stage: "complete",
          lean_proof_attempt: leanProofAttempt,
        });
        emit("complete", `✅ 完全形式化验证通过（整体证明，${wholeProofSummary}）`);
        return {
          status: 200,
          body: {
            ...baseBody,
            nl_solution: nlSolution,
            lean_proof_attempt: leanProofAttempt,
            method: { id: "whole_proof", title: `整体证明 (${wholeProofSummary})`, category: "other" },
            steps: [step],
            sorry_labels: [],
            fully_verified: true,
            build_status: "ok",
            total_attempts: whole.samples,
            sorry_report: { fully_verified: true, summary: "✅ 完全形式化验证通过", details: [] },
            assembled_lean: whole.source,
            build_log: whole.verification.log,
            whole_proof: { rounds: whole.rounds, samples: whole.samples, suggestions: whole.suggestions },
          },
        };
      }
      emit(
        "whole_proof",
        whole.unavailable
          ? "⚠️ Lean 不可用，跳过整体证明"
          : `整体证明未通过（${wholeProofSummary}），转入分步证明`,
      );
    } catch (e) {
      emit("whole_proof", `⚠️ 整体证明出错: ${e instanceof Error ? e.message : "未知错误"}`);
    }
  }

  // ── 4b. Sketch-and-fill: proof skeleton with holes, each hole closed by
  //        the hammer or goal-level tactic search ────────────────────────
  const sketchOn = opts.sketch ?? sketchEnabled();
  let sketchSummary: string | undefined;
  if (sketchOn && preflight.status !== "unavailable" && process.env.LEAN_SERVER_MODE !== "spawn") {
    updateSession(session.id, { pipeline_stage: "solving" });
    emit("sketch", "骨架分解：生成带 sorry 的证明骨架，逐个子目标求解...");
    try {
      const sk = await proveBySketch({
        sessionId: session.id,
        theoremName,
        theoremType,
        expectedSignature: frozenSignature,
        problemText: session.problem_text,
        sketchHint: nlSolution ? sketchFromNL(nlSolution) : undefined,
        initialGoal,
        premises: proverContext.block || undefined,
        config: { ...preset.sketch, useMathlib, goalSearch: { ...preset.goalSearch, useMathlib } },
        onProgress: (p) => emit("sketch", p.detail),
      });
      sketchSummary = `${sk.sketches} 个骨架 / ${sk.holesSolved}/${sk.holes} 个子目标`;
      if (sk.ok && sk.verification && sk.source) {
        void rememberVerifiedProof({ theoremName, theoremType, tactics: sk.tactics ?? "", strategy: "sketch", problemText: session.problem_text });
        const leanProofAttempt: LeanProofAttempt = {
          attempted: true,
          success: true,
          formal_statement: sk.source,
          proof_code: sk.source,
          axioms: sk.verification.axioms?.axioms,
          statement_locked: frozenSignature !== undefined && sk.verification.signatureMatch === true,
          verifier: sk.verification.backend,
          strategy: "sketch",
          attempts: sk.sketches,
          holes: sk.holes,
          holes_solved: sk.holesSolved,
        };
        const step: ProofStep = {
          index: 0,
          plain_goal: "骨架分解证明",
          lean_goal: theoremType,
          plain_explanation: `骨架分解（${sketchSummary}）`,
          lean_code: sk.tactics ?? "",
          status: "ok",
          build_log: sk.verification.log,
        };
        updateSession(session.id, {
          steps: [step],
          sorry_labels: [],
          assembled_lean: sk.source,
          build_status: "ok",
          pipeline_stage: "complete",
          lean_proof_attempt: leanProofAttempt,
        });
        emit("complete", `✅ 完全形式化验证通过（骨架分解，${sketchSummary}）`);
        return {
          status: 200,
          body: {
            ...baseBody,
            nl_solution: nlSolution,
            lean_proof_attempt: leanProofAttempt,
            method: { id: "sketch", title: `骨架分解 (${sketchSummary})`, category: "other" },
            steps: [step],
            sorry_labels: [],
            fully_verified: true,
            build_status: "ok",
            total_attempts: sk.sketches,
            sorry_report: { fully_verified: true, summary: "✅ 完全形式化验证通过", details: [] },
            assembled_lean: sk.source,
            build_log: sk.verification.log,
            whole_proof: wholeProofSummary ? { summary: wholeProofSummary, ok: false } : undefined,
            sketch: { sketches: sk.sketches, holes: sk.holes, holes_solved: sk.holesSolved },
          },
        };
      }
      emit("sketch", sk.unavailable ? "⚠️ Lean 不可用，跳过骨架分解" : `骨架分解未通过（${sketchSummary}），转入分步证明`);
    } catch (e) {
      emit("sketch", `⚠️ 骨架分解出错: ${e instanceof Error ? e.message : "未知错误"}`);
    }
  }

  // ── 5. Methods (single enumerator or multi-agent strategists + critic) ─
  updateSession(session.id, { pipeline_stage: "enumerating" });
  emit("enumerating", "枚举解法...");

  let methods: MethodOption[];
  let methodScores: MethodScore[] | undefined;
  let recommendedId: string | undefined;
  let comparison: string | undefined;
  const multiAgent = opts.multi_agent ?? process.env.SOLVE_MULTI_AGENT === "true";
  if (multiAgent) {
    updateSession(session.id, { pipeline_stage: "evaluating" });
    const evaluation = await runMultiAgentEvaluation({
      problemText: session.problem_text,
      formalStatement: `theorem ${theoremName} ${theoremType}`,
      domain: resolvedDomain ?? "other",
    });
    methods = evaluation.methods;
    methodScores = evaluation.scores;
    recommendedId = evaluation.recommended_method_id;
    comparison = evaluation.comparison;
    updateSession(session.id, {
      methods,
      method_scores: methodScores,
      recommended_method_id: recommendedId,
      comparison_summary: comparison,
    });
    emit("enumerating", `多智能体评估：${methods.length} 种解法，推荐 ${recommendedId}`);
  } else {
    const enumResult = await enumerateMethods(session.problem_text, resolvedDomain);
    methods = enumResult.methods;
    comparison = enumResult.comparison_summary;
    updateSession(session.id, {
      methods,
      comparison_summary: comparison,
      out_of_domain_warning: enumResult.out_of_domain_warning ?? undefined,
    });
    emit("enumerating", `找到 ${methods.length} 种解法`);
  }
  if (methods.length === 0) {
    updateSession(session.id, { build_status: "fail", pipeline_stage: "complete" });
    return { status: 422, body: { ...baseBody, error: "no_methods", detail: "未能枚举出任何解法", nl_solution: nlSolution } };
  }

  // ── 6. Select method ─────────────────────────────────────────────────
  const method =
    (recommendedId && methods.find((m) => m.id === recommendedId)) ||
    (opts.method_selection === "first"
      ? methods[0]
      : methods.reduce((best, cur) => (cur.confidence > best.confidence ? cur : best)));
  emit("selecting", `选择方法: ${method.title} (${method.category}, confidence: ${method.confidence})`);

  // ── 7. Plan ──────────────────────────────────────────────────────────
  updateSession(session.id, { pipeline_stage: "solving" });
  emit("planning", "规划证明步骤...");

  const plan = await planSteps(session.problem_text, method, useMathlib);
  const proofSteps: ProofStep[] = plan.steps.map((s: { index: number; plain_goal: string; lean_goal: string }) => ({
    ...s,
    plain_explanation: "",
    lean_code: "",
    status: "pending" as const,
  }));

  // Statement lock: with a validated formalization the planner only
  // produces steps; otherwise its declaration is used when well-formed.
  const validatedName = theoremName;
  const validatedType = theoremType;
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
  emit("planning", `规划了 ${proofSteps.length} 个步骤`);

  // Preflight of the (possibly planner-supplied) declaration.
  let goalForSearch = initialGoal;
  if (theoremName !== validatedName || theoremType !== validatedType) {
    const src = assembleLeanSource({ theoremName, theoremType, stepCodes: ["sorry"], useMathlib });
    const check = await verifyLeanSource(session.id, src, { allowSorry: true });
    if (check.status !== "unavailable" && !check.ok) {
      emit("preflight", "⚠️ plan 定理声明编译失败，回退到 autoformalize 版本");
      theoremName = validatedName;
      theoremType = validatedType;
      updateSession(session.id, { theorem_name: theoremName, theorem_type: theoremType });
    } else {
      goalForSearch = check.goals?.[0] ?? goalForSearch;
    }
  }

  // ── 8. Best-first stepwise search ────────────────────────────────────
  const adaptiveMaxSorry = opts.max_sorry ?? Math.max(2, Math.ceil(proofSteps.length * 0.5));
  emit("solving", "开始最佳优先证明搜索...");

  const searchResult = await proofSearch({
    session: { ...session, theorem_name: theoremName, theorem_type: theoremType, steps: proofSteps },
    method,
    theoremType,
    config: { maxSorry: adaptiveMaxSorry, useMathlib, samplesPerStep: opts.step_samples },
    domain: resolvedDomain,
    initialGoal: goalForSearch,
    onProgress: (p) => emit("solving", `步骤 ${p.step + 1}/${p.total}: ${p.status}`),
  });

  // ── 9. Final verification (statement lock, axioms, no sorry) ─────────
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
  if (finalResult.ok && searchResult.fullyVerified) {
    void rememberVerifiedProof({
      theoremName,
      theoremType,
      tactics: searchResult.steps.map((s) => s.lean_code).filter(Boolean).join("\n"),
      strategy: "stepwise",
      problemText: session.problem_text,
    });
  }

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
    strategy: "stepwise",
    attempts: searchResult.totalAttempts,
  };

  if (!opts.skip_nl_solution && nlSolution) {
    try {
      const enriched = await generateNLTheoremSolution({
        problemText: session.problem_text,
        methodTitle: method.title,
        proofSteps: searchResult.steps.map((s) => ({ plain_goal: s.plain_goal, plain_explanation: s.plain_explanation })),
      });
      nlSolution = enriched;
      updateSession(session.id, { nl_solution: enriched });
    } catch {
      // keep the original NL solution
    }
  }

  const buildStatus = finalResult.status === "unavailable" ? "unavailable" : finalResult.ok ? "ok" : "fail";
  updateSession(session.id, {
    assembled_lean: finalSource,
    build_status: buildStatus,
    pipeline_stage: "complete",
    lean_proof_attempt: leanProofAttempt,
  });
  emit("complete", finalResult.ok ? report.summary : `❌ 最终验证失败: ${finalResult.log.slice(0, 200)}`);

  return {
    status: 200,
    body: {
      ...baseBody,
      theorem_name: theoremName,
      theorem_type: theoremType,
      nl_solution: nlSolution,
      lean_proof_attempt: leanProofAttempt,
      method: { id: method.id, title: method.title, category: method.category },
      methods,
      method_scores: methodScores,
      recommended_method_id: recommendedId,
      steps: searchResult.steps,
      sorry_labels: searchResult.sorryLabels,
      fully_verified: searchResult.fullyVerified && finalResult.ok,
      build_status: buildStatus,
      total_attempts: searchResult.totalAttempts,
      sorry_report: report,
      assembled_lean: finalSource,
      build_log: finalResult.log,
      whole_proof: wholeProofSummary ? { summary: wholeProofSummary, ok: false } : undefined,
      sketch: sketchSummary ? { summary: sketchSummary, ok: false } : undefined,
    },
  };
}

/** Informal proof sketch for the prover, from the NL solution. */
export function sketchFromNL(nl: NaturalLanguageSolution): string {
  const steps = nl.steps.map((s, i) => `${i + 1}. ${s.title}: ${s.content}`.trim());
  return [nl.summary, ...steps].filter(Boolean).join("\n").slice(0, 3000);
}
