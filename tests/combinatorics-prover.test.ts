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

  it("writes the proof: list facts for the kernel, the rotation to seat 0 when choices are 'no two adjacent'", () => {
    const sc = orbitScript(orbitShape(SEATS)!, [[2, 0, 4, 6, 8]]);
    expect(sc.startsWith("intro Valid Rot Ref Orbit")).toBe(true);
    expect(sc).toContain("let RL : List (List (Fin 15)) := [[0, 2, 4, 6, 8]]");
    expect(sc).toContain("List.sublistsLen 4 (List.finRange 15).tail");
    expect(sc).toContain("hinj.ncard_image");
    expect(sc).not.toMatch(/mergeSort/);
    const r = orbitScript(orbitShape(ROT)!, [[1, 2, 3]]);
    expect(r).toContain("List.sublistsLen 3 (List.finRange 12)");
    expect(r).not.toContain("Ref");
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
