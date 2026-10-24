import { describe, expect, it } from "vitest";
import { divisibilityWitnesses } from "@/lib/lean/induction/witness";
import { proveByInduction, relation } from "@/lib/lean/induction/prove";
import { looksInductive } from "@/lib/lean/induction";
import type { RunnerMark, TacticRunner } from "@/lib/lean/tactic-runner";
describe("divisibility witnesses", () => {
  it("finds the quotient from the induction hypothesis", () => {
    expect(divisibilityWitnesses("7 ∣ 8 ^ (k + 1) - 1", "7 ∣ 8 ^ k - 1", "k").map((w) => w.quotient)).toEqual(["8 * m + 1", "m + (8 ^ k)"]);
    const w = divisibilityWitnesses("(7 : ℤ) ∣ 3 ^ (2 * (k + 1)) - 2 ^ (k + 1)", "(7 : ℤ) ∣ 3 ^ (2 * k) - 2 ^ k", "k");
    expect(w.map((x) => x.multiplier)).toEqual(expect.arrayContaining(["9", "2"]));
    // ring identifies 3 ^ (2 * k) with (3 ^ k) ^ 2, not with 9 ^ k; omega needs the flat 9 ^ k
    expect(w.find((x) => x.multiplier === "2")).toMatchObject({ quotient: "2 * m + (3 ^ k) ^ 2", flat: "2 * m + (9 ^ k)", scaled: true });
    expect(divisibilityWitnesses("3 ∣ (k + 1) ^ 3 + 2 * (k + 1)", "3 ∣ k ^ 3 + 2 * k", "k")[0]).toMatchObject({ multiplier: "1", quotient: "m + k ^ 2 + k + 1" });
    expect(divisibilityWitnesses("3 ∣ (k + 1) ^ 3 + 2 * (k + 1)", "3 ∣ k ^ 3 + 2 * k", "k")[0].flat).toBeUndefined();
    expect(divisibilityWitnesses("4 ∣ 5 ^ (k + 1) + 3", "4 ∣ 5 ^ k + 3", "k")[0].quotient).toBe("5 * m - 3");
    expect(divisibilityWitnesses("9 ∣ 4 ^ (k + 1) + 15 * (k + 1) - 1", "9 ∣ 4 ^ k + 15 * k - 1", "k")[0]).toMatchObject({ flat: "4 * m - 5 * k + 2" });
    expect(divisibilityWitnesses("11 ∣ 10 ^ (k + 1) - (-1) ^ (k + 1)", "11 ∣ 10 ^ k - (-1) ^ k", "k", "q")[0].quotient).toContain("10 * q");
  });
  it("gives up when no constant multiplier works", () => {
    expect(divisibilityWitnesses("6 ∣ (k + 1) ^ 3 + 5 * (k + 1)", "6 ∣ k ^ 3 + 5 * k", "k")).toEqual([]);
    expect(divisibilityWitnesses("5 ∣ 8 ^ (k + 1) - 1", "7 ∣ 8 ^ k - 1", "k")).toEqual([]);
    expect(divisibilityWitnesses("7 ∣ x ^ (k + 1) - 1", "7 ∣ x ^ k - 1", "k")).toEqual([]);
  });
});


/** A runner over a scripted proof: `step(goals, tactic)` gives the new goals, or null (Lean refuses). */
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

