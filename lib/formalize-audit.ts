/**
 * `npm run formalize:audit` → bench/FORMALIZATION-AUDIT.md: is the Lean statement the problem?
 *
 * A Lean proof certifies the statement that was written, not that the statement is the problem,
 * and that step had not been measured on the product's own input: `bench:formalize` compares
 * with miniF2F's official statements (and its "not shown equivalent" is not "unfaithful"), the
 * end-to-end report only notices a proof next to a wrong answer. Whether a statement says what
 * the problem says cannot be decided by a program, so it is read: every statement gets a verdict
 * by hand, kept in bench/formalization-labels.json under the statement's fingerprint. A statement
 * that changes has a new fingerprint and is listed as unread. The program does the counting and
 * compares the two things it can see for itself (lib/lean/statement-scope.ts) with the reading.
 *
 * Sources:
 *  - sessions: each distinct problem that reached the Lean step (its proved session, else the latest)
 *  - end-to-end runs on the held-out set: the statements of `dev` problems only — a `test`
 *    statement is never read (held-out discipline); they are counted
 *  - the latest `bench:formalize` run: our statement next to miniF2F's official one
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { RunFile } from "./e2e/outcome";
import { FIGURE_MARK, statementScope, statementType, type StatementScope } from "./lean/statement-scope";
import type { Session } from "./types";

// ── verdicts ─────────────────────────────────────────────────────────────────────────────────

export type Group = "faithful" | "hollow" | "deviates" | "wrong" | "rejected_right" | "rejected_wrong" | "other";

export const VERDICTS = {
  F: { zh: "忠实：陈述说的就是题目", group: "faithful" },
  E: { zh: "图或选项是手工编码进陈述的：陈述没说错，但读图、读选项这一步不在 Lean 里", group: "hollow" },
  B: { zh: "把解题时算出来的中间结果当作已知写进了陈述：Lean 只核对了最后一步", group: "hollow" },
  S: { zh: "比题目要求的强（仍然为真）", group: "deviates" },
  W: { zh: "比题目弱：证了它不等于证了原题", group: "deviates" },
  A: { zh: "多了假设，或把范围变窄了", group: "deviates" },
  H: { zh: "少了条件：陈述为假，或不是原题", group: "wrong" },
  D: { zh: "定义写错了", group: "wrong" },
  X: { zh: "陈述与答案不一致，或本身为假", group: "wrong" },
  K: { zh: "被检查层拒绝，拒绝得对", group: "rejected_right" },
  R: { zh: "被检查层拒绝，但陈述其实是忠实的", group: "rejected_wrong" },
  N: { zh: "题目本身不完整（例如缺图），与形式化无关", group: "other" },
  U: { zh: "读了，没能判断", group: "other" },
} as const satisfies Record<string, { zh: string; group: Group }>;

export type Verdict = keyof typeof VERDICTS;

const GROUP_ZH: Record<Group, string> = {
  faithful: "忠实",
  hollow: "空心",
  deviates: "有偏差",
  wrong: "错",
  rejected_right: "拒绝得对",
  rejected_wrong: "错拒",
  other: "其他",
};

const groupOf = (v: Verdict): Group => VERDICTS[v].group;

// ── labels ───────────────────────────────────────────────────────────────────────────────────

const labelSchema = z.object({
  /** statementKey of the statement that was read */
  key: z.string().regex(/^[0-9a-f]{12}$/),
  verdict: z.enum(Object.keys(VERDICTS) as [Verdict, ...Verdict[]]),
  note: z.string().optional(),
  /** where it was read (session / heldout / minif2f) and what it is about — for whoever edits the file */
  source: z.string().optional(),
  about: z.string().optional(),
});

const labelFileSchema = z.object({
  description: z.string().optional(),
  /** who read the statements ("Claude, 2026-11-13"), printed with the report: a reading is a judgement, not a proof */
  read_by: z.string().optional(),
  labels: z.array(labelSchema),
});

export type Label = z.infer<typeof labelSchema>;

