/**
 * `npm run lean:variants [--only geometry,optimize/oddtown] [--ids a,b] [--kinds prime,flip] [--quick] [--all]
 *   [--per-group n] [--limit n] [--budget seconds] [--recycle n] [--resume file] [--note text] [--list] [--report-only]
 *   [--file bench/provers.json] [--out bench/VARIANTS.md] [--no-report]`
 *
 * Robustness of the provers to another way of writing a statement (lib/pipeline/prover-variants.ts):
 * every statement of bench/provers.json that a prover, a script or the search proves is rewritten
 * without changing its meaning, Lean confirms the rewrite (`A ↔ B` by `Iff.rfl`), and the variant
 * goes to the route that proves the original on the real sandbox. One JSON line per variant as it finishes
 * → bench/results/variants-<time>.jsonl (git-ignored), then bench/VARIANTS.md. Spends nothing;
 * about an hour for the quick statements on one Lean worker, hours with the slow ones.
 *
 *   --budget   seconds the other routes have on a variant the recorded route did not prove
 *              (default 120; 0 = do not try them: such a variant counts as lost)
 *   --recycle  a fresh Lean worker every n variants (a machine short of memory)
 *   --note     what this run is, for the report's table of runs ("before the change")
 *
 * The recorded route runs alone first (the measure of that prover; no time is spent on the stages
 * before it). When it fails for a reason of the machine (a Lean command timed out, the worker
 * died), it is run once more on a fresh worker.
 * Exit code 0 whatever the variants do: this measures, it does not gate (lean:regress gates).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { hugePower } from "../lib/compute/nat-expr";
import { assembleLeanSource } from "../lib/lean/assemble";
import { shutdownReplPool } from "../lib/lean/repl";
import { checkLeanAvailable, verifyLeanSource } from "../lib/lean/sandbox";
import { EQUIVALENCE_TACTIC, EQUIVALENCE_UNIVERSE, equivalenceType, VARIANT_KINDS, type VariantKind } from "../lib/lean/statement-variants";
import { runProverStages, triedTexts, type StageRun } from "../lib/lean/prover-stages";
import { parseFixture } from "../lib/pipeline/prover-regression";
import { parseVariantRun, sameRouteRate, selectVariants, variantReport, variantVerdict, type VariantCase, type VariantMeta, type VariantRow, type VariantRun } from "../lib/pipeline/prover-variants";
import { sandboxVersions } from "./provers-regress";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const list = (name: string) => arg(name)?.split(",").map((x) => x.trim()).filter(Boolean);
const secs = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`);
const short = (s: string) => s.replace(/\s+/g, " ").slice(0, 400);

/** Does Lean take the variant for the statement itself? (`A ↔ B` closed by reflexivity: the two elaborate to the same proposition.) */
export async function confirmEquivalent(v: VariantCase): Promise<boolean> {
  const type = equivalenceType(v.baseType, v.variant.type);
  if (!type) return false;
  const name = `${v.base.name}_same`;
  const declared = type.includes(EQUIVALENCE_UNIVERSE) ? `${name}.{${EQUIVALENCE_UNIVERSE}}` : name;
  const r = await verifyLeanSource(`variant-eq-${v.id}`, assembleLeanSource({ theoremName: declared, theoremType: type, stepCodes: [EQUIVALENCE_TACTIC], useMathlib: true }), { theoremName: name });
  return r.ok;
}

/** A failure of the machine, not of the prover: worth one more try on a fresh Lean worker. */
const environmental = (reason: string | undefined) => /timed out|was killed|exited|ECONNRESET|EPIPE|out of memory/i.test(reason ?? "");

/**
 * One variant: the equivalence; the route that proves the original, alone; when it does not prove
 * the variant, the other stages for `rescueMs` (0 = not tried).
 */
