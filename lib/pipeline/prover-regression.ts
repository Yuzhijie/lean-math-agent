/**
 * `npm run lean:regress` — regression of the provers the program drives, on real Lean, no model.
 *
 * Every dedicated prover (geometry, induction, optimize, combinatorics, the tactic search and
 * their special routes: Oddtown, Erdős–Ko–Rado, orbits, circular seatings, double counting …)
 * was written against a few statements and "checked in Lean" once, by hand; the unit tests run
 * a fake REPL. They read Lean's printed goals and name Mathlib lemmas, so a Mathlib upgrade, a
 * changed pretty-printer or a refactor can break them without one test failing. bench/provers.json
 * keeps those statements — the probes each prover was developed on and the statements of past
 * sessions the program proved — with the route that proves each; the script runs them through
 * the product's own no-model cascade (proveWithoutModel) and says which no longer go through,
 * which now take another route, and which got slower. Run it before and after upgrading the
 * sandbox's Mathlib, and after touching a prover.
 *
 * This file is the pure part: the fixture, a run's rows, the verdicts, the report.
 */
import { z } from "zod";
import { validateTheoremStatement } from "../lean/sanitize";

/** The routes of proveWithoutModel (lib/pipeline/lean-attempt.ts), in the order they are tried. */
export const ROUTES = ["hammer", "trivial", "order", "bounded", "geometry", "induction", "optimize", "combinatorics", "auto"] as const;
export type Route = (typeof ROUTES)[number];

/** A case that took longer than this is `slow`: left out of `--quick` (on the first run 24 of 160 cases, three quarters of the time). */
export const SLOW_MS = 60_000;

const caseSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  /** theorem name and type, as `theorem <name> <type> := by …` */
  name: z.string().min(1),
  type: z.string().min(1),
  /**
   * The route that proves it, recorded when the case was accepted (`--accept`); "none" = a
   * statement that must not be proved (a wrong value: the harness must not say "proved" to
   * everything); absent = not proved yet by any route, an open target.
   */
  expect: z.enum([...ROUTES, "none"]).optional(),
  /** What it was written for: the prover and, after a slash, the part of it ("optimize/oddtown"). */
  for: z.string().optional(),
  about: z.string().optional(),
  /** probe = a statement the prover was developed on; session = a statement of a past solve */
  source: z.enum(["probe", "session"]).optional(),
  slow: z.boolean().optional(),
});

const fixtureSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  cases: z.array(caseSchema).min(1),
});

export type RegressionCase = z.infer<typeof caseSchema>;
export type RegressionFixture = z.infer<typeof fixtureSchema>;

/** Parse and validate the fixture: ids and statements once each, every statement a valid theorem statement. */
export function parseFixture(text: string): RegressionFixture {
  const doc = fixtureSchema.parse(JSON.parse(text));
  const ids = new Set<string>();
  const types = new Map<string, string>();
  for (const c of doc.cases) {
    if (ids.has(c.id)) throw new Error(`prover regression: duplicate id ${c.id}`);
    ids.add(c.id);
    const key = c.type.replace(/\s+/g, "");
    if (types.has(key)) throw new Error(`prover regression: ${c.id} has the same statement as ${types.get(key)}`);
    types.set(key, c.id);
    const v = validateTheoremStatement(c.name, c.type);
    if (!v.ok) throw new Error(`prover regression: ${c.id}: ${v.reason}`);
  }
  return doc;
}

/** The fixture as it is written to disk: one case per line, so a diff shows what changed. */
export function serializeFixture(f: RegressionFixture): string {
  const head = [`  "name": ${JSON.stringify(f.name)},`, ...(f.description ? [`  "description": ${JSON.stringify(f.description)},`] : [])];
  return ["{", ...head, '  "cases": [', f.cases.map((c) => `    ${JSON.stringify(c)}`).join(",\n"), "  ]", "}", ""].join("\n");
}

export interface CaseSelection {
  ids?: string[];
  /** prefixes of `for` ("optimize", "optimize/oddtown") or expected routes */
  only?: string[];
  quick?: boolean;
  slow?: boolean;
  limit?: number;
}

