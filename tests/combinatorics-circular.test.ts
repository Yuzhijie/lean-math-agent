import { describe, expect, it } from "vitest";
import { circularScript, circularShape } from "@/lib/lean/combinatorics/circular";

const EIGHT = `: let Adjacent : Fin 8 → Fin 8 → Prop := fun i j => i + 1 = j ∨ j + 1 = i; let Valid : (Fin 8 → Fin 8) → Prop := fun f => Function.Bijective f ∧ ¬ Adjacent (f 0) (f 1) ∧ ¬ Adjacent (f 0) (f 2) ∧ ¬ Adjacent (f 1) (f 2) ∧ ¬ Adjacent (f 3) (f 4); let Rot : Fin 8 → (Fin 8 → Fin 8) → (Fin 8 → Fin 8) := fun k f i => f i + k; let Orbit : (Fin 8 → Fin 8) → Set (Fin 8 → Fin 8) := fun s => {t | Valid t ∧ ∃ k : Fin 8, t = Rot k s}; Set.ncard {O : Set (Fin 8 → Fin 8) | ∃ s : Fin 8 → Fin 8, Valid s ∧ O = Orbit s} = 1152`;
const FIVE = `: let Valid : (Fin 5 → Fin 5) → Prop := fun f => Function.Bijective f; let Rot : Fin 5 → (Fin 5 → Fin 5) → (Fin 5 → Fin 5) := fun k f i => f i + k; let Orbit : (Fin 5 → Fin 5) → Set (Fin 5 → Fin 5) := fun s => {t | Valid t ∧ ∃ k : Fin 5, t = Rot k s}; Set.ncard {O : Set (Fin 5 → Fin 5) | ∃ s : Fin 5 → Fin 5, Valid s ∧ O = Orbit s} = 24`;

describe("circular seatings up to rotation", () => {
  it("reads the Valid / Rot / Orbit shape with seat conditions", () => {
    const c = circularShape(EIGHT)!;
    expect(c).toMatchObject({ n: 8, total: 1152, valid: "Valid", rot: "Rot", orbit: "Orbit", relations: ["Adjacent"], hasRest: true, binder: "f" });
    expect(c.rest).toBe("¬ Adjacent (f 0) (f 1) ∧ ¬ Adjacent (f 0) (f 2) ∧ ¬ Adjacent (f 1) (f 2) ∧ ¬ Adjacent (f 3) (f 4)");
    expect(c.names).toEqual(["Adjacent", "Valid", "Rot", "Orbit"]);
  });

  it("reads plain seatings and rejects other shapes", () => {
    expect(circularShape(FIVE)).toMatchObject({ n: 5, total: 24, hasRest: false, rest: "" });
    expect(circularShape(EIGHT.replace("f i + k", "f i * k"))).toBeUndefined();
    expect(circularShape(EIGHT.replace("(f 3) (f 4)", "(f 3) (f 4) ∧ f 5 < f 6"))).toBeUndefined();
    expect(circularShape(EIGHT.replace(/Fin 8/g, "Fin 12"))).toBeUndefined();
  });

  it("decides only the conditions per list, bijectivity from the permutation", () => {
    const s = circularScript(circularShape(EIGHT)!);
    expect(s).toContain("let cR : (Fin 8 → Fin 8) → Prop := fun f => ¬ Adjacent (f 0) (f 1)");
    expect(s).toContain("([1, 2, 3, 4, 5, 6, 7] : List (Fin 8)).permutations').filter (fun p => decide (cR (cF p)))");
    expect(s).toContain("⟨⟨hbij, of_decide_eq_true hval⟩, rfl⟩");
    expect(s).toContain("decide_eq_true hs.2");
    expect(s).toContain("simp only [cL, cF, cR, Adjacent]");
    expect(s.trim().endsWith("decide +kernel")).toBe(true);
    const p = circularScript(circularShape(FIVE)!);
    expect(p).toContain("let cR : (Fin 5 → Fin 5) → Prop := fun _ => True");
    expect(p).toContain("⟨hbij, rfl⟩");
    expect(p).toContain("decide_eq_true trivial");
    expect(p).toContain("Equiv.ofBijective s hs)");
  });
});
