/**
 * Merge a re-run of some theorems into an earlier full run: rows of the later file replace the
 * rows with the same id, the totals are recomputed, and failure kinds that came from Lean
 * messages are re-classified with the current rules (so older files get the corrected buckets).
 *
 *   npm run bench:merge -- bench/results/full.json bench/results/rerun.json --out bench/results/full-merged.json
 */
import { promises as fs } from "node:fs";
import { classifyFailure, type FailureKind } from "./bench";
import { fixStatement } from "./fetch-benchmark";

interface Row {
  id: string;
  ok: boolean;
  proved_by: string;
  failure?: { kind: string; detail: string };
  skipped?: boolean;
  [k: string]: unknown;
}

interface Result {
  rows: Row[];
  [k: string]: unknown;
}

/** Kinds decided from a Lean message (the others come from the pipeline itself). */
const FROM_MESSAGE = new Set(["syntax_error", "tactic_failed", "type_mismatch", "unsolved_goal", "timeout", "other", "unknown_identifier", "missing_lemma", "scope_error"]);

export function reclassify(row: Row): Row {
  if (row.ok || !row.failure || !FROM_MESSAGE.has(row.failure.kind) || !row.failure.detail) return row;
  const kind: FailureKind = classifyFailure({ summary: row.failure.detail }).kind;
  return kind === row.failure.kind ? row : { ...row, failure: { ...row.failure, kind } };
}

/**
 * Theorems of a run worth running again after the fixes: statements that fixStatement changes,
 * and failures caused by the environment (model unreachable, a hung Lean worker).
 */
export function rerunIds(result: { rows: Row[] }, bench: { theorems: { id: string; type: string }[] }): string[] {
  const changed = new Set(bench.theorems.filter((t) => fixStatement(t.type) !== t.type).map((t) => t.id));
  return result.rows
    .filter(
      (r) =>
        changed.has(r.id) ||
        (!r.ok &&
          (r.failure?.kind === "infra_error" ||
            (r.failure?.kind === "statement_error" && /timed out|was killed/i.test(r.failure.detail)) ||
            (r.failure?.kind === "no_candidate" && !r.llm_calls))),
    )
    .map((r) => r.id);
}

export function mergeResults(base: Result, patches: Result[]): Result {
  const byId = new Map<string, Row>();
  for (const p of patches) for (const r of p.rows) if (!r.skipped) byId.set(r.id, { ...r, rerun: true });
  const rows = base.rows.map((r) => reclassify(byId.get(r.id) ?? r));
  const ran = rows.filter((r) => !r.skipped);
  const tally = (keys: string[]) => Object.fromEntries(keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>()));
  return {
    ...base,
    rows,
    pass: ran.filter((r) => r.ok).length,
    total: ran.length,
    proved_by: tally(ran.filter((r) => r.ok).map((r) => r.proved_by)),
    failures: tally(ran.filter((r) => !r.ok).map((r) => r.failure?.kind ?? "other")),
    merged_reruns: patches.map((p) => ({ started_at: p.started_at, commit: p.commit, theorems: p.rows.length })),
  };
}

async function main(): Promise<void> {
  const outIdx = process.argv.indexOf("--out");
  const out = outIdx >= 0 ? process.argv[outIdx + 1] : undefined;
  const files = process.argv.slice(2).filter((a, i, all) => a !== "--out" && all[i - 1] !== "--out");
  if (files.length < 1 || !out) {
    console.error("usage: npm run bench:merge -- <full.json> [rerun.json…] --out <merged.json>");
    process.exit(2);
  }
  const [base, ...patches] = await Promise.all(files.map(async (f) => JSON.parse(await fs.readFile(f, "utf8")) as Result));
  const merged = mergeResults(base, patches);
  await fs.writeFile(out, JSON.stringify(merged, null, 2));
  console.log(`merged ${patches.reduce((a, p) => a + p.rows.length, 0)} re-run theorem(s): pass ${merged.pass}/${merged.total} → ${out}`);
}

if (process.argv[1] && /bench-merge\.(ts|js|mts|mjs)$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
