/**
 * `npm run formalize:audit [--out bench/FORMALIZATION-AUDIT.md] [--labels bench/formalization-labels.json]
 *   [--results bench/results] [--set bench/heldout.json] [--no-sessions]`
 *
 * Is the Lean statement the problem? (lib/formalize-audit.ts) The statements of the stored
 * sessions, of the end-to-end runs (dev problems only) and of the latest `bench:formalize` run,
 * joined with the reading verdicts in the labels file → the report, with every statement nobody
 * has read yet listed at the end. No model, no Lean: reading is done by a person (or by Claude),
 * who then adds the verdicts to the labels file.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadHeldout } from "../lib/e2e/heldout";
import type { RunFile } from "../lib/e2e/outcome";
import { auditReport, auditSummary, heldoutItems, minif2fItems, readLabelFile, sessionItems, type AuditInput, type FormalizeResultRow, type Label } from "../lib/formalize-audit";
import { listSessionsFromDisk } from "../lib/session-store";
import { readRuns } from "./e2e-eval";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const flat = (t: string) => t.replace(/\s+/g, " ").trim();

async function main(): Promise<void> {
  for (const f of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(path.resolve(f));
    } catch {
      // optional
    }
  }
  const labelsFile = arg("labels") ?? path.join("bench", "formalization-labels.json");
  const { labels, readBy }: { labels: Map<string, Label>; readBy?: string } = existsSync(labelsFile) ? readLabelFile(readFileSync(labelsFile, "utf8")) : { labels: new Map() };
  const results = arg("results") ?? path.join("bench", "results");

  // the held-out set: its dev statements are read, and none of its problems is listed from the sessions
  const setFile = arg("set") ?? path.join("bench", "heldout.json");
  const set = existsSync(setFile) ? loadHeldout(setFile) : undefined;
  const heldoutTexts = new Set((set?.problems ?? []).map((p) => flat(p.text)));
  const runs: RunFile[] = readRuns(results).filter((r) => !set || r.meta.set_hash === set.hash);
  const heldout = runs.length ? heldoutItems(runs, new Map((set?.problems ?? []).filter((p) => p.split === "dev").map((p) => [p.id, { text: p.text, answer: p.answer }]))) : undefined;

  const sessions = flag("no-sessions") ? [] : sessionItems(await listSessionsFromDisk(), heldoutTexts);

  // the latest bench:formalize result
  const formalizeFile = existsSync(results)
    ? readdirSync(results)
        .filter((f) => f.endsWith("-formalize.json"))
        .sort()
        .pop()
    : undefined;
  const formalize = formalizeFile ? (JSON.parse(readFileSync(path.join(results, formalizeFile), "utf8")) as { started_at?: string; file?: string; model?: string; rows: FormalizeResultRow[] }) : undefined;

  let commit: string | undefined;
  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    // not a repository
  }
  const lastRun = runs[runs.length - 1];
  const input: AuditInput = {
    sessions,
    ...(heldout ? { heldout } : {}),
    minif2f: formalize ? minif2fItems(formalize.rows) : [],
    labels,
    meta: {
      date: new Date().toISOString().slice(0, 10),
      ...(commit ? { commit } : {}),
      ...(readBy ? { readBy } : {}),
      ...(lastRun ? { e2e: `${runs.length} 次运行，最近一次 ${lastRun.meta.at.slice(0, 16).replace("T", " ")}（题集 ${lastRun.meta.set} \`${lastRun.meta.set_hash.slice(0, 6)}\`）` } : {}),
      ...(formalize ? { formalize: `${(formalize.started_at ?? "").slice(0, 10)}，${formalize.rows.length} 道题${formalize.file ? `（${formalize.file}）` : ""}${formalize.model ? `，模型 ${formalize.model}` : ""}` } : {}),
    },
  };
  const out = arg("out") ?? path.join("bench", "FORMALIZATION-AUDIT.md");
  writeFileSync(out, auditReport(input));
  const s = auditSummary(input);
  console.log(`${sessions.length} session problem(s), ${heldout?.items.length ?? 0} dev statement(s), ${input.minif2f.length} miniF2F statement(s); ${labels.size} label(s)`);
  console.log(`${s.unread} statement(s) not read yet${s.stale ? `; ${s.stale} label(s) without a statement in the data` : ""}`);
  console.log(`Report: ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
