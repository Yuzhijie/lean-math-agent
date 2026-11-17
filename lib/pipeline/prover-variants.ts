/**
 * `npm run lean:variants`: do the provers the program wrote prove a statement when it is written
 * another way? Every statement of the regression list (bench/provers.json) that a prover, a
 * script or the tactic search proves is rewritten without changing its meaning
 * (lib/lean/statement-variants.ts: bound names with a prime, other letters, a subscript, the
 * other case; `∀ … →` against binders before the colon; comparisons turned round), Lean confirms the variant
 * says the same (`A ↔ B` by `Iff.rfl`), and the variant is given to the route that proves the
 * statement as the list has it — alone, on the real sandbox; when that route does not prove it,
 * to the other no-model stages of the product (lib/lean/prover-stages.ts). No model, no cost.
 *
 * What it measures: a prover was developed on one way of writing each statement; a second
 * formalization of the same problem differs in exactly these ways. A variant that is not proved,
 * or only by a later route, is a place where the prover reads the text, not the mathematics.
 *
 * This file is the pure part: which variants, a run's rows, the verdicts, the report
 * (bench/VARIANTS.md). scripts/provers-variants.ts runs it.
 */
import { statementVariants, VARIANT_KINDS, type StatementVariant, type VariantKind } from "../lean/statement-variants";
import { normalizeTheoremType } from "../llm/autoformalize";
import { groupOf, type RegressionCase, type RegressionFixture, type Route, type StageTime } from "./prover-regression";

/** The routes written for kinds of statements (and the search): the cascade's and the single tactics' proofs do not read names. */
export const DEDICATED_ROUTES: readonly Route[] = ["order", "bounded", "geometry", "induction", "optimize", "inequality", "combinatorics", "auto"];

export interface VariantCase {
  /** `<base id>~<kind>` */
  id: string;
  base: RegressionCase;
  /** the route that proves the statement as the list has it */
  expect: Route;
  variant: StatementVariant;
  /** The base statement, normalized as the product does before proving. */
  baseType: string;
}

export interface VariantSelection {
  ids?: string[];
  only?: string[];
  kinds?: VariantKind[];
  /** leave out the base cases that take minutes */
  quick?: boolean;
  /** also the statements the cascade or a single tactic proves */
  all?: boolean;
  /** at most this many base cases per `for` group (the first ones) */
  perGroup?: number;
  limit?: number;
}

/** The variants a run covers: of every selected statement with a recorded route, one per kind that changes it. */
export function selectVariants(f: RegressionFixture, sel: VariantSelection = {}): VariantCase[] {
  const kinds = sel.kinds?.length ? sel.kinds : VARIANT_KINDS;
  const taken = new Map<string, number>();
  const out: VariantCase[] = [];
  for (const c of f.cases) {
    const expect = c.expect;
    if (!expect || expect === "none") continue;
    if (!sel.all && !sel.ids?.length && !DEDICATED_ROUTES.includes(expect)) continue;
    if (sel.ids?.length && !sel.ids.includes(c.id)) continue;
    if (sel.only?.length && !sel.only.some((o) => c.expect === o || c.for === o || (c.for ?? "").startsWith(`${o}/`) || groupOf(c) === o)) continue;
    if (sel.quick && c.slow) continue;
    const group = c.for ?? expect;
    const n = taken.get(group) ?? 0;
    if (sel.perGroup !== undefined && n >= sel.perGroup) continue;
    const baseType = normalizeTheoremType(c.type);
    const variants = statementVariants(baseType, kinds);
    if (!variants.length) continue;
    taken.set(group, n + 1);
    for (const variant of variants) out.push({ id: `${c.id}~${variant.kind}`, base: c, expect, variant, baseType });
  }
  return sel.limit !== undefined ? out.slice(0, Math.max(0, sel.limit)) : out;
}

// ── a run ───────────────────────────────────────────────────────────────