/** The label file: the labels by fingerprint (a key that occurs twice is an error: one statement, one verdict) and who read. */
export function readLabelFile(text: string): { labels: Map<string, Label>; readBy?: string } {
  const doc = labelFileSchema.parse(JSON.parse(text));
  const labels = new Map<string, Label>();
  for (const l of doc.labels) {
    if (labels.has(l.key)) throw new Error(`formalization labels: key ${l.key} occurs twice`);
    labels.set(l.key, l);
  }
  return { labels, ...(doc.read_by ? { readBy: doc.read_by } : {}) };
}

export function parseLabels(text: string): Map<string, Label> {
  return readLabelFile(text).labels;
}

/**
 * The fingerprint a label is stored under: of the statement's type (whitespace aside) together
 * with what it formalizes — the problem's text (sessions) or the problem's id (held-out set,
 * miniF2F). A verdict is about the pair: `∀ n, n + 0 = n` is one problem's faithful statement and
 * could be another's weakened one.
 */
export function statementKey(statement: string | undefined, of: string): string {
  const type = statement?.trim() ? statementType(statement) : "";
  return createHash("sha256").update(`${of.replace(/\s+/g, " ").trim()}\n${type}`).digest("hex").slice(0, 12);
}

// ── items ────────────────────────────────────────────────────────────────────────────────────

/** proved · accepted (the statement passed every check, no proof) · rejected (no statement passed) · gave_up (old code: not tried) · error */
export type Outcome = "proved" | "accepted" | "rejected" | "gave_up" | "error";

export interface AuditItem {
  source: "session" | "heldout" | "minif2f";
  /** session id · held-out problem id · miniF2F theorem id */
  id: string;
  /** the problem as typed (empty for miniF2F: its run file keeps the id only) */
  problem: string;
  /** the statement's type on one line; undefined when none was written */
  statement?: string;
  outcome: Outcome;
  strategy?: string;
  /** miniF2F: the program's comparison with the official statement, and that statement */
  compared?: string;
  official?: string;
  scope?: StatementScope;
  key: string;
}

function item(base: Omit<AuditItem, "key" | "scope" | "statement">, statement: string | undefined, answers: string[] = []): AuditItem {
  const type = statement?.trim() ? statementType(statement) : undefined;
  return {
    ...base,
    ...(type ? { statement: type, scope: statementScope(base.problem, type, answers) } : {}),
    key: statementKey(type, base.source === "session" ? base.problem : `${base.source}:${base.id}`),
  };
}

function sessionOutcome(s: Session): { outcome: Outcome; strategy?: string } {
  const a = s.lean_proof_attempt;
  if (a) {
    if (a.success) return { outcome: "proved", strategy: a.strategy ?? "?" };
    const reason = a.failure_reason ?? "";
    // session.formal_validated: the stepwise route of older versions, which ended in "source contains sorry"
    if (a.statement_accepted || s.formal_validated || /陈述通过了检查|statement passed/i.test(reason)) return { outcome: "accepted" };
    if (/没能写出|No Lean statement|did not pass|没有通过数值检查|failed the numeric check|形式化未通过/.test(reason)) return { outcome: "rejected" };
    if (/当前自动|beyond current automated/.test(reason)) return { outcome: "gave_up" };
    return { outcome: "error" };
  }
  if (s.build_status === "ok") return { outcome: "proved", strategy: "theorem pipeline" };
  return { outcome: s.formal_validated ? "accepted" : "rejected" };
}

const sessionStatement = (s: Session): string | undefined =>
  s.lean_proof_attempt?.formal_statement ?? s.formal_statement ?? (s.theorem_name && s.theorem_type ? `theorem ${s.theorem_name} ${s.theorem_type}` : undefined);

const flat = (t: string) => t.replace(/\s+/g, " ").trim();

/**
 * One item per distinct problem that reached the Lean step: the session in which it was proved,
 * else the latest one with a statement, else the latest. `exclude` holds problem texts that must
 * not appear (the held-out set: a run made with --keep-sessions leaves its problems in the store).
 */
