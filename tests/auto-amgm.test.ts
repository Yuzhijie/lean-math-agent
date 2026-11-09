import { describe, expect, it } from "vitest";
import { amgmFinishers, readProductConstraint } from "@/lib/lean/auto/amgm";
import { parseGoal } from "@/lib/lean/geometry/goal";
import { renameOldLemmas } from "@/lib/lean/renamed";

const goal = (hyps: string[], target: string) => parseGoal(`${hyps.join("\n")}\n⊢ ${target}`);
const ABC = ["a b c : ℝ", "ha : 0 < a", "hb : 0 < b", "hc : 0 < c", "habc : a * b * c = 1"];

describe("AM–GM under a product constraint", () => {
  it("reads positive variables with x₁ ⋯ xₙ = mⁿ", () => {
    expect(readProductConstraint(goal(ABC, "a = 1"))).toEqual({ vars: ["a", "b", "c"], mean: "1", hyp: "habc" });
    expect(readProductConstraint(goal(["x y : ℝ", "hx : 0 < x", "hy : 0 < y", "h : x * y = 9"], "6 ≤ x + y"))).toMatchObject({ vars: ["x", "y"], mean: "3" });
    expect(readProductConstraint(goal(["a b c : ℝ", "ha : 0 < a", "hb : 0 < b", "hc : 0 < c", "habc : a * b * c = 8 / 27"], "2 ≤ a + b + c"))).toMatchObject({ mean: "(2 / 3)" });
    // no cube root, not all positive, a repeated variable
    expect(readProductConstraint(goal(["a b c : ℝ", "ha : 0 < a", "hb : 0 < b", "hc : 0 < c", "habc : a * b * c = 2"], "a = 1"))).toBeUndefined();
    expect(readProductConstraint(goal(["a b c : ℝ", "ha : 0 < a", "hb : 0 < b", "habc : a * b * c = 1"], "a = 1"))).toBeUndefined();
    expect(readProductConstraint(goal(["a b : ℝ", "ha : 0 < a", "hb : 0 < b", "h : a * a * b = 1"], "a = 1"))).toBeUndefined();
  });

  it("proves n·m ≤ the sum first (nlinarith only), then the goal; an equality case part by part", () => {
    const [plain] = amgmFinishers(goal(ABC, "1 * (a + b + c) ≤ a ^ 2 + b ^ 2 + c ^ 2"));
    expect(plain).toContain("have hamgm : (3 : ℝ) * 1 ≤ a + b + c := (by nlinarith only [habc, ha, hb, hc, sq_nonneg (a - b)");
    expect(plain).toContain("nlinarith [hamgm, sq_nonneg (a - b)");
    const both = amgmFinishers(goal([...ABC, "h : (a ^ 2 + b ^ 2 + c ^ 2) / (a + b + c) = 1"], "a = 1 ∧ b = 1 ∧ c = 1"));
    expect(both[1]).toContain("field_simp at *; refine ⟨?_, ?_, ?_⟩ <;> nlinarith [hamgm, sq_nonneg (a - b), sq_nonneg (a - c), sq_nonneg (b - c), sq_nonneg (a - 1), sq_nonneg (b - 1), sq_nonneg (c - 1)]");
    // an ↔ goal is not split
    expect(amgmFinishers(goal(ABC, "a = 1 ↔ b = 1 ∧ c = 1"))[0]).not.toContain("refine ⟨");
    expect(amgmFinishers(goal(["a : ℝ", "ha : 0 < a"], "0 ≤ a"))).toEqual([]);
  });
});

describe("renamed division lemmas", () => {
  it("le_div_iff and its family get the ₀ names, the new names stay", () => {
    expect(renameOldLemmas("rw [le_div_iff hs, div_le_iff hs, lt_div_iff' h, div_le_div_iff hb hd]")).toBe("rw [le_div_iff₀ hs, div_le_iff₀ hs, lt_div_iff₀' h, div_le_div_iff₀ hb hd]");
    expect(renameOldLemmas("rw [le_div_iff₀ hs]")).toBe("rw [le_div_iff₀ hs]");
  });
});
