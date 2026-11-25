import { describe, expect, it } from "vitest";
import { chainScript, chainShape, middleLayers, symmetricChains } from "@/lib/lean/optimize/chains";
import { parseFamily } from "@/lib/lean/optimize/family";

// "The largest family of subsets without three in a chain": two members from each chain of a chain decomposition.

const SESSION =
  ": IsGreatest ({n : ℕ | ∃ F : Finset (Finset (Fin 5)), ((∀ A ∈ F, A ⊆ (Finset.univ : Finset (Fin 5))) ∧ ¬ (∃ A B C : Finset (Fin 5), A ∈ F ∧ B ∈ F ∧ C ∈ F ∧ A ⊆ B ∧ A ≠ B ∧ B ⊆ C ∧ B ≠ C)) ∧ n = F.card} : Set ℕ) 20";

describe("symmetric chains", () => {
  for (const n of [2, 3, 4, 5, 6]) {
    it(`split the subsets of a ${n}-set into rising chains`, () => {
      const chains = symmetricChains(n);
      const all = chains.flat();
      expect(new Set(all).size).toBe(2 ** n);
      expect(all).toHaveLength(2 ** n);
      const size = (x: number) => x.toString(2).replace(/0/g, "").length;
      for (const c of chains) {
        for (let i = 1; i < c.length; i++) {
          // each step adds one element
          expect(c[i] & c[i - 1]).toBe(c[i - 1]);
          expect(size(c[i])).toBe(size(c[i - 1]) + 1);
        }
        // symmetric: first and last sizes add up to n
        expect(size(c[0]) + size(c[c.length - 1])).toBe(n);
      }
      // two from each chain (one from a chain of one) = the two middle layers
      const [a, b] = middleLayers(n);
      const layer = (k: number) => all.filter((x) => size(x) === k).length;
      expect(chains.reduce((s, c) => s + Math.min(2, c.length), 0)).toBe(layer(a) + layer(b));
    });
  }
});

describe("the statement's shape", () => {
  it("reads the session's statement (set ascription, grouped conditions, ¬ ∃ with ⊆ and ≠)", () => {
    const st = chainShape(SESSION)!;
    expect(st).toMatchObject({ n: 5, M: 20, pattern: "⟨hc0, hc1⟩", opening: [] });
  });

  it("reads other spellings of the condition", () => {
    expect(chainShape(": IsGreatest {n : ℕ | ∃ F : Finset (Finset (Fin 4)), (∀ A ∈ F, ∀ B ∈ F, ∀ C ∈ F, A ⊂ B → B ⊂ C → False) ∧ F.card = n} 10")).toMatchObject({ n: 4, M: 10, pattern: "hc0" });
    expect(chainShape(": IsGreatest {n : ℕ | ∃ F : Finset (Finset (Fin 6)), (∀ A ∈ F, ∀ B ∈ F, ∀ C ∈ F, ¬ (A ⊂ B ∧ B ⊂ C)) ∧ n = F.card} 35")).toMatchObject({ n: 6, M: 35 });
  });

  it("writes a helper let out and shows the statement first", () => {
    const st = chainShape(": let NoChain := fun F : Finset (Finset (Fin 5)) => ∀ A B C : Finset (Fin 5), A ∈ F → B ∈ F → C ∈ F → A ⊂ B → ¬ (B ⊂ C); IsGreatest {n : ℕ | ∃ F : Finset (Finset (Fin 5)), NoChain F ∧ n = F.card} 20")!;
    expect(st.opening[0]).toBe("intro NoChain");
    expect(st.opening[1]).toMatch(/^show IsGreatest/);
  });

  it("is not for conditions on pairs, on sizes, or for a large ground set", () => {
    expect(chainShape(": IsGreatest {n : ℕ | ∃ F : Finset (Finset (Fin 5)), (∀ A ∈ F, ∀ B ∈ F, A ⊆ B → A = B) ∧ n = F.card} 10")).toBeUndefined();
    expect(chainShape(": IsGreatest {n : ℕ | ∃ F : Finset (Finset (Fin 5)), (∀ A ∈ F, ∀ B ∈ F, ∀ C ∈ F, (A ∩ B ∩ C).card = 1) ∧ n = F.card} 10")).toBeUndefined();
    expect(chainShape(": IsGreatest {n : ℕ | ∃ F : Finset (Finset (Fin 9)), (∀ A ∈ F, ∀ B ∈ F, ∀ C ∈ F, ¬ (A ⊂ B ∧ B ⊂ C)) ∧ n = F.card} 252")).toBeUndefined();
  });

  it("the family route now reads a set written with its type", () => {
    expect(parseFamily(": IsGreatest ({n : ℕ | ∃ F : Finset (Finset (Fin 4)), (∀ A ∈ F, ∀ B ∈ F, A ⊆ B → A = B) ∧ n = F.card} : Set ℕ) 6")).toMatchObject({ M: 6 });
  });
});

describe("the script", () => {
  it("has one table entry per subset, the witness's layers and no searching tactic but grind for the condition", () => {
    const { tactics } = chainScript(chainShape(SESSION)!);
    expect(tactics).toBeTruthy();
    expect(tactics!.match(/\(\d+, \d+\)/g)).toHaveLength(32);
    expect(tactics).toContain("A.card = 2 ∨ A.card = 3");
    expect(tactics).toContain("Finset.range 10");
    expect(tactics).not.toMatch(/native_decide|sorry|first \|/);
  });

  it("refuses another value and says the right one", () => {
    const r = chainScript({ ...chainShape(SESSION)!, M: 19 });
    expect(r.tactics).toBeUndefined();
    expect(r.reason).toMatch(/20 members/);
  });
});
