import type {
  ClassifiedError,
  MathDomain,
  MethodOption,
  ProofStep,
  Session,
  SorryLabel,
} from "../types";
import { proveOneStep } from "../llm/prove-step";
import { assembleLeanSource, stepCodesUpTo } from "../lean/assemble";
import { verifyLeanSource } from "../lean/sandbox";
import { classifyLeanErrors } from "../lean/parse-log";
import { labelSorry } from "../lean/sorry-gate";
import { tryTrivialTactic } from "../lean/trivial-proof";
import { PriorityQueue } from "./priority-queue";

// ── Configuration ─────────────────────────────────────────────────────

interface ProofSearchConfig {
  maxRetriesPerStep: number;  // repair attempts per step (default 3)
  maxSorry: number;           // max sorry-labeled steps before giving up (default 2)
  maxQueueSize: number;       // max states in the priority queue (default 5)
  useMathlib: boolean;        // use Mathlib imports (default true)
}

const DEFAULT_CONFIG: ProofSearchConfig = {
  maxRetriesPerStep: 3,
  maxSorry: 2,
  maxQueueSize: 5,
  useMathlib: true,
};

// ── Proof State ───────────────────────────────────────────────────────

interface ProofState {
  steps: ProofStep[];
  currentStepIndex: number;  // which step we're trying to prove
  score: number;             // lower = better priority
  sorryCount: number;
  errorCount: number;
  history: string[];         // what was tried (for deduplication)
}

export interface ProofSearchResult {
  steps: ProofStep[];
  sorryLabels: SorryLabel[];
  fullyVerified: boolean;
  totalAttempts: number;
  bestScore: number;
}

// ── Scoring ───────────────────────────────────────────────────────────

function scoreState(state: ProofState, totalSteps: number): number {
  const progress = state.currentStepIndex / Math.max(totalSteps, 1);
  const sorryPenalty = state.sorryCount * 2;
  const errorPenalty = state.errorCount * 0.5;
  // Lower score = higher priority
  // Progress (0-1, negate to reward progress) + penalties
  return -progress + sorryPenalty + errorPenalty;
}

// ── Deduplication ─────────────────────────────────────────────────────

function codeHash(steps: ProofStep[]): string {
  return steps.map((s) => s.lean_code || "").join("|");
}

// ── Main Search ───────────────────────────────────────────────────────

/**
 * Best-first proof search that manages alternative proof attempts.
 * For each pending step, tries generation → compile → repair → alternative tactics → sorry degradation.
 */
