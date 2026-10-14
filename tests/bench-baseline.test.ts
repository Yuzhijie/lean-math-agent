import { describe, expect, it } from "vitest";
import { runPool } from "../scripts/bench";
import { renderReport, type ResultFile } from "../scripts/bench-report";

describe("runPool (bench --concurrency)", () => {
  it("runs at most n at once and keeps the input order", async () => {
    let running = 0;
    let peak = 0;
    const out = await runPool([30, 5, 20, 1, 10], 2, async (ms, i) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, ms));
      running--;
      return `${i}:${ms}`;
    });
    expect(peak).toBe(2);
    expect(out).toEqual(["0:30", "1:5", "2:20", "3:1", "4:10"]);
    expect(await runPool([], 4, async () => 1)).toEqual([]);
    expect(await runPool([1, 2], 0, async (x) => x * 2)).toEqual([2, 4]);
  });
});

const row = (id: string, difficulty: string, ok: boolean, extra: Partial<ResultFile["rows"][number]> = {}) => ({
  id,
  difficulty,
  ok,
  proved_by: ok ? "hammer" : "none",
  wall_ms: ok ? 20_000 : 300_000,
  cost: ok ? 0.01 : 0.1,
  ...(ok ? {} : { failure: { kind: "tactic_failed", detail: "" } }),
  ...extra,
});

describe("bench report (BASELINE.md)", () => {
  const first: ResultFile = {
    started_at: "2026-09-23T10:31:17.807Z",
    file: "minif2f-test.json",
    strategy: "cascade",
    budget: "normal",
    pass: 2,
    total: 3,
    rows: [row("a", "easy", true), row("b", "medium", true, { proved_by: "whole_proof" }), row("c", "hard", false)],
  };
  const retest: ResultFile = {
    ...first,
    started_at: "2026-10-15T01:00:00.000Z",
    concurrency: 3,
    memory: "readonly",
    commit: "abc1234",
    pass: 2,
    total: 3,
    rows: [row("a", "easy", true), row("b", "medium", false, { failure: { kind: "unsolved_goal", detail: "" } }), row("c", "hard", true, { proved_by: "sketch" })],
  };
  const capped: ResultFile = { ...first, started_at: "2026-10-15T02:00:00.000Z", budget: "low", max_cost: 0.2, pass: 1, total: 2, skipped: ["c"], rows: [row("a", "easy", true), row("b", "medium", false), row("c", "hard", false, { skipped: true, cost: 0, wall_ms: 0 })] };

  it("summarises each run and what changed between runs", () => {
    const md = renderReport([
      { name: "first run", result: first },
      { name: "retest", result: retest },
    ]);
    expect(md).toContain("| first run | 2026-09-23 | minif2f-test.json | cascade / normal | 2/3 (67%) | easy 1/1, medium 1/1, hard 0/1 | $0.12 | $0.06 |");
    expect(md).toContain("| retest | 2026-10-15 | minif2f-test.json | cascade / normal ×3 | 2/3 (67%)");
    expect(md).toContain("abc1234");
    expect(md).toContain("- Proved by: hammer 1, whole_proof 1");
    expect(md).toContain("Failed theorems took $0.10 of $0.12 (83%)");
    expect(md).toContain("## retest vs first run");
    expect(md).toContain("On the 3 theorems both runs attempted: 2 → 2 proved.");
    expect(md).toContain("| c | hard | failed (tactic_failed) | proved (sketch) |");
    expect(md).toContain("| b | medium | proved (whole_proof) | failed (unsolved_goal) |");
  });

  it("counts only the theorems that ran when the cost cap stopped a run", () => {
    const md = renderReport([{ name: "capped", result: capped }]);
    expect(md).toContain("1/2 (50%), 1 not run");
    expect(md).toContain("Not run (cost cap): 1 theorem(s).");
    expect(md).toContain("cost cap $0.2");
  });
});

