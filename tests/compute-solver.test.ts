import { describe, it, expect } from "vitest";
import {
  crossValidateMethods,
  type MethodResult,
} from "@/lib/compute/cross-validate";

// ── Pure function tests (no mocking needed) ─────────────────────────

describe("crossValidateMethods", () => {
  it("returns empty result for no methods", () => {
    const result = crossValidateMethods([]);
    expect(result.methods_agree).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.final_answer).toBe("");
  });

  it("returns moderate confidence for single method", () => {
    const methods: MethodResult[] = [
      {
        method_name: "explicit_solve",
        target_value: "14/5",
        target_decimal: 2.8,
        valid_roots: ["2", "4/5"],
      },
    ];
    const result = crossValidateMethods(methods);
    expect(result.methods_agree).toBe(true);
    expect(result.confidence).toBe(0.5);
    expect(result.final_answer).toBe("14/5");
    expect(result.final_answer_decimal).toBe(2.8);
  });

  it("returns high confidence when two methods agree", () => {
    const methods: MethodResult[] = [
      {
        method_name: "explicit_solve",
        target_value: "14/5",
        target_decimal: 2.8,
        valid_roots: ["2", "4/5"],
      },
      {
        method_name: "vieta",
        target_value: "14/5",
        target_decimal: 2.8,
      },
    ];
    const result = crossValidateMethods(methods);
    expect(result.methods_agree).toBe(true);
    expect(result.confidence).toBe(1.0);
    expect(result.max_discrepancy).toBeLessThan(1e-6);
    expect(result.final_answer).toBe("14/5");
  });

  it("detects disagreement between methods", () => {
    const methods: MethodResult[] = [
      {
        method_name: "explicit_solve",
        target_value: "14/5",
        target_decimal: 2.8,
        valid_roots: ["2", "4/5"],
      },
      {
        method_name: "vieta",
        target_value: "3",
        target_decimal: 3.0,
      },
    ];
    const result = crossValidateMethods(methods);
    expect(result.methods_agree).toBe(false);
    expect(result.confidence).toBeLessThan(1.0);
    expect(result.max_discrepancy).toBeCloseTo(0.2, 5);
    expect(result.discrepancy_detail).toBeDefined();
  });

  it("handles three agreeing methods", () => {
    const methods: MethodResult[] = [
      { method_name: "method_a", target_value: "10", target_decimal: 10.0 },
      { method_name: "method_b", target_value: "10", target_decimal: 10.0 },
      { method_name: "method_c", target_value: "10", target_decimal: 10.0 },
    ];
    const result = crossValidateMethods(methods);
    expect(result.methods_agree).toBe(true);
    expect(result.confidence).toBe(1.0);
  });

  it("handles near-equal values within tolerance", () => {
    const methods: MethodResult[] = [
      { method_name: "a", target_value: "14/5", target_decimal: 2.8 },
      {
        method_name: "b",
        target_value: "2.80000001",
        target_decimal: 2.80000001,
      },
    ];
    const result = crossValidateMethods(methods);
    expect(result.methods_agree).toBe(true);
    expect(result.confidence).toBe(1.0);
  });

  it("handles floating-point edge case", () => {
    const methods: MethodResult[] = [
      { method_name: "a", target_value: "1/3", target_decimal: 1 / 3 },
      {
        method_name: "b",
        target_value: "0.333333",
        target_decimal: 0.333333,
      },
    ];
    // 1/3 ≈ 0.333333... vs 0.333333 → diff ≈ 3.3e-7, within default tolerance
    const result = crossValidateMethods(methods);
    expect(result.methods_agree).toBe(true);
  });

  it("custom tolerance changes agreement", () => {
    const methods: MethodResult[] = [
      { method_name: "a", target_value: "10.01", target_decimal: 10.01 },
      { method_name: "b", target_value: "10.02", target_decimal: 10.02 },
    ];

    // Default tolerance (1e-6) → disagree
    const strict = crossValidateMethods(methods);
    expect(strict.methods_agree).toBe(false);

    // Custom tolerance (0.1) → agree
    const lenient = crossValidateMethods(methods, 0.1);
    expect(lenient.methods_agree).toBe(true);
  });
});

// ── ComputeEngine fallback tests (no SymPy server) ──────────────────

describe("ComputeEngine new methods (fallback)", () => {
  // Dynamic import to avoid env issues
  async function getEngine() {
    delete process.env.COMPUTE_ENGINE_URL;
    const { ComputeEngine } = await import("@/lib/compute/engine");
    return new ComputeEngine();
  }

  it("solveEquations returns empty solutions when unavailable", async () => {
    const engine = await getEngine();
    const result = await engine.solveEquations({
      equations: ["x**2 - 4"],
      variables: ["x"],
    });
    expect(result.engine).toBe("llm_fallback");
    expect(result.solutions).toEqual([]);
  });

  it("substituteValues returns empty when unavailable", async () => {
    const engine = await getEngine();
    const result = await engine.substituteValues({
      expression: "x**2",
      values: { x: "3" },
    });
    expect(result.engine).toBe("llm_fallback");
    expect(result.result).toBe("");
  });

  it("validateRoot returns invalid when unavailable", async () => {
    const engine = await getEngine();
    const result = await engine.validateRoot({
      root: { x: "2" },
      original_equations: ["x**2 = 4"],
    });
    expect(result.engine).toBe("llm_fallback");
    expect(result.is_valid).toBe(false);
  });

  it("applyVieta returns empty when unavailable", async () => {
    const engine = await getEngine();
    const result = await engine.applyVieta({
      polynomial: "x**2 - 5*x + 6",
      variable: "x",
    });
    expect(result.engine).toBe("llm_fallback");
    expect(result.degree).toBe(0);
    expect(result.sum_of_roots).toBe("");
  });
});
