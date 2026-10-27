import { describe, expect, it } from "vitest";
import { boundCandidates, boxKey, boxSize, candidates, finiteTypeSize, mentions, readSearchOutput, searchProgram, splitExists } from "@/lib/lean/optimize/domain";
import { looksOptimization } from "@/lib/lean/optimize";

describe("optimization statements", () => {
  it("recognizes the usual shapes", () => {
    expect(looksOptimization(": IsGreatest {p : ℕ | ∃ a b c : ℕ, a + b + c = 10 ∧ p = a * b * c} 36")).toBe(true);
    expect(looksOptimization(": (∃ x y : ℕ, x + y = 3) ∧ ∀ x y : ℕ, x + y = 3 → x * y ≤ 2")).toBe(true);
    expect(looksOptimization(": ∀ n : ℕ, n + 0 = n")).toBe(false);
    expect(looksOptimization(": IsLeast {x : ℝ | 0 ≤ x} 0")).toBe(false); // real numbers: not a finite search
  });
});

describe("∃ binders", () => {
  it("names, typed groups, binder predicates, nesting", () => {
    expect(splitExists("∃ a b c, a + b + c = 10 ∧ 36 = a * b * c")).toEqual({ binders: [{ name: "a" }, { name: "b" }, { name: "c" }], body: "a + b + c = 10 ∧ 36 = a * b * c" });
    expect(splitExists("∃ x y : ℕ, x + y = 3")!.binders).toEqual([
      { name: "x", type: "ℕ" },
      { name: "y", type: "ℕ" },
    ]);
    const s = splitExists("∃ s ⊆ Finset.Icc 1 10, (∀ a ∈ s, ∀ b ∈ s, a + 1 ≠ b) ∧ s.card = 5")!;
    expect(s.binders).toEqual([{ name: "s", pred: { op: "⊆", rhs: "Finset.Icc 1 10" } }]);
    expect(s.body).toBe("(∀ a ∈ s, ∀ b ∈ s, a + 1 ≠ b) ∧ s.card = 5");
    expect(splitExists("∃ f, ∃ g, f = g")!.binders.map((b) => b.name)).toEqual(["f", "g"]);
    expect(splitExists("x = 1")).toBeUndefined();
  });
});

describe("candidates and the search program", () => {
  it("ℕ, ℤ, Fin, subsets, functions", () => {
    expect(candidates({ name: "a" }, "ℕ", 10)!.list).toBe("List.range 11");
    expect(candidates({ name: "x" }, "ℤ", 5)!.witness("-4")).toBe("(-4)");
    expect(candidates({ name: "i" }, "Fin 4", 10)!.size).toBe(4);
    expect(candidates({ name: "s" }, "Finset (Fin 3)", 10)!.size).toBe(8);
    expect(candidates({ name: "s", pred: { op: "⊆", rhs: "Finset.Icc 1 10" } }, "Finset ℕ", 10)!.list).toContain("Finset.Icc 1 10");
    const f = candidates({ name: "f" }, "Fin 3 → Fin 3", 10)!;
    expect(f.size).toBe(27);
    expect(f.witness("[0, 1, 2]")).toBe("![0, 1, 2]");
    expect(candidates({ name: "x" }, "ℝ", 10)).toBeUndefined();
  });

  it("writes the loops and reads the answer back", () => {
    const p = searchProgram(
      [
        { name: "a", c: candidates({ name: "a" }, "ℕ", 10)! },
        { name: "b", c: candidates({ name: "b" }, "ℕ", 10)! },
      ],
      "a + b = 3 ∧ k = a * b",
      [{ name: "k", value: "2", type: "ℕ" }],
    );
    expect(p).toContain("let k : ℕ := 2");
    expect(p).toContain("for a in List.range 11 do");
    expect(p).toContain('return some s!"{repr a}¦{repr b}"');
    expect(readSearchOutput('some "3¦{1, 3, 5}"')).toEqual(["3", "{1, 3, 5}"]);
    expect(readSearchOutput("none")).toBeUndefined();
  });
});

describe("the box", () => {
  it("statement and application", () => {
    const k = boxKey(
      [
        { name: "a", kind: "range", type: "ℕ", lo: 0n, hi: 10n, loProof: "Nat.zero_le _", hiProof: "hb1" },
        { name: "f", kind: "type", type: "Fin 3 → Fin 3", size: 27 },
        { name: "s", kind: "subset", set: "Finset.Icc 1 10", proof: "hs", size: 1024 },
      ],
      [{ name: "h", type: "a + 1 = 3" }],
      "a ≤ 5",
    );
    expect(k.statement).toBe("∀ a ∈ Finset.Icc (0 : ℕ) (10 : ℕ), ∀ f : Fin 3 → Fin 3, ∀ s ∈ (Finset.Icc 1 10).powerset, (a + 1 = 3) → (a ≤ 5)");
    expect(k.apply).toBe("a (Finset.mem_Icc.mpr ⟨Nat.zero_le _, hb1⟩) f s (Finset.mem_powerset.mpr hs) h");
    expect(boxSize([{ name: "a", kind: "range", type: "ℤ", lo: -5n, hi: 5n, loProof: "", hiProof: "" }])).toBe(11);
  });

  it("finite types, local names, bound candidates", () => {
    expect(finiteTypeSize("Fin 3 → Fin 3")).toBe(27);
    expect(finiteTypeSize("Finset (Fin 4)")).toBe(16);
    expect(finiteTypeSize("ℕ")).toBeUndefined();
    expect([...mentions("a + b.card = c", new Set(["a", "b", "x"]))].sort()).toEqual(["a", "b"]);
    expect(boundCandidates([10n, 3n])).toEqual([2n, 3n, 9n, 10n, 13n, 100n, 1000n]);
  });
});
