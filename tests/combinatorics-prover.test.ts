import { describe, expect, it } from "vitest";
import { splitLets } from "@/lib/lean/combinatorics/lets";
import { orbitEvalCommand, orbitScript, orbitShape, parseReps } from "@/lib/lean/combinatorics/orbit";
import { evalSet, parseSetExpr } from "@/lib/lean/combinatorics/sets";
import { cardTerms, vennScript } from "@/lib/lean/combinatorics/venn";
import { closeFinite, introAll } from "@/lib/lean/combinatorics/finite";
import { looksCombinatorial } from "@/lib/lean/combinatorics";
import { parseGoal } from "@/lib/lean/geometry/goal";
import type { RunnerMark, TacticRunner } from "@/lib/lean/tactic-runner";

const SEATS =
  ": (let Valid : Finset (Fin 15) → Prop := fun s => s.card = 5 ∧ ∀ i ∈ s, i + (1 : Fin 15) ∉ s; let Rot : Fin 15 → Finset (Fin 15) → Finset (Fin 15) := fun k s => s.image (fun i => i + k); let Ref : Fin 15 → Finset (Fin 15) → Finset (Fin 15) := fun k s => s.image (fun i => k - i); let Orbit : Finset (Fin 15) → Set (Finset (Fin 15)) := fun s => {t | Valid t ∧ ∃ k : Fin 15, t = Rot k s ∨ t = Ref k s}; Set.ncard {O : Set (Finset (Fin 15)) | ∃ s : Finset (Fin 15), Valid s ∧ O = Orbit s} = 16)";
const ROT =
  ": let Valid : Finset (Fin 12) → Prop := fun s => s.card = 3 ∧ (0 : Fin 12) ∉ s; let Rot : Fin 12 → Finset (Fin 12) → Finset (Fin 12) := fun k s => Finset.image (fun i => i + k) s; let Orbit : Finset (Fin 12) → Set (Finset (Fin 12)) := fun s => {t | Valid t ∧ ∃ k : Fin 12, t = Rot k s}; Set.ncard {O : Set (Finset (Fin 12)) | ∃ s : Finset (Fin 12), Valid s ∧ O = Orbit s} = 10";

