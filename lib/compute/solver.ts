import { ComputeEngine } from "./engine";
import {
  crossValidateMethods,
  type MethodResult,
  type CrossValidationResult,
} from "./cross-validate";
import { setupEquations, type EquationSetup } from "../llm/equation-setup";
import { chatJson } from "../llm/client";
import { lt } from "../llm/output-locale";
import { z } from "zod";
import { orderCheck } from "./order-check";
import {
  CROSS_VALIDATION_SYSTEM,
  SOLUTION_EXPLAINER_SYSTEM,
} from "../llm/compute-prompts";

// ── Types ─────────────────────────────────────────────────────────────

export interface ComputeSolution {
  answer: string;
  answer_exact: string;
  answer_decimal: string;
  cross_validated: boolean;
  confidence: number;
  methods_used: string[];
  solution_steps: string[];
  method_results: MethodResult[];
  validation: CrossValidationResult;
  equation_setup: EquationSetup;
  sympy_available: boolean;
  /** What the program checks found (an answer corrected by exact computation, answers that disagreed). */
  checks: string[];
}

export interface SolverOptions {
  skip_cross_validation?: boolean;
  decimal_precision?: number;
}

// ── Main Solver ───────────────────────────────────────────────────────

/**
 * Solve a computational math problem end-to-end.
 *
 * Flow:
 * 1. LLM sets up equations from word problem
 * 2. Method 1: Explicit solve via SymPy → validate roots → compute target
 * 3. Method 2: Vieta's formulas (for polynomial problems)
 * 4. Cross-validate results from both methods
 * 5. Generate Chinese step-by-step explanation
 */
export async function solveComputational(args: {
  problemText: string;
  options?: SolverOptions;
}): Promise<ComputeSolution> {
  const engine = new ComputeEngine();
  const sympyAvailable = await engine.isAvailable();

  // Step 1: Set up equations via LLM
  const setup = await setupEquations(args.problemText);

  // Step 2: Solve using available methods
  const methodResults: MethodResult[] = [];

  if (sympyAvailable) {
    // Method 1: Explicit solve
    const explicitResult = await solveExplicit(engine, setup);
    if (explicitResult) {
      methodResults.push(explicitResult);
    }

    // Method 2: Vieta's formulas (for polynomial problems)
    const hasVietaMethod = setup.solution_methods.some(
      (m) => m.name === "vieta",
    );
    if (hasVietaMethod) {
      const vietaResult = await solveVieta(engine, setup);
      if (vietaResult) {
        methodResults.push(vietaResult);
      }
    }
  }

  // Step 3: Cross-validate (or use LLM fallback)
  let validation: CrossValidationResult;

  if (methodResults.length === 0 && !sympyAvailable) {
    // LLM fallback when SymPy is unavailable
    validation = await llmFallbackSolve(args.problemText, setup);
  } else if (
    methodResults.length > 0 &&
    !args.options?.skip_cross_validation
  ) {
    validation = crossValidateMethods(methodResults);
  } else if (methodResults.length > 0) {
    // Cross-validation skipped
    validation = {
      methods_agree: true,
      final_answer: methodResults[0].target_value,
      final_answer_decimal: methodResults[0].target_decimal,
      confidence: 0.7,
      max_discrepancy: 0,
      method_results: methodResults,
    };
  } else {
    // SymPy available but no methods produced results
    validation = {
      methods_agree: false,
      final_answer: "",
      final_answer_decimal: NaN,
      confidence: 0,
      max_discrepancy: Infinity,
      method_results: [],
    };
  }

  // Step 3b: exact program checks. A question the program can settle (smallest n with
  // a^n ≡ 1 mod m, …) gets the program's answer, whatever the methods above said.
  const checks: string[] = [];
  let programNote: string | undefined;
  const order = orderCheck(args.problemText);
  if (order?.answer !== undefined) {
    const exact = order.answer.toString();
    const agreed = sameAnswer(validation.final_answer, exact);
    const detail = order.congruences.map((c, i) => `ord_${c.modulus}(${c.base}) = ${order.orders[i]}`).join(", ");
    programNote = `Exact computation by the program: ${detail}; the smallest n is their lcm = ${exact}.`;
    const result: MethodResult = { method_name: "order_lcm", target_value: exact, target_decimal: Number(exact), details: { orders: detail } };
    methodResults.push(result);
    if (!agreed && validation.final_answer) {
      checks.push(
        lt(
          `程序按乘法阶精确计算（${detail}，最小公倍数 ${exact}），更正了先前得到的答案 ${validation.final_answer}`,
          `The program computed the orders exactly (${detail}, lcm ${exact}) and corrected the earlier answer ${validation.final_answer}`,
        ),
      );
    }
    validation = {
      ...validation,
      methods_agree: true,
      final_answer: exact,
      final_answer_decimal: Number(exact),
      confidence: 1,
      method_results: [...validation.method_results, result],
    };
  }

  // Step 4: Generate explanation
  let steps = await generateExplanation(args.problemText, setup, validation, programNote);

  // Step 5: the explanation re-derives the answer; when it ends with a different one and no
  // program check settled it, an independent careful check decides between the two.
  const explained = boxedAnswer(steps);
  const crossChecked = validation.methods_agree && methodResults.length >= 2;
  if (!programNote && !crossChecked && explained && validation.final_answer && !sameAnswer(explained, validation.final_answer)) {
    const decided = await resolveConflict(args.problemText, validation.final_answer, explained);
    checks.push(
      lt(
        `求解得到 ${validation.final_answer}，讲解推导出 ${explained}，两者不一致；复核后采用 ${decided ?? validation.final_answer}`,
        `Solving gave ${validation.final_answer} but the explanation derived ${explained}; after a re-check the answer is ${decided ?? validation.final_answer}`,
      ),
    );
    if (decided && !sameAnswer(decided, validation.final_answer)) {
      const d = parseFloat(decided);
      validation = { ...validation, methods_agree: false, final_answer: decided, final_answer_decimal: isNaN(d) ? NaN : d, confidence: Math.min(validation.confidence, 0.5) };
      steps = await generateExplanation(args.problemText, setup, validation);
    } else {
      validation = { ...validation, methods_agree: false, confidence: Math.min(validation.confidence, 0.5) };
    }
  }

  return {
    answer: validation.final_answer,
    answer_exact: validation.final_answer,
    answer_decimal: Number.isFinite(validation.final_answer_decimal)
      ? formatDecimal(
          validation.final_answer_decimal,
          args.options?.decimal_precision ?? 6,
        )
      : "N/A",
    // An exact program check counts as verified on its own.
    cross_validated: programNote !== undefined || (validation.methods_agree && methodResults.length >= 2),
    confidence: validation.confidence,
    methods_used: methodResults.map((r) => r.method_name),
    solution_steps: steps,
    method_results: methodResults,
    validation,
    equation_setup: setup,
    sympy_available: sympyAvailable,
    checks,
  };
}

