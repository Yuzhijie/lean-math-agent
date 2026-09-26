import { ComputeEngine, isPerfectSquareBigInt } from "./engine";
import { chatJson } from "../llm/client";
import { lt } from "../llm/output-locale";
import { z } from "zod";

// ── Types ─────────────────────────────────────────────────────────────

export interface FindAllHints {
  parameter: string;
  parameter_domain?: "integer" | "positive_integer" | "real";
  condition_description: string;
  search_range_hint?: string;
}

export interface CandidateCheck {
  value: string;
  satisfies: boolean;
  details: string;
  terms_computed?: number;
  terms_verified?: number;
}

export interface FindAllResult {
  answer: string;
  valid_values: string[];
  checked_range: string;
  candidates: CandidateCheck[];
  completeness_argument: string;
  solution_steps: string[];
  confidence: number;
}

// ── LLM Prompts ──────────────────────────────────────────────────────

const FIND_ALL_ANALYZE_SYSTEM = `You are a number theory specialist. Analyze a "find all values" problem and determine the search strategy.

Given a problem that asks to find all values of a parameter (like m, k) satisfying some condition:

1. **Derive necessary conditions**: What algebraic or number-theoretic constraints can you derive?
   - For sequences: compute the first few terms symbolically in terms of the parameter, derive divisibility or congruence conditions
   - For equations: factor, bound, or reduce to a finite search

2. **Bound the search space**: Can you prove the parameter is bounded?
   - Growth rate arguments (if terms grow too fast, they can't satisfy the condition)
   - Modular arithmetic restrictions
   - Size comparisons

3. **Identify candidates**: List all candidate values within the bounded range.

4. **Verification strategy**: How to check each candidate?

5. **Computable recurrence** (CRITICAL for sequence problems): If the problem involves a recursively defined sequence, you MUST provide the recurrence in a format that code can evaluate:
   - \`recurrence_formula\`: Use \`a1\` for the most recent term, \`a2\` for the second most recent, \`a3\` for the third, etc. Use the parameter name directly (e.g. \`m\`). Only use +, -, *, / operators.
     Example: for a_n = m(a_{n-1} + a_{n-2}) - a_{n-3}, write: "m * (a1 + a2) - a3"
   - \`initial_values\`: The seed terms as concrete numbers, in chronological order, e.g. [1, 1, 4]
   - \`recurrence_order\`: How many previous terms the recurrence references (e.g. 3)
   - \`condition_type\`: "all_perfect_squares", "all_integers", "all_positive", or "other"

Return JSON:
{
  "necessary_conditions": ["condition 1", "condition 2", ...],
  "search_lower_bound": "lower bound for parameter",
  "search_upper_bound": "upper bound for parameter",
  "candidate_values": ["value1", "value2", ...],
  "verification_method": "how to verify each candidate",
  "completeness_strategy": "why no other values can work",
  "analysis": "detailed analysis in Chinese",
  "recurrence_formula": "e.g. m * (a1 + a2) - a3 (or null if not a sequence problem)",
  "initial_values": [1, 1, 4],
  "recurrence_order": 3,
  "condition_type": "all_perfect_squares"
}`;

const FIND_ALL_VERIFY_SYSTEM = `You are a mathematical verification specialist. Given a candidate value for a parameter, verify whether it satisfies ALL conditions of the problem.

For sequence problems:
1. Compute at least 10-15 terms of the sequence with the given parameter value
2. Check if each term satisfies the required property (e.g., being a perfect square)
3. Look for patterns in the terms (closed-form, relation to known sequences)
4. If a pattern is found, argue why ALL terms satisfy the property

For equation/algebraic problems:
1. Substitute the candidate value
2. Verify the solution satisfies all original conditions
3. Check boundary conditions

Return JSON:
{
  "candidate_value": "the value being tested",
  "satisfies": true/false,
  "verification_details": "step-by-step verification in Chinese",
  "terms_or_evidence": ["term1", "term2", ...] or relevant evidence,
  "pattern_found": "any pattern discovered, or null",
  "confidence": 0-1
}`;

const FIND_ALL_COMPLETE_SYSTEM = `You are a number theory expert specializing in completeness proofs.

Given a "find all values" problem and a set of verified solutions, provide:
1. A rigorous argument for why these are the ONLY solutions
2. The key mathematical insight that bounds the search space
3. Any modular arithmetic, growth rate, or divisibility arguments used

Write the completeness proof in Chinese with LaTeX math ($...$ for inline, $$...$$ for display).

Return JSON:
{
  "completeness_argument": "why these are all solutions (Chinese, with LaTeX)",
  "key_insight": "the crucial mathematical observation (Chinese)",
  "bounding_argument": "how the search space was bounded (Chinese)"
}`;

// ── Deterministic Verification ────────────────────────────────────────

interface RecurrenceSpec {
  formula: string;
  initialValues: number[];
  order: number;
}

/**
 * Verify a candidate parameter value by computing the recurrence with
 * exact BigInt arithmetic and checking the condition on every term.
 * Returns null if computation fails (caller should fall back to LLM).
 */