export async function runVariant(v: VariantCase, opts: { rescueMs?: number } = {}): Promise<VariantRow> {
  const started = Date.now();
  const base = { id: v.id, base: v.base.id, kind: v.variant.kind, expect: v.expect, note: v.variant.note };
  const type = v.variant.type;
  try {
    if (!(await confirmEquivalent(v))) return { ...base, equivalent: false, ms: Date.now() - started, type };
    const statement = { sessionId: `variant-${v.id}`, theoremName: v.base.name, theoremType: type, useMathlib: true, huge: !!hugePower(type) };
    const times = (runs: StageRun[]) => runs.map((x) => ({ id: x.id, ms: x.ms, outcome: x.outcome }));
    let own = await runProverStages(statement, { only: [v.expect] });
    let retried = false;
    if (!own.proof && environmental(own.runs[0]?.reason)) {
      await shutdownReplPool();
      own = await runProverStages(statement, { only: [v.expect] });
      retried = true;
    }
    // (a proof that had to go through the reading form inside the proof says so: `have reading : …`)
    if (own.proof) return { ...base, equivalent: true, strategy: v.expect, ms: Date.now() - started, stages: times(own.runs), ...(own.proof.tactics.startsWith("have reading :") ? { bridged: true } : {}), ...(retried ? { retried } : {}) };
    // the route did not prove it: keep the variant and what the route said (to reproduce, to fix), then the other routes
    // "" = the route did not take the statement (it does not see its kind of statement in the variant)
    const reason = own.runs.length ? short(own.runs[0].reason ?? "") || "no proof passed Lean" : "";
    const row: VariantRow = { ...base, equivalent: true, ms: 0, type, reason, ...(retried ? { retried } : {}) };
    if (!opts.rescueMs) return { ...row, ms: Date.now() - started, stages: times(own.runs) };
    const rest = await runProverStages(statement, { except: [v.expect], budgetMs: opts.rescueMs });
    return {
      ...row,
      ms: Date.now() - started,
      rescueMs: opts.rescueMs,
      stages: times([...own.runs, ...rest.runs]),
      ...(rest.proof ? { strategy: rest.proof.strategy } : { tried: triedTexts(statement, rest).map(short) }),
    };
  } catch (e) {
    return { ...base, equivalent: true, ms: Date.now() - started, type, error: short(e instanceof Error ? e.message : String(e)) };
  }
}

/** Every variant run in the results directory, oldest first. */
export function readVariantRuns(dir: string): VariantRun[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^variants-.*\.jsonl$/.test(f))
    .sort()
    .flatMap((f) => {
      const r = parseVariantRun(path.join(dir, f), readFileSync(path.join(dir, f), "utf8"));
      return r ? [r] : [];
    });
}

const hostLabel = () => `${os.platform()}-${os.arch()}-${createHash("sha256").update(os.hostname()).digest("hex").slice(0, 6)}`;

