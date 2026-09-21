/**
 * Best-first stepwise proof search.
 *
 * Each search state is a partial proof (steps 0..i-1 verified, with the
 * Lean goal state facing step i). Expanding a state samples `samplesPerStep`
 * candidate tactic blocks for step i from the prover, verifies all of them
 * in parallel (prefix + trailing `sorry`), and pushes one child per
 * distinct resulting goal state — so genuinely different tactics branch,
 * identical outcomes do not. When no candidate verifies, the best failure
 * is repaired sequentially (`maxRetriesPerStep` rounds with Lean's errors
 * in the prompt), then a single-tactic fallback is tried, and finally the
 * step is degraded to `sorry` within the sorry budget. The queue is a beam
 * of `maxQueueSize` states ordered by progress and penalties.
 */
import type {
  ClassifiedError,
  MathDomain,
  MethodOption,
  ProofStep,
  Session,
  SorryLabel,
} from "../types";
import { proveOneStep, proveStepCandidates, type ProveStepOutput } from "../llm/prove-step";
import { assembleLeanSource, stepCodesUpTo } from "../lean/assemble";
import { verifyLeanSource, type LeanVerifyResult } from "../lean/sandbox";
import { classifyLeanErrors } from "../lean/parse-log";
import { labelSorry } from "../lean/sorry-gate";
import { tryTrivialTactic } from "../lean/trivial-proof";
import { PriorityQueue } from "./priority-queue";

// ── Configuration ─────────────────────────────────────────────────────

export interface ProofSearchConfig {
  /** Sequential repair attempts per expansion after the sampled candidates all fail (default 3). */
  maxRetriesPerStep: number;
  /** Max sorry-labeled steps before a branch is abandoned (default 2). */
  maxSorry: number;
  /** Beam width: states kept in the queue (default 5). */
  maxQueueSize: number;
  /** Use Mathlib imports (default true). */
  useMathlib: boolean;
  /** Candidates sampled per expansion (default PROOF_SEARCH_SAMPLES, 2). */
  samplesPerStep: number;
  /** Safety cap on expansions (default 40). */
  maxExpansions: number;
}

function envNumber(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== "" && Number.isFinite(v) ? v : dflt;
}

function defaultConfig(): ProofSearchConfig {
  return {
    maxRetriesPerStep: 3,
    maxSorry: 2,
    maxQueueSize: envNumber("PROOF_SEARCH_BEAM", 5),
    useMathlib: true,
    samplesPerStep: Math.max(1, Math.floor(envNumber("PROOF_SEARCH_SAMPLES", 2))),
    maxExpansions: envNumber("PROOF_SEARCH_MAX_EXPANSIONS", 40),
  };
}

// ── Proof State ───────────────────────────────────────────────────────

interface ProofState {
  steps: ProofStep[];
  currentStepIndex: number;  // which step we're trying to prove
  score: number;             // lower = better priority
  sorryCount: number;
  errorCount: number;
  history: string[];         // what was tried (for deduplication)
  /** Lean goal state facing `currentStepIndex` (from the verifier), if known. */
  goalState?: string;
}

export interface ProofSearchResult {
  steps: ProofStep[];
  sorryLabels: SorryLabel[];
  fullyVerified: boolean;
  totalAttempts: number;
  bestScore: number;
  /** States expanded. */
  expansions: number;
}

// ── Scoring ───────────────────────────────────────────────────────────

function scoreState(state: ProofState, totalSteps: number): number {
  const progress = state.currentStepIndex / Math.max(totalSteps, 1);
  const sorryPenalty = state.sorryCount * 2;
  const errorPenalty = state.errorCount * 0.5;
  // Lower score = higher priority: reward progress, penalise sorries/errors.
  return -progress + sorryPenalty + errorPenalty;
}

/** Identity of a child state for deduplication: the goal it faces, else its code. */
function childKey(stepIdx: number, goalState: string | undefined, code: string): string {
  const goal = goalState?.replace(/\s+/g, " ").trim();
  return goal ? `${stepIdx}:goal:${goal}` : `${stepIdx}:code:${code.trim()}`;
}

// ── Main Search ───────────────────────────────────────────────────────

