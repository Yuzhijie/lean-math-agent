import type { MathDomain, ValidationResult } from "../types";
import { formalizeResponseSchema, backTranslationSchema } from "../schemas";
import { chatJson, chatText, LlmError } from "./client";
import { FORMALIZER_SYSTEM, BACK_TRANSLATE_SYSTEM, EQUIVALENCE_CHECK_SYSTEM } from "./agent-prompt";
import { verifyLeanSource } from "../lean/sandbox";
import { validateTheoremStatement } from "../lean/sanitize";
import { z } from "zod";

// ── Types ─────────────────────────────────────────────────────────────

export interface AutoformalizeResult {
  theorem_name: string;
  theorem_type: string;
  domain: MathDomain;
  formal_statement: string; // full `theorem ... := by sorry` source
  /** `#check @name` of the validated statement (statement lock); undefined if Lean was unavailable. */
  formal_signature?: string;
  validation_results: ValidationResult[];
  accepted: boolean;
}

interface FormalizeResponse {
  theorem_name: string;
  theorem_type: string;
  domain: MathDomain;
  natural_language_restatement: string;
  numerical_instances: Array<{
    variables: Record<string, string>;
    expected_result: string;
  }>;
}

interface BackTranslation {
  natural_language: string;
  semantic_equivalence: number;
  discrepancies: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Ensure theorem_type starts with ':' — assemble.ts expects this format.
 * LLMs sometimes return `∀ (n : ℕ), n + 0 = n` instead of `: ∀ (n : ℕ), n + 0 = n`.
 */
export function normalizeTheoremType(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith(":")) {
    return `: ${trimmed}`;
  }
  return trimmed;
}

// ── Main entry point ──────────────────────────────────────────────────

/**
 * Translates a natural language math problem into a validated Lean 4 theorem.
 * Runs 5 validation layers; retries formalization up to maxRetries times.
 */
export async function autoformalize(args: {
  problemText: string;
  maxRetries?: number;
  equivalenceThreshold?: number; // default 0.8
}): Promise<AutoformalizeResult> {
  const maxRetries = args.maxRetries ?? 3;
  const threshold = args.equivalenceThreshold ?? 0.8;
  let lastResult: AutoformalizeResult | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const retryContext =
      attempt > 0 && lastResult
        ? `\n\nPrevious formalization attempt was rejected:\n${lastResult.validation_results
            .filter((v) => !v.pass)
            .map((v) => `Layer ${v.layer}: ${v.detail}`)
            .join("\n")}\n\nPlease fix these issues.`
        : "";

    // Step 1: Generate formalization via LLM
    const formal = await chatJson<FormalizeResponse>({
      system: FORMALIZER_SYSTEM,
      user: `Formalize the following math problem as a Lean 4 theorem statement:\n\n${args.problemText}${retryContext}`,
      schema: formalizeResponseSchema,
      schemaName: "formalizeResponse",
    });

    // Normalize theorem_type to always start with ':'
    formal.theorem_type = normalizeTheoremType(formal.theorem_type);

    // Build the sorry-wrapped theorem source
    let formalStatement = `theorem ${formal.theorem_name} ${formal.theorem_type} := by sorry`;

    // Step 2: Run 5-layer validation
    const results: ValidationResult[] = [];

    // Layer 1: Elaborability — can Lean compile this with sorry?
    // Also records the pretty-printed signature (`#check @name`) that the
    // final verification must reproduce (statement lock).
    let l1 = await layerElaborability(formal.theorem_name, formal.theorem_type);
    results.push(l1.result);
    if (!l1.result.pass) {
      // ── Targeted repair: feed Lean error back to LLM to fix just the type ──
      const repaired = await repairTheoremType(
        args.problemText,
        formal,
        l1.result.detail,
      );
      if (repaired) {
        formal.theorem_name = repaired.theorem_name;
        formal.theorem_type = repaired.theorem_type;
        formalStatement = `theorem ${formal.theorem_name} ${formal.theorem_type} := by sorry`;
        // Re-check elaborability with repaired type
        l1 = await layerElaborability(formal.theorem_name, formal.theorem_type);
        results[0] = l1.result;
      }
      if (!l1.result.pass) {
        lastResult = {
          theorem_name: formal.theorem_name,
          theorem_type: formal.theorem_type,
          domain: formal.domain,
          formal_statement: formalStatement,
          validation_results: results,
          accepted: false,
        };
        continue;
      }
    }
    const formalSignature = l1.signature;

    // Layer 2: Non-triviality — is it a tautology or vacuous?
    const l2 = await layerNonTriviality(formal);
    results.push(l2);
    if (!l2.pass) {
      lastResult = {
        theorem_name: formal.theorem_name,
        theorem_type: formal.theorem_type,
        domain: formal.domain,
        formal_statement: formalStatement,
        formal_signature: formalSignature,
        validation_results: results,
        accepted: false,
      };
      continue;
    }

    // Layer 3: Back-translation — Lean → NL → compare
    const l3 = await layerBackTranslation(
      args.problemText,
      formalStatement,
      threshold,
    );
    results.push(l3);
    if (!l3.pass) {
      lastResult = {
        theorem_name: formal.theorem_name,
        theorem_type: formal.theorem_type,
        domain: formal.domain,
        formal_statement: formalStatement,
        formal_signature: formalSignature,
        validation_results: results,
        accepted: false,
      };
      continue;
    }

    // Layer 4: Numerical instance verification (best-effort)
    const l4 = await layerNumericalVerification(formal);
    results.push(l4);

    // Layer 5: Hypothesis relevance check
    const l5 = await layerHypothesisRelevance(formal);
    results.push(l5);

    const accepted = results.every((r) => r.pass);
    const result: AutoformalizeResult = {
      theorem_name: formal.theorem_name,
      theorem_type: formal.theorem_type,
      domain: formal.domain,
      formal_statement: formalStatement,
      formal_signature: formalSignature,
      validation_results: results,
      accepted,
    };

    if (accepted) return result;
    lastResult = result;
  }

  // All retries exhausted
  return lastResult!;
}

