import { describe, expect, it } from "vitest";
import { goalToStatement } from "@/lib/lean/goal-statement";

describe("goalToStatement", () => {
  it("turns a printed goal state into a lemma statement with the same names", () => {
    const g = goalToStatement("x y : ℝ\nh₀ : 0 < x\nh₁ : 0 < y\n⊢ x * y ≤ (x ^ 2 + y ^ 2) / 2");
    expect(g?.statement).toBe("(x y : ℝ) (h₀ : 0 < x) (h₁ : 0 < y) : x * y ≤ (x ^ 2 + y ^ 2) / 2");
  });

  it("instances, inaccessible names, universes, let values and wrapped lines", () => {
    const g = goalToStatement("α : Type u_1\ninst✝ : Fintype α\nx✝ : ℕ\ns : Finset ℕ := Finset.range 10\nh : ∑ i ∈ s, i =\n    45\n⊢ s.card = 10");
    expect(g?.binders).toEqual(["(α : Type*)", "[Fintype α]", "(h_aux1 : ℕ)", "(s : Finset ℕ)", "(h : ∑ i ∈ s, i = 45)"]);
    expect(g?.target).toBe("s.card = 10");
  });

  it("no hypotheses; several goals or none give null", () => {
    expect(goalToStatement("⊢ 2 + 2 = 4")?.statement).toBe(": 2 + 2 = 4");
    expect(goalToStatement("x : ℕ\n⊢ x = x\n\nx : ℕ\n⊢ x + 0 = x")).toBeNull();
    expect(goalToStatement("x : ℕ")).toBeNull();
  });
});
