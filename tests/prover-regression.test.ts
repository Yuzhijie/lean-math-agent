import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { acceptRun, groupOf, isRegression, parseFixture, parseRegressionRun, regressionReport, ROUTES, selectCases, serializeFixture, slower, SLOW_MS, verdictOf, type CaseRow, type RegressionFixture, type RegressionRun } from "@/lib/pipeline/prover-regression";
import { looksGeometric } from "@/lib/lean/geometry";
import { looksInductive } from "@/lib/lean/induction";
import { looksOptimization } from "@/lib/lean/optimize";
import { oddtownShape } from "@/lib/lean/optimize/oddtown";
import { looksCombinatorial } from "@/lib/lean/combinatorics";
import { circularShape } from "@/lib/lean/combinatorics/circular";
import { orbitShape } from "@/lib/lean/combinatorics/orbit";
import { boundedMinScripts, orderProofScripts } from "@/lib/pipeline/lean-attempt";
import { normalizeTheoremType } from "@/lib/llm/autoformalize";
import { readRegressionRuns, sandboxVersions } from "@/scripts/provers-regress";

const fixture: RegressionFixture = {
  name: "t",
  cases: [
    { id: "geo-a", name: "geo_a", type: "(A : ℝ × ℝ) : A.1 = A.1", expect: "geometry", for: "geometry/angles", about: "an angle chase", slow: true },
    { id: "opt-a", name: "opt_a", type: ": IsGreatest {n : ℕ | n < 5} 4", expect: "optimize", for: "optimize/oddtown" },
    { id: "opt-b", name: "opt_b", type: ": IsLeast {n : ℕ | 2 < n} 3", expect: "optimize", for: "optimize" },
    { id: "ind-a", name: "ind_a", type: ": ∀ n : ℕ, 2 ∣ n * (n + 1)", expect: "induction", for: "induction" },
    { id: "s-hammer-01", name: "calc", type: ": (12 : ℕ) - 4 - 3 = 5", expect: "hammer", for: "hammer", source: "session" },
    { id: "none-a", name: "false_one", type: ": (2 : ℕ) + 2 = 5", expect: "none" },
    { id: "open-a", name: "open_one", type: ": ∀ n : ℕ, n = n + 0", for: "auto" },
  ],
};

describe("the fixture", () => {
  it("validates: ids and statements once each, every statement a theorem statement", () => {
    const text = serializeFixture(fixture);
    expect(parseFixture(text)).toEqual(fixture);
    // one case per line: a diff shows what changed
    expect(text.split("\n").filter((l) => l.includes('"id"'))).toHaveLength(fixture.cases.length);
    const withCase = (c: object) => JSON.stringify({ name: "t", cases: [...fixture.cases, c] });
    expect(() => parseFixture(withCase({ id: "geo-a", name: "x", type: ": True" }))).toThrow(/duplicate id geo-a/);
    expect(() => parseFixture(withCase({ id: "dup", name: "x", type: ":  (2 : ℕ) + 2 = 5" }))).toThrow(/same statement as none-a/);
    expect(() => parseFixture(withCase({ id: "bad", name: "x", type: ": True := by trivial" }))).toThrow(/bad/);
    expect(() => parseFixture(withCase({ id: "Bad Id", name: "x", type: ": True" }))).toThrow();
    expect(() => parseFixture(withCase({ id: "route", name: "x", type: ": True", expect: "magic" }))).toThrow();
  });

  it("selects by id, prover, route, speed", () => {
    const ids = (sel: Parameters<typeof selectCases>[1]) => selectCases(fixture, sel).map((c) => c.id);
    expect(ids({})).toHaveLength(7);
    expect(ids({ ids: ["ind-a", "none-a"] })).toEqual(["ind-a", "none-a"]);
    expect(ids({ only: ["optimize"] })).toEqual(["opt-a", "opt-b"]);
    expect(ids({ only: ["optimize/oddtown"] })).toEqual(["opt-a"]);
    expect(ids({ only: ["geometry", "hammer"] })).toEqual(["geo-a", "s-hammer-01"]);
    expect(ids({ quick: true })).not.toContain("geo-a");
    expect(ids({ slow: true })).toEqual(["geo-a"]);
    expect(ids({ limit: 2 })).toEqual(["geo-a", "opt-a"]);
    expect(groupOf(fixture.cases[0])).toBe("geometry");
    expect(groupOf({ expect: "none" })).toBe("none");
  });
});

