import { describe, expect, it } from "vitest";
import { colourFamily, familyEvalCommand, familyScript, maxFamily, parseFamily, readFamilyGraph, type FamilyGraph } from "@/lib/lean/optimize/family";

const EVENTOWN =
  ": (let U : Finset ℕ := Finset.Icc 1 6; IsGreatest {t : ℕ | ∃ F : Finset (Finset ℕ), (∀ A ∈ F, A ⊆ U) ∧ (∀ A ∈ F, ∀ B ∈ F, Even ((A ∩ B).card)) ∧ t = F.card} 8)";

/** The graph Lean would print, computed here for subsets of {1..n}. */
function graph(n: number, ok: (a: number) => boolean, compat: (a: number, b: number) => boolean): FamilyGraph {
  const masks = Array.from({ length: 1 << n }, (_, m) => m);
  return {
    sets: masks.map((m) => Array.from({ length: n }, (_, i) => i + 1).filter((i) => m & (1 << (i - 1)))),
    ok: masks.map(ok),
    compat: masks.map((a) => masks.map((b) => compat(a, b))),
  };
}
const pop = (m: number) => m.toString(2).replace(/0/g, "").length;

describe("largest family of subsets", () => {
  it("reads the statement: lets, ground set, conditions, the bound", () => {
    const st = parseFamily(EVENTOWN)!;
    expect(st.lets.map((l) => l.name)).toEqual(["U"]);
    expect(st.family).toBe("F");
    expect(st.memberType).toBe("Finset ℕ");
    expect(st.domain).toBe("U");
    expect(st.pairwise).toEqual([{ index: 1, a: "A", b: "B", body: "Even ((A ∩ B).card)" }]);
    expect(st.M).toBe(8);
    expect(familyEvalCommand(st)).toContain("sublists.map List.toFinset");
    // not this prover's: an extra condition on the family as a whole
    expect(parseFamily(": IsGreatest {t : ℕ | ∃ F : Finset (Finset ℕ), (∀ A ∈ F, A ⊆ Finset.Icc 1 4) ∧ F.card ≤ 3 ∧ (∀ A ∈ F, ∀ B ∈ F, A = B) ∧ t = F.card} 1")).toBeUndefined();
    expect(parseFamily(": IsGreatest {n : ℕ | n < 5} 4")).toBeUndefined();
  });

  it("takes the members' type as the ground set when no condition names one (Finset (Fin 6))", () => {
    const st = parseFamily(": IsGreatest {n : ℕ | ∃ F : Finset (Finset (Fin 6)), (∀ A ∈ F, ∀ B ∈ F, Even ((A ∩ B).card)) ∧ n = F.card} 8")!;
    expect(st.domain).toBe("(Finset.univ : Finset (Fin 6))");
    expect(st.domainItem.kind).toBe("univ");
    expect(st.items).toBe(1);
    // over ℕ a ground set is still needed
    expect(parseFamily(": IsGreatest {n : ℕ | ∃ F : Finset (Finset ℕ), (∀ A ∈ F, ∀ B ∈ F, Even ((A ∩ B).card)) ∧ n = F.card} 8")).toBeUndefined();
  });

  it("reads Lean's table back", () => {
    const g = readFamilyGraph('"[]|1|11\\n[1]|0|10\\n"')!;
    expect(g.sets).toEqual([[], [1]]);
    expect(g.ok).toEqual([true, false]);
    expect(g.compat).toEqual([
      [true, true],
      [true, false],
    ]);
    expect(readFamilyGraph('"[1]|1|1\\n[2]|1|1\\n"')).toBeUndefined(); // ragged
  });

  it("Eventown on 6 points: 8 sets, and 8 colours certify the bound", () => {
    const g = graph(6, (a) => pop(a) % 2 === 0, (a, b) => pop(a & b) % 2 === 0 && pop(a) % 2 === 0 && pop(b) % 2 === 0);
    const best = maxFamily(g, 9);
    expect(best.length).toBe(8);
    const col = colourFamily(g, 8)!;
    expect(col).toBeDefined();
    for (let a = 0; a < 64; a++) for (let b = a + 1; b < 64; b++) if (g.ok[a] && g.ok[b] && g.compat[a][b]) expect(col[a]).not.toBe(col[b]);
    expect(colourFamily(g, 7)).toBeUndefined();
    const script = familyScript(parseFamily(EVENTOWN)!, g, best, col);
    expect(script).toContain("intro U");
    expect(script).toContain("have key : ∀ A ∈ (U).powerset, ∀ B ∈ (U).powerset, A ≠ B →");
    expect(script).toContain("rintro t ⟨F, hc0, hc1, rfl⟩");
    expect(script).toContain("(hc1 A hA B hB)");
  });
});
