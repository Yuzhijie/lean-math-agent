import {
  SymPyBridge,
  type SolveResponse,
  type SubstituteResponse,
  type ValidateRootResponse,
  type VietaResponse,
} from "./sympy-bridge";
import { compileArith, type ArithEvaluator } from "./safe-arith";

export interface ComputeResult {
  expression: string;
  result: string;
  steps?: string[];
  engine: "sympy" | "llm_fallback";
}

export interface SolveResult {
  solutions: Record<string, string>[];
  engine: "sympy" | "llm_fallback";
  error?: string;
}

export interface SubstituteResult {
  result: string;
  result_decimal: string;
  engine: "sympy" | "llm_fallback";
  error?: string;
}

export interface ValidateRootResult {
  is_valid: boolean;
  equation_residuals: string[];
  constraint_checks: Array<{
    constraint: string;
    satisfied: boolean;
    error?: string;
  }>;
  engine: "sympy" | "llm_fallback";
  error?: string;
}

export interface VietaResult {
  degree: number;
  sum_of_roots: string;
  product_of_roots: string;
  coefficients: string[];
  roots?: string[];
  engine: "sympy" | "llm_fallback";
  error?: string;
}

/**
 * Compute engine that delegates to SymPy/SageMath when available,
 * falls back to LLM-based computation.
 */
export class ComputeEngine {
  private sympy: SymPyBridge | null;

  constructor() {
    const url = process.env.COMPUTE_ENGINE_URL;
    this.sympy = url ? new SymPyBridge(url) : null;
  }

  /**
   * Evaluate a mathematical expression.
   */
  async evaluate(expression: string): Promise<ComputeResult> {
    if (this.sympy) {
      try {
        const result = await this.sympy.evaluate(expression);
        return { expression, result, engine: "sympy" };
      } catch {
        // Fall through to LLM fallback
      }
    }
    return { expression, result: "[compute engine unavailable]", engine: "llm_fallback" };
  }

  /**
   * Simplify a mathematical expression.
   */
  async simplify(expression: string): Promise<string> {
    if (this.sympy) {
      try {
        return await this.sympy.simplify(expression);
      } catch {
        // Fall through
      }
    }
    return expression; // no simplification available
  }

  /**
   * Verify a mathematical claim.
   */
  async verify(claim: string): Promise<boolean | null> {
    if (this.sympy) {
      try {
        return await this.sympy.verify(claim);
      } catch {
        // Fall through
      }
    }
    return null; // cannot verify
  }

  /**
   * Check if the compute engine is available.
   */
  async isAvailable(): Promise<boolean> {
    if (!this.sympy) return false;
    try {
      await this.sympy.evaluate("1 + 1");
      return true;
    } catch {
      return false;
    }
  }

  // ── New methods ───────────────────────────────────────────────────

  /**
   * Solve equations symbolically.
   */
  async solveEquations(args: {
    equations: string[];
    variables: string[];
    domain?: string;
  }): Promise<SolveResult> {
    if (this.sympy) {
      try {
        const resp = await this.sympy.solve(args);
        if (resp.error) {
          return { solutions: [], engine: "sympy", error: resp.error };
        }
        return { solutions: resp.solutions, engine: "sympy" };
      } catch {
        // Fall through
      }
    }
    return { solutions: [], engine: "llm_fallback", error: "[compute engine unavailable]" };
  }

  /**
   * Substitute values into an expression.
   */
  async substituteValues(args: {
    expression: string;
    values: Record<string, string>;
  }): Promise<SubstituteResult> {
    if (this.sympy) {
      try {
        const resp = await this.sympy.substitute(args);
        if (resp.error) {
          return { result: "", result_decimal: "", engine: "sympy", error: resp.error };
        }
        return { result: resp.result, result_decimal: resp.result_decimal, engine: "sympy" };
      } catch {
        // Fall through
      }
    }
    return { result: "", result_decimal: "", engine: "llm_fallback", error: "[compute engine unavailable]" };
  }

  /**
   * Validate a root by substituting into original equations and checking constraints.
   */
  async validateRoot(args: {
    root: Record<string, string>;
    original_equations: string[];
    constraints?: string[];
  }): Promise<ValidateRootResult> {
    if (this.sympy) {
      try {
        const resp = await this.sympy.validateRoot(args);
        return {
          is_valid: resp.is_valid,
          equation_residuals: resp.equation_residuals,
          constraint_checks: resp.constraint_checks,
          engine: "sympy",
        };
      } catch {
        // Fall through
      }
    }
    return {
      is_valid: false,
      equation_residuals: [],
      constraint_checks: [],
      engine: "llm_fallback",
      error: "[compute engine unavailable]",
    };
  }

  /**
   * Compute terms of a recurrence relation.
   */
  async computeRecurrence(args: {
    recurrence: string;
    initial_values: string[];
    num_terms: number;
    parameters?: Record<string, string>;
  }): Promise<{ terms: string[]; all_integers: boolean; error?: string }> {
    if (this.sympy) {
      try {
        const resp = await this.sympy.recurrence(args);
        return {
          terms: resp.terms,
          all_integers: resp.all_integers,
          error: resp.error,
        };
      } catch {
        // Fall through
      }
    }
    return { terms: [], all_integers: false, error: "[compute engine unavailable]" };
  }

