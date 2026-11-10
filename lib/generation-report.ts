/**
 * `npm run gen:report`: where generation spends its candidates, time and money (bench/GENERATION.md).
 * Reads the banks' stored generations (every candidate with its checks) and the generation log
 * (lib/generation-stats.ts: time per stage, rounds, model usage — for bank and built-in runs).
 * Pure: the script gathers the inputs.
 */
import type { Generation } from "./bank/types";
import type { GenerationLogEntry } from "./generation-stats";

const CHECKS = ["format", "answer", "novelty", "fit", "figure"] as const;

/** A failure detail reduced to its kind (numbers and quoted text out), for counting. */
export function failureKind(check: string, detail: string): string {
  const d = detail.trim();
  if (check === "answer") {
    if (/unsolvable|ill-posed|不完整|有矛盾/i.test(d)) return "independent solve: unsolvable / ill-posed";
    if (/does not say which card|which card goes where/i.test(d)) return "answer does not name the card for each place";
    if (/symmetric/i.test(d)) return "shape is symmetric";
    if (/checked by the program|程序/i.test(d) && /not|不一致/.test(d)) return "the program's check disagrees with the answer";
    if (/, not |不一致|disagree/i.test(d)) return "independent answer differs";
  }
  if (check === "fit") {
    const m = d.match(/(?:fit|匹配度)\s*(\d)\s*\/\s*5/i);
    if (m) return `fit ${m[1]}/5`;
  }
  if (check === "figure") {
    if (/Invalid discriminator|图形描述无效|could not be drawn|无法绘制/i.test(d)) return "figure spec invalid (kind the program does not have)";
    if (/does not match its description|与描述不符/i.test(d)) return "model-drawn figure does not match its description";
    if (/no (figure|table)|missing|requires? a|需要/i.test(d)) return "required figure / table / 3D missing";
    if (/angle|角/i.test(d)) return "angles contradict the question";
    if (/overlap|cover|重叠|遮挡/i.test(d)) return "drawing overlaps itself";
    if (/shows the answer|泄露|answer leak/i.test(d)) return "figure shows the answer";
  }
  if (check === "novelty") {
    if (/reword|改写/i.test(d)) return "too close to a bank question (rewording did not help)";
    return "too close to a bank question";
  }
  return d.replace(/\d+(\.\d+)?/g, "N").replace(/"[^"]*"|“[^”]*”|「[^」]*」/g, "…").slice(0, 80);
}

