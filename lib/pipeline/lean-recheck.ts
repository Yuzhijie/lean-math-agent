/**
 * `npm run lean:recheck` — re-run what needs no model on the Lean statements stored in past
 * sessions (Lean-tab attempts and theorem solves), to see what the current code proves without
 * spending anything. This file holds the pure parts (picking the statements, the report); the
 * script (scripts/lean-recheck.ts) runs Lean.
 */
import { normalizeTheoremType } from "../llm/autoformalize";
import type { Session } from "../types";

export type BeforeOutcome = "proved" | "no_statement" | "no_proof" | "gave_up_old" | "error";

export interface RecheckItem {
  sessionId: string;
  problem: string;
  kind: "lean_attempt" | "theorem";
  theoremName: string;
  theoremType: string;
  expectedSignature?: string;
  before: BeforeOutcome;
  beforeDetail: string;
  tries: number;
  createdAt: number;
}

/** `theorem name <type> := by sorry` → name and type. */
export function splitStatement(statement: string | undefined): { theoremName: string; theoremType: string } | undefined {
  const m = /^\s*theorem\s+(\S+)\s+([\s\S]*?)\s*:=\s*(?:by\s+sorry\s*)?$/.exec(statement ?? "");
  return m ? { theoremName: m[1], theoremType: m[2].trim() } : undefined;
}

function classify(s: Session): { before: BeforeOutcome; detail: string } {
  const a = s.lean_proof_attempt;
  if (a) {
    if (a.success) return { before: "proved", detail: a.strategy ?? "" };
    const reason = a.failure_reason ?? "";
    const at = (a.limitations ?? []).find((l) => /卡在|failed at|计算步数|computation budget/.test(l)) ?? "";
    if (/没能写出|No Lean statement|did not pass|没有通过数值检查|failed the numeric check|形式化未通过/.test(reason)) return { before: "no_statement", detail: reason.slice(0, 120) };
    if (/陈述通过了检查|statement passed|没有可用的 Lean|Lean is not available/i.test(reason)) return { before: "no_proof", detail: at.replace(/^.*?(卡在：|failed at: )/, "").slice(0, 120) };
    if (/当前自动|beyond current automated/.test(reason)) return { before: "gave_up_old", detail: reason.slice(0, 80) };
    return { before: "error", detail: reason.slice(0, 120) };
  }
  if (s.build_status === "ok") return { before: "proved", detail: "theorem pipeline" };
  if (!s.formal_validated) return { before: "no_statement", detail: (s.validation_results ?? []).filter((v) => !v.pass).map((v) => `L${v.layer}`).join(", ") };
  return { before: "no_proof", detail: s.pipeline_stage ?? "" };
}

/**
 * One item per distinct problem (its latest session with a statement): Lean-tab attempts that got
 * as far as a statement, and theorem sessions with a formal statement.
 */
export function recheckItems(sessions: Session[]): RecheckItem[] {
  const latest = new Map<string, { s: Session; tries: number; everProved: boolean; provedBy?: string }>();
  for (const s of [...sessions].sort((a, b) => a.created_at - b.created_at)) {
    const a = s.lean_proof_attempt;
    const statement = a ? a.formal_statement : s.formal_statement;
    if (a && !a.attempted) continue;
    if (!statement && !(s.theorem_name && s.theorem_type)) continue;
    const key = s.problem_text.trim().slice(0, 300);
    const prev = latest.get(key);
    const proved = !!(a ? a.success : s.build_status === "ok");
    latest.set(key, {
      s,
      tries: (prev?.tries ?? 0) + 1,
      everProved: (prev?.everProved ?? false) || proved,
      provedBy: proved ? (a?.strategy ?? "theorem pipeline") : prev?.provedBy,
    });
  }
  const out: RecheckItem[] = [];
  for (const { s, tries, everProved, provedBy } of latest.values()) {
    const a = s.lean_proof_attempt;
    const parts = a ? splitStatement(a.formal_statement) : s.theorem_name && s.theorem_type ? { theoremName: s.theorem_name, theoremType: s.theorem_type } : splitStatement(s.formal_statement);
    const { before, detail } = everProved ? { before: "proved" as const, detail: provedBy ?? "" } : classify(s);
    out.push({
      sessionId: s.id,
      problem: s.problem_text.replace(/\s+/g, " ").trim(),
      kind: a ? "lean_attempt" : "theorem",
      theoremName: parts?.theoremName ?? "",
      // stored before normalizeTheoremType learnt to add a missing ∀: normalize again
      theoremType: parts?.theoremType ? normalizeTheoremType(parts.theoremType) : "",
      ...(a ? {} : s.formal_signature ? { expectedSignature: s.formal_signature } : {}),
      before,
      beforeDetail: detail,
      tries,
      createdAt: s.created_at,
    });
  }
  return out.sort((x, y) => x.createdAt - y.createdAt);
}