/** The last `\\boxed{…}` in the steps (the explanation's own final answer). */
export function boxedAnswer(steps: string[]): string | undefined {
  const text = steps.join("\n");
  let last: string | undefined;
  for (let i = text.indexOf("\\boxed{"); i >= 0; i = text.indexOf("\\boxed{", i + 1)) {
    let depth = 0;
    const start = i + "\\boxed{".length;
    for (let j = start - 1; j < text.length; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}" && --depth === 0) {
        last = text.slice(start, j).trim();
        break;
      }
    }
  }
  return last;
}

/** Same answer up to spacing, `$`, thousands separators and trailing punctuation. */
export function sameAnswer(a: string, b: string): boolean {
  const n = (x: string) =>
    x
      .replace(/\$|\s|,|，|\\,|\\[;!]|\.$|。$/g, "")
      .replace(/\\boxed\{(.*)\}/, "$1")
      .replace(/\\[dt]?frac\{([^{}]+)\}\{([^{}]+)\}/g, "($1)/($2)")
      .replace(/\((-?\d+(?:\.\d+)?)\)/g, "$1");
  const x = n(a);
  const y = n(b);
  if (x === y) return true;
  const num = (t: string) => (/^-?\d+(?:\.\d+)?(?:\/-?\d+(?:\.\d+)?)?$/.test(t) ? t.split("/").map(Number).reduce((p, q) => p / q) : NaN);
  const u = num(x);
  const v = num(y);
  return Number.isFinite(u) && Number.isFinite(v) && Math.abs(u - v) <= 1e-9 * Math.max(1, Math.abs(u));
}

