import { z } from "zod";
import { chatJson } from "./client";
import { CLASSIFIER_SYSTEM } from "./compute-prompts";

// ── Schema ──────────────────────────────────────────────────────────

export const problemClassificationSchema = z
  .object({
    problem_type: z.enum([
      "computational",
      "theorem",
      "optimization",
      "find_all_values",
    ]),
    confidence: z.number().min(0).max(1),
    reasoning: z.string().min(1),
    computational_hints: z
      .object({
        unknowns: z.array(z.string()),
        equation_type: z
          .enum([
            "linear",
            "quadratic",
            "polynomial",
            "system",
            "radical_equation",
            "other",
          ])
          .nullish()
          .transform((v) => v ?? undefined)
          .catch(undefined),
      })
      // Models send null (or a half-filled object) when the problem is not computational.
      .nullish()
      .catch(undefined),
    find_all_hints: z
      .object({
        parameter: z.string().min(1),
        parameter_domain: z
          .enum(["integer", "positive_integer", "real"])
          .optional(),
        condition_description: z.string().min(1),
        search_range_hint: z.string().nullish().transform((v) => v ?? undefined),
      })
      .nullish()
      .catch(undefined),
  })
  .transform((data) => {
    // Strip find_all_hints when the problem isn't find_all_values,
    // or when the LLM returned empty/invalid placeholder strings.
    // Hints only for their own problem type; null becomes undefined.
    return {
      ...data,
      computational_hints: data.problem_type === "computational" ? (data.computational_hints ?? undefined) : undefined,
      find_all_hints: data.problem_type === "find_all_values" ? (data.find_all_hints ?? undefined) : undefined,
    };
  });

export type ProblemClassification = z.infer<
  typeof problemClassificationSchema
>;

// ── Main function ───────────────────────────────────────────────────

/**
 * Classify a math problem as computational or theorem-proving.
 */
export async function classifyProblem(
  problemText: string,
): Promise<ProblemClassification> {
  return chatJson({
    system: CLASSIFIER_SYSTEM,
    user: `Classify the following math problem:\n\n${problemText}`,
    schema: problemClassificationSchema,
    schemaName: "problemClassification",
    temperature: 0,
  });
}
