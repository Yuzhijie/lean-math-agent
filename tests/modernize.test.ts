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

  it("gives renamed Mathlib lemmas their current name", () => {
    expect(modernizeLeanSyntax("rw [Real.sqrt_eq_iff_sq_eq (by positivity) (by norm_num)]")).toBe(
      "rw [Real.sqrt_eq_iff_eq_sq (by positivity) (by norm_num)]",
    );
    expect(modernizeLeanSyntax("rw [sqrt_eq_iff_sq_eq h1 h2]")).toBe("rw [sqrt_eq_iff_eq_sq h1 h2]");
    expect(modernizeLeanSyntax("simp only [Set.mem_setOf_eq, Finset.card_insert_of_not_mem h]")).toBe(
      "simp only [Set.mem_ofPred_eq, Finset.card_insert_of_notMem h]",
    );
    // current names and longer names that merely contain an old one are left alone
    expect(modernizeLeanSyntax("rcases le_or_gt a b with h | h")).toBe("rcases le_or_gt a b with h | h");
    expect(modernizeLeanSyntax("exact Real.sqrt_eq_iff_sq_eq'")).toBe("exact Real.sqrt_eq_iff_sq_eq'");
    expect(modernizeLeanSyntax("rcases le_or_lt a b with h | h")).toBe("rcases le_or_gt a b with h | h");
  });
});

describe("extractTactics with let in the statement", () => {
  it("takes the proof after the statement's own `:=`, not a let's", () => {
    const t = extractTactics("```lean\ntheorem t : let f : ℕ → ℕ := fun n => n + 1; f 1 = 2 := by\n  intro f\n  rfl\n```", "t");
    expect(t).toBe("intro f\nrfl");
    const term = extractTactics("theorem t : let a := 2; a = 2 := rfl", "t");
    expect(term).toBe("exact rfl");
  });
});