describe("the induction prover's steps", () => {
  it("reads the relation of a goal", () => {
    expect(relation("∑ i ∈ Finset.range n, (↑i + 1) = ↑n * (↑n + 1) / 2")).toBe("=");
    expect(relation("7 ∣ 8 ^ (k + 1) - 1")).toBe("∣");
    expect(relation("(k + 1) ^ 2 ≤ 2 ^ (k + 1)")).toBe("≤");
    expect(relation("4 ≤ n → n ^ 2 ≤ 2 ^ n")).toBeUndefined();
  });

  it("takes statements over ℕ, not geometry", () => {
    expect(looksInductive(": ∀ n : ℕ, 7 ∣ 8 ^ n - 1")).toBe(true);
    expect(looksInductive(": ∀ n ≥ 1, (n : ℝ) ≤ 2 ^ (n - 1)")).toBe(true);
    expect(looksInductive("(A B : ℝ × ℝ) : A = B")).toBe(false);
    expect(looksInductive(": (2 : ℕ) + 2 = 4")).toBe(false);
  });

  it("divisibility: plain induction, the step closed with the computed quotient", async () => {
    const succ = "case succ\nn✝ : ℕ\na✝ : 7 ∣ 8 ^ n✝ - 1\n⊢ 7 ∣ 8 ^ (n✝ + 1) - 1";
    const { run, script } = fakeRunner("⊢ ∀ (n : ℕ), 7 ∣ 8 ^ n - 1", (g, t) => {
      if (t === "intro n") return ["n : ℕ\n⊢ 7 ∣ 8 ^ n - 1"];
      if (t === "induction n") return ["case zero\n⊢ 7 ∣ 8 ^ 0 - 1", succ];
      if (t === "case zero => simp") return [];
      if (t.startsWith("case succ k ih => ") && t.includes("exact ⟨8 * m + 1") && t.includes("omega")) return [];
      return null;
    });
    const out = await proveByInduction(run);
    expect(out).toMatchObject({ ok: true, scheme: "induction" });
    expect(script[3]).toContain("rw [pow_succ 8 k]; omega");
  });

  it("a lower bound: Nat.le_induction, names for the step; a failed scheme is undone", async () => {
    const { run, script } = fakeRunner("⊢ ∀ (n : ℕ), 4 ≤ n → n ^ 2 ≤ 2 ^ n", (g, t) => {
      if (t === "intro n") return ["n : ℕ\n⊢ 4 ≤ n → n ^ 2 ≤ 2 ^ n"];
      if (t === "intro h1") return ["n : ℕ\nh1 : 4 ≤ n\n⊢ n ^ 2 ≤ 2 ^ n"];
      if (t === "induction n, h1 using Nat.le_induction")
        return ["case base\nn : ℕ\n⊢ 4 ^ 2 ≤ 2 ^ 4", "case succ\nn n✝ : ℕ\nhmn✝ : 4 ≤ n✝\na✝ : n✝ ^ 2 ≤ 2 ^ n✝\n⊢ (n✝ + 1) ^ 2 ≤ 2 ^ (n✝ + 1)"];
      if (t === "case base => simp") return [];
      if (t.startsWith("case succ k hk ih => nlinarith") && t.includes("Nat.mul_le_mul hk (le_refl k)") && t.includes("pow_succ 2 k")) return [];
      return null;
    });
    const out = await proveByInduction(run);
    expect(out).toMatchObject({ ok: true, scheme: "le_induction" });
    expect(script).toHaveLength(5);
  });

  it("a two-step recurrence: strong induction with two base cases", async () => {
    const hyps = "a : ℕ → ℤ\nh0 : a 0 = 0\nh1 : a 1 = 1\nhs : ∀ (n : ℕ), a (n + 2) = 3 * a (n + 1) - 2 * a n\n";
    const { run, script } = fakeRunner(`${hyps}⊢ ∀ (n : ℕ), a n = 2 ^ n - 1`, (g, t) => {
      if (t === "intro n") return [`${hyps}n : ℕ\n⊢ a n = 2 ^ n - 1`];
      if (t === "induction n using Nat.strong_induction_on") return [`case h\n${hyps}n✝ : ℕ\na✝ : ∀ m < n✝, a m = 2 ^ m - 1\n⊢ a n✝ = 2 ^ n✝ - 1`];
      if (t === "rename_i n ih") return [`${hyps}n : ℕ\nih : ∀ m < n, a m = 2 ^ m - 1\n⊢ a n = 2 ^ n - 1`];
      if (t === "rcases n with _ | _ | k") return [`${hyps}⊢ a 0 = 2 ^ 0 - 1`, `${hyps}⊢ a (0 + 1) = 2 ^ (0 + 1) - 1`, `${hyps}k : ℕ\nih : ∀ m < k + 1 + 1, a m = 2 ^ m - 1\n⊢ a (k + 1 + 1) = 2 ^ (k + 1 + 1) - 1`];
      if (t === "· simp [h0, h1]") return [];
      if (t === "· rw [hs, ih (k + 1) (by omega), ih k (by omega)]; ring") return [];
      return null;
    });
    const out = await proveByInduction(run);
    expect(out).toMatchObject({ ok: true, scheme: "strong" });
    expect(script.slice(-3)).toEqual(["· simp [h0, h1]", "· simp [h0, h1]", "· rw [hs, ih (k + 1) (by omega), ih k (by omega)]; ring"]);
  });
});