export function sessionItems(sessions: Session[], exclude: ReadonlySet<string> = new Set()): AuditItem[] {
  const groups = new Map<string, Session[]>();
  for (const s of [...sessions].sort((a, b) => a.created_at - b.created_at)) {
    const a = s.lean_proof_attempt;
    // a theorem solve that stopped before its statement was checked has nothing to audit
    if (a ? !a.attempted : !((s.theorem_type || s.formal_statement) && (s.formal_validated || s.validation_results?.length))) continue;
    if (exclude.has(flat(s.problem_text))) continue;
    // the same problem read with its figure twice has two descriptions: group by the text before it
    const k = flat(s.problem_text.split(FIGURE_MARK)[0]).slice(0, 300);
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  const out: AuditItem[] = [];
  for (const g of groups.values()) {
    const s = g.findLast((x) => sessionOutcome(x).outcome === "proved") ?? g.findLast((x) => !!sessionStatement(x)) ?? g[g.length - 1];
    const answers = [s.computation_result?.answer, s.nl_solution?.final_answer].filter((x): x is string => !!x);
    out.push(item({ source: "session", id: s.id, problem: flat(s.problem_text), ...sessionOutcome(s) }, sessionStatement(s), answers));
  }
  return out;
}

export interface HeldoutAudit {
  /** dev problems that reached the Lean step, the latest run's row of each */
  items: AuditItem[];
  /** the test split, never read: counts over the latest row of each problem */
  test: { attempted: number; formalized: number; proved: number };
}

/** The statements of the end-to-end runs (older first): `dev` rows as items, `test` rows as counts. */
export function heldoutItems(runs: RunFile[], problems: ReadonlyMap<string, { text: string; answer?: string }> = new Map()): HeldoutAudit {
  const latest = new Map<string, RunFile["rows"][number]>();
  for (const run of [...runs].sort((a, b) => a.meta.at.localeCompare(b.meta.at))) {
    for (const r of run.rows) if (r.status === "done" && r.lean_attempted) latest.set(r.id, r);
  }
  const rows = [...latest.values()];
  const test = rows.filter((r) => r.split === "test");
  return {
    items: rows
      .filter((r) => r.split === "dev")
      .map((r) => {
        const p = problems.get(r.id);
        return item(
          { source: "heldout", id: r.id, problem: flat(p?.text ?? r.id), outcome: r.proved ? "proved" : r.formalized ? "accepted" : "rejected", ...(r.strategy ? { strategy: r.strategy } : {}) },
          r.statement,
          [p?.answer, r.answer].filter((x): x is string => !!x),
        );
      }),
    test: { attempted: test.length, formalized: test.filter((r) => r.formalized).length, proved: test.filter((r) => r.proved).length },
  };
}

/** A row of a `bench:formalize` result file. */
export interface FormalizeResultRow {
  id: string;
  accepted: boolean;
  verdict: string;
  official: string;
  ours?: string;
}

export function minif2fItems(rows: FormalizeResultRow[]): AuditItem[] {
  return rows
    .filter((r) => r.verdict !== "official_broken")
    .map((r) => ({
      ...item({ source: "minif2f", id: r.id, problem: "", outcome: r.accepted ? "accepted" : "rejected" }, r.verdict === "not_formalized" ? undefined : r.ours),
      compared: r.verdict,
      official: flat(r.official),
    }));
}

// ── the report ───────────────────────────────────────────────────────────────────────────────

/** What was read of an item: its label, or — a miniF2F statement the program showed equal to the official one — faithful without reading. */
export function readingOf(it: AuditItem, labels: ReadonlyMap<string, Label>): { verdict: Verdict; note?: string; by: "label" | "program" } | undefined {
  const l = labels.get(it.key);
  if (l) return { verdict: l.verdict, ...(l.note ? { note: l.note } : {}), by: "label" };
  if (it.source === "minif2f" && (it.compared === "same" || it.compared === "equivalent")) return { verdict: "F", by: "program" };
  return undefined;
}

const OUTCOME_ZH: Record<Outcome, string> = {
  proved: "Lean 已证",
  accepted: "陈述通过检查，没证出来",
  rejected: "没有通过检查的陈述",
  gave_up: "旧版本没有尝试证明",
  error: "出错",
};

const COMPARED_ZH: Record<string, string> = {
  same: "与官方陈述相同（签名一致）",
  equivalent: "等价（自动证出 官方 ↔ 我们的）",
  not_shown: "没证出等价",
  refuted: "我们的陈述有反例",
  not_formalized: "没写出陈述",
};

const pct = (k: number, n: number) => (n ? `${Math.round((k / n) * 100)}%` : "—");
const share = (k: number, n: number) => `${k}/${n}（${pct(k, n)}）`;

function table(head: string[], rows: string[][]): string[] {
  return [`| ${head.join(" | ")} |`, `|${head.map(() => " --- ").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)];
}

function cell(s: string | undefined, n: number): string {
  // control characters: a stored problem may hold what "\a", "\f" of unescaped LaTeX turned into
  const t = (s ?? "").replace(/[\u0000-\u001f\u007f\s]+/g, " ").replace(/\|/g, "\\|").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

interface Read {
  it: AuditItem;
  verdict?: Verdict;
  note?: string;
}

interface Tally {
  /** statements the checks did not reject (proved or not; old versions that gave up without trying included) */
  accepted: Read[];
  read: Read[];
  by: Map<Group, Read[]>;
  unread: Read[];
  proved: Read[];
}

function tally(items: Read[]): Tally {
  const accepted = items.filter((r) => r.it.statement && r.it.outcome !== "rejected");
  const read = accepted.filter((r) => r.verdict);
  const by = new Map<Group, Read[]>();
  for (const r of read) by.set(groupOf(r.verdict!), [...(by.get(groupOf(r.verdict!)) ?? []), r]);
  return { accepted, read, by, unread: accepted.filter((r) => !r.verdict), proved: accepted.filter((r) => r.it.outcome === "proved") };
}

const n = (t: Tally, g: Group) => t.by.get(g)?.length ?? 0;

/** "忠实 85，空心 15，…" over the accepted statements that were read. */
function mix(t: Tally): string {
  return (["faithful", "hollow", "deviates", "wrong", "other"] as Group[])
    .filter((g) => n(t, g))
    .map((g) => `${GROUP_ZH[g]} ${n(t, g)}`)
    .join("，");
}

function verdictTable(reads: Read[]): string[] {
  const rows: string[][] = [];
  for (const v of Object.keys(VERDICTS) as Verdict[]) {
    const g = reads.filter((r) => r.verdict === v);
    if (g.length) rows.push([`**${v}**`, GROUP_ZH[groupOf(v)], String(g.length), String(g.filter((r) => r.it.outcome === "proved").length), VERDICTS[v].zh]);
  }
  const unread = reads.filter((r) => r.it.statement && !r.verdict);
  if (unread.length) rows.push(["—", "还没读", String(unread.length), String(unread.filter((r) => r.it.outcome === "proved").length), "见最后一节"]);
  return table(["读法", "归类", "条数", "其中 Lean 已证", "含义"], rows);
}

export interface AuditInput {
  sessions: AuditItem[];
  heldout?: HeldoutAudit;
  minif2f: AuditItem[];
  labels: ReadonlyMap<string, Label>;
  meta: { date: string; commit?: string; e2e?: string; formalize?: string; readBy?: string };
}

export interface AuditSummary {
  accepted: number;
  read: number;
  unread: number;
  /** labels whose statement is not in the data any more */
  stale: number;
}

export function auditSummary(input: AuditInput): AuditSummary {
  const all = [...input.sessions, ...(input.heldout?.items ?? []), ...input.minif2f];
  const reads = all.map((it) => ({ it, ...readingOf(it, input.labels) }));
  const t = tally(reads);
  const keys = new Set(all.map((it) => it.key));
  return { accepted: t.accepted.length, read: t.read.length, unread: reads.filter((r) => r.it.statement && !r.verdict).length, stale: [...input.labels.keys()].filter((k) => !keys.has(k)).length };
}

export function auditReport(input: AuditInput): string {
  const { labels, meta } = input;
  const reads = (items: AuditItem[]): Read[] => items.map((it) => ({ it, ...readingOf(it, labels) }));
  const S = reads(input.sessions);
  const H = reads(input.heldout?.items ?? []);
  const M = reads(input.minif2f);
  const ts = tally(S);
  const th = tally(H);
  const tm = tally(M);
  const out: string[] = ["# 形式化审计：写出来的 Lean 陈述是不是原题", ""];
  out.push(
    `由 \`npm run formalize:audit\` 生成（${meta.date}${meta.commit ? `，\`${meta.commit}\`` : ""}）。`,
    "",
    "Lean 保证的是“写出来的这条陈述被证明了”，不保证“这条陈述就是题目”。后一件事程序判断不了，只能读：每条陈述读过后给一个结论，按陈述的指纹记在 `bench/formalization-labels.json`；陈述一变，指纹就变，会列在最后一节等人重读。程序只负责统计，并把它自己能看出来的两个信号（`lib/lean/statement-scope.ts`）拿来和读出的结论对照。",
    "",
    `读法是判断，不是证明：没有经过 Lean 核实，读的人也会看走眼。${meta.readBy ? `目前的结论由 ${meta.readBy} 读出。` : ""}对某一条有不同看法，改标签文件里那一条即可。`,
    "",
  );

  // ── the findings, as sentences
  out.push("## 结论", "");
  if (ts.accepted.length) {
    out.push(
      `- **用过的题**：${input.sessions.length} 道题走到了 Lean 这一步，${ts.accepted.length} 条陈述没有被检查层拒绝，读过 ${ts.read.length} 条：${mix(ts)}。` +
        (ts.read.length ? `说错了题意的（有偏差 + 错）只有 ${share(n(ts, "deviates") + n(ts, "wrong"), ts.read.length)}；更常见的问题是空心 ${share(n(ts, "hollow"), ts.read.length)}——陈述没说错，但题目的难点（读图、建模、中间推导）是在 Lean 之外完成的。` : ""),
    );
    const provedRead = ts.proved.filter((r) => r.verdict);
    const provedHollow = provedRead.filter((r) => groupOf(r.verdict!) === "hollow").length;
    const provedBad = provedRead.filter((r) => groupOf(r.verdict!) === "deviates" || groupOf(r.verdict!) === "wrong").length;
    if (provedRead.length) {
      out.push(
        `- **“Lean 已证”有多实**：${ts.proved.length} 个证明里（读过 ${provedRead.length} 个），${provedRead.length - provedHollow - provedBad} 个证的确实是原题；${provedHollow} 个（${pct(provedHollow, provedRead.length)}）证的是空心陈述——一份手工编码或一步算式；${provedBad} 个证的陈述与题意有出入。`,
      );
    }
    const rejected = S.filter((r) => r.it.outcome === "rejected");
    if (rejected.length) {
      const right = rejected.filter((r) => r.verdict === "K").length;
      const wrong = rejected.filter((r) => r.verdict === "R").length;
      out.push(`- **检查层**：${rejected.length} 道题没有陈述通过检查；读下来拒绝得对 ${right} 条，错拒 ${wrong} 条${rejected.length - right - wrong ? `，其余 ${rejected.length - right - wrong} 条见下` : ""}。`);
    }
  }
  if (H.length || input.heldout?.test.attempted) {
    out.push(
      `- **端到端评测（留出题集）**：dev 部分 ${th.accepted.length} 条通过检查的陈述，读过 ${th.read.length} 条：${mix(th) || "—"}。` +
        (input.heldout?.test.attempted ? `test 部分 ${input.heldout.test.formalized}/${input.heldout.test.attempted} 条通过检查、${input.heldout.test.proved} 条已证，按留出纪律不读。` : ""),
    );
  }
  if (M.length) {
    const shown = M.filter((r) => r.it.compared === "same" || r.it.compared === "equivalent").length;
    const notShown = M.filter((r) => r.it.compared === "not_shown");
    const notShownRead = notShown.filter((r) => r.verdict);
    const notShownFaithful = notShownRead.filter((r) => groupOf(r.verdict!) === "faithful").length;
    out.push(
      `- **miniF2F（对照官方陈述）**：程序能证明相同或等价的 ${share(shown, M.length)}；读下来忠实的 ${share(n(tm, "faithful"), tm.read.length)}。` +
        (notShownRead.length ? `“没证出等价”的 ${notShown.length} 条里读过 ${notShownRead.length} 条，${notShownFaithful} 条是忠实的——多数只是写法或一般性与官方不同（官方陈述本身也有写错的），所以“没证出等价”不能当作“不忠实”来读。` : ""),
    );
  }
  const unreadAll = [...S, ...H, ...M].filter((r) => r.it.statement && !r.verdict);
  if (unreadAll.length) out.push(`- 还有 ${unreadAll.length} 条陈述没读过（最后一节）。上面的比例只覆盖读过的部分。`);
  out.push("");

  out.push("### 标签", "");
  out.push(...table(["代号", "归类", "含义"], (Object.keys(VERDICTS) as Verdict[]).map((v) => [`**${v}**`, GROUP_ZH[groupOf(v)], VERDICTS[v].zh])), "");

  // ── sessions
  if (S.length) {
    out.push("## 一、用过的题（历史会话）", "");
    out.push("每道不同的题取一次：证出来的那一次，否则取最近一次有陈述的。", "");
    const outcomes = (Object.keys(OUTCOME_ZH) as Outcome[]).filter((o) => S.some((r) => r.it.outcome === o));
    out.push(...table(["走到哪一步", "题数", "占比"], outcomes.map((o) => [OUTCOME_ZH[o], String(S.filter((r) => r.it.outcome === o).length), pct(S.filter((r) => r.it.outcome === o).length, S.length)])), "");
    out.push("### 读下来", "", ...verdictTable(S), "");
    const listed = S.filter((r) => r.verdict && r.verdict !== "F").sort((a, b) => Object.keys(VERDICTS).indexOf(a.verdict!) - Object.keys(VERDICTS).indexOf(b.verdict!));
    if (listed.length) {
      out.push("### 逐条（忠实的不列）", "");
      out.push(...table(["读法", "题目", "结果", "说明"], listed.map((r) => [`**${r.verdict}**`, cell(r.it.problem, 60), r.it.outcome === "proved" ? `已证（${r.it.strategy ?? "?"}）` : OUTCOME_ZH[r.it.outcome], cell(r.note, 200)])), "");
    }
    const remarks = S.filter((r) => r.verdict === "F" && r.note);
    if (remarks.length) {
      out.push("### 忠实，但值得记一笔", "");
      out.push(...table(["题目", "结果", "说明"], remarks.map((r) => [cell(r.it.problem, 60), r.it.outcome === "proved" ? `已证（${r.it.strategy ?? "?"}）` : OUTCOME_ZH[r.it.outcome], cell(r.note, 200)])), "");
    }
  }

  // ── held-out
  if (H.length || input.heldout?.test.attempted) {
    out.push("## 二、端到端评测（留出题集）", "");
    if (meta.e2e) out.push(`运行：${meta.e2e}。只读 dev 部分的陈述；test 部分只计数。`, "");
    if (H.length) {
      out.push(...table(["题", "结果", "读法", "说明"], H.map((r) => [r.it.id, r.it.outcome === "proved" ? `已证（${r.it.strategy ?? "?"}）` : OUTCOME_ZH[r.it.outcome], r.verdict ? `**${r.verdict}** ${GROUP_ZH[groupOf(r.verdict)]}` : "还没读", cell(r.note, 200)])), "");
    }
    if (input.heldout?.test.attempted) out.push(`test：${input.heldout.test.attempted} 道题走到 Lean，${input.heldout.test.formalized} 条陈述通过检查，${input.heldout.test.proved} 条已证。这些陈述不读，所以其中有多少空心、多少有偏差是不知道的；dev 的比例是唯一的估计。`, "");
  }

  // ── miniF2F
  if (M.length) {
    out.push("## 三、miniF2F：与官方陈述对照", "");
    if (meta.formalize) out.push(`运行：${meta.formalize}。程序的判定只有“相同 / 等价 / 没证出等价”；“没证出等价”的由人读（对照题目原文的意思，而不是官方的写法）。`, "");
    const groups: Group[] = ["faithful", "deviates", "wrong", "other"];
    const kinds = Object.keys(COMPARED_ZH).filter((k) => M.some((r) => r.it.compared === k));
    out.push(
      ...table(
        ["程序的判定", "条数", ...groups.map((g) => `读：${GROUP_ZH[g]}`), "还没读"],
        kinds.map((k) => {
          const g = M.filter((r) => r.it.compared === k);
          return [COMPARED_ZH[k], String(g.length), ...groups.map((x) => String(g.filter((r) => r.verdict && groupOf(r.verdict) === x).length)), String(g.filter((r) => !r.verdict).length)];
        }),
      ),
      "",
    );
    const listed = M.filter((r) => labels.has(r.it.key));
    if (listed.length) {
      out.push("### 读过的（程序没证出等价的那些）", "");
      out.push(...table(["定理", "读法", "说明"], listed.map((r) => [r.it.id.replace(/_/g, "\\_"), `**${r.verdict}** ${GROUP_ZH[groupOf(r.verdict!)]}`, cell(r.note, 220)])), "");
    }
  }

  // ── the program's signals against the reading
  const judged = [...ts.read, ...th.read];
  if (judged.length) {
    const fig = judged.filter((r) => r.it.scope?.figure);
    const calc = judged.filter((r) => r.it.scope?.closed && r.it.scope.derived.length);
    const hollow = judged.filter((r) => groupOf(r.verdict!) === "hollow");
    const flagged = new Set([...fig, ...calc]);
    const hollowOf = (g: Read[]) => g.filter((r) => groupOf(r.verdict!) === "hollow").length;
    out.push("## 四、程序自己能看出多少", "");
    out.push("程序看不出陈述是否忠实，但空心的两种常见情形有迹可循。下面是这两个信号在读过的陈述（会话 + dev）上的表现；它们现在会作为说明显示在“Lean 已证”下面。", "");
    out.push(
      ...table(
        ["信号", "命中", "其中读为空心", "其余"],
        [
          ["题目带图（陈述里图的内容是模型读图写进去的）", String(fig.length), String(hollowOf(fig)), fig.length - hollowOf(fig) ? `${fig.length - hollowOf(fig)}（陈述不依赖图）` : "0"],
          ["陈述是不含未知量的算式，且含题目没给的数", String(calc.length), String(hollowOf(calc)), String(calc.length - hollowOf(calc))],
        ],
      ),
      "",
    );
    out.push(`读为空心的共 ${hollow.length} 条，两个信号合起来能指出其中 ${hollow.filter((r) => flagged.has(r)).length} 条。指不出来的是“带着变量、但把算出来的坐标或长度写成了已知”这一类，只能靠读。`, "");
  }

  // ── unread
  out.push("## 五、还没读过的陈述", "");
  if (!unreadAll.length) out.push("没有。", "");
  else {
    out.push("读完后在 `bench/formalization-labels.json` 的 `labels` 里加一条 `{ \"key\": …, \"verdict\": … , \"note\": … }`，再运行一次。", "");
    const SHOWN = 40;
    for (const r of unreadAll.slice(0, SHOWN)) {
      out.push(`- \`${r.it.key}\` ${r.it.source === "session" ? "会话" : r.it.source === "heldout" ? "dev" : "miniF2F"} ${r.it.source === "session" ? r.it.id.slice(0, 8) : r.it.id}（${OUTCOME_ZH[r.it.outcome]}）`);
      if (r.it.problem) out.push(`  - 题目：${cell(r.it.problem, 240)}`);
      if (r.it.official) out.push(`  - 官方：\`${cell(r.it.official, 300)}\``);
      out.push(`  - 陈述：${r.it.statement ? `\`${cell(r.it.statement, 600)}\`` : "（没有写出陈述）"}`);
    }
    if (unreadAll.length > SHOWN) out.push(`- ……还有 ${unreadAll.length - SHOWN} 条。`);
    out.push("");
  }
  const keys = new Set([...S, ...H, ...M].map((r) => r.it.key));
  const stale = [...labels.keys()].filter((k) => !keys.has(k)).length;
  if (stale) out.push(`标签文件里有 ${stale} 条对应的陈述已经不在当前数据里（题目重新形式化过，或会话已删除）；留着无妨。`, "");
  return out.join("\n");
}
