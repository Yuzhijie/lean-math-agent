import { describe, it, expect } from "vitest";
import {
  crossValidateMethods,
  type MethodResult,
} from "@/lib/compute/cross-validate";

describe("crossValidateMethods", () => {
  it("returns empty result for no methods", () => {
    const result = crossValidateMethods([]);
    expect(result.methods_agree).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.final_answer).toBe("");
    expect(result.final_answer_decimal).toBeNaN();
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
  });

  it("returns low confidence when methods disagree", () => {
    const methods: MethodResult[] = [
      {
        method_name: "method_a",
        target_value: "5",
        target_decimal: 5.0,
      },
      {
        method_name: "method_b",
        target_value: "7",
        target_decimal: 7.0,
      },
    ];
    const result = crossValidateMethods(methods);
    expect(result.methods_agree).toBe(false);
    expect(result.confidence).toBeLessThan(1.0);
    expect(result.max_discrepancy).toBe(2.0);
    expect(result.discrepancy_detail).toBeDefined();
  });

  it("uses custom tolerance", () => {
    const methods: MethodResult[] = [
      { method_name: "a", target_value: "1", target_decimal: 1.0 },
      { method_name: "b", target_value: "1.01", target_decimal: 1.01 },
    ];
    // Default tolerance 1e-6: should disagree
    const strict = crossValidateMethods(methods);
    expect(strict.methods_agree).toBe(false);

    // Custom tolerance 0.1: should agree
    const loose = crossValidateMethods(methods, 0.1);
    expect(loose.methods_agree).toBe(true);
    expect(loose.confidence).toBe(1.0);
  });

  it("handles three methods with majority agreement", () => {
    const methods: MethodResult[] = [
      { method_name: "a", target_value: "3", target_decimal: 3.0 },
      { method_name: "b", target_value: "3", target_decimal: 3.0 },
      { method_name: "c", target_value: "5", target_decimal: 5.0 },
    ];
    const result = crossValidateMethods(methods);
    expect(result.methods_agree).toBe(false);
    expect(result.confidence).toBeCloseTo(2 / 3);
  });
});