/** The prover a case belongs to in the report: what it was written for, else the route that proves it. */
export function groupOf(c: Pick<RegressionCase, "for" | "expect">): string {
  return (c.for ?? c.expect ?? "other").split("/")[0];
}

export function selectCases(f: RegressionFixture, sel: CaseSelection = {}): RegressionCase[] {
  let list = f.cases;
  if (sel.ids?.length) list = list.filter((c) => sel.ids!.includes(c.id));
  if (sel.only?.length) list = list.filter((c) => sel.only!.some((o) => c.expect === o || c.for === o || (c.for ?? "").startsWith(`${o}/`) || groupOf(c) === o));
  if (sel.quick) list = list.filter((c) => !c.slow);
  if (sel.slow) list = list.filter((c) => c.slow);
  if (sel.limit !== undefined) list = list.slice(0, Math.max(0, sel.limit));
  return list;
}

// ── a run ────────────────────────────────────────────────────────────────────────────────────

export interface CaseRow {
  id: string;
  /** what the fixture expected when the case ran */
  expect?: Route | "none";
  /** the route that proved it; absent = not proved */
  strategy?: Route;
  ms: number;
  /** what was tried and why it failed (the provers' own words), for a case that was not proved */
  tried?: string[];
  /** the run itself failed (Lean not reachable, a prover threw) */
  error?: string;
  /** not proved at first, run again on a fresh Lean worker (the row is the second attempt when that one proved it) */
  retried?: boolean;
}

/** ok · other_route (proved, by another route than recorded) · failed · unexpected (a must-not-prove statement proved) · open (no route recorded, still not proved) · gained (no route recorded, proved now) · error */
export type Verdict = "ok" | "other_route" | "failed" | "unexpected" | "open" | "gained" | "error";

export function verdictOf(r: CaseRow): Verdict {
  if (r.error) return "error";
  if (r.expect === "none") return r.strategy ? "unexpected" : "ok";
  if (r.expect === undefined) return r.strategy ? "gained" : "open";
  if (!r.strategy) return "failed";
  return r.strategy === r.expect ? "ok" : "other_route";
}

/** A verdict that should stop a release: something that worked no longer does. */
export const isRegression = (v: Verdict) => v === "failed" || v === "unexpected" || v === "error";

export interface RegressionMeta {
  type: "run";
  at: string;
  fixture: string;
  /** how many cases this run was asked to cover */
  selected: number;
  commit?: string;
  lean?: string;
  mathlib?: string;
  /** the machine, as a platform and a short hash of its name: times are only compared on the same one */
  host: string;
  args: string[];
}

export interface RegressionRun {
  file: string;
  meta: RegressionMeta;
  rows: CaseRow[];
  ended?: { at: string; wall_ms: number };
}

/** Read a run (JSON lines: the run record, a row per case as it finished — the last row of an id wins —, the end record). */
export function parseRegressionRun(file: string, text: string): RegressionRun | undefined {
  let meta: RegressionMeta | undefined;
  let ended: RegressionRun["ended"];
  const rows = new Map<string, CaseRow>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // a line cut off by a crash
    }
    if (rec.type === "run") meta ??= rec as unknown as RegressionMeta;
    else if (rec.type === "end") ended = { at: String(rec.at), wall_ms: Number(rec.wall_ms) || 0 };
    else if (typeof rec.id === "string") rows.set(rec.id, rec as unknown as CaseRow);
  }
  return meta ? { file, meta, rows: [...rows.values()], ...(ended ? { ended } : {}) } : undefined;
}

/**
 * The fixture after a run was accepted: every case the run proved records its route (and whether
 * it is slow). A case that was not proved keeps what it had — accepting never hides a failure,
 * and "none" is only ever written by hand.
 */