describe("verdicts", () => {
  it("ok, another route, failed, a statement that must not be proved, open targets, errors", () => {
    const v = (r: Partial<CaseRow>) => verdictOf({ id: "x", ms: 1, ...r });
    expect(v({ expect: "optimize", strategy: "optimize" })).toBe("ok");
    expect(v({ expect: "optimize", strategy: "hammer" })).toBe("other_route");
    expect(v({ expect: "optimize" })).toBe("failed");
    expect(v({ expect: "none" })).toBe("ok");
    expect(v({ expect: "none", strategy: "hammer" })).toBe("unexpected");
    expect(v({})).toBe("open");
    expect(v({ strategy: "auto" })).toBe("gained");
    expect(v({ expect: "optimize", strategy: "optimize", error: "worker died" })).toBe("error");
    expect((["ok", "other_route", "open", "gained"] as const).some(isRegression)).toBe(false);
    expect((["failed", "unexpected", "error"] as const).every(isRegression)).toBe(true);
  });

  it("slower: at least twice as long and half a minute more", () => {
    expect(slower(70_000, 30_000)).toBe(true);
    expect(slower(50_000, 30_000)).toBe(false);
    expect(slower(9_000, 1_000)).toBe(false);
    expect(slower(400_000, 250_000)).toBe(false);
  });
});

const meta = (at: string, o: Partial<RegressionRun["meta"]> = {}): RegressionRun["meta"] => ({ type: "run", at, fixture: "t", selected: 7, commit: "0123456789abcdef", lean: "Lean 4.33.1", mathlib: "Mathlib v4.33.1", host: "darwin-arm64-abc123", args: [], ...o });
const first: RegressionRun = {
  file: "a",
  meta: meta("2026-11-13T01:00:00.000Z"),
  rows: [
    { id: "geo-a", expect: "geometry", strategy: "geometry", ms: 200_000 },
    { id: "opt-a", expect: "optimize", strategy: "optimize", ms: 30_000 },
    { id: "opt-b", expect: "optimize", strategy: "optimize", ms: 4_000 },
    { id: "ind-a", expect: "induction", strategy: "induction", ms: 3_000 },
    { id: "s-hammer-01", expect: "hammer", strategy: "hammer", ms: 1_000 },
    { id: "none-a", expect: "none", ms: 60_000, tried: ["策略组合搜索（no combination closed every goal）"] },
    { id: "open-a", ms: 70_000, tried: ["x"] },
  ],
  ended: { at: "2026-11-13T01:10:00.000Z", wall_ms: 368_000 },
};
const second: RegressionRun = {
  file: "b",
  meta: meta("2026-12-01T01:00:00.000Z", { mathlib: "Mathlib v4.34.0", lean: "Lean 4.34.0" }),
  rows: [
    { id: "geo-a", expect: "geometry", ms: 610_000, tried: ["程序写的坐标代数证明（no certificate）", "x | y"] },
    { id: "opt-a", expect: "optimize", strategy: "optimize", ms: 95_000 },
    { id: "opt-b", expect: "optimize", strategy: "hammer", ms: 2_000 },
    { id: "ind-a", expect: "induction", strategy: "induction", ms: 3_500 },
    { id: "s-hammer-01", expect: "hammer", strategy: "hammer", ms: 900 },
    { id: "none-a", expect: "none", ms: 61_000 },
    { id: "open-a", strategy: "auto", ms: 5_000 },
  ],
};

describe("run files", () => {
  it("parses a run: the last row of an id wins, a line cut off by a crash is skipped", () => {
    const text = [JSON.stringify(first.meta), JSON.stringify({ id: "x", ms: 1, error: "worker died" }), JSON.stringify({ id: "x", expect: "auto", strategy: "auto", ms: 2 }), '{"id":"y","ms', JSON.stringify({ type: "end", at: "t", wall_ms: 9 })].join("\n");
    const r = parseRegressionRun("f", text)!;
    expect(r.rows).toEqual([{ id: "x", expect: "auto", strategy: "auto", ms: 2 }]);
    expect(r.ended).toEqual({ at: "t", wall_ms: 9 });
    expect(parseRegressionRun("f", '{"id":"x","ms":1}')).toBeUndefined();
  });

  it("accepting a run records the routes it proved and never hides a failure", () => {
    const { fixture: f, changed } = acceptRun(fixture, second.rows);
    const by = new Map(f.cases.map((c) => [c.id, c]));
    // proved by another route, proved for the first time, slower than the slow mark
    expect(by.get("opt-b")).toMatchObject({ expect: "hammer" });
    expect(by.get("open-a")).toMatchObject({ expect: "auto" });
    // opt-a kept its route and took over a minute this time: marked slow
    expect(by.get("opt-a")).toMatchObject({ expect: "optimize", slow: true });
    expect(changed.sort()).toEqual(["open-a", "opt-a", "opt-b"]);
    // not proved: what it had stays — the regression is still a regression next time
    expect(by.get("geo-a")).toEqual(fixture.cases[0]);
    expect(by.get("none-a")?.expect).toBe("none");
    // the slow mark follows the time
    const timed = acceptRun(fixture, [{ id: "opt-a", expect: "optimize", strategy: "optimize", ms: SLOW_MS + 1 }, { id: "geo-a", expect: "geometry", strategy: "geometry", ms: 5_000 }]).fixture;
    expect(timed.cases.find((c) => c.id === "opt-a")?.slow).toBe(true);
    expect(timed.cases.find((c) => c.id === "geo-a")?.slow).toBeUndefined();
    // a must-not-prove statement that was proved is not turned into an expectation
    expect(acceptRun(fixture, [{ id: "none-a", expect: "none", strategy: "hammer", ms: 1 }]).changed).toEqual([]);
  });
});