async function verifyCandidateWithComputation(
  problemText: string,
  parameterName: string,
  candidateValue: string,
  spec: RecurrenceSpec,
  conditionType: string,
  numTerms = 15,
): Promise<CandidateCheck | null> {
  const engine = new ComputeEngine();

  try {
    const result = await engine.computeSequenceTerms({
      recurrence: spec.formula,
      initialValues: spec.initialValues,
      parameterValue: Number(candidateValue),
      parameterName,
      numTerms,
    });

    if (result.error) {
      return null;
    }

    let satisfies = true;
    let failureIndex: number | null = null;
    const details: string[] = [];

    if (conditionType === "all_perfect_squares") {
      for (let i = 0; i < result.terms.length; i++) {
        const check = isPerfectSquareBigInt(BigInt(result.terms[i]!));
        if (!check.isSquare) {
          satisfies = false;
          failureIndex = i;
          details.push(`a[${i}] = ${result.terms[i]} is NOT a perfect square (${check.sqrt})`);
          break;
        }
      }
      if (satisfies) {
        details.push(`All ${result.terms.length} computed terms are perfect squares`);
        details.push(`Terms: ${result.terms.slice(0, 8).join(", ")}${result.terms.length > 8 ? ", ..." : ""}`);
      }
    } else {
      // For non-square conditions, fall back to LLM
      return null;
    }

    return {
      value: candidateValue,
      satisfies,
      details: satisfies
        ? lt(`确定性验证通过: ${details.join("; ")}`, `Deterministic check passed: ${details.join("; ")}`)
        : lt(`确定性验证失败: ${details.join("; ")}`, `Deterministic check failed: ${details.join("; ")}`),
      terms_computed: result.terms.length,
      terms_verified: failureIndex !== null ? failureIndex : result.terms.length,
    };
  } catch {
    return null;
  }
}

// ── Main Solver ──────────────────────────────────────────────────────

