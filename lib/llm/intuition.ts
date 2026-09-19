import type { IntuitionReview, MethodOption, ProofStep, StepInsight } from "../types";
import { intuitionReviewSchema, stepInsightSchema } from "../schemas";
import { chatJson } from "./client";
import { EXPLAINER_SYSTEM } from "./agent-prompt";
import { z } from "zod";

/**
 * Generate intuition review for a completed (or partially completed) proof.
 * Two-pass approach:
 * 1. Per-step insights (motivation, trigger, discovery path, dead ends, lessons)
 * 2. Overall lessons + transferable patterns
 */
export async function generateIntuitionReview(args: {
  problemText: string;
  method: MethodOption;
  steps: ProofStep[];
  formalStatement?: string;
}): Promise<IntuitionReview> {
  // Pass 1: Per-step insights
  const perStepInsights = await generatePerStepInsights(args);

  // Pass 2: Overall lessons (uses per-step results as context)
  const overallResults = await generateOverallLessons({
    ...args,
    perStepInsights,
  });

  return {
    per_step: perStepInsights,
    overall_lessons: overallResults.lessons,
    transferable_patterns: overallResults.patterns,
  };
}

async function generatePerStepInsights(args: {
  problemText: string;
  method: MethodOption;
  steps: ProofStep[];
  formalStatement?: string;
}): Promise<StepInsight[]> {
  const perStepSchema = z.object({
    insights: z.array(stepInsightSchema),
  });

  const userMessage = [
    `Problem: ${args.problemText}`,
    args.formalStatement ? `Formal statement: ${args.formalStatement}` : null,
    `Method: ${args.method.title} (${args.method.category})`,
    `Method inspiration: ${args.method.inspiration}`,
    `Proof steps:`,
    JSON.stringify(
      args.steps.map((s) => ({
        index: s.index,
        plain_goal: s.plain_goal,
        plain_explanation: s.plain_explanation,
        status: s.status,
      })),
      null,
      2,
    ),
    `For each step, provide: motivation, trigger_observation, discovery_path, dead_ends, transferable_lesson.`,
    `Write everything in Chinese. Be concrete and pedagogical.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = await chatJson({
    system: EXPLAINER_SYSTEM,
    user: userMessage,
    schema: perStepSchema,
    schemaName: "perStepInsights",
    temperature: 0.4, // slightly creative for insights
  });

  return result.insights;
}

async function generateOverallLessons(args: {
  problemText: string;
  method: MethodOption;
  steps: ProofStep[];
  perStepInsights: StepInsight[];
  formalStatement?: string;
}): Promise<{ lessons: string[]; patterns: string[] }> {
  const overallSchema = z.object({
    lessons: z.array(z.string().min(1)).min(1),
    patterns: z.array(z.string().min(1)).min(1),
  });

  const userMessage = [
    `Problem: ${args.problemText}`,
    `Method: ${args.method.title}`,
    `Per-step insights already generated:`,
    JSON.stringify(
      args.perStepInsights.map((i) => ({
        step: i.step_index,
        motivation: i.motivation,
        lesson: i.transferable_lesson,
      })),
      null,
      2,
    ),
    `Now provide:`,
    `1. lessons: 3-5 overall lessons from this proof (what did we learn?)`,
    `2. patterns: 3-5 transferable patterns (what techniques/principles can be applied to other problems?)`,
    `Write in Chinese. Be specific and actionable.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = await chatJson({
    system: EXPLAINER_SYSTEM,
    user: userMessage,
    schema: overallSchema,
    schemaName: "overallLessons",
    temperature: 0.4,
  });

  return result;
}