/** Two candidate answers: a careful independent check says which one is right (undefined when it cannot). */
async function resolveConflict(problemText: string, a: string, b: string): Promise<string | undefined> {
  try {
    const r = await chatJson({
      system:
        "You are a careful mathematician. Two candidate answers to a problem disagree. Solve the problem yourself, check each candidate concretely against every condition (and minimality / completeness when asked), and say which is correct. If neither is, give the correct answer.",
      user: `Problem: ${problemText}\n\nCandidate A: ${a}\nCandidate B: ${b}`,
      schema: z.object({ answer: z.string().min(1), reason: z.string() }),
      schemaName: "answerConflict",
      reasoningEffort: "high",
    });
    return r.answer.trim();
  } catch {
    return undefined;
  }
}

// ── Method 1: Explicit Solve ──────────────────────────────────────────

async function solveExplicit(
  engine: ComputeEngine,
  setup: EquationSetup,
): Promise<MethodResult | null> {
  // Build equation strings: "lhs = rhs" or just "lhs - rhs" (=0)
  const eqStrings = setup.equations.map((eq) => `${eq.lhs} = ${eq.rhs}`);
  const varNames = setup.variables.map((v) => v.name);
  const domain = setup.variables[0]?.domain ?? "real";

  // Solve
  const solveResult = await engine.solveEquations({
    equations: eqStrings,
    variables: varNames,
    domain,
  });

  if (solveResult.error || solveResult.solutions.length === 0) {
    return null;
  }

  // Validate each root against ORIGINAL equations
  const validRoots: Record<string, string>[] = [];
  const origEqStrings = setup.equations.map((eq) => `${eq.lhs} = ${eq.rhs}`);

  for (const root of solveResult.solutions) {
    const validation = await engine.validateRoot({
      root,
      original_equations: origEqStrings,
      constraints: setup.constraints,
    });

    if (validation.is_valid) {
      validRoots.push(root);
    }
  }

  if (validRoots.length === 0) {
    return null;
  }

  // Compute target expression by substituting each valid root
  // and summing (if the target is a sum) or using the first root's value
  const targetValues: string[] = [];
  const targetDecimals: number[] = [];

  for (const root of validRoots) {
    const sub = await engine.substituteValues({
      expression: setup.target_expression,
      values: root,
    });

    if (!sub.error) {
      targetValues.push(sub.result);
      targetDecimals.push(parseFloat(sub.result_decimal));
    }
  }

  // If target is a sum of all valid roots, compute the sum
  let finalValue: string;
  let finalDecimal: number;

  if (
    setup.target_description.includes("和") ||
    setup.target_description.includes("sum")
  ) {
    // Sum all valid root values
    const sumExpr = targetValues.join(" + ");
    const sumResult = await engine.substituteValues({
      expression: sumExpr,
      values: {},
    });
    finalValue = sumResult.error ? targetValues[0] : sumResult.result;
    finalDecimal = targetDecimals.reduce((a, b) => a + b, 0);
  } else {
    finalValue = targetValues[0] ?? "";
    finalDecimal = targetDecimals[0] ?? NaN;
  }

  const rootStrings = validRoots.map((r) => {
    const vals = Object.values(r);
    return vals.length === 1 ? vals[0] : JSON.stringify(r);
  });

  return {
    method_name: "explicit_solve",
    target_value: finalValue,
    target_decimal: finalDecimal,
    valid_roots: rootStrings,
    details: {
      total_roots: String(solveResult.solutions.length),
      valid_roots: String(validRoots.length),
    },
  };
}

// ── Method 2: Vieta's Formulas ────────────────────────────────────────

async function solveVieta(
  engine: ComputeEngine,
  setup: EquationSetup,
): Promise<MethodResult | null> {
  // Vieta only works for single-variable polynomial equations
  if (setup.variables.length !== 1) return null;

  const varName = setup.variables[0].name;

  // Build polynomial: lhs - rhs = 0
  const polyExpr = setup.equations
    .map((eq) => `(${eq.lhs}) - (${eq.rhs})`)
    .join(" + ");

  // First, we need to expand and get the polynomial form
  // Use substitute to simplify
  const simplified = await engine.substituteValues({
    expression: polyExpr,
    values: {},
  });

  if (simplified.error) return null;

  const vietaResult = await engine.applyVieta({
    polynomial: simplified.result,
    variable: varName,
  });

  if (vietaResult.error || vietaResult.degree === 0) return null;

  const sumOfRoots = vietaResult.sum_of_roots;

  // Get decimal value
  const subResult = await engine.substituteValues({
    expression: sumOfRoots,
    values: {},
  });

  const decimal = subResult.error
    ? parseFloat(sumOfRoots)
    : parseFloat(subResult.result_decimal);

  return {
    method_name: "vieta",
    target_value: sumOfRoots,
    target_decimal: decimal,
    details: {
      degree: String(vietaResult.degree),
      sum_of_roots: vietaResult.sum_of_roots,
      product_of_roots: vietaResult.product_of_roots,
      coefficients: vietaResult.coefficients.join(", "),
    },
  };
}