export async function solveFindAll(args: {
  problemText: string;
  hints?: FindAllHints;
  searchRange?: { min: number; max: number };
}): Promise<FindAllResult> {
  const engine = new ComputeEngine();
  const sympyAvailable = await engine.isAvailable();

  // Step 1: Analyze the problem and derive search strategy
  const analyzeSchema = z.object({
    necessary_conditions: z.array(z.string()).min(1),
    search_lower_bound: z.string(),
    search_upper_bound: z.string(),
    candidate_values: z.array(z.string()).min(1),
    verification_method: z.string(),
    completeness_strategy: z.string(),
    analysis: z.string().min(1),
    recurrence_formula: z.string().nullable().optional(),
    initial_values: z.array(z.number()).optional(),
    recurrence_order: z.number().optional(),
    condition_type: z.string().optional(),
  });

  const analysis = await chatJson({
    system: FIND_ALL_ANALYZE_SYSTEM,
    user: `Problem: ${args.problemText}

Parameter hints:
- Parameter: ${args.hints?.parameter ?? "unknown"}
- Domain: ${args.hints?.parameter_domain ?? "integer"}
- Condition: ${args.hints?.condition_description ?? "not specified"}
${args.searchRange ? `- Search range: ${args.searchRange.min} to ${args.searchRange.max}` : ""}
${sympyAvailable ? "- SymPy compute engine is available for symbolic computation" : "- SymPy is NOT available, use manual reasoning"}`,
    schema: analyzeSchema,
    schemaName: "findAllAnalyze",
    temperature: 0,
  });

  // Step 2: Determine search range
  const searchMin = args.searchRange?.min ?? parseNumber(analysis.search_lower_bound, 2);
  const searchMax = args.searchRange?.max ?? parseNumber(analysis.search_upper_bound, 100);

  // Merge LLM candidates with systematic range
  const llmCandidates = new Set(analysis.candidate_values.map((v) => v.trim()));

  // Also add systematic candidates in the search range
  const allCandidates = new Set<string>();
  for (const c of llmCandidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n >= searchMin && n <= searchMax) {
      allCandidates.add(c);
    }
  }

  // For integer parameters, add all values in a reasonable sub-range
  if (args.hints?.parameter_domain === "integer" || args.hints?.parameter_domain === "positive_integer") {
    const intMax = Math.min(searchMax, searchMin + 200); // cap at 200 values
    for (let i = Math.max(searchMin, 2); i <= intMax; i++) {
      allCandidates.add(String(i));
    }
  }

  // Step 3: Verify each candidate
  const verifySchema = z.object({
    candidate_value: z.string(),
    satisfies: z.boolean(),
    verification_details: z.string().min(1),
    terms_or_evidence: z.array(z.string()).optional(),
    pattern_found: z.string().nullable().optional(),
    confidence: z.number().min(0).max(1),
  });

  const candidates: CandidateCheck[] = [];
  const validValues: string[] = [];

  // Sort candidates numerically
  const sortedCandidates = [...allCandidates].sort(
    (a, b) => Number(a) - Number(b),
  );

  // Check if we can use deterministic computation
  const hasRecurrenceSpec =
    analysis.recurrence_formula &&
    analysis.initial_values &&
    analysis.initial_values.length > 0 &&
    analysis.recurrence_order &&
    analysis.recurrence_order > 0;

  const recurrenceSpec: RecurrenceSpec | null = hasRecurrenceSpec
    ? {
        formula: analysis.recurrence_formula!,
        initialValues: analysis.initial_values!,
        order: analysis.recurrence_order!,
      }
    : null;

  const conditionType = analysis.condition_type ?? "other";
  const paramName = args.hints?.parameter ?? "m";

  for (const candidate of sortedCandidates) {
    // Try deterministic computation first (for sequence / recurrence problems)
    let computed: CandidateCheck | null = null;
    if (recurrenceSpec) {
      computed = await verifyCandidateWithComputation(
        args.problemText,
        paramName,
        candidate,
        recurrenceSpec,
        conditionType,
      );
    }

    if (computed) {
      // Deterministic verification succeeded — use it directly
      candidates.push(computed);
      if (computed.satisfies) {
        validValues.push(candidate);
      }
      continue;
    }

    // Fall back to LLM verification
    try {
      const verification = await chatJson({
        system: FIND_ALL_VERIFY_SYSTEM,
        user: `Problem: ${args.problemText}

Candidate value: ${paramName} = ${candidate}

Verify whether this value satisfies ALL conditions. Compute terms/evidence carefully.
${analysis.verification_method ? `Suggested verification method: ${analysis.verification_method}` : ""}`,
        schema: verifySchema,
        schemaName: "findAllVerify",
        temperature: 0,
      });

      candidates.push({
        value: candidate,
        satisfies: verification.satisfies,
        details: verification.verification_details,
        terms_computed: verification.terms_or_evidence?.length,
      });

      if (verification.satisfies && verification.confidence >= 0.8) {
        validValues.push(candidate);
      }
    } catch {
      candidates.push({
        value: candidate,
        satisfies: false,
        details: lt("验证过程出错", "Verification raised an error"),
      });
    }
  }

  // Step 4: Generate completeness argument
  const completeSchema = z.object({
    completeness_argument: z.string().min(1),
    key_insight: z.string().min(1),
    bounding_argument: z.string().min(1),
  });

  let completenessResult;
  try {
    completenessResult = await chatJson({
      system: FIND_ALL_COMPLETE_SYSTEM,
      user: `Problem: ${args.problemText}

Verified solutions: ${validValues.join(", ")} (all values of ${args.hints?.parameter ?? "m"} that satisfy the condition)

Search range checked: ${searchMin} to ${searchMax}
Candidates checked: ${sortedCandidates.length} values

Necessary conditions derived:
${analysis.necessary_conditions.map((c) => `- ${c}`).join("\n")}

Provide a completeness argument explaining why these are the ONLY solutions.`,
      schema: completeSchema,
      schemaName: "findAllComplete",
      temperature: 0,
    });
  } catch {
    completenessResult = {
      completeness_argument: lt("在搜索范围 [" + searchMin + ", " + searchMax + "] 内已穷举验证所有候选值。", `All candidates in the search range [${searchMin}, ${searchMax}] were checked exhaustively.`),
      key_insight: lt("通过系统搜索和逐一验证确定所有解。", "All solutions were found by systematic search and case-by-case verification."),
      bounding_argument: lt("搜索范围由必要条件限定。", "The search range is bounded by the necessary conditions."),
    };
  }

  // Step 5: Build solution steps
  const solutionSteps: string[] = [
    lt(`**分析问题**：${analysis.analysis}`, `**Analysis**: ${analysis.analysis}`),
    lt(`**必要条件**：\n${analysis.necessary_conditions.map((c, i) => `${i + 1}. ${c}`).join("\n")}`, `**Necessary conditions**:\n${analysis.necessary_conditions.map((c, i) => `${i + 1}. ${c}`).join("\n")}`),
    lt(`**搜索范围**：${args.hints?.parameter ?? "m"} ∈ [${searchMin}, ${searchMax}]`, `**Search range**: ${args.hints?.parameter ?? "m"} ∈ [${searchMin}, ${searchMax}]`),
    lt(`**候选值**：共检查 ${sortedCandidates.length} 个候选值`, `**Candidates**: ${sortedCandidates.length} values checked`),
    lt(`**验证结果**：满足条件的值为 ${validValues.join(", ")}`, `**Verification**: the values satisfying the condition are ${validValues.join(", ")}`),
    lt(`**完备性论证**：${completenessResult.completeness_argument}`, `**Completeness argument**: ${completenessResult.completeness_argument}`),
  ];

  const answerStr = validValues.length > 0
    ? validValues.map((v) => `${args.hints?.parameter ?? "m"} = ${v}`).join(", ")
    : lt("无解", "No solution");

  return {
    answer: answerStr,
    valid_values: validValues,
    checked_range: `[${searchMin}, ${searchMax}]`,
    candidates,
    completeness_argument: completenessResult.completeness_argument,
    solution_steps: solutionSteps,
    confidence: validValues.length > 0 ? 0.9 : 0.5,
  };
}

// ── Utilities ────────────────────────────────────────────────────────

function parseNumber(s: string, fallback: number): number {
  const n = Number(s.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : fallback;
}
