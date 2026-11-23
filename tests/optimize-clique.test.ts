import { describe, expect, it } from "vitest";
import { CLIQUE_LEMMA, cliqueScript, cliqueSearch, cliqueTable, maxCoverFamily } from "@/lib/lean/optimize/clique";
import { parseFamily, type FamilyGraph } from "@/lib/lean/optimize/family";

const HM7 =
  ": IsGreatest {n : ℕ | ∃ F : Finset (Finset (Fin 7)), (∀ A ∈ F, A.card = 4) ∧ (∀ A ∈ F, ∀ B ∈ F, A ≠ B → 2 ≤ (A ∩ B).card) ∧ F.biUnion (fun A => A) = (Finset.univ : Finset (Fin 7)) ∧ n = F.card} 13";

/** The graph Lean would list: every subset of 0 … points − 1, allowed when it has `size` elements, compatible when the intersection has ≥ `meet`. */
function graph(points: number, size: number, meet: number): FamilyGraph {
  const sets = Array.from({ length: 2 ** points }, (_, code) => Array.from({ length: points }, (_, x) => x).filter((x) => (code >> x) & 1));
  const common = (a: number[], b: number[]) => a.filter((x) => b.includes(x)).length;
  return { sets, ok: sets.map((s) => s.length === size), compat: sets.map((a) => sets.map((b) => a === b || common(a, b) >= meet)) };
}

describe("a family that must cover the ground set", () => {
  it("is read with its cover condition, however the union is written", () => {
    expect(parseFamily(HM7)).toMatchObject({ family: "F", M: 13, items: 3, cover: { index: 2, union: "F.biUnion (fun A => A)", reversed: false }, unary: [{ index: 0 }], pairwise: [{ index: 1 }] });
    expect(parseFamily(": IsGreatest {t | ∃ G : Finset (Finset (Fin 6)), (Finset.univ : Finset (Fin 6)) = G.biUnion id ∧ (∀ X ∈ G, ∀ Y ∈ G, (X ∩ Y).Nonempty) ∧ t = G.card} 10")?.cover).toEqual({ index: 0, union: "G.biUnion id", reversed: true });
    expect(parseFamily(": IsGreatest {t | ∃ G : Finset (Finset (Fin 6)), (∀ X ∈ G, ∀ Y ∈ G, (X ∩ Y).Nonempty) ∧ G.sup id = Finset.univ ∧ t = G.card} 10")?.cover).toMatchObject({ union: "G.sup id" });
    // over ℕ with a ground set of its own, a union that is not the whole type, another condition on the family: not taken
    expect(parseFamily(": IsGreatest {t | ∃ G : Finset (Finset ℕ), (∀ X ∈ G, X ⊆ Finset.range 6) ∧ (∀ X ∈ G, ∀ Y ∈ G, (X ∩ Y).Nonempty) ∧ G.biUnion id = Finset.range 6 ∧ t = G.card} 10")).toBeUndefined();
    expect(parseFamily(": IsGreatest {t | ∃ G : Finset (Finset (Fin 6)), (∀ X ∈ G, ∀ Y ∈ G, (X ∩ Y).Nonempty) ∧ G.biUnion (fun A => Aᶜ) = Finset.univ ∧ t = G.card} 10")).toBeUndefined();
    // without a cover the statement is read as before
    expect(parseFamily(": IsGreatest {t | ∃ G : Finset (Finset (Fin 6)), (∀ X ∈ G, ∀ Y ∈ G, (X ∩ Y).Nonempty) ∧ t = G.card} 32")?.cover).toBeUndefined();
  });

  it("4-subsets of 7 points meeting in two: 13 when they cover, by a search of some 16 000 nodes", () => {
    const t = cliqueTable(graph(7, 4, 2), 7);
    expect(t.verts).toHaveLength(35);
    expect(t.codes[0]).toBe(15);
    expect(maxCoverFamily(t, 14)).toHaveLength(13);
    expect(cliqueSearch(t, 14)).toEqual({ nodes: 16205, empty: true });
    // 13 members exist: the search finds one and stops
    expect(cliqueSearch(t, 13).empty).toBe(false);
    // not given to the kernel past the node limit
    expect(cliqueSearch(t, 14, 1000).empty).toBe(false);
  });

  it("without the pruning by the cover the families that miss a point would be found", () => {
    // all 15 four-subsets that avoid one point are compatible: only the cover excludes them
    const t = cliqueTable(graph(7, 4, 2), 7);
    const star = t.verts.map((_, i) => i).filter((i) => t.codes[i] < 64);
    expect(star).toHaveLength(15);
    expect(star.every((i) => star.every((j) => i === j || (t.adj[i] >> BigInt(j)) & 1n))).toBe(true);
  });

  it("the proof: the lemma, the tables, the kernel's run, the family as the indices of its members", () => {
    const st = parseFamily(HM7)!;
    const g = graph(7, 4, 2);
    const t = cliqueTable(g, 7);
    const script = cliqueScript(st, g, t, maxCoverFamily(t, 14));
    expect(script.startsWith(CLIQUE_LEMMA)).toBe(true);
    expect(script).toContain("let SL : List (Finset (Fin 7)) := [{0, 1, 2, 3}, {0, 1, 2, 4}, ");
    expect(script).toContain("have hidx : ∀ A : Finset (Fin 7), (fun (A : Finset (Fin 7)) => A.card = 4) A → (fun (A B : Finset (Fin 7)) => A ≠ B → 2 ≤ (A ∩ B).card) A A → ∃ i ∈ List.range 35, SL.getD i ∅ = A := by");
    expect(script).toContain("^[36] [(14, List.range 35, 0)] = [] := by\n  decide +kernel");
    expect(script).toContain("    have hx : x ∈ F.biUnion (fun A => A) := by\n      rw [hc2]");
    expect(script).toContain("· rintro t ⟨F, hc0, hc1, hc2, rfl⟩");
    expect(script).toContain("exact hadj i hi'.1 j hj'.1 hlt (hc1 _ (of_decide_eq_true hi'.2) _ (of_decide_eq_true hj'.2)) (hc1 _ (of_decide_eq_true hj'.2) _ (of_decide_eq_true hi'.2))");
    expect(script).not.toMatch(/native_decide|sorry|first \|/);
  });
});