export async function proofSearch(args: {
  session: Session;
  method: MethodOption;
  theoremType: string;
  config?: Partial<ProofSearchConfig>;
  domain?: MathDomain;
  onProgress?: (state: {
    step: number;
    total: number;
    status: "proving" | "ok" | "fail" | "sorry";
  }) => void;
}): Promise<ProofSearchResult> {
  const config = { ...DEFAULT_CONFIG, ...args.config };
  const totalSteps = args.session.steps.length;

  // Initialize with plan steps
  const initialSteps: ProofStep[] = args.session.steps.map((s) => ({
    ...s,
    lean_code: "",
    status: "pending" as const,
  }));

  const initialState: ProofState = {
    steps: initialSteps,
    currentStepIndex: 0,
    score: 0,
    sorryCount: 0,
    errorCount: 0,
    history: [],
  };

  // Priority queue: lower score = higher priority
  const queue = new PriorityQueue<ProofState>((a, b) => a.score - b.score);
  queue.push(initialState);

  let bestState = initialState;
  let totalAttempts = 0;
  const seenCodes = new Set<string>();

  while (queue.size > 0) {
    const state = queue.pop()!;

    // Skip if we've exceeded sorry budget
    if (state.sorryCount > config.maxSorry) continue;

    // Track best state (most progress)
    if (state.currentStepIndex > bestState.currentStepIndex) {
      bestState = state;
    }

    // All steps proved?
    if (state.currentStepIndex >= totalSteps) {
      // Verify final assembly
      const source = assembleLeanSource({
        theoremName: args.session.theorem_name ?? "problem",
        theoremType: args.theoremType,
        stepCodes: state.steps.map((s) => s.lean_code).filter(Boolean),
        useMathlib: config.useMathlib,
      });
      const result = await verifyLeanSource(args.session.id, source);
      if (result.ok) {
        return {
          steps: state.steps,
          sorryLabels: state.steps
            .filter((s) => s.status === "sorry")
            .map((s) => s.sorry_label!),
          fullyVerified: state.sorryCount === 0,
          totalAttempts,
          bestScore: state.score,
        };
      }
      // Final verification failed — continue search
      continue;
    }

    // Try to prove the current step
    const stepIdx = state.currentStepIndex;
    args.onProgress?.({
      step: stepIdx,
      total: totalSteps,
      status: "proving",
    });

    let buildLog: string | undefined;
    let classifiedErrors: ClassifiedError[] | undefined;
    let stepSolved = false;

    for (
      let attempt = 0;
      attempt < config.maxRetriesPerStep;
      attempt++
    ) {
      totalAttempts++;

      try {
        const gen = await proveOneStep({
          problemText: args.session.problem_text,
          method: args.method,
          steps: state.steps,
          stepIndex: stepIdx,
          theoremType: args.theoremType,
          buildLog,
          classifiedErrors,
          useMathlib: config.useMathlib,
          domain: args.domain,
        });

        // Deduplicate
        const hash = `${stepIdx}:${gen.lean_code}`;
        if (seenCodes.has(hash)) {
          // Same code as before — try with higher temperature
          buildLog = buildLog
            ? `${buildLog}\n[NOTE: previous attempt produced identical code, trying alternative]`
            : "[NOTE: duplicate code detected, trying alternative approach]";
          continue;
        }
        seenCodes.add(hash);

        const newSteps = [...state.steps];
        newSteps[stepIdx] = {
          ...newSteps[stepIdx],
          plain_explanation: gen.plain_explanation,
          lean_code: gen.lean_code,
          status: "pending",
        };

        // Verify
        const source = assembleLeanSource({
          theoremName: args.session.theorem_name ?? "problem",
          theoremType: args.theoremType,
          stepCodes: stepCodesUpTo(newSteps, stepIdx),
          appendSorry: stepIdx < totalSteps - 1,
          useMathlib: config.useMathlib,
        });
        const result = await verifyLeanSource(args.session.id, source, {
          allowSorry: true,
        });

        if (result.status === "unavailable") {
          // Lean not available — can't verify, accept the code
          newSteps[stepIdx] = {
            ...newSteps[stepIdx],
            status: "ok",
            build_log: result.log,
          };
          stepSolved = true;
          break;
        }

        if (result.ok) {
          newSteps[stepIdx] = {
            ...newSteps[stepIdx],
            status: "ok",
            build_log: result.log,
          };
          // Advance to next step
          const nextState: ProofState = {
            ...state,
            steps: newSteps,
            currentStepIndex: stepIdx + 1,
            history: [...state.history, `step ${stepIdx}: ok`],
          };
          nextState.score = scoreState(nextState, totalSteps);
          queue.push(nextState);
          stepSolved = true;

          args.onProgress?.({
            step: stepIdx,
            total: totalSteps,
            status: "ok",
          });
          break;
        }

        // Failed — classify errors and retry
        buildLog = result.log;
        classifiedErrors = classifyLeanErrors(result.log);
        state.errorCount++;
      } catch {
        // LLM error — skip this attempt
        state.errorCount++;
      }
    }

    // If LLM retries exhausted, try trivial single-tactic fallback for this step
    if (!stepSolved) {
      const priorCodes = state.steps
        .filter((s) => s.index < stepIdx && s.lean_code && s.lean_code !== "sorry")
        .sort((a, b) => a.index - b.index)
        .map((s) => s.lean_code);
      const fallback = await tryTrivialTactic(
        args.session.id,
        args.session.theorem_name ?? "problem",
        args.theoremType,
        priorCodes,
        config.useMathlib,
      );
      if (fallback) {
        const newSteps = [...state.steps];
        newSteps[stepIdx] = {
          ...newSteps[stepIdx],
          lean_code: fallback.lean_code,
          plain_explanation: `自动策略: ${fallback.tactic}`,
          status: "ok",
        };
        const nextState: ProofState = {
          ...state,
          steps: newSteps,
          currentStepIndex: stepIdx + 1,
          history: [...state.history, `step ${stepIdx}: trivial (${fallback.tactic})`],
        };
        nextState.score = scoreState(nextState, totalSteps);

        if (queue.size < config.maxQueueSize) {
          queue.push(nextState);
        }
        stepSolved = true;

        args.onProgress?.({ step: stepIdx, total: totalSteps, status: "ok" });
      }
    }

    // If step couldn't be solved, degrade to sorry
    if (!stepSolved && state.sorryCount < config.maxSorry) {
      const sorrySteps = [...state.steps];
      const step = sorrySteps[stepIdx];
      const sorryLbl = labelSorry(step, classifiedErrors);
      sorrySteps[stepIdx] = {
        ...step,
        lean_code: step.lean_code || "sorry",
        status: "sorry" as const,
        sorry_label: sorryLbl,
      };

      const nextState: ProofState = {
        ...state,
        steps: sorrySteps,
        currentStepIndex: stepIdx + 1,
        sorryCount: state.sorryCount + 1,
        history: [...state.history, `step ${stepIdx}: sorry (${sorryLbl.reason})`],
      };
      nextState.score = scoreState(nextState, totalSteps);

      args.onProgress?.({
        step: stepIdx,
        total: totalSteps,
        status: "sorry",
      });

      if (queue.size < config.maxQueueSize) {
        queue.push(nextState);
      }
    }
  }

  // Queue exhausted — try trivial tactic fallback for sorry-degraded steps
  let finalSteps = [...bestState.steps];
  let finalSorryLabels = finalSteps
    .filter((s) => s.status === "sorry")
    .map((s) => s.sorry_label!);
  let finalFullyVerified = bestState.sorryCount === 0;

  if (finalSorryLabels.length > 0) {
    const theoremName = args.session.theorem_name ?? "problem";
    for (let i = 0; i < finalSteps.length; i++) {
      if (finalSteps[i].status !== "sorry") continue;
      const priorCodes = finalSteps
        .slice(0, i)
        .filter((s) => s.lean_code)
        .map((s) => s.lean_code);
      const fallback = await tryTrivialTactic(
        args.session.id,
        theoremName,
        args.theoremType,
        priorCodes,
        config.useMathlib,
      );
      if (fallback) {
        finalSteps[i] = {
          ...finalSteps[i],
          lean_code: fallback.lean_code,
          status: "ok" as const,
        };
        finalSorryLabels = finalSteps
          .filter((s) => s.status === "sorry")
          .map((s) => s.sorry_label!);
        finalFullyVerified = finalSorryLabels.length === 0;
      }
    }
  }

  return {
    steps: finalSteps,
    sorryLabels: finalSorryLabels,
    fullyVerified: finalFullyVerified,
    totalAttempts,
    bestScore: bestState.score,
  };
}
