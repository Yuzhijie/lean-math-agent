import { describe, expect, it } from "vitest";
import { autoSearch } from "@/lib/lean/auto/search";
import { finishers, splitters } from "@/lib/lean/auto/tactics";
import { parseGoal } from "@/lib/lean/geometry/goal";
import type { RunnerMark, TacticRunner } from "@/lib/lean/tactic-runner";

function fakeRunner(start: string, step: (goal: string, tactic: string) => string[] | null) {
  let goals = [start];
  const script: string[] = [];
  let n = 0;
  const tried: string[] = [];
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
      tried.push(t);
      const next = step(goals[0], t);
      if (!next) return false;
      goals = [...next, ...goals.slice(1)];
      script.push(t);
      return true;
    },
  };
  return { run, script, tried };
}

const far = () => Date.now() + 60_000;

describe("tactic library", () => {
  it("picks finishers by the goal's relation", () => {
    const eq = finishers(parseGoal("x y : ℝ\nh : x = 2 * y\n⊢ x - 2 * y = 0")!);
    expect(eq.slice(0, 4)).toEqual(["rfl", "norm_num", "simp", "ring"]);
    expect(eq).toContain("linear_combination h");
    const ineq = finishers(parseGoal("a b : ℝ\nha : 0 < a\n⊢ a * b ≤ (a ^ 2 + b ^ 2) / 2")!);
    expect(ineq.some((t) => t.startsWith("nlinarith [sq_nonneg (a - b)"))).toBe(true);
    expect(finishers(parseGoal("h : 1 = 2\n⊢ False")!)[0]).toBe("simp_all");
  });

  it("offers the splitters the goal allows", () => {
    let k = 0;
    const fresh = (b: string) => `${b}${++k}`;
    const sp = splitters(parseGoal("x : ℕ\nh₀ : x < 5\nh₁ : x = 1 ∨ x = 3\n⊢ x ≠ 2 ∧ x % 2 = 1")!, fresh).map((s) => s.tactic);
    expect(sp).toContain("constructor");
    expect(sp).toContain("interval_cases x");
    expect(sp.some((t) => t.startsWith("rcases h₁ with"))).toBe(true);
    const ex = splitters(parseGoal("⊢ ∃ n : ℕ, n * 7 = 21")!, fresh).map((s) => s.tactic);
    expect(ex).toContain("use 21");
    const abs = splitters(parseGoal("x : ℝ\nh : |x - 1| < 2\n⊢ x < 3")!, fresh).map((s) => s.tactic);
    expect(abs.some((t) => t.startsWith("rcases abs_cases (x - 1)"))).toBe(true);
  });
});

describe("the search", () => {
  it("splits into every value, closes each, and writes a linear script", async () => {
    const { run, script } = fakeRunner("x : ℕ\nh : x < 3\n⊢ x * x ≠ 5", (g, t) => {
      if (t === "interval_cases x") return ["h : 0 < 3\n⊢ 0 * 0 ≠ 5", "h : 1 < 3\n⊢ 1 * 1 ≠ 5", "h : 2 < 3\n⊢ 2 * 2 ≠ 5"];
      if (t === "· norm_num" && !/x/.test(g)) return [];
      return null;
    });
    const r = await autoSearch(run, { deadline: far() });
    expect(r.ok).toBe(true);
    expect(script).toEqual(["interval_cases x", "· norm_num", "· norm_num", "· norm_num"]);
    expect(r.stats.splitters).toEqual(["interval"]);
  });

  it("undoes a splitter whose parts do not all close, and tries the next one", async () => {
    const { run, script } = fakeRunner("p q : Prop\nhp : p\nhq : q\n⊢ p ∧ q", (g, t) => {
      if (t === "constructor") return ["hp : p\nhq : q\n⊢ p", "hp : p\nhq : q\n⊢ q"];
      if (t === "· tauto" && /⊢ p$/.test(g)) return [];
      if (t === "· aesop" && /⊢ q$/.test(g)) return [];
      return null;
    });
    const r = await autoSearch(run, { deadline: far() });
    expect(r.ok).toBe(true);
    expect(script).toEqual(["constructor", "· tauto", "· aesop"]);
  });

  it("gives up at the deadline without throwing", async () => {
    const { run } = fakeRunner("x : ℕ\n⊢ x = x + 0", () => null);
    const r = await autoSearch(run, { deadline: Date.now() - 1 });
    expect(r.ok).toBe(false);
  });
});
