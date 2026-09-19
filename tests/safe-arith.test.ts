import { describe, it, expect } from "vitest";
import { compileArith, ArithSyntaxError } from "@/lib/compute/safe-arith";
import { ComputeEngine } from "@/lib/compute/engine";

const VARS = ["m", "a1", "a2", "a3"];

describe("compileArith — grammar", () => {
  it("evaluates + - * / with precedence and parentheses", () => {
    const f = compileArith("m * (a1 + a2) - a3 / 2", VARS);
    expect(f({ m: 2n, a1: 3n, a2: 4n, a3: 10n })).toEqual({ value: 9n, exact: true });
  });

  it("handles unary minus and nested parentheses", () => {
    const f = compileArith("-(a1 - -a2) * 3", VARS);
    expect(f({ m: 0n, a1: 1n, a2: 2n, a3: 0n }).value).toBe(-9n);
  });

  it("uses exact BigInt arithmetic for large values", () => {
    const f = compileArith("a1 * a1 + 1", VARS);
    const big = 12345678901234567890n;
    expect(f({ m: 0n, a1: big, a2: 0n, a3: 0n }).value).toBe(big * big + 1n);
  });

  it("reports inexact integer division", () => {
    const f = compileArith("a1 / 2", VARS);
    expect(f({ m: 0n, a1: 7n, a2: 0n, a3: 0n })).toEqual({ value: 3n, exact: false });
    expect(f({ m: 0n, a1: 8n, a2: 0n, a3: 0n })).toEqual({ value: 4n, exact: true });
  });

  it("throws on division by zero at evaluation time", () => {
    const f = compileArith("a1 / m", VARS);
    expect(() => f({ m: 0n, a1: 1n, a2: 0n, a3: 0n })).toThrow(RangeError);
  });

  it("exposes the variables actually referenced", () => {
    const f = compileArith("a1 + a2", VARS);
    expect([...f.variables].sort()).toEqual(["a1", "a2"]);
  });
});

describe("compileArith — rejects anything outside the grammar", () => {
  const bad = [
    "process.mainModule.require('child_process').execSync('id')",
    "a1; globalThis.x = 1",
    "constructor.constructor('return 1')()",
    "a1 ** 100000000",
    "a1 + b2", // unknown variable
    "Math.max(a1, a2)",
    "a1 + (a2",
    "a1 +",
    "",
    "   ",
    "1e9",
    "0x10",
    "a1 => a1",
    "`${a1}`",
    "[a1][0]",
  ];
  for (const src of bad) {
    it(`rejects ${JSON.stringify(src)}`, () => {
      expect(() => compileArith(src, VARS)).toThrow(ArithSyntaxError);
    });
  }

  it("rejects overly long formulas", () => {
    expect(() => compileArith("a1+".repeat(300) + "a1", VARS)).toThrow(ArithSyntaxError);
  });
});

describe("ComputeEngine.computeSequenceTerms — no code execution", () => {
  it("returns an error instead of executing injected JavaScript", async () => {
    const engine = new ComputeEngine();
    const marker = `__injected_${Date.now()}`;
    const result = await engine.computeSequenceTerms({
      recurrence: `(globalThis['${marker}'] = 1, a1 + a2)`,
      initialValues: [1, 1],
      parameterValue: 2,
      numTerms: 4,
    });
    expect(result.error).toMatch(/Invalid recurrence formula/);
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
  });

  it("flags sequences with non-integer division", async () => {
    const engine = new ComputeEngine();
    const result = await engine.computeSequenceTerms({
      recurrence: "a1 / 2",
      initialValues: [7],
      parameterValue: 0,
      numTerms: 3,
    });
    expect(result.error).toBeUndefined();
    expect(result.terms).toEqual(["7", "3", "1"]);
    expect(result.allIntegers).toBe(false);
  });
});
