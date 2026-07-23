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

export const enumerateResponseSchema = z.object({
  comparison_summary: z.string().min(1),
  out_of_domain_warning: z.string().nullable().optional(),
  methods: z.array(methodOptionSchema).min(1),
});

export const planStepSkeletonSchema = z.object({
  index: z.number().int().nonnegative(),
  plain_goal: z.string().min(1),
  lean_goal: z.string().min(1),
});

export const planResponseSchema = z.object({
  theorem_name: z.string().min(1).default("problem"),
  theorem_type: z.string().min(1),
  steps: z.array(planStepSkeletonSchema).min(1),
});

export const proveStepResponseSchema = z.object({
  plain_explanation: z.string().min(1),
  lean_code: z.string().min(1),
});
