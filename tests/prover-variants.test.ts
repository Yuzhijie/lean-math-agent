import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEDICATED_ROUTES, parseVariantRun, sameRouteRate, selectVariants, variantReport, variantVerdict, type VariantRow, type VariantRun } from "@/lib/pipeline/prover-variants";
import type { RegressionFixture } from "@/lib/pipeline/prover-regression";
import { readVariantRuns } from "@/scripts/provers-variants";

const fixture: RegressionFixture = {
  name: "t",
  cases: [
    { id: "ind-a", name: "ind_a", type: "(n : ℕ) (hn : 5 ≤ n) : n ^ 2 < 2 ^ n", expect: "induction", for: "induction" },
    { id: "ind-b", name: "ind_b", type: ": ∀ n : ℕ, 2 ∣ n * (n + 1)", expect: "induction", for: "induction" },
    { id: "opt-a", name: "opt_a", type: ": IsGreatest {n : ℕ | n < 5} 4", expect: "optimize", for: "optimize/oddtown", slow: true },
    { id: "ham-a", name: "ham_a", type: "(n : ℕ) : n + 0 = n", expect: "hammer", for: "hammer" },
    { id: "calc", name: "calc", type: ": (12 : ℕ) - 4 - 3 = 5", expect: "trivial" },
    { id: "none-a", name: "false_one", type: ": ∀ n : ℕ, n = n + 1", expect: "none" },
    { id: "open-a", name: "open_one", type: ": ∀ n : ℕ, n = n + 0", for: "auto" },
  ],
};

const row = (id: string, over: Partial<VariantRow> = {}): VariantRow => {
  const [base, kind] = id.split("~");
  return { id, base, kind: kind as VariantRow["kind"], expect: fixture.cases.find((c) => c.id === base)!.expect as VariantRow["expect"], equivalent: true, ms: 1000, ...over };
};

describe("which variants a run covers", () => {
  it("by default: the statements a prover, a script or the search proves — every kind that changes them", () => {
    const vs = selectVariants(fixture);
    expect(vs.map((v) => v.id)).toEqual(["ind-a~prime", "ind-a~letters", "ind-a~subscript", "ind-a~case", "ind-a~binders", "ind-a~flip", "ind-b~prime", "ind-b~letters", "ind-b~subscript", "ind-b~binders", "opt-a~prime", "opt-a~letters", "opt-a~subscript", "opt-a~flip"]);
    expect(vs.every((v) => DEDICATED_ROUTES.includes(v.expect))).toBe(true);
    expect(vs[0]).toMatchObject({ expect: "induction", baseType: "(n : ℕ) (hn : 5 ≤ n) : n ^ 2 < 2 ^ n", variant: { kind: "prime", type: "(n' : ℕ) (hn' : 5 ≤ n') : n' ^ 2 < 2 ^ n'" } });
  });

  it("never a must-not-prove or an open statement; the cascade's and the single tactics' only when asked", () => {
    const all = selectVariants(fixture, { all: true }).map((v) => v.base.id);
    expect(new Set(all)).toEqual(new Set(["ind-a", "ind-b", "opt-a", "ham-a"])); // `calc` binds nothing: no variant
    expect(selectVariants(fixture, { ids: ["ham-a", "none-a", "open-a"] }).map((v) => v.id)).toEqual(["ham-a~prime", "ham-a~letters", "ham-a~subscript", "ham-a~binders"]);
  });

  it("narrowed by prover, kind, speed and number", () => {
    expect(selectVariants(fixture, { only: ["optimize/oddtown"] }).map((v) => v.id)).toEqual(["opt-a~prime", "opt-a~letters", "opt-a~subscript", "opt-a~flip"]);
    expect(selectVariants(fixture, { only: ["induction"], kinds: ["flip", "binders"] }).map((v) => v.id)).toEqual(["ind-a~flip", "ind-a~binders", "ind-b~binders"]);
    expect(selectVariants(fixture, { quick: true }).some((v) => v.base.id === "opt-a")).toBe(false);
    expect(new Set(selectVariants(fixture, { perGroup: 1 }).map((v) => v.base.id))).toEqual(new Set(["ind-a", "opt-a"]));
    expect(selectVariants(fixture, { limit: 3 })).toHaveLength(3);
  });
});

describe("a variant's verdict", () => {
  it("same route, another route, lost, not confirmed, error", () => {
    expect(variantVerdict(row("ind-a~prime", { strategy: "induction" }))).toBe("same");
    expect(variantVerdict(row("ind-a~prime", { strategy: "auto" }))).toBe("other");
    expect(variantVerdict(row("ind-a~prime"))).toBe("lost");
    expect(variantVerdict(row("ind-a~prime", { equivalent: false }))).toBe("unchecked");
    expect(variantVerdict(row("ind-a~prime", { strategy: "induction", error: "boom" }))).toBe("error");
  });

  it("the rate counts only the variants Lean confirmed and that ran", () => {
    const rows = [row("ind-a~prime", { strategy: "induction" }), row("ind-a~letters", { strategy: "auto" }), row("ind-a~flip"), row("ind-a~case", { equivalent: false }), row("ind-b~prime", { error: "x" })];
    expect(sameRouteRate(rows)).toEqual({ same: 1, run: 3 });
  });
});

