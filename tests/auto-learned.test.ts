import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addLearned, canonicalGoal, learnedTactics, matchGoal, readLearned, renameText, worthLearning } from "@/lib/lean/auto/learned";
import { finisherEntries } from "@/lib/lean/auto/rules";
import { autoSearch } from "@/lib/lean/auto/search";
import { parseGoal } from "@/lib/lean/geometry/goal";
import type { RunnerMark, TacticRunner } from "@/lib/lean/tactic-runner";

const learnedGoal = [
  "U : Type u_1",
  "inst✝¹ : Fintype U",
  "inst✝ : DecidableEq U",
  "hU : Fintype.card U = 20",
  "A : Fin 6 → Finset U",
  "h_membership : ∀ (x : U), {i | x ∈ A i}.card = 3",
  "k : ℕ",
  "h_pairwise : ∀ (i j : Fin 6), i < j → (A i ∩ A j).card = k",
  "⊢ k = 4",
].join("\n");
const proof = "have e := h_pairwise 0 1 (by decide)\nhave c := (A 0).card\nsimp [hU, h_membership] at *\nomega";

// the same goal with other names, another hypothesis order, one extra hypothesis
const renamed = [
  "α : Type u_1",
  "inst✝¹ : Fintype α",
  "inst✝ : DecidableEq α",
  "S : Fin 6 → Finset α",
  "m : ℕ",
  "hp : ∀ (i j : Fin 6), i < j → (S i ∩ S j).card = m",
  "hm : ∀ (x : α), {i | x ∈ S i}.card = 3",
  "hU : Fintype.card α = 20",
  "extra : 0 < m",
  "⊢ m = 4",
].join("\n");

beforeEach(() => {
  process.env.AUTO_LEARNED_PATH = path.join(mkdtempSync(path.join(tmpdir(), "learned-")), "learned.json");
});

describe("goals up to renaming", () => {
  it("finds the renaming: variables, hypotheses, order, extra hypotheses", () => {
    const sigma = matchGoal(parseGoal(learnedGoal)!, parseGoal(renamed)!)!;
    expect(Object.fromEntries(sigma)).toMatchObject({ U: "α", A: "S", k: "m", h_pairwise: "hp", h_membership: "hm", hU: "hU" });
  });

  it("renames whole names only, also before a field (A.card, U.x)", () => {
    const sigma = new Map([["A", "S"], ["k", "m"]]);
    expect(renameText("simp [A.card, Ak, k] at hA; exact (A 0).card ▸ k", sigma, new Set(["A", "k", "hA"]))).toBe("simp [S.card, Ak, m] at hA; exact (S 0).card ▸ m");
  });

  it("names the proof binds itself are renamed when a renamed name would collide", async () => {
    const { renameProof } = await import("@/lib/lean/auto/learned");
    const sigma = new Map([["A", "S"]]);
    expect(renameProof("have h : ∀ S : Finset ℕ, S = S := fun S => rfl\nexact A.card", sigma, new Set(["A"]))).toBe("have h : ∀ S_1 : Finset ℕ, S_1 = S_1 := fun S_1 => rfl\nexact S.card");
  });

  it("no match when anything but names differs", () => {
    expect(matchGoal(parseGoal(learnedGoal)!, parseGoal(renamed.replace("= 20", "= 21"))!)).toBeUndefined();
    expect(matchGoal(parseGoal(learnedGoal)!, parseGoal(renamed.replace("i < j", "i ≠ j"))!)).toBeUndefined();
    expect(matchGoal(parseGoal(learnedGoal)!, parseGoal(renamed.replace("⊢ m = 4", "⊢ m = 5"))!)).toBeUndefined();
    // a hypothesis of the learned goal missing
    expect(matchGoal(parseGoal(learnedGoal)!, parseGoal(renamed.replace(/hm : .*\n/, ""))!)).toBeUndefined();
    // an instance the proof may rely on missing
    expect(matchGoal(parseGoal(learnedGoal)!, parseGoal(renamed.replace(/inst✝ : DecidableEq α\n/, ""))!)).toBeUndefined();
  });

  it("one canonical form for renamed goals", () => {
    const a = canonicalGoal(parseGoal(learnedGoal)!);
    const b = canonicalGoal(parseGoal(learnedGoal.replace(/\bk\b/g, "t").replace(/h_pairwise/g, "hq"))!);
    expect(a).toBe(b);
  });
});

describe("the store and the search", () => {
  it("learns once per goal, replays with the names substituted, first among the finishers", () => {
    expect(addLearned({ goal: learnedGoal, tactics: proof, source: "solve", strategy: "whole_proof" })).toBe(true);
    expect(addLearned({ goal: learnedGoal.replace(/h_pairwise/g, "hq"), tactics: proof, source: "solve" })).toBe(false);
    expect(addLearned({ goal: learnedGoal, tactics: "sorry", source: "solve" })).toBe(false);
    expect(readLearned()).toHaveLength(1);
    const [t] = learnedTactics(parseGoal(renamed)!);
    expect(t.tactic).toBe("have e := hp 0 1 (by decide)\nhave c := (S 0).card\nsimp [hU, hm] at *\nomega");
    const es = finisherEntries(parseGoal(renamed)!);
    expect(es[0]).toEqual({ tactic: t.tactic, rule: `learned:${t.id}` });
  });

  it("needs the namespaces it was learned under", () => {
    addLearned({ goal: learnedGoal, tactics: proof, source: "solve", opens: ["Real"] });
    expect(learnedTactics(parseGoal(renamed)!)).toHaveLength(0);
    expect(learnedTactics(parseGoal(renamed)!, ["Real", "Nat"])).toHaveLength(1);
  });

  it("the search replays it on the statement as opened and counts the hit", async () => {
    addLearned({ goal: learnedGoal, tactics: proof, source: "solve" });
    let goals = [renamed];
    const script: string[] = [];
    const run: TacticRunner = {
      goals: () => goals,
      lastError: () => "",
      fresh: (b) => `${b}1`,
      save: () => ({ handle: null, goals, length: script.length }),
      restore: (m: RunnerMark) => {
        goals = m.goals;
        script.length = m.length;
      },
      async apply(t) {
        if (!t.startsWith("· have e := hp 0 1")) return false;
        script.push(t);
        goals = [];
        return true;
      },
    };
    const r = await autoSearch(run, { deadline: Date.now() + 60_000 });
    expect(r.ok).toBe(true);
    expect(r.stats.rules[0]).toMatch(/^learned:/);
    expect(readLearned()[0]).toMatchObject({ hits: 1, tried: 1 });
  });

  it("learns only from proofs the program did not find itself, not from benchmarks", () => {
    process.env.AUTO_LEARN = "";
    expect(worthLearning("whole_proof", "solve")).toBe(true);
    expect(worthLearning("memory", "lean-attempt")).toBe(true);
    expect(worthLearning("auto", "solve")).toBe(false);
    expect(worthLearning("geometry", "solve")).toBe(false);
    expect(worthLearning("whole_proof", "bench:minif2f-test.json")).toBe(false);
    process.env.AUTO_LEARN = "off";
    expect(worthLearning("whole_proof", "solve")).toBe(false);
  });
});