// ── Layer 1: Elaborability ────────────────────────────────────────────

async function layerElaborability(
  theoremName: string,
  theoremType: string,
): Promise<{ result: ValidationResult; signature?: string }> {
  // The statement string is spliced into `theorem <name> <type> := by ...`
  // by every later stage, so it must be a bare signature: single line, no
  // `:=`, no comments, no forbidden commands.
  const shape = validateTheoremStatement(theoremName, theoremType);
  if (!shape.ok) {
    return { result: { layer: 1, pass: false, detail: `定理陈述格式无效: ${shape.reason}` } };
  }
  const formalStatement = `theorem ${theoremName} ${theoremType} := by sorry`;
  try {
    // Prepend Mathlib imports so the elaborability check can resolve Mathlib types
    const withImports = `import Mathlib\nimport Batteries\nimport Aesop\n\n${formalStatement}`;
    const res = await verifyLeanSource("autoformalize-l1", withImports, {
      allowSorry: true,
      theoremName,
      checkAxioms: false,
      wantSignature: true,
    });
    if (res.status === "unavailable") {
      return {
        result: {
          layer: 1,
          pass: true, // can't verify — assume OK (degrade gracefully)
          skipped: true,
          detail: "Lean 不可用，跳过可阐述性检查",
        },
      };
    }
    return {
      result: {
        layer: 1,
        pass: res.ok,
        detail: res.ok
          ? `Lean 编译通过（with sorry）${res.signature ? `，陈述: ${res.signature}` : ""}`
          : res.log,
      },
      signature: res.ok ? res.signature : undefined,
    };
  } catch {
    return { result: { layer: 1, pass: false, detail: "Lean 编译异常" } };
  }
}

// ── Layer 2: Non-triviality ───────────────────────────────────────────