describe("regressionReport", () => {
  it("says what to do when there is no run yet", () => {
    expect(regressionReport(fixture, [])).toContain("npm run lean:regress");
  });

  it("a clean run: the headline, per prover, every case", () => {
    const md = regressionReport(fixture, [first]);
    expect(md).toContain("7 条用例：6 条通过，0 条换了路线，0 条没证出，0 条不该证出却证出了，0 条运行出错，1 条仍未证出。**没有退化。**");
    expect(md).toMatch(/\| optimize \| 2 \| 2 \| 0 \| 0 \| 34 秒 \| opt-a（30 秒） \|/);
    expect(md).toMatch(/\| geo-a \| geometry\/angles \| ✓ \| geometry \| 3.3 分钟 \| an angle chase \|/);
    expect(md).toMatch(/\| none-a \| — \| ✓ \| （不该证出） \|/);
    expect(md).toMatch(/\| 2026-11-13 01:00 \| darwin-arm64-abc123 \| Lean 4.33.1 \/ Mathlib v4.33.1 \| 7 \| 6 \| 0 \| 1 \| 0 \| 0 \| 6.1 分钟 \| `0123456` \|/);
    expect(md).not.toContain("与上一次");
  });

  it("after an upgrade: what was lost, what moved, what got slower", () => {
    const md = regressionReport(fixture, [second, first]);
    expect(md).toContain("**有退化，见下。**");
    expect(md).toMatch(/\| geo-a \| geometry\/angles \| geometry \| 没证出（退化） \| 10.2 分钟 \| 程序写的坐标代数证明（no certificate）；x \\\| y \|/);
    expect(md).toMatch(/\| opt-b \| optimize \| optimize \| 证出，但换了路线（hammer） \|/);
    expect(md).toMatch(/\| open-a \| auto \| — \| 新证出（auto） \|/);
    expect(md).toContain("与上一次（2026-11-13 01:00）相比");
    expect(md).toContain("Lean / Mathlib：Lean 4.33.1 / Mathlib v4.33.1 → Lean 4.34.0 / Mathlib v4.34.0。");
    expect(md).toContain("丢掉 1 条（geo-a），新证出 1 条（open-a），路线变了 1 条（opt-b：optimize → hammer）");
    expect(md).toContain("变慢一倍以上（且多出半分钟）的 1 条：opt-a（30 秒 → 95 秒）；快了一倍以上的 0 条");
    // on another machine the times say nothing
    const other = regressionReport(fixture, [{ ...second, meta: { ...second.meta, host: "linux-x64-ffffff" } }, first]);
    expect(other).toContain("两次不在同一台机器上，用时不比较。");
    expect(other).not.toContain("变慢一倍以上");
  });

  it("reads the latest run against the fixture as it is now: an accepted run is the baseline", () => {
    // the first run of a new list: nothing was expected yet
    const fresh = { ...first, rows: first.rows.map(({ expect: _e, ...r }) => r) };
    expect(verdictOf(fresh.rows[0])).toBe("gained");
    const accepted = acceptRun({ ...fixture, cases: fixture.cases.map(({ expect, ...c }) => (expect === "none" ? { ...c, expect } : c)) }, fresh.rows).fixture;
    const md = regressionReport(accepted, [fresh]);
    expect(md).toContain("7 条用例：6 条通过，0 条换了路线，0 条没证出，0 条不该证出却证出了，0 条运行出错，1 条仍未证出。**没有退化。**");
    expect(md).not.toContain("新证出");
    // an earlier run keeps the verdicts it had: a fixture changed since does not rewrite history
    const later = { ...second, rows: second.rows.map((r) => (r.id === "geo-a" ? { ...r, strategy: "geometry" as const } : r)) };
    const both = regressionReport(accepted, [fresh, later]);
    expect(both).toMatch(/\| 2026-11-13 01:00 \| [^|]+ \| [^|]+ \| 7 \| 5 \| 0 \| 2 \| 0 \| 0 \|/);
  });

  it("says which cases needed a fresh Lean worker", () => {
    const rows = first.rows.map((r) => (r.id === "opt-a" ? { ...r, retried: true } : r.id === "open-a" ? { ...r, retried: true } : r));
    const md = regressionReport(fixture, [{ ...first, rows }]);
    // proved at the second attempt: passes, and is named; still not proved after the retry: nothing to add
    expect(md).toContain("其中 1 条第一次没证出，换一个新的 Lean 进程重跑才证出（opt-a）");
    expect(md).toMatch(/\| opt-a \| optimize\/oddtown \| ✓（第二次） \| optimize \|/);
    expect(md).toContain("**没有退化。**");
  });

  it("names the cases a partial run left out", () => {
    const md = regressionReport(fixture, [{ ...first, rows: first.rows.slice(0, 2), meta: { ...first.meta, selected: 2 } }]);
    expect(md).toContain("2 条用例（清单共 7 条）");
    expect(md).toContain("这次没跑的 5 条：opt-b、ind-a、s-hammer-01、none-a、open-a。");
  });
});

