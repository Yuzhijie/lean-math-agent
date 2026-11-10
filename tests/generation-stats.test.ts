import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StageClock, generationLogPath, generationStats, logGeneration, measured } from "@/lib/generation-stats";
import { failureKind, generationReport } from "@/lib/generation-report";
import { recordUsage } from "@/lib/llm/usage-tracker";
import type { Generation } from "@/lib/bank/types";

beforeEach(() => vi.useRealTimers());

describe("generation stats", () => {
  it("times consecutive stages", () => {
    vi.useFakeTimers();
    const c = new StageClock();
    c.enter("writing");
    vi.advanceTimersByTime(3000);
    c.enter("solving");
    vi.advanceTimersByTime(5000);
    c.enter("writing");
    vi.advanceTimersByTime(1000);
    expect(c.stop()).toEqual({ writing: 4000, solving: 5000 });
  });

  it("counts the run's model calls in a scope of its own and logs one line", async () => {
    const m = await measured(async (clock) => {
      clock.enter("writing");
      recordUsage({ model: "m1", role: "general", promptTokens: 100, completionTokens: 20, latencyMs: 5, timestamp: Date.now() } as never);
      recordUsage({ model: "m1", role: "general", promptTokens: 50, completionTokens: 10, latencyMs: 5, timestamp: Date.now() } as never);
      return 7;
    });
    expect(m.result).toBe(7);
    const s = generationStats(m, { rounds: 2, written: 3, passed: 1 });
    expect(s).toMatchObject({ rounds: 2, written: 3, passed: 1, llm_calls: 2, prompt_tokens: 150, completion_tokens: 30, by_model: { m1: { calls: 2 } } });
    expect(Object.keys(s.stage_ms)).toEqual(["writing"]);
    logGeneration({ at: 1, kind: "builtin", label: "x", requested: 1, stats: s, outcomes: [{ passed: true, failed: {} }] });
    const lines = readFileSync(generationLogPath(), "utf8").trim().split("\n");
    expect(JSON.parse(lines[lines.length - 1])).toMatchObject({ kind: "builtin", stats: { llm_calls: 2 } });
  });
});

describe("generation report", () => {
  const cand = (passed: boolean, checks: Record<string, { ok: boolean; detail: string }>, source = "program") =>
    ({ id: Math.random().toString(36).slice(2), stem: "s", type: "multiple_choice", answer: "A", solution: "", hints: [], grade: "Year 2", difficulty: 2, knowledge_points: [], checks, passed, figure: { source } }) as never;
  const ok = { ok: true, detail: "ok" };
  const gen = (candidates: never[], extra: Partial<Generation> = {}) =>
    ({ id: "g", bank_id: "b", template: { item_ids: ["i"] }, template_label: "1 selected question", mode: "same_type", requested: 1, candidates, created_at: Date.UTC(2026, 10, 1), ...extra }) as Generation;

  it("reads failure details as kinds", () => {
    expect(failureKind("answer", "独立解答为 unsolvable，与答案 B 不一致")).toBe("independent solve: unsolvable / ill-posed");
    expect(failureKind("fit", "fit 2/5 — layout differs")).toBe("fit 2/5");
    expect(failureKind("fit", "匹配度 1/5 — 缺图")).toBe("fit 1/5");
    expect(failureKind("figure", "图形描述无效：parts.0.kind Invalid discriminator value")).toBe("figure spec invalid (kind the program does not have)");
    expect(failureKind("novelty", 'too close to bank question "x" (74%) — the rewording changed a number')).toBe("too close to a bank question (rewording did not help)");
  });

  it("counts rejections per check, sole failures, waste per template, and time per passed question", () => {
    const tiles = gen([cand(false, { format: ok, answer: { ok: false, detail: "independent answer is unsolvable, not B" }, fit: { ok: false, detail: "fit 1/5 — different puzzle" } }), cand(false, { format: ok, answer: ok, fit: { ok: false, detail: "fit 2/5 — x" } })], { template_label: "tiles" });
    const good = gen([cand(true, { format: ok, answer: ok }), cand(false, { format: ok, figure: { ok: false, detail: "图形描述无效：kind Invalid discriminator value" } }, "none")], {
      stats: { duration_ms: 90_000, rounds: 1, written: 3, passed: 2, stage_ms: { writing: 30_000, solving: 60_000 }, llm_calls: 6, prompt_tokens: 1, completion_tokens: 1, cost_usd: 0.03 },
    });
    const md = generationReport({
      generations: [{ ...tiles, template_text: "In this puzzle, the tiles have patterns" }, good],
      log: [{ at: 1, kind: "bank", label: "x", requested: 1, stats: good.stats!, outcomes: [] }],
      now: new Date(Date.UTC(2026, 10, 10)),
    });
    expect(md).toContain("| Questions written | 5 (at least: 1 older records");
    expect(md).toContain("| Passed every check | 2 (kept 1) |");
    expect(md).toMatch(/\| fit \| 2 \| 1 \|/);
    expect(md).toMatch(/\| figure \| 1 \| 1 \|/);
    expect(md).toContain("independent solve: unsolvable / ill-posed");
    expect(md).toMatch(/\| 2 \| 1 \| 2 \| 0 \| answer 1, fit 2 \| — \| In this puzzle/);
    expect(md).toContain("| Time per passed question | 45 s |");
    expect(md).toContain("| Cost per passed question | $0.0150 |");
    expect(md).toMatch(/\| solving \| 1.0 min \| 67% \|/);
    expect(md).toContain("No runs logged yet");
  });
});