export interface RecheckResult {
  item: RecheckItem;
  /** The statement was checked (it parses and is not empty). */
  checked: boolean;
  now?: { strategy: string; attempts: number };
  ms: number;
}

const BEFORE_LABEL: Record<BeforeOutcome, string> = {
  proved: "proved",
  no_statement: "no accepted statement",
  no_proof: "statement ok, no proof",
  gave_up_old: "old code gave up without trying",
  error: "error",
};

export function recheckReport(results: RecheckResult[], meta: { date: string; commit?: string }): string {
  const n = results.length;
  const before = results.filter((r) => r.item.before === "proved").length;
  // a statement that never passed the checks may be wrong (refuted, or easier than the problem):
  // proving it now says nothing about the problem, so it is counted apart
  const nowOnly = results.filter((r) => r.item.before !== "proved" && r.item.before !== "no_statement" && r.now);
  const unchecked = results.filter((r) => r.item.before === "no_statement" && r.now);
  const total = results.filter((r) => r.item.before === "proved" || (r.item.before !== "no_statement" && r.now)).length;
  const byBefore = new Map<BeforeOutcome, number>();
  for (const r of results) byBefore.set(r.item.before, (byBefore.get(r.item.before) ?? 0) + 1);
  const short = (t: string, k = 70) => (t.length > k ? `${t.slice(0, k - 1)}…` : t).replace(/\|/g, "\\|");
  const lines = [
    "# Lean re-check of past problems",
    "",
    `Generated by \`npm run lean:recheck\` on ${meta.date}${meta.commit ? ` (commit ${meta.commit})` : ""}. Each distinct problem's latest stored Lean statement is re-run through the steps that need no model — the hammer cascade, single tactics and the order proofs the program writes — with the current code. No model is called, so nothing is spent; statements are not re-formalized.`,
    "",
    "| Measure | Value |",
    "| --- | --- |",
    `| Problems with a stored statement | ${n} |`,
    `| Proved when they were solved | ${before} |`,
    `| Not proved then, proved now without a model | ${nowOnly.length} |`,
    `| Proved (then or now) | ${total} (${n ? Math.round((100 * total) / n) : 0}%) |`,
    `| Statements that never passed the checks, provable now (not counted: the statement may be wrong) | ${unchecked.length} |`,
    "",
    "Before, by outcome: " + [...byBefore.entries()].map(([k, v]) => `${BEFORE_LABEL[k]} ${v}`).join(", "),
    "",
    "| # | Problem | Kind | Before | Now (no model) |",
    "| --- | --- | --- | --- | --- |",
    ...results.map((r, i) => {
      const before = r.item.before === "proved" ? `proved${r.item.beforeDetail ? ` (${r.item.beforeDetail})` : ""}` : `${BEFORE_LABEL[r.item.before]}${r.item.beforeDetail ? `: ${short(r.item.beforeDetail, 60)}` : ""}`;
      const now = !r.checked ? "not checked" : r.now ? `proved (${r.now.strategy})` : "—";
      return `| ${i + 1} | ${short(r.item.problem)} | ${r.item.kind === "theorem" ? "theorem" : "Lean tab"} | ${before} | ${now} |`;
    }),
    "",
  ];
  return lines.join("\n");
}
