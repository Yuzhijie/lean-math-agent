import type { BuildStatus, ClassifiedError, MathDomain, MethodOption, ProofStep, Session } from "../types";
import { proveStepResponseSchema } from "../schemas";
import { assembleLeanSource, stepCodesUpTo } from "../lean/assemble";
import { verifyLeanSource } from "../lean/sandbox";
import { classifyLeanErrors, formatErrorsForRepair } from "../lean/parse-log";
import { suggestLemmasForProblem } from "../lean/lemma-cache";
import { chatJson } from "./client";
import { PROVE_STEP_SYSTEM, PROVE_STEP_MATHLIB_SYSTEM, REPAIR_STRATEGIES } from "./prompts";

const MAX_RETRIES = 3;

export async function proveOneStep(args: {
  problemText: string;
  method: MethodOption;
  steps: ProofStep[];
  stepIndex: number;
  theoremType?: string;
  buildLog?: string;
  classifiedErrors?: ClassifiedError[];
  useMathlib?: boolean;
  domain?: MathDomain;
  /**
   * Pretty-printed Lean goal state the step starts from (hypotheses and
   * `⊢ goal`), as reported by the verifier at the `sorry` that follows the
   * previous steps. This is what a human sees in the infoview and is far
   * more useful to the model than the planner's informal `lean_goal`.
   */
  goalState?: string;
}) {
  const step = args.steps.find((s) => s.index === args.stepIndex);
  if (!step) throw new Error(`missing step ${args.stepIndex}`);

  const goalContext = args.goalState
    ? `\n\nCurrent Lean goal state at this step (from the Lean checker; the tactics you write must make progress on exactly this):\n\`\`\`\n${args.goalState}\n\`\`\``
    : "";

  // Choose system prompt based on Mathlib availability
  const systemPrompt = args.useMathlib
    ? PROVE_STEP_MATHLIB_SYSTEM
    : PROVE_STEP_SYSTEM;

  // Build repair context if errors are classified
  let repairContext = "";
  if (args.classifiedErrors && args.classifiedErrors.length > 0) {
    const formatted = formatErrorsForRepair(args.classifiedErrors);
    repairContext = `\n\nClassified errors from last attempt:\n${formatted}`;

    // Add strategy-specific hints for the primary error
    const primary = args.classifiedErrors[0];
    const strategyHint = REPAIR_STRATEGIES[primary.kind];
    if (strategyHint) {
      repairContext += `\n\nPrimary repair strategy: ${strategyHint}`;
    }
  }

  // Inject relevant Mathlib lemma suggestions for the LLM
  let lemmaContext = "";
  if (args.useMathlib) {
    try {
      const lemmas = await suggestLemmasForProblem(args.problemText, args.domain, 8);
      if (lemmas.length > 0) {
        const lemmaList = lemmas
          .map((l) => `${l.name} : ${l.type_signature}  -- ${l.description}`)
          .join("\n");
        lemmaContext = `\n\nRelevant Mathlib lemmas you can use directly (no need to reprove):\n${lemmaList}`;
      }
    } catch {
      // Lemma suggestion is best-effort; don't block proof generation
    }
  }

  return chatJson({
    system: systemPrompt,
    user: JSON.stringify(
      {
        problemText: args.problemText,
        theoremType: args.theoremType ?? null,
        method: args.method,
        step,
        prior_steps: args.steps.filter((s) => s.index < args.stepIndex),
        build_log: args.buildLog ?? null,
      },
      null,
      2,
    ) + goalContext + repairContext + lemmaContext,
    schema: proveStepResponseSchema,
    schemaName: "proveStepResponse",
  });
}

export type ProveStepRepairResult = {
  step: ProofStep;
  /** Only `/api/verify` may set session `ok`; repair leaves idle or signals unavailable. */
  buildStatus: Extract<BuildStatus, "idle" | "unavailable">;
  classifiedErrors?: ClassifiedError[];
  attempts: number;
};

export async function proveStepWithRepair(args: {
  session: Session;
  method: MethodOption;
  stepIndex: number;
  theoremType: string;
  useMathlib?: boolean;
  domain?: MathDomain;
}): Promise<ProveStepRepairResult> {
  const steps = [...args.session.steps];
  let buildLog: string | undefined;
  let classifiedErrors: ClassifiedError[] | undefined;
  const hasLaterSteps = steps.some((s) => s.index > args.stepIndex);

  // Goal state the step starts from: verify the prefix of earlier steps with
  // a trailing `sorry`; the verifier reports the goal at that sorry.
  let goalState: string | undefined;
  if (process.env.LEAN_SERVER_MODE !== "spawn") {
    // (spawn mode cannot report goals, so skip the extra compile there)
    const priorCodes = stepCodesUpTo(steps, args.stepIndex - 1);
    const prefixSource = assembleLeanSource({
      theoremName: args.session.theorem_name ?? "problem",
      theoremType: args.theoremType,
      stepCodes: priorCodes,
      appendSorry: true,
      useMathlib: args.useMathlib,
    });
    const prefix = await verifyLeanSource(args.session.id, prefixSource, { allowSorry: true });
    // The trailing sorry is the last one in source order.
    const last = prefix.goals?.[prefix.goals.length - 1];
    if (prefix.ok && last) goalState = last;
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const gen = await proveOneStep({
      problemText: args.session.problem_text,
      method: args.method,
      steps,
      stepIndex: args.stepIndex,
      theoremType: args.theoremType,
      buildLog,
      classifiedErrors,
      useMathlib: args.useMathlib,
      domain: args.domain,
      goalState,
    });
    const idx = steps.findIndex((s) => s.index === args.stepIndex);
    steps[idx] = {
      ...steps[idx],
      plain_explanation: gen.plain_explanation,
      lean_code: gen.lean_code,
      status: "pending",
    };
    const source = assembleLeanSource({
      theoremName: args.session.theorem_name ?? "problem",
      theoremType: args.theoremType,
      stepCodes: stepCodesUpTo(steps, args.stepIndex),
      appendSorry: hasLaterSteps,
      useMathlib: args.useMathlib,
    });
    const result = await verifyLeanSource(args.session.id, source, {
      allowSorry: true,
    });

    if (result.status === "unavailable") {
      steps[idx] = {
        ...steps[idx],
        status: "pending",
        build_log: result.log,
      };
      return { step: steps[idx], buildStatus: "unavailable", attempts: attempt + 1 };
    }
    if (result.ok) {
      steps[idx] = { ...steps[idx], status: "ok", build_log: result.log };
      return { step: steps[idx], buildStatus: "idle", attempts: attempt + 1 };
    }

    // Classify errors for targeted repair
    buildLog = result.log;
    classifiedErrors = classifyLeanErrors(result.log);
    steps[idx] = { ...steps[idx], status: "fail", build_log: result.log };
  }
  return {
    step: steps.find((s) => s.index === args.stepIndex)!,
    buildStatus: "idle",
    classifiedErrors,
    attempts: MAX_RETRIES,
  };
}
