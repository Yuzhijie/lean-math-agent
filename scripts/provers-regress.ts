/**
 * `npm run lean:regress [--only geometry,optimize/oddtown] [--ids a,b] [--quick] [--slow] [--limit n]
 *   [--resume file] [--accept] [--no-retry] [--list] [--file bench/provers.json] [--out bench/PROVERS.md] [--no-report]`
 *
 * Regression of the provers the program drives (lib/pipeline/prover-regression.ts): every statement
 * of bench/provers.json through the no-model cascade (proveWithoutModel) on the real Lean sandbox.
 * One JSON line per case as it finishes → bench/results/provers-<time>.jsonl (git-ignored), then
 * bench/PROVERS.md. Spends nothing; the whole list takes about an hour and a half on one Lean
 * worker (`--quick` leaves out the cases that take minutes).
 *
 *   --accept   record, for every case this run proved, the route that proved it (and whether it
 *              is slow) in the fixture — after adding cases, or after a change that is meant to
 *              move a case to another route. A case that was not proved is never touched.
 *
 * A case that is not proved is run once more on a fresh Lean worker (`--no-retry` to skip): on a
 * machine short of memory a worker that has run for an hour fails where a new one does not.
 *
 * Exit code 1 when a case that used to be proved is not, or a must-not-prove statement is proved.
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
import { normalizeTheoremType } from "../lib/llm/autoformalize";
import { proveWithoutModel } from "../lib/pipeline/lean-attempt";
import { acceptRun, isRegression, parseFixture, parseRegressionRun, regressionReport, selectCases, serializeFixture, verdictOf, type CaseRow, type RegressionCase, type RegressionMeta, type RegressionRun } from "../lib/pipeline/prover-regression";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const list = (name: string) => arg(name)?.split(",").map((x) => x.trim()).filter(Boolean);
const secs = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`);

/** One case through the product's no-model cascade. */
export async function runCase(c: RegressionCase): Promise<CaseRow> {
  const started = Date.now();
  const base = { id: c.id, ...(c.expect ? { expect: c.expect } : {}) };
  try {
    const type = normalizeTheoremType(c.type);
    const r = await proveWithoutModel({ sessionId: `regress-${c.id}`, theoremName: c.name, theoremType: type, useMathlib: true, huge: !!hugePower(type) });
    return r.proof ? { ...base, strategy: r.proof.strategy, ms: Date.now() - started } : { ...base, ms: Date.now() - started, tried: r.tried.map((t) => t.replace(/\s+/g, " ").slice(0, 400)) };
  } catch (e) {
    return { ...base, ms: Date.now() - started, error: (e instanceof Error ? e.message : String(e)).slice(0, 400) };
  }
}

/** Every regression run in the results directory, oldest first. */
export function readRegressionRuns(dir: string): RegressionRun[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^provers-.*\.jsonl$/.test(f))
    .sort()
    .flatMap((f) => {
      const r = parseRegressionRun(path.join(dir, f), readFileSync(path.join(dir, f), "utf8"));
      return r ? [r] : [];
    });
}

/**
 * Lean and Mathlib as the sandbox has them: its toolchain file and manifest, else the repository's
 * own (next to the fixture's bench/ directory, when the sandbox is a bare Lean installation elsewhere).
 */
export function sandboxVersions(fixtureFile?: string): { lean?: string; mathlib?: string } {
  const roots = [process.env.LEAN_SANDBOX_PATH, "lean-sandbox", ...(fixtureFile ? [path.join(path.dirname(path.resolve(fixtureFile)), "..", "lean-sandbox")] : [])].filter((x): x is string => !!x);
  const read = (name: string) => {
    for (const r of roots) {
      try {
        return readFileSync(path.join(r, name), "utf8");
      } catch {
        // next root
      }
    }
    return undefined;
  };
  const lean = read("lean-toolchain")?.trim().replace(/^.*:/, "");
  let mathlib: string | undefined;
  try {
    const manifest = JSON.parse(read("lake-manifest.json") ?? "{}") as { packages?: { name?: string; inputRev?: string; rev?: string }[] };
    const m = manifest.packages?.find((p) => p.name === "mathlib");
    mathlib = m?.inputRev ?? m?.rev?.slice(0, 10);
  } catch {
    // no manifest
  }
  mathlib ??= /name\s*=\s*"mathlib"[\s\S]*?rev\s*=\s*"([^"]+)"/.exec(read("lakefile.toml") ?? "")?.[1];
  return { ...(lean ? { lean: `Lean ${lean.replace(/^v/, "")}` } : {}), ...(mathlib ? { mathlib: `Mathlib ${mathlib}` } : {}) };
}