export async function proofSearch(args: {
  session: Session;
  method: MethodOption;
  theoremType: string;
  config?: Partial<ProofSearchConfig>;
  domain?: MathDomain;
  /** Goal state at the start of the proof (e.g. from a preflight `sorry`). */
  initialGoal?: string;
  onProgress?: (state: {
    step: number;
    total: number;
    status: "proving" | "ok" | "fail" | "sorry";
  }) => void;
}): Promise<ProofSearchResult> {
  const config: ProofSearchConfig = { ...defaultConfig() };
  for (const [k, v] of Object.entries(args.config ?? {})) {
    if (v !== undefined) (config as unknown as Record<string, unknown>)[k] = v;
  }
  const totalSteps = args.session.steps.length;
  const theoremName = args.session.theorem_name ?? "problem";

  const initialState: ProofState = {
    steps: args.session.steps.map((s) => ({ ...s, lean_code: "", status: "pending" as const })),
    currentStepIndex: 0,
    score: 0,
    sorryCount: 0,
    errorCount: 0,
    history: [],
    goalState: args.initialGoal,
  };

  const queue = new PriorityQueue<ProofState>((a, b) => a.score - b.score);
  queue.push(initialState);

  let bestState = initialState;
  let totalAttempts = 0;
  let expansions = 0;
  const seenChildren = new Set<string>();

  const pushChild = (child: ProofState, code: string): boolean => {
    const key = childKey(child.currentStepIndex, child.goalState, code);
    if (seenChildren.has(key)) return false;
    seenChildren.add(key);
    child.score = scoreState(child, totalSteps);
    queue.push(child);
    queue.prune(config.maxQueueSize);
    return true;
  };

  const verifyPrefix = (steps: ProofStep[], stepIdx: number): Promise<LeanVerifyResult> =>
    verifyLeanSource(
      args.session.id,
      assembleLeanSource({
        theoremName,
        theoremType: args.theoremType,
        stepCodes: stepCodesUpTo(steps, stepIdx),
        appendSorry: stepIdx < totalSteps - 1,
        useMathlib: config.useMathlib,
      }),
      { allowSorry: true },
    );

  while (queue.size > 0 && expansions < config.maxExpansions) {
    const state = queue.pop()!;
    if (state.sorryCount > config.maxSorry) continue;
    expansions++;

    if (state.currentStepIndex > bestState.currentStepIndex) bestState = state;

    // ── Goal: all steps proved → final assembly must verify ────────────
    if (state.currentStepIndex >= totalSteps) {
      const source = assembleLeanSource({
        theoremName,
        theoremType: args.theoremType,
        stepCodes: state.steps.map((s) => s.lean_code).filter(Boolean),
        useMathlib: config.useMathlib,
      });
      const result = await verifyLeanSource(args.session.id, source);
      if (result.ok) {
        return {
          steps: state.steps,
          sorryLabels: state.steps.filter((s) => s.status === "sorry").map((s) => s.sorry_label!),
          fullyVerified: state.sorryCount === 0,
          totalAttempts,
          bestScore: state.score,
          expansions,
        };
      }
      continue; // final verification failed — explore other branches
    }

    const stepIdx = state.currentStepIndex;
    args.onProgress?.({ step: stepIdx, total: totalSteps, status: "proving" });

    const baseArgs = {
      problemText: args.session.problem_text,
      method: args.method,
      steps: state.steps,
      stepIndex: stepIdx,
      theoremType: args.theoremType,
      useMathlib: config.useMathlib,
      domain: args.domain,
      goalState: state.goalState,
    };

    let stepSolved = false;
    let buildLog: string | undefined;
    let classifiedErrors: ClassifiedError[] | undefined;
    let failedCandidates: Array<{ gen: ProveStepOutput; result: LeanVerifyResult }> = [];

    // ── 1. Sample k candidates and verify them in parallel ─────────────
    let candidates: ProveStepOutput[] = [];
    try {
      const raw = await proveStepCandidates({ ...baseArgs, n: config.samplesPerStep });
      const codes = new Set<string>();
      candidates = raw.filter((c) => {
        const key = c.lean_code.trim();
        if (!key || codes.has(key)) return false;
        codes.add(key);
        return true;
      });
    } catch {
      state.errorCount++;
    }
    totalAttempts += candidates.length;

    if (candidates.length > 0) {
      const verified = await Promise.all(
        candidates.map(async (gen) => {
          const newSteps = [...state.steps];
          newSteps[stepIdx] = {
            ...newSteps[stepIdx],
            plain_explanation: gen.plain_explanation,
            lean_code: gen.lean_code,
            status: "pending",
          };
          return { gen, newSteps, result: await verifyPrefix(newSteps, stepIdx) };
        }),
      );

      // Lean unavailable — cannot verify anything; accept the first candidate.
      const unavailable = verified.find((v) => v.result.status === "unavailable");
      if (unavailable) {
        const steps = [...unavailable.newSteps];
        steps[stepIdx] = { ...steps[stepIdx], status: "ok", build_log: unavailable.result.log };
        pushChild(
          { ...state, steps, currentStepIndex: stepIdx + 1, history: [...state.history, `step ${stepIdx}: unverified`], goalState: undefined },
          unavailable.gen.lean_code,
        );
        args.onProgress?.({ step: stepIdx, total: totalSteps, status: "ok" });
        continue;
      }

      for (const v of verified) {
        if (!v.result.ok) {
          failedCandidates.push({ gen: v.gen, result: v.result });
          continue;
        }
        const steps = [...v.newSteps];
        steps[stepIdx] = { ...steps[stepIdx], status: "ok", build_log: v.result.log };
        const pushed = pushChild(
          {
            ...state,
            steps,
            currentStepIndex: stepIdx + 1,
            history: [...state.history, `step ${stepIdx}: ok`],
            // trailing sorry = last goal in source order
            goalState: v.result.goals?.[v.result.goals.length - 1] || undefined,
          },
          v.gen.lean_code,
        );
        if (pushed) stepSolved = true;
      }
      if (stepSolved) {
        args.onProgress?.({ step: stepIdx, total: totalSteps, status: "ok" });
        continue;
      }
    }

    // ── 2. Sequential repair from the most promising failure ───────────
    if (failedCandidates.length > 0) {
      failedCandidates = failedCandidates.sort(
        (a, b) => errorCount(a.result) - errorCount(b.result),
      );
      const best = failedCandidates[0];
      state.steps = replaceStep(state.steps, stepIdx, best.gen);
      buildLog = best.result.log;
      classifiedErrors = classifyLeanErrors(best.result.log);
      state.errorCount++;
    }

    const seenCodes = new Set(candidates.map((c) => c.lean_code.trim()));
    for (let attempt = 0; attempt < config.maxRetriesPerStep && !stepSolved; attempt++) {
      totalAttempts++;
      try {
        const gen = await proveOneStep({ ...baseArgs, steps: state.steps, buildLog, classifiedErrors });
        if (seenCodes.has(gen.lean_code.trim())) {
          buildLog = `${buildLog ?? ""}\n[NOTE: the previous attempt produced identical code; try a different tactic]`.trim();
          continue;
        }
        seenCodes.add(gen.lean_code.trim());
        const newSteps = replaceStep(state.steps, stepIdx, gen);
        const result = await verifyPrefix(newSteps, stepIdx);

        if (result.status === "unavailable") {
          newSteps[stepIdx] = { ...newSteps[stepIdx], status: "ok", build_log: result.log };
          pushChild(
            { ...state, steps: newSteps, currentStepIndex: stepIdx + 1, history: [...state.history, `step ${stepIdx}: unverified`], goalState: undefined },
            gen.lean_code,
          );
          stepSolved = true;
          break;
        }
        if (result.ok) {
          newSteps[stepIdx] = { ...newSteps[stepIdx], status: "ok", build_log: result.log };
          pushChild(
            {
              ...state,
              steps: newSteps,
              currentStepIndex: stepIdx + 1,
              history: [...state.history, `step ${stepIdx}: ok (repair ${attempt + 1})`],
              goalState: result.goals?.[result.goals.length - 1] || undefined,
            },
            gen.lean_code,
          );
          stepSolved = true;
          args.onProgress?.({ step: stepIdx, total: totalSteps, status: "ok" });
          break;
        }
        state.steps = newSteps;
        buildLog = result.log;
        classifiedErrors = classifyLeanErrors(result.log);
        state.errorCount++;
      } catch {
        state.errorCount++; // LLM error — skip this attempt
      }
    }
    if (stepSolved) continue;

    // ── 3. Single-tactic fallback ──────────────────────────────────────
    const priorCodes = state.steps
      .filter((s) => s.index < stepIdx && s.lean_code && s.lean_code !== "sorry")
      .sort((a, b) => a.index - b.index)
      .map((s) => s.lean_code);
    const fallback = await tryTrivialTactic(args.session.id, theoremName, args.theoremType, priorCodes, config.useMathlib);
    if (fallback) {
      const newSteps = [...state.steps];
      newSteps[stepIdx] = {
        ...newSteps[stepIdx],
        lean_code: fallback.lean_code,
        plain_explanation: `自动策略: ${fallback.tactic}`,
        status: "ok",
      };
      pushChild(
        { ...state, steps: newSteps, currentStepIndex: stepIdx + 1, history: [...state.history, `step ${stepIdx}: trivial (${fallback.tactic})`], goalState: undefined },
        fallback.lean_code,
      );
      args.onProgress?.({ step: stepIdx, total: totalSteps, status: "ok" });
      continue;
    }

    // ── 4. Degrade to sorry within budget ──────────────────────────────
    if (state.sorryCount < config.maxSorry) {
      const step = state.steps[stepIdx];
      const sorryLbl = labelSorry(step, classifiedErrors);
      const sorrySteps = [...state.steps];
      sorrySteps[stepIdx] = {
        ...step,
        lean_code: step.lean_code || "sorry",
        status: "sorry" as const,
        sorry_label: sorryLbl,
      };
      args.onProgress?.({ step: stepIdx, total: totalSteps, status: "sorry" });
      pushChild(
        {
          ...state,
          steps: sorrySteps,
          currentStepIndex: stepIdx + 1,
          sorryCount: state.sorryCount + 1,
          history: [...state.history, `step ${stepIdx}: sorry (${sorryLbl.reason})`],
          goalState: undefined,
        },
        `sorry:${sorryLbl.reason}`,
      );
    } else {
      args.onProgress?.({ step: stepIdx, total: totalSteps, status: "fail" });
    }
  }

  // ── Queue exhausted: best partial proof, single-tactic retry on sorries ─
  const finalSteps = [...bestState.steps];
  let finalSorryLabels = finalSteps.filter((s) => s.status === "sorry").map((s) => s.sorry_label!);
  let finalFullyVerified = bestState.sorryCount === 0 && bestState.currentStepIndex >= totalSteps;

  if (finalSorryLabels.length > 0) {
    for (let i = 0; i < finalSteps.length; i++) {
      if (finalSteps[i].status !== "sorry") continue;
      const priorCodes = finalSteps.slice(0, i).filter((s) => s.lean_code).map((s) => s.lean_code);
      const fallback = await tryTrivialTactic(args.session.id, theoremName, args.theoremType, priorCodes, config.useMathlib);
      if (fallback) {
        finalSteps[i] = { ...finalSteps[i], lean_code: fallback.lean_code, status: "ok" as const };
        finalSorryLabels = finalSteps.filter((s) => s.status === "sorry").map((s) => s.sorry_label!);
        finalFullyVerified = finalSorryLabels.length === 0 && bestState.currentStepIndex >= totalSteps;
      }
    }
  }

  return {
    steps: finalSteps,
    sorryLabels: finalSorryLabels,
    fullyVerified: finalFullyVerified,
    totalAttempts,
    bestScore: bestState.score,
    expansions,
  };
}

// ── helpers ───────────────────────────────────────────────────────────

function errorCount(r: LeanVerifyResult): number {
  return r.messages.filter((m) => m.severity === "error").length;
}

function replaceStep(steps: ProofStep[], idx: number, gen: ProveStepOutput): ProofStep[] {
  const out = [...steps];
  out[idx] = { ...out[idx], plain_explanation: gen.plain_explanation, lean_code: gen.lean_code, status: "pending" };
  return out;
}
