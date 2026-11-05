import { describe, expect, it } from "vitest";
import { parseFamily } from "@/lib/lean/optimize/family";
import { choose, ekrScript, ekrShape, readGround } from "@/lib/lean/optimize/ekr";

const EKR =
  ": let X : Finset ℕ := Finset.Icc 1 10; IsGreatest {m : ℕ | ∃ F : Finset (Finset ℕ), (∀ A ∈ F, A ⊆ X ∧ A.card = 4) ∧ (∀ A ∈ F, ∀ B ∈ F, A ≠ B → (A ∩ B).Nonempty) ∧ m = F.card} 84";
const ground = Array.from({ length: 10 }, (_, i) => i + 1);

describe("Erdős–Ko–Rado families", () => {
  it("reads the ground set out of a conjunction `A ⊆ X ∧ A.card = 4`", () => {
    const st = parseFamily(EKR)!;
    expect(st.domain).toBe("X");
    expect(st.domainItem).toEqual({ index: 0, kind: "subset", proj: ".1" });
    expect(ekrShape(st)).toEqual({ k: 4, sizeItem: 0, pairItem: 1 });
  });

  it("takes the usual ways of saying 'any two meet' and separate size conditions", () => {
    for (const pair of ["(A ∩ B).Nonempty", "A ∩ B ≠ ∅", "¬Disjoint A B", "A ≠ B → 0 < (A ∩ B).card", "1 ≤ (A ∩ B).card"]) {
      const st = parseFamily(`: IsGreatest {t : ℕ | ∃ F : Finset (Finset ℕ), (∀ A ∈ F, A ⊆ Finset.range 8) ∧ (∀ A ∈ F, A.card = 3) ∧ (∀ A ∈ F, ∀ B ∈ F, ${pair}) ∧ t = F.card} 21`)!;
      expect(ekrShape(st), pair).toEqual({ k: 3, sizeItem: 1, pairItem: 2 });
    }
    // another condition on the members: not this theorem
    const other = parseFamily(": IsGreatest {t : ℕ | ∃ F : Finset (Finset ℕ), (∀ A ∈ F, A ⊆ Finset.range 8 ∧ A.card = 3 ∧ 0 ∈ A) ∧ (∀ A ∈ F, ∀ B ∈ F, (A ∩ B).Nonempty) ∧ t = F.card} 21")!;
    expect(ekrShape(other)).toBeUndefined();
  });

  it("checks the number: C(n-1, k-1), a bigger star is a counterexample", () => {
    const st = parseFamily(EKR)!;
    const sh = ekrShape(st)!;
    expect(choose(9, 3)).toBe(84);
    const r = ekrScript(st, sh, ground);
    expect(r.tactics).toContain("Finset.erdos_ko_rado");
    expect(r.tactics).toContain("powersetCard 3 |>.image (insert 1)");
    expect(r.tactics).toContain("(hc0 A hA).1");
    const small = ekrScript({ ...st, M: 80 }, sh, ground);
    expect(small.counterexample).toMatch(/^84 > 80/);
    expect(ekrScript({ ...st, M: 90 }, sh, ground).reason).toMatch(/84 members/);
    expect(ekrScript(st, { ...sh, k: 6 }, ground).reason).toMatch(/not the Erdős–Ko–Rado case/);
    expect(readGround('[1, 2, 3]')).toEqual([1, 2, 3]);
  });
});
