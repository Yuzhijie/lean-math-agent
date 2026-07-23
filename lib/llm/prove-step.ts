import type { BuildStatus, MethodOption, ProofStep, Session } from "../types";
import { proveStepResponseSchema } from "../schemas";
import { assembleLeanSource, stepCodesUpTo } from "../lean/assemble";
import { verifyLeanSource } from "../lean/sandbox";
import { chatJson } from "./client";
import { PROVE_STEP_SYSTEM } from "./prompts";

const MAX_RETRIES = 3;

export async function proveOneStep(args: {
  problemText: string;
  method: MethodOption;
  steps: ProofStep[];
  stepIndex: number;
  buildLog?: string;
}) {
  const step = args.steps.find((s) => s.index === args.stepIndex);
  if (!step) throw new Error(`missing step ${args.stepIndex}`);
  return chatJson({
    system: PROVE_STEP_SYSTEM,
    user: JSON.stringify(
      {
        problemText: args.problemText,
        method: args.method,
        step,
        prior_steps: args.steps.filter((s) => s.index < args.stepIndex),
        build_log: args.buildLog ?? null,
      },
      null,
      2,
    ),
    schema: proveStepResponseSchema,
    schemaName: "proveStepResponse",
  });
}

export type ProveStepRepairResult = {
  step: ProofStep;
  /** Only `/api/verify` may set session `ok`; repair leaves idle or signals unavailable. */
  buildStatus: Extract<BuildStatus, "idle" | "unavailable">;
};

export async function proveStepWithRepair(args: {
  session: Session;
  method: MethodOption;
  stepIndex: number;
  theoremType: string;
}): Promise<ProveStepRepairResult> {
  const steps = [...args.session.steps];
  let buildLog: string | undefined;
  const hasLaterSteps = steps.some((s) => s.index > args.stepIndex);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const gen = await proveOneStep({
      problemText: args.session.problem_text,
      method: args.method,
      steps,
      stepIndex: args.stepIndex,
      buildLog,
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
      return { step: steps[idx], buildStatus: "unavailable" };
    }
    if (result.ok) {
      steps[idx] = { ...steps[idx], status: "ok", build_log: result.log };
      return { step: steps[idx], buildStatus: "idle" };
    }
    buildLog = result.log;
    steps[idx] = { ...steps[idx], status: "fail", build_log: result.log };
  }
  return {
    step: steps.find((s) => s.index === args.stepIndex)!,
    buildStatus: "idle",
  };
}
