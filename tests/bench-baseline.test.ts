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