export interface VariantRow {
  id: string;
  base: string;
  kind: VariantKind;
  /** the route that proves the statement as the list has it */
  expect: Route;
  /** Lean proved `statement ↔ variant` by reflexivity; false = the rewrite is not trusted and the variant was not run */
  equivalent: boolean;
  /** the route that proved the variant: `expect` (run alone), else one of the others; absent = not proved */
  strategy?: Route;
  ms: number;
  /** what the rewrite changed */
  note?: string;
  /** the variant itself, when the recorded route did not prove it (to reproduce) */
  type?: string;
  /** what the recorded route said about the variant; "" = it did not take the statement at all */
  reason?: string;
  /** the time the other routes had, ms; absent = they were not tried */
  rescueMs?: number;
  /** what the other routes said */
  tried?: string[];
  stages?: StageTime[];
  /** the proof did not run under the variant as written: the reading form was proved inside it (lib/lean/reading-form.ts) */
  bridged?: boolean;
  error?: string;
  retried?: boolean;
}

/** same = proved by the route that proves the original · other = that route did not, another one did · lost = not proved · unchecked = Lean did not confirm the rewrite (not counted) · error. */
export type VariantVerdict = "same" | "other" | "lost" | "unchecked" | "error";

export function variantVerdict(r: VariantRow): VariantVerdict {
  if (r.error) return "error";
  if (!r.equivalent) return "unchecked";
  if (!r.strategy) return "lost";
  return r.strategy === r.expect ? "same" : "other";
}

export interface VariantMeta {
  type: "run";
  at: string;
  fixture: string;
  selected: number;
  commit?: string;
  lean?: string;
  mathlib?: string;
  host: string;
  args: string[];
  /** false = the provers got the variants as written (PROVER_READING_FORM=0), to compare with */
  reading?: boolean;
  /** what this run is, in a few words (`--note`), for the table of runs */
  note?: string;
}

export interface VariantRun {
  file: string;
  meta: VariantMeta;
  rows: VariantRow[];
  ended?: { at: string; wall_ms: number };
}

/** A run file (JSON lines: the run record, a row per variant as it finishes — the last row of an id wins —, the end record). */
export function parseVariantRun(file: string, text: string): VariantRun | undefined {
  let meta: VariantMeta | undefined;
  let ended: VariantRun["ended"];
  const rows = new Map<string, VariantRow>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // a line cut off by a crash
    }
    if (rec.type === "run") meta ??= rec as unknown as VariantMeta;
    else if (rec.type === "end") ended = { at: String(rec.at), wall_ms: Number(rec.wall_ms) || 0 };
    else if (typeof rec.id === "string" && typeof rec.base === "string") rows.set(rec.id, rec as unknown as VariantRow);
  }
  return meta ? { file, meta, rows: [...rows.values()], ...(ended ? { ended } : {}) } : undefined;
}

// ── the report ──────────────────────────────────────────────────────────

const KIND_ZH: Record<VariantKind, string> = {
  prime: "约束变量加撇（n → n'）",
  letters: "约束变量换字母，长名字加下标（n → q，Valid → Valid₁）",
  subscript: "单字母变量加下标（x → x₁）",
  case: "名字换大小写（Valid → valid）",
  binders: "∀ 写法与参数写法互换",
  flip: "比较号两边对调（0 < n → n > 0）",
};