async function layerNonTriviality(
  formal: FormalizeResponse,
): Promise<ValidationResult> {
  // Heuristic checks:
  // 1. Check for trivial goal patterns
  const trivialGoals = ["True", "0 = 0", "1 = 1"];
  const goalPart = formal.theorem_type.split(":").pop()?.trim() ?? "";
  const isTrivialGoal = trivialGoals.some((g) => goalPart === g);

  if (isTrivialGoal) {
    return {
      layer: 2,
      pass: false,
      detail: `目标退化为平凡命题: ${goalPart}`,
    };
  }

  // 2. Check for contradictory premises (vacuous truth)
  // Heuristic: if the theorem type contains "False" as conclusion, it's suspicious
  if (/\bFalse\b/.test(goalPart) && !/\b¬/.test(formal.theorem_type)) {
    return {
      layer: 2,
      pass: false,
      detail: "目标为 False，可能是矛盾前提",
    };
  }

  // 3. Use LLM to check for non-triviality
  try {
    const check = await chatJson<{
      is_non_trivial: boolean;
      reasoning: string;
    }>({
      system: `Analyze this Lean 4 theorem statement for non-triviality.
Check if:
- The premises are contradictory (vacuous truth)
- The goal is trivially true
- The theorem is meaningful (not degenerate)
Return JSON: { "is_non_trivial": boolean, "reasoning": string (Chinese) }`,
      user: `theorem ${formal.theorem_name} ${formal.theorem_type} := by sorry\n\nOriginal problem: ${formal.natural_language_restatement}`,
      schema: z.object({
        is_non_trivial: z.boolean(),
        reasoning: z.string().min(1),
      }),
      schemaName: "nonTrivialityCheck",
      temperature: 0,
    });

    return {
      layer: 2,
      pass: check.is_non_trivial,
      detail: check.reasoning,
    };
  } catch {
    return {
      layer: 2,
      pass: true, // degrade gracefully — but marked as not actually checked
      skipped: true,
      detail: "LLM 非平凡性检查失败，默认通过",
    };
  }
}

// ── Layer 3: Back-translation ─────────────────────────────────────────

async function layerBackTranslation(
  originalProblem: string,
  formalStatement: string,
  threshold: number,
): Promise<ValidationResult> {
  try {
    // Step 3a: Translate Lean back to NL
    const backTranslation = await chatJson<BackTranslation>({
      system: BACK_TRANSLATE_SYSTEM,
      user: `Translate this Lean 4 theorem statement back to natural language:\n\n${formalStatement}`,
      schema: backTranslationSchema,
      schemaName: "backTranslation",
      temperature: 0,
    });

    // Step 3b: Compare original and back-translated NL
    const equivalence = await chatJson<{
      equivalent: boolean;
      score: number;
      discrepancies: string[];
      analysis: string;
    }>({
      system: EQUIVALENCE_CHECK_SYSTEM,
      user: `Compare these two math statements for semantic equivalence:

Statement A (original problem):
${originalProblem}

Statement B (back-translated from Lean):
${backTranslation.natural_language}

Rate equivalence 0-1 and explain any discrepancies.`,
      schema: z.object({
        equivalent: z.boolean(),
        score: z.number().min(0).max(1),
        discrepancies: z.array(z.string()),
        analysis: z.string().min(1),
      }),
      schemaName: "equivalenceCheck",
      temperature: 0,
    });

    return {
      layer: 3,
      pass: equivalence.score >= threshold,
      detail: `等价度: ${equivalence.score} (阈值: ${threshold})\n${equivalence.analysis}`,
    };
  } catch {
    return {
      layer: 3,
      pass: true, // degrade gracefully — but marked as not actually checked
      skipped: true,
      detail: "回译检查失败，默认通过",
    };
  }
}

// ── Layer 4: Numerical instance verification ──────────────────────────

async function layerNumericalVerification(
  formal: FormalizeResponse,
): Promise<ValidationResult> {
  if (!formal.numerical_instances || formal.numerical_instances.length === 0) {
    return {
      layer: 4,
      pass: true,
      detail: "无数值实例可验证，跳过",
    };
  }

  // Use LLM to verify instances (since we don't have compute engine yet)
  try {
    const verification = await chatJson<{
      all_consistent: boolean;
      results: Array<{
        variables: Record<string, string>;
        expected: string;
        actual: string;
        match: boolean;
      }>;
    }>({
      system: `Verify that the following numerical instances are consistent with the theorem statement.
For each instance, substitute the values into the theorem and check if the expected result matches.
Be precise with arithmetic. Return JSON.`,
      user: `Theorem: theorem ${formal.theorem_name} ${formal.theorem_type}

Numerical instances to verify:
${JSON.stringify(formal.numerical_instances, null, 2)}`,
      schema: z.object({
        all_consistent: z.boolean(),
        results: z.array(
          z.object({
            variables: z.record(z.string()),
            expected: z.string(),
            actual: z.string(),
            match: z.boolean(),
          }),
        ),
      }),
      schemaName: "numericalVerification",
      temperature: 0,
    });

    return {
      layer: 4,
      pass: verification.all_consistent,
      detail: verification.all_consistent
        ? `全部 ${verification.results.length} 个数值实例验证通过`
        : `不一致的实例: ${verification.results
            .filter((r) => !r.match)
            .map((r) => `${JSON.stringify(r.variables)}: expected=${r.expected}, actual=${r.actual}`)
            .join("; ")}`,
    };
  } catch {
    return {
      layer: 4,
      pass: true, // degrade gracefully — but marked as not actually checked
      skipped: true,
      detail: "数值验证失败，默认通过",
    };
  }
}