describe("the script's own parts", () => {
  it("names the sandbox's Lean and Mathlib from its toolchain file and manifest", () => {
    const saved = process.env.LEAN_SANDBOX_PATH;
    // a bare Lean installation elsewhere: the repository's lean-sandbox next to the fixture's bench/ is read
    process.env.LEAN_SANDBOX_PATH = path.join(__dirname, "no-such-sandbox");
    try {
      const v = sandboxVersions(path.join(__dirname, "..", "bench", "provers.json"));
      expect(v.lean).toMatch(/^Lean \d+\.\d+/);
      expect(v.mathlib).toMatch(/^Mathlib v?\d+\.\d+/);
    } finally {
      if (saved === undefined) delete process.env.LEAN_SANDBOX_PATH;
      else process.env.LEAN_SANDBOX_PATH = saved;
    }
  });

  it("finds no runs where there is no results directory", () => {
    expect(readRegressionRuns(path.join(__dirname, "no-such-dir"))).toEqual([]);
  });
});

describe("bench/provers.json", () => {
  const fixtureFile = parseFixture(readFileSync(path.join(__dirname, "..", "bench", "provers.json"), "utf8"));
  const cases = fixtureFile.cases;

  it("has every prover's statements, each with the route that proves it", () => {
    expect(cases.length).toBeGreaterThan(120);
    const groups = new Set(cases.map(groupOf));
    for (const g of ["geometry", "induction", "optimize", "combinatorics", "auto", "order", "bounded", "hammer"]) expect(groups, g).toContain(g);
    // a statement that must not be proved keeps the harness honest
    expect(cases.some((c) => c.expect === "none")).toBe(true);
    for (const c of cases) if (c.expect && c.expect !== "none") expect(ROUTES, c.id).toContain(c.expect);
  });

  // the provers' gates are text predicates: a refactor that makes one refuse a statement it used to prove fails here, without Lean
  it("every case still passes the gate of the prover that proves it", () => {
    const gate: Record<string, (t: string) => boolean> = {
      geometry: looksGeometric,
      induction: looksInductive,
      optimize: looksOptimization,
      combinatorics: looksCombinatorial,
      order: (t) => orderProofScripts(t).length > 0,
      bounded: (t) => boundedMinScripts(t).length > 0,
    };
    for (const c of cases) {
      const check = c.expect ? gate[c.expect] : undefined;
      if (check) expect(check(normalizeTheoremType(c.type)), `${c.id} (${c.expect})`).toBe(true);
    }
  });

  it("the special routes still recognise the statements they were written for", () => {
    const shape: Record<string, (t: string) => unknown> = { "optimize/oddtown": oddtownShape, "combinatorics/circular": circularShape, "combinatorics/orbit": orbitShape };
    for (const c of cases) {
      const read = c.for ? shape[c.for] : undefined;
      if (read && c.expect && c.expect !== "none" && c.expect === c.for!.split("/")[0]) expect(read(normalizeTheoremType(c.type)), c.id).toBeTruthy();
    }
  });
});