describe("statement repairs (fixStatement)", async () => {
  const { fixStatement } = await import("../scripts/fetch-benchmark");
  it("parenthesises big-operator bodies written for the old precedence", () => {
    expect(fixStatement("(a d : ℝ) (h₀ : (∑ k ∈ Finset.range 5, a + k * d) = 70) : a = 42 / 5")).toBe("(a d : ℝ) (h₀ : (∑ k ∈ Finset.range 5, (a + k * d)) = 70) : a = 42 / 5");
    expect(fixStatement(": (∏ k ∈ Finset.range 6, 2 * k + 1) % 10 = 5")).toBe(": (∏ k ∈ Finset.range 6, (2 * k + 1)) % 10 = 5");
    expect(fixStatement(": (∏ k ∈ Finset.range 7, 2 ^ 2 ^ k + 3 ^ 2 ^ k) = 3 ^ 128 - 2 ^ 128")).toBe(": (∏ k ∈ Finset.range 7, (2 ^ 2 ^ k + 3 ^ 2 ^ k)) = 3 ^ 128 - 2 ^ 128");
    expect(fixStatement("(a : ℕ) (h₁ : ↑(∑ k ∈ Finset.range 8, 2 * k + 1) - ↑(∑ k ∈ Finset.range 5, a + 2 * k) = (4 : ℤ)) : a = 8")).toBe(
      "(a : ℕ) (h₁ : ↑(∑ k ∈ Finset.range 8, (2 * k + 1)) - ↑(∑ k ∈ Finset.range 5, (a + 2 * k)) = (4 : ℤ)) : a = 8",
    );
  });
  it("leaves statements that already parse as intended alone", () => {
    for (const s of [": (∑ k ∈ Finset.Icc 1 100, k) + 1 = 5051", "(f : ℕ → ℕ) : ∑ k ∈ Finset.range 10, f k = 3", ": (∑ k ∈ Finset.range 5, (k + 1)) = 15", "(x : ℝ) : x + 1 > x"]) {
      expect(fixStatement(s)).toBe(s);
    }
  });
  it("replaces the removed Complex.abs by the norm", () => {
    expect(fixStatement("(a b : ℂ) : Complex.abs (a - b) ≤ 2 * Real.sqrt 21")).toBe("(a b : ℂ) : ‖a - b‖ ≤ 2 * Real.sqrt 21");
    expect(fixStatement("(z : ℂ) : Complex.abs z = 1")).toBe("(z : ℂ) : ‖z‖ = 1");
  });
});

describe("failure buckets and re-runs", async () => {
  const { classifyFailure } = await import("../scripts/bench");
  const { mergeResults, rerunIds } = await import("../scripts/bench-merge");
  it("classifies current Lean 4 messages", () => {
    expect(classifyFailure({ summary: "failed to prove positivity/nonnegativity/nonzeroness" }).kind).toBe("tactic_failed");
    expect(classifyFailure({ summary: "omega could not prove the goal:" }).kind).toBe("tactic_failed");
    expect(classifyFailure({ summary: "Tactic `simp` failed with a nested error:" }).kind).toBe("tactic_failed");
    expect(classifyFailure({ summary: "`dsimp` made no progress" }).kind).toBe("tactic_failed");
    expect(classifyFailure({ summary: "Function expected at" }).kind).toBe("type_mismatch");
    expect(classifyFailure({ summary: "Unknown constant `Real.pi_lt_22_div_7`" }).kind).toBe("unknown_identifier");
    expect(classifyFailure({ summary: "Lean REPL command timed out after 120000ms; worker #12 was killed" }).kind).toBe("timeout");
    expect(classifyFailure({ summary: "unknown tactic" }).kind).toBe("syntax_error");
  });
  it("picks the theorems to re-run and merges them into the full run", () => {
    const bench = { theorems: [{ id: "a", type: ": 1 = 1" }, { id: "b", type: ": (∑ k ∈ Finset.range 3, k + 1) = 6" }, { id: "c", type: ": 2 = 2" }, { id: "d", type: ": 3 = 3" }, { id: "e", type: ": 4 = 4" }] };
    const full = {
      started_at: "2026-10-14T04:08:50.315Z",
      rows: [
        { id: "a", ok: true, proved_by: "hammer" },
        { id: "b", ok: false, proved_by: "none", failure: { kind: "statement_error", detail: "Unknown identifier `k`" } },
        { id: "c", ok: false, proved_by: "none", llm_calls: 0, failure: { kind: "no_candidate", detail: "no parseable proof was sampled" } },
        { id: "d", ok: false, proved_by: "none", failure: { kind: "statement_error", detail: "Lean REPL command timed out after 180000ms; worker #17 was killed" } },
        { id: "e", ok: false, proved_by: "none", llm_calls: 3, failure: { kind: "syntax_error", detail: "omega could not prove the goal:" } },
      ],
    };
    expect(rerunIds(full, bench)).toEqual(["b", "c", "d"]);
    const rerun = { started_at: "2026-10-15T00:00:00.000Z", commit: "abc", rows: [{ id: "b", ok: true, proved_by: "whole_proof" }, { id: "c", ok: true, proved_by: "hammer" }, { id: "d", ok: false, proved_by: "none", failure: { kind: "unsolved_goal", detail: "" } }] };
    const merged = mergeResults(full, [rerun]);
    expect(merged.pass).toBe(3);
    expect(merged.total).toBe(5);
    expect(merged.failures).toEqual({ unsolved_goal: 1, tactic_failed: 1 });
    expect(merged.rows.find((r) => r.id === "b")?.rerun).toBe(true);
  });
});