const secs = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} 秒` : ms < 120_000 ? `${Math.round(ms / 1000)} 秒` : `${(ms / 60_000).toFixed(1)} 分钟`);
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "—");
const label = (r: VariantRun) => r.meta.at.slice(0, 16).replace("T", " ");
const table = (head: string[], rows: string[][]) => [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)];
const cell = (s: string | undefined, n: number) => {
  const t = (s ?? "").replace(/[\u0000-\u001f\u007f\s]+/g, " ").replace(/\|/g, "\\|").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** What the recorded route said about a variant it did not prove. */
const said = (r: VariantRow) => (r.reason === undefined ? "—" : r.reason ? cell(r.reason, 240) : "没有接这条陈述（认不出是它的题型）");

interface Tally {
  run: number;
  same: number;
  other: number;
  lost: number;
}

function tally(rows: VariantRow[]): Tally {
  const of = (v: VariantVerdict) => rows.filter((r) => variantVerdict(r) === v).length;
  const same = of("same");
  const other = of("other");
  const lost = of("lost");
  return { run: same + other + lost, same, other, lost };
}

const tallyCells = (t: Tally) => [String(t.run), `${t.same}（${pct(t.same, t.run)}）`, String(t.other), String(t.lost)];

/** How many of the variants that ran were proved by the route that proves the original — the headline. */
export function sameRouteRate(rows: VariantRow[]): { same: number; run: number } {
  const t = tally(rows);
  return { same: t.same, run: t.run };
}

/** bench/VARIANTS.md: every run in one line, the latest by prover and by kind of rewrite, every variant that was lost or rerouted. */
export function variantReport(fixture: RegressionFixture, runs: VariantRun[], opts: { now?: Date } = {}): string {
  const cases = new Map(fixture.cases.map((c) => [c.id, c]));
  const sorted = [...runs].filter((r) => r.rows.length).sort((a, b) => a.meta.at.localeCompare(b.meta.at));
  const out: string[] = ["# 同义变体：证明器对“换一种写法”的稳健性（真实 Lean，不调模型）", ""];
  out.push(
    `由 \`npm run lean:variants\` 生成${opts.now ? `（${opts.now.toISOString().slice(0, 16).replace("T", " ")} UTC）` : ""}。回归清单 \`bench/provers.json\` 里由专用证明器、程序脚本或策略搜索证出的每条陈述，被改写成**意思相同、写法不同**的变体：`,
    "",
    ...VARIANT_KINDS.map((k) => `- ${KIND_ZH[k]}`),
    "",
    "每个变体先由 Lean 核对与原陈述等价（`A ↔ B` 由 `Iff.rfl` 证出），再单独交给证出原陈述的那条路线；那条路线没证出时，再交给产品其余不调模型的阶段。同一道题重新形式化一次，差别正是这几种；变体没证出、或者要靠别的路线才证出，说明那个证明器读的是文字，不是数学。",
    "",
    "- **同一路线** = 由证出原陈述的那条路线证出。**换了路线** = 那条路线没证出，别的路线接住了（通常更慢，也更靠运气）。**丢失** = 都没证出（其余路线有时间上限，见运行命令的 `--budget`）。",
    "- Lean 没能确认等价的变体（改写程序的局限）不计入，单列在最后。",
    "- “规范写法”一栏：证明器读到的是不是统一成一种写法的陈述（`lib/lean/reading-form.ts`；产品里是开）。`PROVER_READING_FORM=0 npm run lean:variants` 让证明器直接读变体原文，用来对比。",
    "",
  );
  if (!sorted.length) {
    out.push("还没有运行结果。运行 `npm run lean:variants`（需要 Lean 沙箱；不花钱）。", "");
    return out.join("\n");
  }

  const noted = sorted.some((r) => r.meta.note);
  out.push("## 历次运行", "");
  out.push(
    ...table(
      ["运行", "规范写法", "机器", "陈述", "变体", "同一路线", "换了路线", "丢失", "未确认等价", "用时", "提交", ...(noted ? ["备注"] : [])],
      sorted.map((r) => {
        const t = tally(r.rows);
        return [
          label(r),
          r.meta.reading === false ? "关" : "开",
          r.meta.host,
          String(new Set(r.rows.map((x) => x.base)).size),
          String(t.run),
          `**${t.same}（${pct(t.same, t.run)}）**`,
          String(t.other),
          String(t.lost),
          String(r.rows.filter((x) => variantVerdict(x) === "unchecked").length),
          secs(r.rows.reduce((a, x) => a + x.ms, 0)),
          r.meta.commit ? `\`${r.meta.commit.slice(0, 7)}\`` : "—",
          ...(noted ? [cell(r.meta.note, 200) || "—"] : []),
        ];
      }),
    ),
    "",
  );

  const run = sorted[sorted.length - 1];
  const rows = run.rows;
  const all = tally(rows);
  out.push(`## 最近一次运行：${label(run)}`, "");
  out.push(
    `${new Set(rows.map((r) => r.base)).size} 条陈述的 ${all.run} 个变体：**${all.same} 个（${pct(all.same, all.run)}）由同一路线证出**，${all.other} 个换了路线，${all.lost} 个丢失。` +
      (all.lost + all.other ? "" : "**每个变体都由原来的路线证出。**"),
    "",
  );
  const bridged = rows.filter((r) => r.bridged).length;
  if (bridged) out.push(`其中 ${bridged} 个的证明脚本在变体原文下跑不通，是在证明里先证出规范写法、再由它推出原陈述的（\`have reading : …\`）。`, "");

  // ── by prover
  const groupOfRow = (r: VariantRow) => groupOf(cases.get(r.base) ?? { expect: r.expect });
  const groups = [...new Set(rows.map(groupOfRow))];
  out.push("### 按证明器", "");
  out.push(...table(["为哪个证明器而写", "变体", "同一路线", "换了路线", "丢失"], groups.map((g) => [g, ...tallyCells(tally(rows.filter((r) => groupOfRow(r) === g)))])), "");

  // ── by the part of a prover
  const parts = [...new Set(rows.map((r) => cases.get(r.base)?.for ?? r.expect))].filter((p) => p.includes("/"));
  if (parts.length) {
    out.push("### 按专门路线", "");
    out.push(...table(["路线", "变体", "同一路线", "换了路线", "丢失"], parts.map((p) => [p, ...tallyCells(tally(rows.filter((r) => (cases.get(r.base)?.for ?? r.expect) === p)))])), "");
  }

  // ── by kind of rewrite
  out.push("### 按改写的种类", "");
  out.push(...table(["改写", "变体", "同一路线", "换了路线", "丢失"], VARIANT_KINDS.filter((k) => rows.some((r) => r.kind === k)).map((k) => [KIND_ZH[k], ...tallyCells(tally(rows.filter((r) => r.kind === k)))])), "");

  // ── what was lost, what moved
  const lost = rows.filter((r) => variantVerdict(r) === "lost");
  if (lost.length) {
    out.push("### 丢失的变体", "");
    if (lost.some((r) => r.rescueMs === undefined)) out.push("（标 * 的没有再试其余路线。）", "");
    out.push(...table(["变体", "为它而写", "原路线", "改了什么", "原路线的说法"], lost.map((r) => [`${r.id}${r.rescueMs === undefined ? " *" : ""}`, cases.get(r.base)?.for ?? "—", r.expect, cell(r.note, 80), said(r)])), "");
  }
  const moved = rows.filter((r) => variantVerdict(r) === "other");
  if (moved.length) {
    out.push("### 换了路线的变体", "");
    out.push(...table(["变体", "为它而写", "原路线", "现在", "改了什么", "原路线的说法", "用时"], moved.map((r) => [r.id, cases.get(r.base)?.for ?? "—", r.expect, r.strategy ?? "—", cell(r.note, 80), said(r), secs(r.ms)])), "");
  }
  const errors = rows.filter((r) => variantVerdict(r) === "error");
  if (errors.length) {
    out.push("### 运行出错", "");
    out.push(...table(["变体", "错误"], errors.map((r) => [r.id, cell(r.error, 200)])), "");
  }

  // ── against the run before
  const before = sorted.filter((r) => r !== run).pop();
  if (before) {
    const prev = new Map(before.rows.map((r) => [r.id, r]));
    const both = rows.filter((r) => prev.has(r.id) && variantVerdict(r) !== "unchecked" && variantVerdict(prev.get(r.id)!) !== "unchecked");
    const ok = (r: VariantRow) => variantVerdict(r) === "same";
    const gained = both.filter((r) => ok(r) && !ok(prev.get(r.id)!));
    const worse = both.filter((r) => !ok(r) && ok(prev.get(r.id)!));
    const then = tally(both.map((r) => prev.get(r.id)!));
    const now = tally(both);
    out.push(`### 与上一次（${label(before)}）相比`, "");
    out.push(
      `两次都跑过的 ${both.length} 个变体：同一路线证出 ${then.same}（${pct(then.same, then.run)}）→ ${now.same}（${pct(now.same, now.run)}）；丢失 ${then.lost} → ${now.lost}，换了路线 ${then.other} → ${now.other}。` +
        `新由同一路线证出 ${gained.length} 个${gained.length ? `（${gained.slice(0, 30).map((r) => r.id).join("、")}${gained.length > 30 ? " ……" : ""}）` : ""}，` +
        `退步 ${worse.length} 个${worse.length ? `（${worse.map((r) => r.id).join("、")}）` : ""}。`,
      "",
    );
  }

  const unchecked = rows.filter((r) => variantVerdict(r) === "unchecked");
  if (unchecked.length) {
    out.push("### Lean 没能确认等价的变体（不计入）", "");
    out.push(`${unchecked.length} 个：${unchecked.slice(0, 60).map((r) => r.id).join("、")}${unchecked.length > 60 ? " ……" : ""}。这是改写程序的局限，不是证明器的。`, "");
  }
  return out.join("\n");
}
