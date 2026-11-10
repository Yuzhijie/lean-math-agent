import { describe, expect, it } from "vitest";
import { existsWitness } from "@/lib/lean/geometry/witness";

describe("∃ witness fixed by linear equations (geometry)", () => {
  it("finds the circumcentre, rationalising √3 out of the denominators", () => {
    const g =
      "∃ O, (O.1 - (3 + √3) / 6) ^ 2 + (O.2 - (3 + √3) / 6) ^ 2 = (O.1 - 0) ^ 2 + (O.2 - 0) ^ 2 ∧ (O.1 - 0) ^ 2 + (O.2 - 0) ^ 2 = (O.1 - 1) ^ 2 + (O.2 - 0) ^ 2 ∧ (O.1 - 1) ^ 2 + (O.2 - 0) ^ 2 = (O.1 - x) ^ 2 + (O.2 - y) ^ 2";
    const w = existsWitness(g, new Set(["x", "y"]));
    // the third equation has x, y in its coefficients and is left to be proved
    expect(w).toEqual({ tactic: "refine ⟨((1 / 2), (1 / 6) * (√3)), ?_⟩", values: ["(1 / 2)", "(1 / 6) * (√3)"] });
  });

  it("solves for real witnesses and inverts a coefficient with a root", () => {
    expect(existsWitness("∃ t, 2 * t + √2 * t = 1", new Set())?.values).toEqual(["-(1 / 2) * (√2) + 1"]);
    expect(existsWitness("∃ u v, u + v = 3 ∧ u - v = 1", new Set())?.tactic).toBe("refine ⟨2, 1, ?_⟩");
  });

  it("gives up when the equations do not fix the witness", () => {
    expect(existsWitness("∃ t, t ^ 2 = 2", new Set())).toBeUndefined();
    expect(existsWitness("∃ t, t * x = 1", new Set(["x"]))).toBeUndefined();
    expect(existsWitness("∀ t, t = 1", new Set())).toBeUndefined();
  });
});

describe("signs of numbers with square roots (|…| and denominators)", () => {
  it("tells the sign and gives nlinarith the root's bounds", async () => {
    const { rootNumberSign } = await import("@/lib/lean/geometry/prove");
    const { parseTerm } = await import("@/lib/lean/geometry/expr");
    const s = "(0 - (3 + √3) / 6) * (0 - (3 + √3) / 6) - (0 - (3 + √3) / 6) * (1 - (3 + √3) / 6)";
    const r = rootNumberSign(s, parseTerm(s))!;
    expect(r.positive).toBe(true);
    expect(r.hints).toContain("Real.sq_sqrt (show (0:ℝ) ≤ (3 : ℝ) by norm_num)");
    expect(r.hints).toContain("((1732050 / 1000000 : ℝ)) ^ 2 < (3 : ℝ)");
    const n = "1 - √2";
    expect(rootNumberSign(n, parseTerm(n))?.positive).toBe(false);
    // no root, a variable, or zero: not this helper's business
    for (const t of ["2 - 1", "x - √2", "√2 * √2 - 2"]) expect(rootNumberSign(t, parseTerm(t))).toBeUndefined();
  });
});