describe("orbit-counting statements", () => {
  it("splits a let chain at the top level only", () => {
    const sp = splitLets(SEATS)!;
    expect(sp.lets.map((l) => l.name)).toEqual(["Valid", "Rot", "Ref", "Orbit"]);
    expect(sp.lets[3].value).toContain("{t | Valid t ∧");
    expect(sp.body.startsWith("Set.ncard")).toBe(true);
    expect(splitLets(": 2 + 2 = 4")).toBeUndefined();
  });

  it("recognises the shape: rotations and reflections, the size, no two adjacent", () => {
    expect(orbitShape(SEATS)).toMatchObject({ valid: "Valid", rot: "Rot", ref: "Ref", orbit: "Orbit", n: 15, k: 5, adjacent: true, total: 16 });
    const rot = orbitShape(ROT)!;
    expect(rot).toMatchObject({ n: 12, k: 3, total: 10 });
    expect(rot.ref).toBeUndefined();
    expect(rot.adjacent).toBeUndefined();
    // a reflection that is not k - i is not ours
    expect(orbitShape(SEATS.replace("fun i => k - i", "fun i => k + i"))).toBeUndefined();
  });

  it("asks Lean for the representatives and reads its answer", () => {
    const cmd = orbitEvalCommand(orbitShape(SEATS)!);
    expect(cmd).toContain("abbrev Valid : Finset (Fin 15) → Prop := fun s =>");
    expect(cmd).toContain("(List.finRange 15).sublistsLen 5");
    expect(cmd).toContain("#eval");
    expect(parseReps("[[0, 2, 4], [0, 3, 6]]")).toEqual([[0, 2, 4], [0, 3, 6]]);
    expect(parseReps("[]")).toEqual([]);
    expect(parseReps("error: unknown")).toBeUndefined();
  });

  it("lists the valid choices by rising code, so a representative is the smallest member of its orbit", () => {
    const cmd = orbitEvalCommand(orbitShape(SEATS)!);
    expect(cmd).toContain(".mergeSort (fun a b => decide (code a.toFinset ≤ code b.toFinset))");
  });

  it("writes the proof: choices as numbers, the orbits as one bitmap, every computed fact a Bool", () => {
    const sc = orbitScript(orbitShape(SEATS)!, [[2, 0, 4, 6, 8]])!;
    expect(sc.startsWith("intro Valid Rot Ref Orbit")).toBe(true);
    // the representative sorted; representatives are told apart by their codes
    expect(sc).toContain("let RL : List (List (Fin 15)) := [[0, 2, 4, 6, 8]]");
    expect(sc).toContain("have hcnd : (RL.map code).Nodup := by decide +kernel");
    // different orbits: each representative has the smallest code of its orbit — one comparison per image, no look-up
    expect(sc).toContain("have hminB : RL.all (fun r => (List.finRange 15).all (fun k => Nat.ble (code r) (code (r.map (· + k))) && Nat.ble (code r) (code (r.map (k - ·))))) = true := by\n  decide +kernel");
    expect(sc).toContain("exact hinjRL r1 h1 r2 h2 (Nat.le_antisymm (hle r1 h1 r2 m2) (hle r2 h2 r1 m1))");
    expect(sc).not.toMatch(/RC\b|contains \(code/);
    // every image of every representative as one number, a choice's membership one bit test
    expect(sc).toContain("let IM : List ℕ := RL.flatMap (fun r => (List.finRange 15).flatMap (fun k => [code (r.map (· + k)), code (r.map (k - ·))]))");
    expect(sc).toContain("let B : ℕ := IM.foldl (fun b c => b ||| 2 ^ c) 0");
    // the rotation to seat 0 when choices are "no two adjacent": C(14, 4) lists as a Bool over the list,
    // adjacency read off neighbours in the rising list and seat 14 next to seat 0
    expect(sc).toContain(
      "have hcovB : (List.sublistsLen 4 (List.finRange 15).tail).all (fun l => !(((0 :: l).zip l).all (fun p => p.1 + 1 != p.2) && !l.contains (14 : Fin 15)) || B.testBit (code (0 :: l))) = true := by\n  decide +kernel",
    );
    // no proposition quantified over a long list is decided (one recursion per element), nothing is sorted or searched
    expect(sc).not.toMatch(/∀ l ∈ List\.sublistsLen[^\n]*:= by\n?\s*decide/);
    expect(sc).not.toMatch(/insertionSort|mergeSort|srt/);
    // a computed fact leaves the context once its consequence is stated
    expect(sc.indexOf("clear hminB")).toBeGreaterThan(sc.indexOf("have hmin :"));
    expect(sc.indexOf("clear hcovB")).toBeGreaterThan(sc.indexOf("have hcov :"));
    expect(sc.indexOf("clear hcovB")).toBeLessThan(sc.indexOf("have hcover"));
    expect(sc).toContain("hinj.ncard_image");
    // only the maps a composition lemma is about (an unused simp argument is a linter warning)
    expect(sc).toContain("have rr : ∀ j k s, Rot k (Rot j s) = Rot (j + k) s := by\n  intro j k s; simp only [Rot, Finset.image_image]");
    expect(sc).toContain("have fr : ∀ j k s, Ref k (Rot j s) = Ref (k - j) s := by\n  intro j k s; simp only [Rot, Ref, Finset.image_image]");

    const r = orbitScript(orbitShape(ROT)!, [[1, 2, 3]])!;
    expect(r).toContain("List.sublistsLen 3 (List.finRange 12)");
    expect(r).not.toContain("Ref");
    expect(r).toContain("[code (r.map (· + k))]))");
    // a general Valid: its size is read off before the computed facts are in the context (tauto scans it),
    // and only the valid images of a representative are members of its orbit
    expect(r.indexOf("have hcardV : ∀ s, Valid s → s.card = 3")).toBeGreaterThan(0);
    expect(r.indexOf("have hcardV")).toBeLessThan(r.indexOf("let code"));
    expect(r).toContain("have hcard : s.card = 3 := hcardV s hs");
    expect(r).toContain("have hmin : ∀ r ∈ RL, ∀ k : Fin 12, (Valid (r.map (· + k)).toFinset → code r ≤ code (r.map (· + k))) := by\n  simp only [Valid]; decide +kernel");
    expect(r).toContain("have hcovB : ∀ l ∈ List.sublistsLen 3 (List.finRange 12), Valid l.toFinset → B.testBit (code l) = true := by\n  simp only [Valid]; decide +kernel");
  });

  it("6 of 18 places up to the dihedral group: the size that was past the kernel's depth and memory", () => {
    const type =
      ": let Valid : Finset (Fin 18) → Prop := fun s => s.card = 6 ∧ ∀ i ∈ s, i + 1 ∉ s; let Rot : Fin 18 → Finset (Fin 18) → Finset (Fin 18) := fun k s => s.image (fun i => i + k); let Ref : Fin 18 → Finset (Fin 18) → Finset (Fin 18) := fun k s => s.image (fun i => k - i); let Orbit : Finset (Fin 18) → Set (Finset (Fin 18)) := fun s => {t | Valid t ∧ ∃ k : Fin 18, t = Rot k s ∨ t = Ref k s}; Set.ncard {O : Set (Finset (Fin 18)) | ∃ s : Finset (Fin 18), Valid s ∧ O = Orbit s} = 50";
    const shape = orbitShape(type)!;
    expect(shape).toMatchObject({ n: 18, k: 6, adjacent: true, total: 50, ref: "Ref" });
    const sc = orbitScript(shape, [[0, 2, 4, 6, 8, 10], [11, 2, 4, 6, 8, 0]])!;
    expect(sc).toContain("let RL : List (List (Fin 18)) := [[0, 2, 4, 6, 8, 10], [0, 2, 4, 6, 8, 11]]");
    expect(sc).toContain("(List.sublistsLen 5 (List.finRange 18).tail).all (fun l =>");
    expect(sc).toContain("!l.contains (17 : Fin 18)");
  });

  it("leaves a statement alone whose lets carry the names of the proof's own steps", () => {
    expect(orbitScript(orbitShape(ROT.replaceAll("Valid", "code"))!, [[1, 2, 3]])).toBeUndefined();
    expect(orbitScript(orbitShape(ROT.replaceAll("Orbit", "B"))!, [[1, 2, 3]])).toBeUndefined();
    expect(orbitScript(orbitShape(ROT)!, [[1, 2, 3]])).toBeDefined();
  });
});

describe("Venn regions", () => {
  it("reads set expressions with Lean's precedences", () => {
    const e = parseSetExpr("A \\ (B ∪ C) ∪ B \\ (A ∪ C) ∪ C \\ (A ∪ B)")!;
    const only = (s: string) => (n: string) => n === s;
    expect(evalSet(e, only("A"))).toBe(true);
    expect(evalSet(e, (n) => n === "A" || n === "B")).toBe(false);
    expect(evalSet(parseSetExpr("Aᶜ ∩ Bᶜ")!, () => false)).toBe(true);
    expect(parseSetExpr("A + B")).toBeUndefined();
  });

  it("finds the card terms, Fintype.card of a Greek type included", () => {
    const sets = new Set(["A", "B"]);
    expect(cardTerms("(A ∩ B).card = 21", sets)?.map((t) => t.text)).toEqual(["(A ∩ B).card"]);
    expect(cardTerms("Fintype.card α = 100", sets)?.map((t) => t.text)).toEqual(["Fintype.card α"]);
    expect(cardTerms("(A ∩ X).card = 1", sets)).toBeUndefined();
  });

  it("writes region equations and leaves the arithmetic to omega", () => {
    const st = parseGoal("α : Type u_1\ninst✝ : DecidableEq α\nA B : Finset α\nhA : A.card = 20\nhB : B.card = 15\nhAB : (A ∩ B).card = 5\n⊢ (A ∪ B).card = 30")!;
    const lines = vennScript(st)!;
    expect(lines.at(-1)).toBe("omega");
    expect(lines.filter((l) => l.startsWith("have c")).length).toBe(4);
    expect(lines.join("\n")).toContain("(A.filter (fun x => x ∈ B))");
    expect(lines.join("\n")).not.toContain("Finset.univ.filter"); // no universe without complements
    expect(vennScript(parseGoal("n : ℕ\n⊢ n + 0 = n")!)).toBeUndefined();
  });

  it("a set equation such as A ∪ B ∪ C = univ becomes a card fact (the outside region is then empty)", () => {
    const st = parseGoal(
      "α : Type u_1\ninst✝ : Fintype α\nA B C : Finset α\nhU : Fintype.card α = 30\nhA : A.card = 18\nhUnion : A ∪ B ∪ C = Finset.univ\n⊢ (A \\ (B ∪ C)).card = 12",
    )!;
    const lines = vennScript(st)!;
    expect(lines[0]).toBe("have hseq0 : (A ∪ B ∪ C).card = Fintype.card α := by rw [hUnion]; exact Finset.card_univ");
    expect(lines.join("\n")).toContain("Finset.univ.filter");
  });

  it("a set defined by a let is its definition, not a fourth set", () => {
    const st = parseGoal(
      "α : Type u_1\ninst✝ : Fintype α\nA B C : Finset α\nhU : Fintype.card α = 30\nhA : A.card = 18\nhUnion : A ∪ B ∪ C = Finset.univ\nX : Finset α := A \\ (B ∪ C) ∪ B \\ (A ∪ C) ∪ C \\ (A ∪ B)\n⊢ X.card = 12",
    )!;
    const text = vennScript(st)!.join("\n");
    expect(text).not.toMatch(/x [∈∉] X/);
    expect(text).toContain("simp only [X, Finset.mem_union");
    expect(text).toContain("have e0 : X = (A.filter (fun x => x ∉ B ∧ x ∉ C)) ∪ ((B.filter (fun x => x ∉ A ∧ x ∉ C)) ∪ ((C.filter (fun x => x ∉ A ∧ x ∉ B))))");
  });
});

function fakeRunner(start: string, step: (goal: string, tactic: string) => string[] | null) {
  let goals = [start];
  const script: string[] = [];
  let n = 0;
  const run: TacticRunner = {
    goals: () => goals,
    lastError: () => "",
    fresh: (b) => `${b}${++n}`,
    save: () => ({ handle: null, goals, length: script.length }),
    restore: (m: RunnerMark) => {
      goals = m.goals;
      script.length = m.length;
    },
    async apply(t) {
      const next = step(goals[0], t);
      if (!next) return false;
      goals = [...next, ...goals.slice(1)];
      script.push(t);
      return true;
    },
  };
  return { run, script };
}

describe("finite decision", () => {
  it("introduces the lets, unfolds them, splits a conjunction and lets the kernel decide each part", async () => {
    const { run, script } = fakeRunner("⊢ let f : Fin 3 → ℕ := fun i => i.val;\n  f 0 = 0 ∧ f 2 = 2", (g, t) => {
      if (t === "intro f") return ["f : Fin 3 → ℕ := fun i => i.val\n⊢ f 0 = 0 ∧ f 2 = 2"];
      if (t === "refine ⟨?_, ?_⟩") return ["f : Fin 3 → ℕ := fun i => i.val\n⊢ f 0 = 0", "f : Fin 3 → ℕ := fun i => i.val\n⊢ f 2 = 2"];
      if (t === "· simp only [f]; decide +kernel" && !/∧/.test(g)) return [];
      return null;
    });
    const lets = await introAll(run);
    expect(lets).toEqual(["f"]);
    expect(await closeFinite(run, lets)).toBe(true);
    expect(script).toEqual(["intro f", "refine ⟨?_, ?_⟩", "· simp only [f]; decide +kernel", "· simp only [f]; decide +kernel"]);
  });

  it("takes counting statements, not coordinate geometry", () => {
    expect(looksCombinatorial(SEATS)).toBe(true);
    expect(looksCombinatorial(": (Finset.filter (fun n => 6 ∣ n) (Finset.Icc 1 500)).card = 83")).toBe(true);
    expect(looksCombinatorial("(A B : ℝ × ℝ) : A = B")).toBe(false);
  });
});