export function acceptRun(f: RegressionFixture, rows: CaseRow[]): { fixture: RegressionFixture; changed: string[] } {
  const by = new Map(rows.map((r) => [r.id, r]));
  const changed: string[] = [];
  const cases = f.cases.map((c) => {
    const r = by.get(c.id);
    if (!r || r.error || !r.strategy || c.expect === "none") return c;
    const slow = r.ms > SLOW_MS;
    if (c.expect === r.strategy && !!c.slow === slow) return c;
    changed.push(c.id);
    const { slow: _was, ...rest } = c;
    return { ...rest, expect: r.strategy, ...(slow ? { slow: true } : {}) };
  });
  return { fixture: { ...f, cases }, changed };
}

// ── the report ───────────────────────────────────────────────────────────────────────────────

const VERDICT_ZH: Record<Verdict, string> = {
  ok: "通过",
  other_route: "证出，但换了路线",
  failed: "没证出（退化）",
  unexpected: "不该证出却证出了",
  open: "仍未证出（没有记录过路线）",
  gained: "新证出",
  error: "运行出错",
};

const secs = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} 秒` : ms < 120_000 ? `${Math.round(ms / 1000)} 秒` : `${(ms / 60_000).toFixed(1)} 分钟`);

function table(head: string[], rows: string[][]): string[] {
  return [`| ${head.join(" | ")} |`, `|${head.map(() => " --- ").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)];
}

