import { z } from "zod";
import {
  TAXONOMY,
  MATH_DOMAINS,
  PROOF_TECHNIQUES,
  ERROR_KINDS,
  GRADE_LEVELS,
  DIFFICULTY_LEVELS,
  COMPETITION_DOMAINS,
} from "./types";

// ── Shared ────────────────────────────────────────────────────────────
export const leanIdent = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_']*$/,
    "theorem_name must be a Lean identifier (letters, digits, _, ')",
  );

export const taxonomySchema = z.enum(TAXONOMY);
export const mathDomainSchema = z.enum(MATH_DOMAINS);
export const proofTechniqueSchema = z.enum(PROOF_TECHNIQUES);
export const errorKindSchema = z.enum(ERROR_KINDS);

// ── Method Option ─────────────────────────────────────────────────────
export const methodOptionSchema = z.object({
  id: z.string().min(1),
  category: taxonomySchema,
  title: z.string().min(1),
  inspiration: z.string().min(1),
  pros: z.string().min(1),
  cons: z.string().min(1),
  lean_sketch: z.string().min(1),
  confidence: z.number().min(0).max(1),
  technique_tags: z.array(proofTechniqueSchema).optional(),
  estimated_difficulty: z
    .number()
    .min(0)
    .max(10)
    .optional()
    .transform((v) => (v != null && v > 1 ? v / 10 : v)),
});

// ── Enumerate Response ────────────────────────────────────────────────
export const enumerateResponseSchema = z
  .object({
    comparison_summary: z.string().min(1),
    out_of_domain_warning: z.string().nullable().optional(),
    methods: z.array(methodOptionSchema).min(1),
  })
  .superRefine((data, ctx) => {
    const ood = data.out_of_domain_warning;
    const inDomain = ood == null || (typeof ood === "string" && !ood.trim());
    if (inDomain && data.methods.length < 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["methods"],
        message:
          "in-domain enumerate responses must include at least 3 methods",
      });
    }
  });

// ── Plan Response ─────────────────────────────────────────────────────
export const planStepSkeletonSchema = z.object({
  index: z.number().int().nonnegative(),
  plain_goal: z.string().min(1),
  lean_goal: z.string().min(1),
});

export const planResponseSchema = z.object({
  theorem_name: leanIdent.default("problem"),
  theorem_type: z.string().min(1),
  steps: z.array(planStepSkeletonSchema).min(1),
});

// ── Prove Step Response ───────────────────────────────────────────────
export const proveStepResponseSchema = z.object({
  plain_explanation: z.string().min(1),
  lean_code: z.string().min(1),
});

// ── Autoformalize Response (Stage ①) ─────────────────────────────────
export const numericalInstanceSchema = z.object({
  variables: z.record(z.string()).default({}),
  expected_result: z.string().default(""),
});

export const formalizeResponseSchema = z.object({
  theorem_name: leanIdent,
  theorem_type: z.string().min(1),
  domain: mathDomainSchema,
  natural_language_restatement: z.string().min(1),
  numerical_instances: z.array(numericalInstanceSchema).min(1),
});

export const backTranslationSchema = z.object({
  natural_language: z.string().min(1),
  semantic_equivalence: z.number().min(0).max(1),
  discrepancies: z.array(z.string()),
});

export const validationResultSchema = z.object({
  layer: z.number().int().min(1).max(5),
  pass: z.boolean(),
  detail: z.string(),
});

// ── Method Evaluation Response (Stage ③) ──────────────────────────────
export const methodScoreSchema = z.object({
  method_id: z.string().min(1),
  feasibility: z.number().min(0).max(1),
  elegance: z.number().min(0).max(1),
  lean_difficulty: z.number().min(0).max(1),
  mathlib_coverage: z.number().min(0).max(1),
  pedagogical_value: z.number().min(0).max(1),
  composite: z.number().min(0).max(1),
  rationale: z.string().min(1),
});

export const evaluateResponseSchema = z.object({
  scores: z.array(methodScoreSchema),
  recommended_method_id: z.string().min(1),
  comparison: z.string().min(1),
});

// ── Intuition Review Response (Stage ⑤) ───────────────────────────────
export const stepInsightSchema = z.object({
  step_index: z.number().int().nonnegative(),
  motivation: z.string().min(1),
  trigger_observation: z.string().min(1),
  discovery_path: z.string().min(1),
  dead_ends: z.array(z.string()),
  transferable_lesson: z.string().min(1),
});

export const intuitionReviewSchema = z.object({
  per_step: z.array(stepInsightSchema),
  overall_lessons: z.array(z.string().min(1)).min(1),
  transferable_patterns: z.array(z.string().min(1)).min(1),
});

// ── Classified Error ──────────────────────────────────────────────────
export const classifiedErrorSchema = z.object({
  kind: errorKindSchema,
  line: z.number().int().positive().optional(),
  column: z.number().int().nonnegative().optional(),
  message: z.string().min(1),
  suggestion: z.string().optional(),
  raw: z.string().min(1),
});

// ── Problem Generation ───────────────────────────────────────────────
export const gradeLevelSchema = z.enum(GRADE_LEVELS);
export const difficultyLevelSchema = z.enum(DIFFICULTY_LEVELS);
export const competitionDomainSchema = z.enum(COMPETITION_DOMAINS);

export const generatedProblemSchema = z.object({
  statement: z.string().min(10),
  answer: z.string().min(1),
  // Lenient: models occasionally return 6+ hints; keep the first 5 instead of failing
  hints: z
    .array(z.string().min(1))
    .min(1)
    .transform((arr) => arr.slice(0, 5)),
  grade_level: gradeLevelSchema,
  difficulty: difficultyLevelSchema,
  domain: competitionDomainSchema,
  suggested_techniques: z.array(proofTechniqueSchema).min(1),
  source_inspiration: z.string().min(1),
  estimated_solve_time: z.string().min(1),
  // Lenient: models often emit null instead of omitting the field
  diagram_svg: z
    .string()
    .nullish()
    .transform((v) => v ?? undefined),
});

export const generateProblemResponseSchema = z.object({
  problems: z.array(generatedProblemSchema).min(1).max(10),
  generation_notes: z.string().optional(),
});

// ── Computational Problem Solving ───────────────────────────────────
// Re-export from dedicated modules for convenience
export {
  problemClassificationSchema,
  type ProblemClassification,
} from "./llm/classify-problem";
export {
  equationSetupSchema,
  type EquationSetup,
} from "./llm/equation-setup";