describe("a run file", () => {
  const meta = { type: "run", at: "2026-11-16T03:00:00.000Z", fixture: "t", selected: 3, host: "linux-x64-abc123", args: [], commit: "0123456789abcdef" };
  const lines = (rows: VariantRow[], at = meta.at) => [JSON.stringify({ ...meta, at }), ...rows.map((r) => JSON.stringify(r)), JSON.stringify({ type: "end", at, wall_ms: 5000 })].join("\n");

  it("the last row of a variant wins; a cut-off line is skipped; no run record → nothing", () => {
    const text = `${lines([row("ind-a~prime"), row("ind-a~prime", { strategy: "induction" })])}\n{"id":"ind-a~fl`;
    const run = parseVariantRun("f", text)!;
    expect(run.rows).toHaveLength(1);
    expect(run.rows[0].strategy).toBe("induction");
    expect(run.ended?.wall_ms).toBe(5000);
    expect(parseVariantRun("f", JSON.stringify(row("ind-a~prime")))).toBeUndefined();
  });

  it("reads every variants-*.jsonl of a directory, oldest first, and nothing else", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "variants-"));
    writeFileSync(path.join(dir, "variants-b.jsonl"), lines([row("ind-a~prime")], "2026-11-17T00:00:00.000Z"));
    writeFileSync(path.join(dir, "variants-a.jsonl"), lines([row("ind-a~prime", { strategy: "induction" })]));
    writeFileSync(path.join(dir, "provers-a.jsonl"), lines([row("ind-b~prime")]));
    expect(readVariantRuns(dir).map((r) => path.basename(r.file))).toEqual(["variants-a.jsonl", "variants-b.jsonl"]);
    expect(readVariantRuns(path.join(dir, "missing"))).toEqual([]);
  });

  describe("the report", () => {
    const run = (at: string, rows: VariantRow[]): VariantRun => ({ file: at, meta: { ...meta, type: "run", at }, rows });
    const before = run("2026-11-16T03:00:00.000Z", [
      row("ind-a~prime", { reason: "没有认出归纳变量", rescueMs: 120_000, tried: ["自动化策略没有证出"], note: "n → n'" }),
      row("ind-a~letters", { strategy: "auto", reason: "", rescueMs: 120_000, note: "n → q" }),
      row("ind-b~prime", { strategy: "induction" }),
      row("opt-a~prime", { strategy: "optimize" }),
      row("opt-a~letters", { equivalent: false }),
    ]);
    const after = run("2026-11-16T09:00:00.000Z", [
      row("ind-a~prime", { strategy: "induction" }),
      row("ind-a~letters", { strategy: "induction" }),
      row("ind-b~prime", { strategy: "induction" }),
      row("opt-a~prime", { note: "n → n'", reason: "取不到 | 的值" }),
      row("opt-a~letters", { equivalent: false }),
    ]);

    it("no run yet: says how to make one", () => {
      expect(variantReport(fixture, [])).toMatch(/还没有运行结果[\s\S]*npm run lean:variants/);
    });

    it("one run: the rate, by prover, by rewrite, what was lost and what moved", () => {
      const text = variantReport(fixture, [before]);
      expect(text).toContain("3 条陈述的 4 个变体：**2 个（50%）由同一路线证出**，1 个换了路线，1 个丢失。");
      expect(text).toContain("| induction | 3 | 1（33%） | 1 | 1 |");
      expect(text).toContain("| optimize/oddtown | 1 | 1（100%） | 0 | 0 |");
      expect(text).toContain("| ind-a~prime | induction | induction | n → n' | 没有认出归纳变量 |");
      expect(text).toContain("| ind-a~letters | induction | induction | auto | n → q | 没有接这条陈述（认不出是它的题型） | 1.0 秒 |");
      expect(text).not.toContain("标 * 的");
      expect(text).toMatch(/Lean 没能确认等价的变体[\s\S]*opt-a~letters/);
      expect(text).not.toContain("与上一次");
    });

    it("two runs: every run in the table, the latest in detail, gained and lost against the one before", () => {
      const text = variantReport(fixture, [after, before]);
      expect(text.indexOf("2026-11-16 03:00")).toBeLessThan(text.indexOf("2026-11-16 09:00"));
      expect(text).toContain("## 最近一次运行：2026-11-16 09:00");
      expect(text).toContain("两次都跑过的 4 个变体：同一路线证出 2（50%）→ 3（75%）；丢失 1 → 1，换了路线 1 → 0。新由同一路线证出 2 个（ind-a~prime、ind-a~letters），退步 1 个（opt-a~prime）。");
      // a bar in a prover's words does not break the table; the other routes were not tried on it
      expect(text).toContain("| opt-a~prime * | optimize/oddtown | optimize | n → n' | 取不到 \\| 的值 |");
      expect(text).toContain("（标 * 的没有再试其余路线。）");
    });

    it("says whether the provers read the variants in the reading form or as written", () => {
      const off: VariantRun = { ...before, meta: { ...before.meta, reading: false } };
      const text = variantReport(fixture, [off, after]);
      expect(text).toMatch(/\| 2026-11-16 03:00 \| 关 \|/);
      expect(text).toMatch(/\| 2026-11-16 09:00 \| 开 \|/);
      expect(text).not.toContain("备注");
      // a run's note gets its column
      const noted = variantReport(fixture, [{ ...off, meta: { ...off.meta, note: "改动之前的代码" } }, after]);
      expect(noted).toMatch(/\| 提交 \| 备注 \|/);
      expect(noted).toMatch(/\| 改动之前的代码 \|\n.*\| — \|/);
    });

    it("counts the proofs that went through the reading form inside the proof", () => {
      const text = variantReport(fixture, [run("2026-11-16T03:00:00.000Z", [row("ind-a~prime", { strategy: "induction", bridged: true }), row("ind-a~flip", { strategy: "induction" })])]);
      expect(text).toContain("其中 1 个的证明脚本在变体原文下跑不通");
    });

    it("all by the same route: says so", () => {
      expect(variantReport(fixture, [run("2026-11-16T03:00:00.000Z", [row("ind-a~prime", { strategy: "induction" })])])).toContain("**每个变体都由原来的路线证出。**");
    });
  });
});
