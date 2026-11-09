import { z } from "zod";
import { chatJson } from "./client";
import { EQUATION_SETUP_SYSTEM } from "./compute-prompts";

// ── Schema ──────────────────────────────────────────────────────────

export const VARIABLE_DOMAINS = ["real", "positive_real", "integer", "positive_integer", "rational"] as const;
export type VariableDomain = (typeof VARIABLE_DOMAINS)[number];

/**
 * The domain the model wrote, as one of VARIABLE_DOMAINS. Models also write "natural",
 * "nonnegative_integer", "number", "positive real", "ℤ", … (the setup of "375 + 24 × 5 − 68" failed on
 * one such value); anything not recognised is "real", the widest the solver works in.
 */
export function normalizeDomain(v: unknown): VariableDomain {
  if (typeof v !== "string") return "real";
  const t = v.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((VARIABLE_DOMAINS as readonly string[]).includes(t)) return t as VariableDomain;
  if (/^(ℕ\+?|ℕ\*|n\+|n\*|z\+|ℤ\+|natural(_numbers?)?|positive_(integers?|ints?|whole_numbers?|naturals?)|counting(_numbers?)?)$/.test(t)) return "positive_integer";
  if (/^(ℕ|n|nat|ℤ|z|int|integers?|whole(_numbers?)?|non_?negative_(integers?|ints?)|nonneg_int(eger)?)$/.test(t)) return "integer";
  if (/^(ℚ|q|rationals?|fractions?)$/.test(t)) return "rational";
  // nonnegative stays "real" (0 may be the answer); the constraints carry the sign
  if (/^(ℝ\+|r\+|positive(_reals?|_numbers?)?|real_positive)$/.test(t)) return "positive_real";
  return "real";
}

export const equationVariableSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  domain: z.preprocess(normalizeDomain, z.enum(VARIABLE_DOMAINS)),
});

export const equationSchema = z.object({
  lhs: z.string().min(1),
  rhs: z.string().min(1),
  description: z.string().min(1),
});

export const solutionMethodSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
});

/**
 * One SymPy expression. Models sometimes return a list when the problem asks for several
 * quantities ("find x and y"): one item is taken as is, several become a SymPy tuple "(a, b)".
 */
const oneExpression = z.preprocess((v) => {
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) {
    const parts = v.map((x) => (typeof x === "number" ? String(x) : x)).filter((x): x is string => typeof x === "string" && x.trim() !== "");
    if (parts.length === 1) return parts[0];
    if (parts.length > 1) return `(${parts.join(", ")})`;
  }
  return v;
}, z.string().min(1));

/** A description; a list of descriptions (one per target) is joined. */
const oneText = z.preprocess((v) => (Array.isArray(v) && v.every((x) => typeof x === "string") ? v.join("; ") : v), z.string().min(1));

export const equationSetupSchema = z.object({
  variables: z.array(equationVariableSchema).min(1),
  equations: z.array(equationSchema).min(1),
  parameter_values: z.record(z.string(), z.string()).optional(),
  constraints: z.array(z.string()),
  target_expression: oneExpression,
  target_description: oneText,
  solution_methods: z.array(solutionMethodSchema).min(2),
});

export type EquationSetup = z.infer<typeof equationSetupSchema>;
export type EquationVariable = z.infer<typeof equationVariableSchema>;
export type SolutionMethod = z.infer<typeof solutionMethodSchema>;

// ── Main function ───────────────────────────────────────────────────

/**
 * Extract symbolic equations from a word problem using LLM.
 * The output is structured for direct consumption by SymPy.
 */
export async function setupEquations(
  problemText: string,
): Promise<EquationSetup> {
  return chatJson({
    system: EQUATION_SETUP_SYSTEM,
    user: `Model the following word problem as symbolic equations:\n\n${problemText}`,
    schema: equationSetupSchema,
    schemaName: "equationSetup",
    temperature: 0,
  });
}