const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "—");
const sec = (ms: number) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(0)} s`);
const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const esc = (t: string) => t.replace(/\|/g, "\\|").replace(/\s+/g, " ");

export interface ReportInput {
  generations: (Generation & { template_text?: string })[];
  log: GenerationLogEntry[];
  /** Report date (for the heading). */
  now?: Date;
}

export function generationReport({ generations, log, now = new Date() }: ReportInput): string {
  const out: string[] = [];
  const gens = [...generations].sort((a, b) => a.created_at - b.created_at);
  out.push(`# Question generation: where candidates, time and money go`, "");
  out.push(`Generated ${now.toISOString().slice(0, 10)} by \`npm run gen:report\` (no model calls).`, "");

  // ── Bank generations: candidates and checks ──
  const cands = gens.flatMap((g) => g.candidates);
  const requested = gens.reduce((s, g) => s + g.requested, 0);
  const kept = cands.filter((c) => c.passed).length;
  const withStats = gens.filter((g) => g.stats);
  const written = gens.reduce((s, g) => s + (g.stats?.written ?? g.candidates.length), 0);
  const passedAll = gens.reduce((s, g) => s + (g.stats?.passed ?? g.candidates.filter((c) => c.passed).length), 0);
  const full = gens.filter((g) => g.candidates.filter((c) => c.passed).length >= g.requested).length;
  const none = gens.filter((g) => !g.candidates.some((c) => c.passed)).length;
  out.push(`## Bank generations (同类创编)`, "");
  if (!gens.length) out.push("No stored generations.", "");
  else {
    const span = `${new Date(gens[0].created_at).toISOString().slice(0, 10)} – ${new Date(gens[gens.length - 1].created_at).toISOString().slice(0, 10)}`;
    out.push(
      `| | |`,
      `|---|---|`,
      `| Generations | ${gens.length} (${span}) |`,
      `| Questions requested | ${requested} |`,
      `| Questions written | ${written}${withStats.length < gens.length ? ` (at least: ${gens.length - withStats.length} older records keep only the candidates shown — passed extras beyond the request were not stored)` : ""} |`,
      `| Passed every check | ${passedAll} (kept ${kept}) |`,
      `| Written per passed question | ${passedAll ? (written / passedAll).toFixed(2) : "—"} |`,
      `| Generations that got every question asked | ${full} (${pct(full, gens.length)}) |`,
      `| Generations with none passed | ${none} |`,
      "",
    );

    // checks
    const failed = Object.fromEntries(CHECKS.map((k) => [k, 0])) as Record<string, number>;
    const sole = Object.fromEntries(CHECKS.map((k) => [k, 0])) as Record<string, number>;
    const kinds = new Map<string, Map<string, { n: number; example: string }>>();
    for (const c of cands) {
      const bad = Object.entries(c.checks).filter(([, v]) => v && !v.ok && !v.skipped);
      for (const [k, v] of bad) {
        failed[k] = (failed[k] ?? 0) + 1;
        const kind = failureKind(k, v!.detail);
        const m = kinds.get(k) ?? new Map();
        const e = m.get(kind) ?? { n: 0, example: v!.detail };
        e.n++;
        m.set(kind, e);
        kinds.set(k, m);
      }
      if (bad.length === 1) sole[bad[0][0]] = (sole[bad[0][0]] ?? 0) + 1;
    }
    const failedCands = cands.filter((c) => !c.passed).length;
    out.push(`### Which checks reject candidates`, "", `${failedCands} of ${cands.length} stored candidates failed. A candidate can fail several checks; "only" counts the ones that failed that check alone (fixing it would have passed them).`, "");
    out.push(`| Check | Failed | Only this check |`, `|---|---|---|`);
    for (const k of CHECKS) out.push(`| ${k} | ${failed[k] ?? 0} | ${sole[k] ?? 0} |`);
    out.push("");
    out.push(`### Why`, "");
    for (const k of CHECKS) {
      const m = kinds.get(k);
      if (!m?.size) continue;
      out.push(`**${k}**`, "", `| Reason | Candidates | Example |`, `|---|---|---|`);
      for (const [kind, e] of [...m.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 8)) out.push(`| ${esc(kind)} | ${e.n} | ${esc(e.example.slice(0, 160))} |`);
      out.push("");
    }

    // figure source
    const bySource = new Map<string, [number, number]>();
    for (const c of cands) {
      const src = c.figure?.source ?? "none";
      const v = bySource.get(src) ?? [0, 0];
      v[0] += c.passed ? 1 : 0;
      v[1]++;
      bySource.set(src, v);
    }
    out.push(`### Pass rate by figure`, "", `| Figure | Passed | Candidates | Rate |`, `|---|---|---|---|`);
    for (const [src, [p, n]] of [...bySource.entries()].sort((a, b) => b[1][1] - a[1][1])) out.push(`| ${src === "program" ? "drawn by the program" : src === "model" ? "drawn by the model (SVG)" : "no figure"} | ${p} | ${n} | ${pct(p, n)} |`);
    out.push("");

    // templates
    const per = new Map<string, { gens: number; cands: number; passed: number; fails: Record<string, number>; kinds: Set<string> }>();
    for (const g of gens) {
      const key = g.template_text?.trim() ? g.template_text.trim().slice(0, 70) : `[${g.template_label.slice(0, 60)}]`;
      const t = per.get(key) ?? { gens: 0, cands: 0, passed: 0, fails: {}, kinds: new Set<string>() };
      t.gens++;
      t.cands += g.candidates.length;
      t.passed += g.candidates.filter((c) => c.passed).length;
      for (const k of g.figure_plan?.kinds ?? []) t.kinds.add(k);
      for (const c of g.candidates) for (const [k, v] of Object.entries(c.checks)) if (v && !v.ok && !v.skipped) t.fails[k] = (t.fails[k] ?? 0) + 1;
      per.set(key, t);
    }
    const rows = [...per.entries()].map(([k, t]) => ({ k, ...t, wasted: t.cands - t.passed })).sort((a, b) => b.wasted - a.wasted);
    const wasted = rows.reduce((s, r) => s + r.wasted, 0);
    const top = rows.slice(0, 6).reduce((s, r) => s + r.wasted, 0);
    out.push(`### Templates that waste the most candidates`, "", `${wasted} candidates failed; the top 6 templates account for ${top} (${pct(top, wasted)}).`, "");
    out.push(`| Failed | Generations | Candidates | Passed | Failing checks | Figure kinds | Template |`, `|---|---|---|---|---|---|---|`);
    for (const r of rows.slice(0, 12)) {
      if (!r.wasted) break;
      out.push(`| ${r.wasted} | ${r.gens} | ${r.cands} | ${r.passed} | ${Object.entries(r.fails).map(([k, n]) => `${k} ${n}`).join(", ")} | ${[...r.kinds].join(", ") || "—"} | ${esc(r.k)} |`);
    }
    out.push("");
  }

  // ── Time and money (generation log) ──
  out.push(`## Time and money`, "");
  for (const kind of ["bank", "builtin"] as const) {
    const runs = log.filter((e) => e.kind === kind);
    out.push(`### ${kind === "bank" ? "Bank generations" : "Built-in generations (内置出题)"}`, "");
    if (!runs.length) {
      out.push(`No runs logged yet (the log starts with this version: .data/generation-log.jsonl).`, "");
      continue;
    }
    const passed = runs.reduce((s, e) => s + e.stats.passed, 0);
    const writtenN = runs.reduce((s, e) => s + e.stats.written, 0);
    const dur = runs.map((e) => e.stats.duration_ms);
    const total = dur.reduce((a, b) => a + b, 0);
    const costs = runs.map((e) => e.stats.cost_usd).filter((c): c is number => c !== undefined);
    const cost = costs.reduce((a, b) => a + b, 0);
    const calls = runs.reduce((s, e) => s + e.stats.llm_calls, 0);
    out.push(
      `| | |`,
      `|---|---|`,
      `| Runs | ${runs.length} |`,
      `| Requested / written / passed | ${runs.reduce((s, e) => s + e.requested, 0)} / ${writtenN} / ${passed} |`,
      `| Rounds per run (mean) | ${(runs.reduce((s, e) => s + e.stats.rounds, 0) / runs.length).toFixed(2)} |`,
      `| Time per run (median / mean) | ${sec(median(dur))} / ${sec(total / runs.length)} |`,
      `| Time per passed question | ${passed ? sec(total / passed) : "—"} |`,
      `| Model calls per passed question | ${passed ? (calls / passed).toFixed(1) : "—"} |`,
      `| Cost per passed question | ${costs.length && passed ? `$${(cost / passed).toFixed(4)}${costs.length < runs.length ? ` (${costs.length} of ${runs.length} runs priced)` : ""}` : "— (no LLM_PRICES for the models used)"} |`,
      "",
    );
    const stage = new Map<string, number>();
    for (const e of runs) for (const [k, v] of Object.entries(e.stats.stage_ms)) stage.set(k, (stage.get(k) ?? 0) + v);
    const stageTotal = [...stage.values()].reduce((a, b) => a + b, 0);
    if (stageTotal) {
      out.push(`| Stage | Time | Share |`, `|---|---|---|`);
      for (const [k, v] of [...stage.entries()].sort((a, b) => b[1] - a[1])) out.push(`| ${k} | ${sec(v)} | ${pct(v, stageTotal)} |`);
      out.push("");
    }
    if (kind === "builtin") {
      const ms = runs.flatMap((e) => e.outcomes.map((o) => o.check_ms).filter((x): x is Record<string, number> => !!x));
      if (ms.length) out.push(`Per problem, the independent solve took ${sec(median(ms.map((m) => m.answer ?? 0)))} and the Lean counterexample search ${sec(median(ms.map((m) => m.counterexample ?? 0)))} (medians; they run side by side).`, "");
      const f = new Map<string, number>();
      for (const e of runs) for (const o of e.outcomes) for (const k of Object.keys(o.failed)) f.set(k, (f.get(k) ?? 0) + 1);
      if (f.size) out.push(`Rejected by: ${[...f.entries()].map(([k, n]) => `${k} ${n}`).join(", ")}.`, "");
    }
    const models = new Map<string, number>();
    for (const e of runs) for (const [k, v] of Object.entries(e.stats.by_model ?? {})) models.set(k, (models.get(k) ?? 0) + v.calls);
    if (models.size) out.push(`Calls by model: ${[...models.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ")}.`, "");
  }
  return out.join("\n");
}
