import { describe, expect, it } from "vitest";
import { ODDTOWN_LEMMA, oddtownShape } from "@/lib/lean/optimize/oddtown";

const LETS =
  "(n : ℕ) (hn : 0 < n) : let U : Finset ℕ := Finset.Icc 1 n; let Valid : Finset (Finset ℕ) → Prop := fun F => (∀ A ∈ F, A ⊆ U ∧ Odd A.card) ∧ (∀ A ∈ F, ∀ B ∈ F, A ≠ B → Even (A ∩ B).card); let S : Finset (Finset ℕ) := U.image (fun i => ({i} : Finset ℕ)); IsGreatest {t : ℕ | ∃ F : Finset (Finset ℕ), Valid F ∧ t = F.card} n ∧ Valid S ∧ S.card = n";

describe("Oddtown statements", () => {
  it("reads the ground set behind a let, and the lets", () => {
    expect(oddtownShape(LETS)).toEqual({ domain: "U", domainLet: "U", lets: ["U", "Valid", "S"] });
  });

  it("reads an inline ground set and % 2 conditions", () => {
    const t = "(n : ℕ) : IsGreatest {m : ℕ | ∃ F : Finset (Finset ℕ), (∀ A ∈ F, A ⊆ Finset.range n) ∧ (∀ A ∈ F, A.card % 2 = 1) ∧ (∀ A ∈ F, ∀ B ∈ F, A ≠ B → (A ∩ B).card % 2 = 0) ∧ m = F.card} n";
    expect(oddtownShape(t)).toMatchObject({ domain: "Finset.range n", lets: [] });
  });

  it("takes Finset.univ for members in Finset (Fin k) without a ground-set condition", () => {
    const t = ": IsGreatest {m : ℕ | ∃ F : Finset (Finset (Fin 9)), (∀ A ∈ F, Odd A.card) ∧ (∀ A ∈ F, ∀ B ∈ F, A ≠ B → Even (A ∩ B).card) ∧ m = F.card} 9";
    expect(oddtownShape(t)?.domain).toBe("(Finset.univ : Finset (Fin 9))");
  });

  it("leaves other family statements alone (Eventown: even sizes)", () => {
    const t = ": IsGreatest {m : ℕ | ∃ F : Finset (Finset ℕ), (∀ A ∈ F, A ⊆ Finset.range 6 ∧ Even A.card) ∧ (∀ A ∈ F, ∀ B ∈ F, Even (A ∩ B).card) ∧ m = F.card} 8";
    expect(oddtownShape(t)).toBeUndefined();
  });

  it("the lemma is one `have` over any type", () => {
    expect(ODDTOWN_LEMMA).toMatch(/^have oddtown_bound : ∀ \{α : Type\} \[DecidableEq α\]/);
    expect(ODDTOWN_LEMMA).not.toMatch(/sorry|#eval/);
  });
});