/** The machine as a platform and a short hash of its name (no personal name in a committed report). */
function hostLabel(): string {
  return `${os.platform()}-${os.arch()}-${createHash("sha256").update(os.hostname()).digest("hex").slice(0, 6)}`;
}

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
  const cases = selectCases(fixture, { ids: list("ids"), only: list("only"), quick: flag("quick"), slow: flag("slow"), ...(arg("limit") ? { limit: Number(arg("limit")) } : {}) });
  if (flag("list")) {
    for (const c of cases) console.log(`${c.id.padEnd(40)} ${(c.expect ?? "—").padEnd(14)} ${c.slow ? "slow " : "     "}${c.for ?? ""}`);
    console.log(`${cases.length} case(s)`);
    return;
  }
  const dir = path.join("bench", "results");
  mkdirSync(dir, { recursive: true });
  const resume = arg("resume");
  const prior = resume && existsSync(resume) ? parseRegressionRun(resume, readFileSync(resume, "utf8")) : undefined;
  const out = prior?.file ?? path.join(dir, `provers-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}.jsonl`);
  let commit: string | undefined;
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    // not a repository
  }
  const done = new Map((prior?.rows ?? []).filter((r) => !r.error).map((r) => [r.id, r]));
  const todo = cases.filter((c) => !done.has(c.id));
  if (todo.length) {
    const lean = await checkLeanAvailable();
    if (!lean.ok) {
      console.error(`lean:regress needs Lean: ${lean.message}`);
      process.exit(2);
    }
  }
  if (!prior) {
    const meta: RegressionMeta = { type: "run", at: new Date().toISOString(), fixture: fixture.name, selected: cases.length, ...(commit ? { commit } : {}), ...sandboxVersions(file), host: hostLabel(), args: process.argv.slice(2) };
    writeFileSync(out, `${JSON.stringify(meta)}\n`);
  }
  console.log(`${cases.length} case(s)${done.size ? `, ${cases.length - todo.length} already in ${out}` : ""} → ${out}`);

  // start the Lean worker and load Mathlib before the first case is timed (a cold start takes from half a minute to minutes)
  if (todo.length) {
    const warm = Date.now();
    const ready = await verifyLeanSource("regress-warmup", assembleLeanSource({ theoremName: "regress_warmup", theoremType: ": (1 : ℕ) + 1 = 2", stepCodes: ["norm_num"], useMathlib: true }), { theoremName: "regress_warmup" });
    if (!ready.ok) {
      console.error(`lean:regress: Lean does not verify a trivial theorem — ${ready.log.slice(0, 300)}`);
      process.exit(2);
    }
    console.log(`Lean ready (${secs(Date.now() - warm)})`);
  }

  // a long run: keep a Mac awake while it lasts
  const awake = process.platform === "darwin" ? spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" }) : undefined;
  awake?.on("error", () => undefined);

  const started = Date.now();
  const rows: CaseRow[] = [...done.values()];
  for (const [k, c] of todo.entries()) {
    let row = await runCase(c);
    // not proved: once more on a fresh Lean worker — one that has run for an hour may be out of memory, and
    // a failure that goes away with a new worker is not the prover's
    if (!row.strategy && c.expect !== "none" && !flag("no-retry")) {
      await shutdownReplPool();
      const again = await runCase(c);
      row = again.strategy ? { ...again, retried: true } : { ...row, ms: row.ms + again.ms, retried: true };
    }
    rows.push(row);
    appendFileSync(out, `${JSON.stringify(row)}\n`);
    const v = verdictOf(row);
    console.log(`${String(k + 1).padStart(3)}/${todo.length} ${v === "ok" || v === "gained" ? "✓" : v === "other_route" ? "~" : "✗"} ${c.id.padEnd(38)} ${(row.strategy ?? "—").padEnd(14)} ${secs(row.ms).padStart(6)}${v === "ok" ? "" : `  ${v}${row.expect && row.strategy !== row.expect ? ` (expected ${row.expect})` : ""}${row.error ? `: ${row.error.slice(0, 120)}` : ""}`}`);
  }
  appendFileSync(out, `${JSON.stringify({ type: "end", at: new Date().toISOString(), wall_ms: Date.now() - started })}\n`);
  awake?.kill();
  await shutdownReplPool();

  const bad = rows.filter((r) => isRegression(verdictOf(r)));
  const moved = rows.filter((r) => verdictOf(r) === "other_route");
  const of = (v: ReturnType<typeof verdictOf>) => rows.filter((r) => verdictOf(r) === v).length;
  console.log(`\n${of("ok")} ok, ${moved.length} by another route, ${bad.length} regression(s)${of("gained") ? `, ${of("gained")} proved without a recorded route` : ""}${of("open") ? `, ${of("open")} still open` : ""} · ${secs(Date.now() - started)}`);
  for (const r of bad) console.log(`  ✗ ${r.id}: ${verdictOf(r)}${r.error ? ` — ${r.error.slice(0, 160)}` : ""}`);

  let current = fixture;
  if (flag("accept")) {
    const accepted = acceptRun(fixture, rows);
    current = accepted.fixture;
    writeFileSync(file, serializeFixture(current));
    console.log(`--accept: ${accepted.changed.length} case(s) updated in ${file}${accepted.changed.length ? ` (${accepted.changed.slice(0, 12).join(", ")}${accepted.changed.length > 12 ? ", …" : ""})` : ""}`);
  }
  if (!flag("no-report")) {
    const report = arg("out") ?? path.join("bench", "PROVERS.md");
    writeFileSync(report, regressionReport(current, readRegressionRuns(dir), { now: new Date() }));
    console.log(`Report: ${report}`);
  }
  process.exit(bad.length && !flag("accept") ? 1 : 0);
}

if (process.argv[1] && /provers-regress\.(ts|js|mts|mjs|cjs)$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
