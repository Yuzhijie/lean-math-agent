import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { autoSearch } from "@/lib/lean/auto/search";
import { _resetRegisteredRulesForTests, allRules, BUILTIN_RULES, fileRule, finisherEntries, registerRule, splitterEntries } from "@/lib/lean/auto/rules";
import { readRuleStats, ruleStatsMarkdown } from "@/lib/lean/auto/stats";
import { parseGoal } from "@/lib/lean/geometry/goal";
import type { RunnerMark, TacticRunner } from "@/lib/lean/tactic-runner";

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

let dir: string;
const env = { ...process.env };
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "auto-rules-"));
  process.env.AUTO_RULE_STATS_PATH = path.join(dir, "stats.json");
  process.env.AUTO_RULES_PATH = path.join(dir, "rules.json");
  delete process.env.AUTO_RULE_STATS;
  delete process.env.AUTO_RULE_ORDER;
  _resetRegisteredRulesForTests();
});
afterEach(() => {
  process.env = { ...env };
  _resetRegisteredRulesForTests();
});

describe("rule table", () => {
  it("every built-in rule has a distinct id and a description", () => {
    const ids = BUILTIN_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(BUILTIN_RULES.every((r) => r.doc.length > 5)).toBe(true);
    expect(BUILTIN_RULES.filter((r) => r.kind === "finisher").at(-1)!.id).toBe("aesop");
  });

  it("tags each tactic with the rule that offered it", () => {
    const st = parseGoal("n : ℕ\nh : n + 5 ∣ n ^ 2 + 14\n⊢ n = 8")!;
    const es = finisherEntries(st);
    expect(es[0]).toEqual({ tactic: "rfl", rule: "equation" });
    expect(es.find((e) => e.tactic.includes("hbound"))!.rule).toBe("divisibility-bound");
    expect(es.at(-1)).toEqual({ tactic: "aesop", rule: "aesop" });
    let k = 0;
    const sp = splitterEntries(parseGoal("x : ℕ\nh₀ : x < 5\n⊢ x ≠ 2 ∧ x < 9")!, (b) => `${b}${++k}`);
    expect(sp.find((s) => s.tactic === "interval_cases x")!.rule).toBe("interval");
    expect(sp.find((s) => s.tactic === "constructor")!.rule).toBe("constructor");
  });

  it("a new strategy is one registered rule, placed before another or at the end of its kind", () => {
    registerRule({ id: "my-ring", kind: "finisher", doc: "ring_nf then linarith", tactics: (g) => (g.rel === "=" ? ["(ring_nf; linarith)"] : []) }, { before: "equation" });
    registerRule({ id: "late", kind: "finisher", doc: "something last", tactics: () => ["tauto"] });
    const es = finisherEntries(parseGoal("x : ℝ\n⊢ x = x")!);
    expect(es[0]).toEqual({ tactic: "(ring_nf; linarith)", rule: "my-ring" });
    const ids = allRules().filter((r) => r.kind === "finisher").map((r) => r.id);
    expect(ids.indexOf("late")).toBe(ids.indexOf("aesop") - 1);
    // a tactic an earlier rule already offered keeps that rule
    expect(es.filter((e) => e.tactic === "tauto")).toHaveLength(1);
  });

  it("a broken rule does not stop the others", () => {
    registerRule({ id: "boom", kind: "finisher", doc: "throws", tactics: () => { throw new Error("x"); } }, { before: "equation" });
    expect(finisherEntries(parseGoal("x : ℝ\n⊢ x = x")!)[0].tactic).toBe("rfl");
  });

  it("rules from the rule file: literal tactics, relation and pattern filters, forbidden commands dropped", () => {
    writeFileSync(
      process.env.AUTO_RULES_PATH!,
      JSON.stringify({
        rules: [
          { id: "amgm", kind: "finisher", relation: ["≤"], matches: "\\*", tactics: ["nlinarith [sq_nonneg (a - b)]", "sorry"], before: "inequality" },
          { id: "bad", kind: "finisher", tactics: ["#eval 1"] },
          { id: "unfold", kind: "splitter", matches: "myDef", tactics: ["unfold myDef"] },
        ],
      }),
    );
    const ineq = finisherEntries(parseGoal("a b : ℝ\n⊢ a * b ≤ (a ^ 2 + b ^ 2) / 2")!);
    expect(ineq.find((e) => e.rule === "amgm")).toEqual({ tactic: "nlinarith [sq_nonneg (a - b)]", rule: "amgm" });
    expect(ineq.findIndex((e) => e.rule === "amgm")).toBeLessThan(ineq.findIndex((e) => e.rule === "inequality"));
    expect(ineq.some((e) => e.tactic === "sorry" || e.rule === "bad")).toBe(false);
    expect(finisherEntries(parseGoal("a : ℝ\n⊢ a = a")!).some((e) => e.rule === "amgm")).toBe(false);
    expect(splitterEntries(parseGoal("x : ℕ\nh : myDef x\n⊢ x = 1")!, (b) => b).some((s) => s.rule === "unfold")).toBe(true);
    expect(fileRule({ id: "bad id!", kind: "finisher", tactics: ["simp"] })).toBeUndefined();
  });
});