function cell(s: string | undefined, n: number): string {
  const t = (s ?? "").replace(/[\u0000-\u001f\u007f\s]+/g, " ").replace(/\|/g, "\\|").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

const label = (r: RegressionRun) => r.meta.at.slice(0, 16).replace("T", " ");
const count = (rows: CaseRow[], v: Verdict) => rows.filter((r) => verdictOf(r) === v).length;

/** Slower by at least half a minute and at least twice as long. */
export function slower(now: number, before: number): boolean {
  return now - before >= 30_000 && now >= 2 * before;
}

/** bench/PROVERS.md: every run in one line, the latest in detail, and what changed since the run before it. */
export function regressionReport(fixture: RegressionFixture, runs: RegressionRun[], opts: { now?: Date } = {}): string {
  const cases = new Map(fixture.cases.map((c) => [c.id, c]));
  const byTime = [...runs].filter((r) => r.rows.length).sort((a, b) => a.meta.at.localeCompare(b.meta.at));
  // The latest run is read against the fixture as it is now (after `--accept`, the run that was
  // accepted is the baseline: every route it found is the expected one); earlier runs keep the
  // expectations they ran with.
  const now = (x: CaseRow): CaseRow => {
    const c = cases.get(x.id);
    if (!c) return x;
    const { expect: _then, ...rest } = x;
    return c.expect ? { ...rest, expect: c.expect } : rest;
  };
  const sorted: RegressionRun[] = byTime.map((r, i) => (i < byTime.length - 1 ? r : { ...r, rows: r.rows.map(now) }));
  const out: string[] = ["# 证明器回归（真实 Lean，不调模型）", ""];
  out.push(
    `由 \`npm run lean:regress\` 生成${opts.now ? `（${opts.now.toISOString().slice(0, 16).replace("T", " ")} UTC）` : ""}。清单 \`bench/provers.json\`（${fixture.name}）里有 ${fixture.cases.length} 条陈述：各个程序证明器开发时验证过的陈述，以及过去的求解里由程序证出的陈述。每条都记着“由哪条路线证出”。脚本用产品自己的不调模型的流程（自动化 → 乘法阶 → 逐个检查 → 几何 → 归纳 → 优化 → 组合 → 策略搜索）在真实的 Lean 里重跑一遍。`,
    "",
    "- **通过** = 仍由记录的那条路线证出。**换了路线** = 证出了，但不是原来那条（通常是前面的路线变强了；也可能是原来的证明器坏了、后面的路线接住了，值得看一眼）。**没证出** = 退化。",
    "- 什么时候跑：升级沙箱的 Mathlib 之前和之后各一次；改动某个证明器之后（`--only geometry`）。日常用 `--quick`（跳过要几分钟的用例）。",
    "- 用时只在同一台机器的两次运行之间比较。",
    "",
  );
  if (!sorted.length) {
    out.push("还没有运行结果。运行 `npm run lean:regress`（需要 Lean 沙箱；不花钱）。", "");
    return out.join("\n");
  }

  out.push("## 历次运行", "");
  out.push(
    ...table(
      ["运行", "机器", "Lean / Mathlib", "用例", "通过", "换了路线", "没证出", "不该证却证了", "出错", "用时", "提交"],
      sorted.map((r) => [
        label(r),
        r.meta.host,
        [r.meta.lean, r.meta.mathlib].filter(Boolean).join(" / ") || "—",
        `${r.rows.length}${r.rows.length < r.meta.selected ? `（计划 ${r.meta.selected}）` : ""}`,
        String(count(r.rows, "ok") + count(r.rows, "gained")),
        String(count(r.rows, "other_route")),
        String(count(r.rows, "failed") + count(r.rows, "open")),
        String(count(r.rows, "unexpected")),
        String(count(r.rows, "error")),
        // the cases' own times: a resumed run has no single wall time
        secs(r.rows.reduce((a, x) => a + x.ms, 0)),
        r.meta.commit ? `\`${r.meta.commit.slice(0, 7)}\`` : "—",
      ]),
    ),
    "",
  );

  const run = sorted[sorted.length - 1];
  const rows = run.rows;
  const bad = rows.filter((r) => isRegression(verdictOf(r)));
  out.push(`## 最近一次运行：${label(run)}`, "");
  out.push(
    `${rows.length} 条用例${rows.length < fixture.cases.length ? `（清单共 ${fixture.cases.length} 条）` : ""}：` +
      `${count(rows, "ok")} 条通过，${count(rows, "other_route")} 条换了路线，${count(rows, "failed")} 条没证出，${count(rows, "unexpected")} 条不该证出却证出了，${count(rows, "error")} 条运行出错` +
      `${count(rows, "gained") ? `，${count(rows, "gained")} 条新证出` : ""}${count(rows, "open") ? `，${count(rows, "open")} 条仍未证出` : ""}。` +
      (bad.length ? "**有退化，见下。**" : "**没有退化。**"),
    "",
  );
  const second = rows.filter((r) => r.retried && r.strategy);
  if (second.length) {
    out.push(`其中 ${second.length} 条第一次没证出，换一个新的 Lean 进程重跑才证出（${second.map((r) => r.id).join("、")}）：这是机器内存或进程状态的问题，不算证明器的退化，但说明这些用例在这台机器上吃紧。`, "");
  }

  // ── by prover
  const groups = [...new Set(rows.map((r) => groupOf(cases.get(r.id) ?? { expect: r.expect })))];
  out.push("### 按证明器", "");
  out.push(
    ...table(
      ["为哪个证明器而写", "用例", "通过", "换了路线", "没通过", "总用时", "最慢的一条"],
      groups.map((g) => {
        const of = rows.filter((r) => groupOf(cases.get(r.id) ?? { expect: r.expect }) === g);
        const slowest = [...of].sort((a, b) => b.ms - a.ms)[0];
        return [
          g === "none" ? "（不该证出的陈述）" : g,
          String(of.length),
          String(count(of, "ok") + count(of, "gained")),
          String(count(of, "other_route")),
          String(of.filter((r) => isRegression(verdictOf(r)) || verdictOf(r) === "open").length),
          secs(of.reduce((a, r) => a + r.ms, 0)),
          slowest ? `${slowest.id}（${secs(slowest.ms)}）` : "—",
        ];
      }),
    ),
    "",
  );

  // ── what did not pass
  const notOk = rows.filter((r) => verdictOf(r) !== "ok");
  if (notOk.length) {
    out.push("### 没有按预期通过的用例", "");
    out.push(
      ...table(
        ["用例", "为它而写", "预期", "结果", "用时", "说明"],
        notOk.map((r) => {
          const c = cases.get(r.id);
          const v = verdictOf(r);
          return [r.id, c?.for ?? "—", r.expect ?? "—", `${VERDICT_ZH[v]}${r.strategy ? `（${r.strategy}）` : ""}`, secs(r.ms), cell(r.error ?? (r.strategy ? c?.about : [v === "open" ? c?.about : undefined, ...(r.tried ?? [])].filter(Boolean).join("；")), 420)];
        }),
      ),
      "",
    );
  }

  // ── against the run before, on the same machine
  const before = sorted.filter((r) => r !== run && r.meta.at < run.meta.at).pop();
  const prev = new Map((before?.rows ?? []).map((r) => [r.id, r]));
  if (before) {
    const both = rows.filter((r) => prev.has(r.id));
    const proved = (r: CaseRow) => !!r.strategy && !r.error;
    const lost = both.filter((r) => !proved(r) && proved(prev.get(r.id)!));
    const gained = both.filter((r) => proved(r) && !proved(prev.get(r.id)!));
    const rerouted = both.filter((r) => proved(r) && proved(prev.get(r.id)!) && r.strategy !== prev.get(r.id)!.strategy);
    out.push(`### 与上一次（${label(before)}）相比`, "");
    const versions = (r: RegressionRun) => [r.meta.lean, r.meta.mathlib].filter(Boolean).join(" / ") || "未知";
    if (versions(before) !== versions(run)) out.push(`Lean / Mathlib：${versions(before)} → ${versions(run)}。`, "");
    out.push(`两次都跑过的 ${both.length} 条：丢掉 ${lost.length} 条${lost.length ? `（${lost.map((r) => r.id).join("、")}）` : ""}，新证出 ${gained.length} 条${gained.length ? `（${gained.map((r) => r.id).join("、")}）` : ""}，路线变了 ${rerouted.length} 条${rerouted.length ? `（${rerouted.map((r) => `${r.id}：${prev.get(r.id)!.strategy} → ${r.strategy}`).join("、")}）` : ""}。`, "");
    if (before.meta.host === run.meta.host) {
      const slow = both.filter((r) => proved(r) && proved(prev.get(r.id)!) && slower(r.ms, prev.get(r.id)!.ms));
      const fast = both.filter((r) => proved(r) && proved(prev.get(r.id)!) && slower(prev.get(r.id)!.ms, r.ms));
      const total = (xs: CaseRow[]) => xs.reduce((a, r) => a + r.ms, 0);
      out.push(`总用时 ${secs(total(both.map((r) => prev.get(r.id)!)))} → ${secs(total(both))}。变慢一倍以上（且多出半分钟）的 ${slow.length} 条${slow.length ? `：${slow.map((r) => `${r.id}（${secs(prev.get(r.id)!.ms)} → ${secs(r.ms)}）`).join("、")}` : ""}；快了一倍以上的 ${fast.length} 条${fast.length ? `：${fast.map((r) => `${r.id}（${secs(prev.get(r.id)!.ms)} → ${secs(r.ms)}）`).join("、")}` : ""}。`, "");
    } else out.push("两次不在同一台机器上，用时不比较。", "");
  }

  // ── every case
  out.push("### 全部用例", "");
  out.push(
    ...table(
      ["用例", "为它而写", "结果", "路线", "用时", ...(before ? ["上次"] : []), "是什么"],
      rows.map((r) => {
        const c = cases.get(r.id);
        const v = verdictOf(r);
        const p = prev.get(r.id);
        return [r.id, c?.for ?? "—", `${v === "ok" ? "✓" : VERDICT_ZH[v]}${r.retried && r.strategy ? "（第二次）" : ""}`, r.strategy ?? (r.expect === "none" ? "（不该证出）" : "—"), secs(r.ms), ...(before ? [p ? secs(p.ms) : "—"] : []), cell(c?.about ?? c?.name, 90)];
      }),
    ),
    "",
  );
  const notRun = fixture.cases.filter((c) => !rows.some((r) => r.id === c.id));
  if (notRun.length) out.push(`这次没跑的 ${notRun.length} 条：${notRun.slice(0, 40).map((c) => c.id).join("、")}${notRun.length > 40 ? " ……" : ""}。`, "");
  return out.join("\n");
}