  /**
   * Check if values are all perfect squares.
   */
  async checkPerfectSquares(args: {
    values: string[];
  }): Promise<{ all_perfect_squares: boolean; non_squares: string[]; first_failure_index: number | null; error?: string }> {
    if (this.sympy) {
      try {
        const resp = await this.sympy.checkPerfectSquares(args);
        return {
          all_perfect_squares: resp.all_perfect_squares,
          non_squares: resp.non_squares,
          first_failure_index: resp.first_failure_index,
          error: resp.error,
        };
      } catch {
        // Fall through
      }
    }
    return { all_perfect_squares: false, non_squares: [], first_failure_index: null, error: "[compute engine unavailable]" };
  }

  /**
   * Compute terms of a recurrence relation using exact BigInt arithmetic.
   *
   * Unlike `computeRecurrence` (which delegates to SymPy), this method runs
   * entirely in-process with JavaScript BigInt, so it works without a
   * running compute server and never has floating-point rounding issues.
   *
   * @param recurrence  Formula using a1 (most recent), a2, a3, ... and the
   *                    parameter name, e.g. "m*(a1 + a2) - a3"
   * @param initialValues  Seed terms, e.g. [1, 1, 4]
   * @param parameterValue  Concrete value for the parameter
   * @param parameterName  Symbol name in the formula (default "m")
   * @param numTerms  Total number of terms to produce (including seeds)
   */
  async computeSequenceTerms(args: {
    recurrence: string;
    initialValues: number[];
    parameterValue: number;
    parameterName?: string;
    numTerms: number;
  }): Promise<{ terms: string[]; allIntegers: boolean; error?: string }> {
    const paramName = args.parameterName ?? "m";
    const order = args.initialValues.length;
    const terms: bigint[] = args.initialValues.map((v) => BigInt(v));

    // The recurrence is LLM output derived from user text: compile it with
    // the restricted arithmetic parser (integers, `m`, `a1..aN`, + - * /)
    // instead of `new Function`, which allowed arbitrary code execution.
    const paramNames = [paramName, ...Array.from({ length: order }, (_, i) => `a${i + 1}`)];
    let evalFn: ArithEvaluator;
    try {
      evalFn = compileArith(args.recurrence, paramNames);
    } catch (e) {
      return { terms: [], allIntegers: false, error: `Invalid recurrence formula: ${e instanceof Error ? e.message : String(e)}` };
    }

    let allIntegers = true;
    for (let i = order; i < args.numTerms; i++) {
      try {
        const vars: Record<string, bigint> = { [paramName]: BigInt(args.parameterValue) };
        for (let j = 1; j <= order; j++) {
          vars[`a${j}`] = terms[i - j]!;
        }
        const { value, exact } = evalFn(vars);
        if (!exact) allIntegers = false;
        terms.push(value);
      } catch (e) {
        return {
          terms: terms.map(String),
          allIntegers: false,
          error: `Failed computing term ${i}: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }

    return { terms: terms.map(String), allIntegers };
  }

  /**
   * Apply Vieta's formulas to a polynomial.
   */
  async applyVieta(args: {
    polynomial: string;
    variable: string;
  }): Promise<VietaResult> {
    if (this.sympy) {
      try {
        const resp = await this.sympy.vieta(args);
        if (resp.error) {
          return {
            degree: 0,
            sum_of_roots: "",
            product_of_roots: "",
            coefficients: [],
            engine: "sympy",
            error: resp.error,
          };
        }
        return {
          degree: resp.degree,
          sum_of_roots: resp.sum_of_roots,
          product_of_roots: resp.product_of_roots,
          coefficients: resp.coefficients,
          roots: resp.roots,
          engine: "sympy",
        };
      } catch {
        // Fall through
      }
    }
    return {
      degree: 0,
      sum_of_roots: "",
      product_of_roots: "",
      coefficients: [],
      engine: "llm_fallback",
      error: "[compute engine unavailable]",
    };
  }
}

// ── Exported utilities ──────────────────────────────────────────────────

/**
 * Check if a BigInt is a perfect square using Newton's method.
 * Exact — no floating-point rounding.
 */
export function isPerfectSquareBigInt(n: bigint): { isSquare: boolean; sqrt: string } {
  const ZERO = BigInt(0);
  const ONE = BigInt(1);
  const TWO = BigInt(2);
  if (n < ZERO) return { isSquare: false, sqrt: "N/A" };
  if (n === ZERO) return { isSquare: true, sqrt: "0" };
  if (n === ONE) return { isSquare: true, sqrt: "1" };

  // Newton's method for integer square root
  let x = n;
  let y = (x + ONE) / TWO;
  while (y < x) {
    x = y;
    y = (x + n / x) / TWO;
  }
  // x is now the floor of sqrt(n)
  if (x * x === n) {
    return { isSquare: true, sqrt: x.toString() };
  }
  return { isSquare: false, sqrt: `≈${x.toString()}` };
}

/**
 * Convert a math expression string to use BigInt literals.
 *
 * Replaces standalone integer tokens (e.g. `2`, `10`) with `BigInt("2")`,
 * `BigInt("10")`, etc.  Variable names and operators are left untouched.
 *
 * @deprecated No longer used by the engine (formulas are evaluated by the
 * restricted parser in `safe-arith.ts`, never by `new Function`). Kept only
 * for backward compatibility of the exported API.
 */
export function convertToBigIntExpr(formula: string): string {
  return formula.replace(/\b(\d+)\b/g, (_match, num: string) => `BigInt("${num}")`);
}