describe("hit rates", () => {
  it("records tried / worked / in the proof per rule, across searches", async () => {
    const { run } = fakeRunner("x : ℕ\nh : x < 3\n⊢ x * x ≠ 5", (g, t) => {
      if (t === "interval_cases x") return ["h : 0 < 3\n⊢ 0 * 0 ≠ 5", "h : 1 < 3\n⊢ 1 * 1 ≠ 5", "h : 2 < 3\n⊢ 2 * 2 ≠ 5"];
      if (t === "· norm_num" && !/x/.test(g)) return [];
      return null;
    });
    const r = await autoSearch(run, { deadline: Date.now() + 60_000 });
    expect(r.ok).toBe(true);
    expect(r.stats.rules).toEqual(["interval", "not-equal", "not-equal", "not-equal"]);
    const s = readRuleStats();
    expect(s.searches).toBe(1);
    expect(s.proved).toBe(1);
    expect(s.rules["interval"]).toMatchObject({ tried: 1, worked: 1, proofs: 1 });
    expect(s.rules["not-equal"].worked).toBe(3);
    expect(s.rules["not-equal"].tried).toBeGreaterThan(3);
    expect(s.rules["aesop"].worked).toBe(0);

    const { run: run2 } = fakeRunner("x : ℕ\n⊢ x = x + 1", () => null);
    expect((await autoSearch(run2, { deadline: Date.now() + 60_000 })).ok).toBe(false);
    const s2 = readRuleStats();
    expect(s2.searches).toBe(2);
    expect(s2.proved).toBe(1);
    const md = ruleStatsMarkdown(s2, new Map(BUILTIN_RULES.map((r, i) => [r.id, { kind: r.kind, doc: r.doc, order: i }])));
    expect(md).toMatch(/\| `interval` \| 拆分 \|.*\| 1 \| 1 \| 100\.0% \| 1 \|/);
  });

  it("an undone splitter is not counted in the proof", async () => {
    const { run } = fakeRunner("p q : Prop\nhp : p\nhq : q\n⊢ p ∧ q", (g, t) => {
      if (t === "constructor") return ["hp : p\nhq : q\n⊢ p", "hp : p\nhq : q\n⊢ q"];
      if (t === "· tauto" && /⊢ p$/.test(g)) return [];
      if (t === "· aesop" && /⊢ q$/.test(g)) return [];
      return null;
    });
    const r = await autoSearch(run, { deadline: Date.now() + 60_000 });
    expect(r.stats.rules).toEqual(["constructor", "other", "aesop"]);
    // "constructor" is also a name on Object.prototype
    expect(readRuleStats().rules["constructor"]).toMatchObject({ tried: 1, worked: 1, proofs: 1 });
    expect(ruleStatsMarkdown(readRuleStats(), new Map())).not.toMatch(/undefined/);
  });

  it("AUTO_RULE_STATS=off writes nothing; AUTO_RULE_ORDER=learned tries the best record first", async () => {
    process.env.AUTO_RULE_STATS = "off";
    const { run } = fakeRunner("x : ℕ\n⊢ x = x", (_g, t) => (t === "· rfl" ? [] : null));
    await autoSearch(run, { deadline: Date.now() + 60_000 });
    expect(readRuleStats().searches).toBe(0);

    writeFileSync(process.env.AUTO_RULE_STATS_PATH!, JSON.stringify({ version: 1, searches: 9, proved: 9, rules: { "shifted-squares": { tried: 10, worked: 9, proofs: 9, searches: 9 }, equation: { tried: 100, worked: 1, proofs: 1, searches: 9 } } }));
    process.env.AUTO_RULE_ORDER = "learned";
    const es = finisherEntries(parseGoal("a : ℝ\nh : a = 2\n⊢ a * (4 - a) = 4")!);
    expect(es[0].rule).toBe("shifted-squares");
    expect(es.at(-1)!.rule).toBe("aesop");
    expect(JSON.parse(readFileSync(process.env.AUTO_RULE_STATS_PATH!, "utf8")).searches).toBe(9);
  });
});