async function main(): Promise<void> {
  for (const f of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(path.resolve(f));
    } catch {
      // optional
    }
  }
  const file = arg("file") ?? path.join("bench", "provers.json");
  const fixture = parseFixture(readFileSync(file, "utf8"));
  const kinds = list("kinds")?.filter((k): k is VariantKind => (VARIANT_KINDS as readonly string[]).includes(k));
  const variants = selectVariants(fixture, {
    ids: list("ids"),
    only: list("only"),
    ...(kinds?.length ? { kinds } : {}),
    quick: flag("quick"),
    all: flag("all"),
    ...(arg("per-group") ? { perGroup: Number(arg("per-group")) } : {}),
    ...(arg("limit") ? { limit: Number(arg("limit")) } : {}),
  });
  if (flag("list")) {
    for (const v of variants) console.log(`${v.id.padEnd(46)} ${v.expect.padEnd(14)} ${v.base.slow ? "slow " : "     "}${v.variant.note}`);
    console.log(`${variants.length} variant(s) of ${new Set(variants.map((v) => v.base.id)).size} statement(s)`);
    return;
  }
  const dir = path.join("bench", "results");
  mkdirSync(dir, { recursive: true });
  if (flag("report-only")) {
    // the report from the runs there are (after moving run files, or to see it again)
    const report = arg("out") ?? path.join("bench", "VARIANTS.md");
    writeFileSync(report, variantReport(fixture, readVariantRuns(dir), { now: new Date() }));
    console.log(`Report: ${report}`);
    return;
  }
  const resume = arg("resume");
  const prior = resume && existsSync(resume) ? parseVariantRun(resume, readFileSync(resume, "utf8")) : undefined;
  const out = prior?.file ?? resume ?? path.join(dir, `variants-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}.jsonl`);
  let commit: string | undefined;
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    // not a repository
  }
  const done = new Map((prior?.rows ?? []).filter((r) => !r.error).map((r) => [r.id, r]));
  const todo = variants.filter((v) => !done.has(v.id));
  if (todo.length) {
    const lean = await checkLeanAvailable();
    if (!lean.ok) {
      console.error(`lean:variants needs Lean: ${lean.message}`);
      process.exit(2);
    }
  }
  if (!prior) {
    const meta: VariantMeta = { type: "run", at: new Date().toISOString(), fixture: fixture.name, selected: variants.length, ...(commit ? { commit } : {}), ...sandboxVersions(file), host: hostLabel(), args: process.argv.slice(2), reading: process.env.PROVER_READING_FORM !== "0", ...(arg("note") ? { note: arg("note") } : {}) };
    writeFileSync(out, `${JSON.stringify(meta)}\n`);
  }
  console.log(`${variants.length} variant(s) of ${new Set(variants.map((v) => v.base.id)).size} statement(s)${done.size ? `, ${variants.length - todo.length} already in ${out}` : ""} → ${out}`);

  const warmUp = async () => {
    const ready = await verifyLeanSource("variants-warmup", assembleLeanSource({ theoremName: "variants_warmup", theoremType: ": (1 : ℕ) + 1 = 2", stepCodes: ["norm_num"], useMathlib: true }), { theoremName: "variants_warmup" });
    return ready.ok ? undefined : ready.log.slice(0, 300);
  };
  if (todo.length) {
    const warm = Date.now();
    const failed = await warmUp();
    if (failed !== undefined) {
      console.error(`lean:variants: Lean does not verify a trivial theorem — ${failed}`);
      process.exit(2);
    }
    console.log(`Lean ready (${secs(Date.now() - warm)})`);
  }

  const awake = process.platform === "darwin" ? spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" }) : undefined;
  awake?.on("error", () => undefined);

  const rescueMs = Math.max(0, Number(arg("budget") ?? 120)) * 1000;
  const recycle = Number(arg("recycle") ?? 0);
  const started = Date.now();
  const rows: VariantRow[] = [...done.values()];
  for (const [k, v] of todo.entries()) {
    if (recycle > 0 && k > 0 && k % recycle === 0) {
      await shutdownReplPool();
      await warmUp();
    }
    const row = await runVariant(v, { rescueMs });
    rows.push(row);
    appendFileSync(out, `${JSON.stringify(row)}\n`);
    const verdict = variantVerdict(row);
    console.log(`${String(k + 1).padStart(3)}/${todo.length} ${verdict === "same" ? "✓" : verdict === "other" ? "~" : verdict === "unchecked" ? "?" : "✗"} ${v.id.padEnd(44)} ${(row.strategy ?? "—").padEnd(14)} ${secs(row.ms).padStart(6)}${verdict === "same" ? "" : `  ${verdict} (expected ${row.expect})${row.error ? `: ${row.error.slice(0, 120)}` : ""}`}`);
  }
  appendFileSync(out, `${JSON.stringify({ type: "end", at: new Date().toISOString(), wall_ms: Date.now() - started })}\n`);
  awake?.kill();
  await shutdownReplPool();

  const of = (x: ReturnType<typeof variantVerdict>) => rows.filter((r) => variantVerdict(r) === x).length;
  const rate = sameRouteRate(rows);
  console.log(`\n${rate.same}/${rate.run} by the same route, ${of("other")} by another route, ${of("lost")} lost${of("unchecked") ? `, ${of("unchecked")} not confirmed equivalent` : ""}${of("error") ? `, ${of("error")} error(s)` : ""} · ${secs(Date.now() - started)}`);
  for (const r of rows.filter((x) => variantVerdict(x) === "lost")) console.log(`  ✗ ${r.id}  (${r.note ?? ""})`);

  if (!flag("no-report")) {
    const report = arg("out") ?? path.join("bench", "VARIANTS.md");
    writeFileSync(report, variantReport(fixture, readVariantRuns(dir), { now: new Date() }));
    console.log(`Report: ${report}`);
  }
  process.exit(0);
}

if (process.argv[1] && /provers-variants\.(ts|js|mts|mjs|cjs)$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