// ── LLM Fallback ──────────────────────────────────────────────────────

async function llmFallbackSolve(
  problemText: string,
  setup: EquationSetup,
): Promise<CrossValidationResult> {
  const llmSchema = z.object({
    valid_roots: z.array(z.string()),
    extraneous_roots: z.array(z.string()),
    final_answer: z.string(),
    final_answer_decimal: z.string(),
    verification_details: z.string().min(1),
  });

  const equationsDesc = setup.equations
    .map((eq) => `${eq.lhs} = ${eq.rhs} (${eq.description})`)
    .join("\n");

  const constraintsDesc = setup.constraints.join(", ");

  try {
    const result = await chatJson({
      system: CROSS_VALIDATION_SYSTEM,
      user: `Problem: ${problemText}

Equations:
${equationsDesc}

Constraints: ${constraintsDesc || "none"}

Target: ${setup.target_expression} (${setup.target_description})

Solve this problem, verify all roots against the original equations, and identify any extraneous roots.`,
      schema: llmSchema,
      schemaName: "llmFallbackSolve",
      temperature: 0,
    });

    const decimal = parseFloat(result.final_answer_decimal);

    return {
      methods_agree: true,
      final_answer: result.final_answer,
      final_answer_decimal: isNaN(decimal) ? NaN : decimal,
      confidence: 0.4, // lower confidence for LLM-only
      max_discrepancy: 0,
      method_results: [
        {
          method_name: "llm_fallback",
          target_value: result.final_answer,
          target_decimal: decimal,
          valid_roots: result.valid_roots,
        },
      ],
    };
  } catch {
    return {
      methods_agree: false,
      final_answer: "",
      final_answer_decimal: NaN,
      confidence: 0,
      max_discrepancy: Infinity,
      method_results: [],
    };
  }
}

// ── Explanation Generation ────────────────────────────────────────────

async function generateExplanation(
  problemText: string,
  setup: EquationSetup,
  validation: CrossValidationResult,
  programNote?: string,
): Promise<string[]> {
  const explainerSchema = z.object({
    steps: z.array(z.string().min(1)).min(1),
  });

  try {
    const result = await chatJson({
      system: SOLUTION_EXPLAINER_SYSTEM,
      user: `Problem: ${problemText}

Equations:
${setup.equations.map((eq) => `${eq.lhs} = ${eq.rhs}`).join("\n")}

Solution: ${validation.final_answer} (≈${validation.final_answer_decimal})

Method results:
${validation.method_results.map((r) => `- ${r.method_name}: ${r.target_value}`).join("\n")}
${programNote ? `\n${programNote} This answer is exact; explain how to obtain it.\n` : ""}
Provide a step-by-step explanation of the solution.`,
      schema: explainerSchema,
      schemaName: "solutionExplanation",
      temperature: 0.3,
    });

    return result.steps;
  } catch {
    // Fallback: generate minimal explanation
    return [
      lt(`设${setup.variables.map((v) => v.description).join("、")}`, `Let ${setup.variables.map((v) => v.description).join(", ")}`),
      lt(`建立方程: ${setup.equations.map((eq) => `${eq.lhs} = ${eq.rhs}`).join("; ")}`, `Set up the equations: ${setup.equations.map((eq) => `${eq.lhs} = ${eq.rhs}`).join("; ")}`),
      lt(`求解得到答案: ${validation.final_answer}`, `Solving gives the answer: ${validation.final_answer}`),
    ];
  }
}

// ── Utilities ─────────────────────────────────────────────────────────

function formatDecimal(value: number, precision: number): string {
  if (Number.isInteger(value)) return String(value);
  const formatted = value.toFixed(precision);
  // Remove trailing zeros
  return formatted.replace(/\.?0+$/, "");
}