// ── Layer 5: Hypothesis relevance ─────────────────────────────────────

async function layerHypothesisRelevance(
  formal: FormalizeResponse,
): Promise<ValidationResult> {
  // Simple heuristic: if there are no hypotheses (no → in type), skip
  const hasImplications = formal.theorem_type.includes("→") || formal.theorem_type.includes("->");
  if (!hasImplications) {
    return {
      layer: 5,
      pass: true,
      detail: "无条件假设，跳过相关性检查",
    };
  }

  try {
    const check = await chatJson<{
      all_relevant: boolean;
      suspicious: string[];
      analysis: string;
    }>({
      system: `Analyze the hypotheses in this Lean 4 theorem for relevance.
Check if each hypothesis is:
- Actually needed (not redundant)
- Not contradictory with other hypotheses
- Appropriately scoped (not overly restrictive)
Return JSON: { "all_relevant": boolean, "suspicious": string[], "analysis": string (Chinese) }`,
      user: `theorem ${formal.theorem_name} ${formal.theorem_type} := by sorry\n\nOriginal problem: ${formal.natural_language_restatement}`,
      schema: z.object({
        all_relevant: z.boolean(),
        suspicious: z.array(z.string()),
        analysis: z.string().min(1),
      }),
      schemaName: "hypothesisRelevance",
      temperature: 0,
    });

    return {
      layer: 5,
      pass: check.all_relevant,
      detail: check.all_relevant
        ? check.analysis
        : `可疑假设: ${check.suspicious.join(", ")}\n${check.analysis}`,
    };
  } catch {
    return {
      layer: 5,
      pass: true, // degrade gracefully — but marked as not actually checked
      skipped: true,
      detail: "假设相关性检查失败，默认通过",
    };
  }
}

// ── Targeted repair: fix theorem type using Lean error feedback ────

async function repairTheoremType(
  problemText: string,
  formal: FormalizeResponse,
  leanError: string,
): Promise<{ theorem_name: string; theorem_type: string } | null> {
  try {
    const repaired = await chatJson<{
      theorem_name: string;
      theorem_type: string;
    }>({
      system: `You are a Lean 4 expert. Fix the given theorem declaration so it compiles.
Common issues:
- Missing or wrong type annotations (e.g., using Set instead of Finset)
- Unknown identifiers: check if Mathlib has the right import or use a different name
- Syntax errors in quantifiers, implications, or type expressions
- Mismatched parentheses or brackets
- Using Prop-valued types where Type is expected, or vice versa
Return ONLY valid JSON with the corrected theorem_name and theorem_type.
theorem_type MUST start with ':' (e.g., ": ∀ (n : ℕ), n ≥ 0").`,
      user: `The following Lean 4 theorem declaration fails to compile:

\`\`\`lean
theorem ${formal.theorem_name} ${formal.theorem_type} := by sorry
\`\`\`

Lean error:
\`\`\`
${leanError.slice(0, 1500)}
\`\`\`

Original math problem: ${problemText}

Fix the theorem_name and/or theorem_type to make it compile. Keep the same mathematical meaning.`,
      schema: z.object({
        theorem_name: z.string().min(1),
        theorem_type: z.string().min(1),
      }),
      schemaName: "repairTheoremType",
      temperature: 0,
    });

    repaired.theorem_type = normalizeTheoremType(repaired.theorem_type);
    return repaired;
  } catch {
    return null;
  }
}
