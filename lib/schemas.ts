import { z } from "zod";
import { TAXONOMY } from "./types";

export const taxonomySchema = z.enum(TAXONOMY);

export const methodOptionSchema = z.object({
  id: z.string().min(1),
  category: taxonomySchema,
  title: z.string().min(1),
  inspiration: z.string().min(1),
  pros: z.string().min(1),
  cons: z.string().min(1),
  lean_sketch: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

const leanIdent = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_']*$/,
    "theorem_name must be a Lean identifier (letters, digits, _, ')",
  );

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

export const proveStepResponseSchema = z.object({
  plain_explanation: z.string().min(1),
  lean_code: z.string().min(1),
});
