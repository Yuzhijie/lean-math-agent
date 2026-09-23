import { describe, expect, it } from "vitest";
import { modernizeLeanSyntax } from "@/lib/lean/modernize";
import { extractTactics } from "@/lib/prover/whole-proof";
import { extractTactic } from "@/lib/search/goal-search";

describe("modernizeLeanSyntax", () => {
  it("rewrites the removed big-operator `in` binder", () => {
    expect(modernizeLeanSyntax("rw [Finset.sum_range_succ]\nhave h : ∑ i in Finset.range n, f i = 0 := by simp")).toBe(
      "rw [Finset.sum_range_succ]\nhave h : ∑ i ∈ Finset.range n, f i = 0 := by simp",
    );
    expect(modernizeLeanSyntax("∏ k : ℕ in Finset.Icc 1 5, k")).toBe("∏ k : ℕ ∈ Finset.Icc 1 5, k");
    expect(modernizeLeanSyntax("∑ i ∈ s, f i")).toBe("∑ i ∈ s, f i");
  });

  it("ports Lean 3 one-line cases/induction and lambdas, leaving structured forms alone", () => {
    expect(modernizeLeanSyntax("  cases h with x hx\n  exact hx")).toBe("  cases' h with x hx\n  exact hx");
    expect(modernizeLeanSyntax("induction n with n ih")).toBe("induction' n with n ih");
    expect(modernizeLeanSyntax("cases h with\n| inl h => simp\n| inr h => simp")).toBe("cases h with\n| inl h => simp\n| inr h => simp");
    expect(modernizeLeanSyntax("rcases h with ⟨x, hx⟩")).toBe("rcases h with ⟨x, hx⟩");
    expect(modernizeLeanSyntax("exact λ x, x + 1")).toBe("exact fun x => x + 1");
    expect(modernizeLeanSyntax("exact λ ⟨a, b⟩, a")).toBe("exact fun ⟨a, b⟩ => a");
  });

  it("is applied to extracted whole proofs and single tactics", () => {
    const t = extractTactics("```lean\ntheorem t (n : ℕ) : ∑ i in Finset.range n, (0 : ℕ) = 0 := by\n  simp\n```");
    expect(t).toBe("simp");
    const t2 = extractTactics("```lean\ntheorem t : True := by\n  have h : ∑ i in Finset.range 3, i = 3 := by decide\n  trivial\n```");
    expect(t2).toContain("∑ i ∈ Finset.range 3, i");
    expect(extractTactic("cases h with x hx")).toBe("cases' h with x hx");
  });
});
