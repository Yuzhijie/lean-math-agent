import { describe, expect, it } from "vitest";
import { divisibilityBounds, divisibilityFinishers } from "@/lib/lean/auto/divbound";
import { denominators } from "@/lib/lean/auto/tactics";
import type { GoalState } from "@/lib/lean/geometry/goal";

const st = (hyps: [string, string][], target = "n = 8"): GoalState => ({ hyps: hyps.map(([n, type]) => ({ names: [n], type })), target }) as GoalState;

describe("bounds from divisibility", () => {
  it("n + 5 ∣ n² + 14 gives n + 5 ∣ 39, so n ≤ 34; 2n + 1 ∣ n² + 4 gives 2n + 1 ∣ 17, n ≤ 8", () => {
    const g = st([
      ["n", "ℕ"],
      ["h1", "n + 5 ∣ n ^ 2 + 14"],
      ["h2", "2 * n + 1 ∣ n ^ 2 + 4"],
    ]);
    const b = divisibilityBounds(g);
    expect(b.map((x) => [x.hyp, x.bound])).toEqual([
      ["h2", 8],
      ["h1", 34],
    ]);
    expect(b[0].have).toContain("((n : ℤ) ^ 2 + 4) * 4 = (2 * (n : ℤ) + 1) * (2 * (n : ℤ) - 1) + (17)");
    expect(b[1].have).toContain("(n : ℤ) + 5 ∣ (39 : ℤ)");
    expect(divisibilityFinishers(g)[0]).toMatch(/^\(have hbound : n ≤ 8 := .*; interval_cases n <;> omega\)$/);
  });

  it("a negative remainder, and what it leaves alone", () => {
    // n + 3 ∣ n² + 1: n² + 1 = (n + 3)(n − 3) + 10 → bound 7
    expect(divisibilityBounds(st([["n", "ℕ"], ["h", "n + 3 ∣ n ^ 2 + 1"]]))[0].bound).toBe(7);
    // n + 1 ∣ n² − 1… subtraction in ℕ, an exact multiple, a non-linear divisor, two variables: nothing
    expect(divisibilityBounds(st([["n", "ℕ"], ["h", "n + 1 ∣ n ^ 2 + 2 * n + 1"]]))).toEqual([]);
    expect(divisibilityBounds(st([["n", "ℕ"], ["h", "n ^ 2 + 1 ∣ n ^ 3 + 2"]]))).toEqual([]);
    expect(divisibilityBounds(st([["n", "ℕ"], ["m", "ℕ"], ["h", "n + m ∣ n ^ 2 + 3"]]))).toEqual([]);
  });

  it("denominators to clear", () => {
    expect(denominators("1 / (x + 1) + 1 / (y + 1) + 1 / (z + 1) = 5 / 4")).toEqual(["(x + 1)", "(y + 1)", "(z + 1)"]);
    expect(denominators("a / b = 2 / 3")).toEqual(["b"]);
  });
});
