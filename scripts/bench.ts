/**
 * Prover benchmark: runs the prover cascade (hammer → whole-proof →
 * sketch-and-fill), a single stage, or the stepwise pipeline over a set of
 * Lean statements and reports pass rate, which stage proved what, wall
 * time, LLM calls/tokens/cost, Lean verifications and a failure taxonomy.
 *
 *   npm run bench -- [--file bench/theorems.json] [--strategy cascade|whole_proof|sketch|stepwise]
 *                    [--budget low|normal|high] [--samples 4] [--rounds 2]
 *                    [--only id,id] [--difficulty easy|medium|hard] [--limit n] [--offset n]
 *                    [--json path] [--no-mathlib] [--no-retrieval]
 *                    [--concurrency n] [--max-cost usd] [--cost-cap usd] [--early-stop] [--memory readonly|write|off]
 *
 *   --concurrency n   theorems proved at once (default 1); LEAN_REPL_WORKERS defaults to n
 *   --max-cost usd    stop starting new theorems once the run has spent this much (estimated
 *                     from LLM_PRICES); the theorems not started are listed as skipped
 *   --only-failed f   only the theorems the result file f did not prove
 *   --no-retry        do not re-run theorems that failed for environment reasons (infra_error)
 *   --cost-cap usd    per-theorem cost cap (default PROOF_COST_CAP_USD): once a theorem has spent this,
 *                     no more model calls for it (failure "budget_exhausted")
 *   SKETCH_HARD_ONLY  in the cascade, sketch-and-fill runs on hard theorems only (default; "false" = all)
 *   --early-stop      give up after the first whole-proof round when no sample got past its first
 *                     tactic, and skip sketch-and-fill for it (PROOF_EARLY_STOP=true)
 *   --memory          proof memory: "readonly" (default) recalls stored proofs but does not add
 *                     the run's own, so results do not depend on order or earlier runs of the same
 *                     file; "write" also stores them (and repair pairs); "off" disables recall and
 *                     the memory replay stage (use it to compare with runs made before the memory
 *                     was filled — the result JSON records memory_size)
 *
 *   npm run bench:fetch && npm run bench -- --file bench/minif2f-test.json --limit 20
 *
 * Needs a configured LLM (LLM_API_KEY / LLM_PROVER_* in .env.local) and a
 * built Lean sandbox with Mathlib (LEAN_SANDBOX_PATH). Statements are given
 * directly in Lean, so autoformalization is not part of the measurement.
 * A bench file is either an array of theorems or `{ opens, theorems }`
 * (as written by `npm run bench:fetch`).
 */
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { checkLeanAvailable, verifyLeanSource } from "../lib/lean/sandbox";
import { fixStatement } from "./fetch-benchmark";
import { shutdownReplPool } from "../lib/lean/repl";
import { costCapReached, proofCostCapUsd, withUsageScope, type RunMetrics } from "../lib/llm/usage-tracker";
import { proveWholeTheorem, type WholeProofResult } from "../lib/prover/whole-proof";
import { proveBySketch, type SketchResult } from "../lib/prover/sketch";
import { budgetPreset, parseBudget } from "../lib/prover/budget";
import { buildProverContext, rememberVerifiedProof } from "../lib/prover/context";
import { proofMemorySize, recallProofs, rememberRepair } from "../lib/lean/proof-memory";
import { replayRecalled } from "../lib/prover/replay";
import { hammerTheorem } from "../lib/lean/hammer";
import { classifyLeanErrors } from "../lib/lean/parse-log";
import { enumerateMethods } from "../lib/llm/enumerate";
import { planSteps } from "../lib/llm/plan";
import { proofSearch } from "../lib/search/proof-search";
import { assembleLeanSource } from "../lib/lean/assemble";
import type { ProofStep, Session } from "../lib/types";

interface BenchTheorem {
  id: string;
  difficulty?: "easy" | "medium" | "hard";
  name: string;
  type: string;
  /** Informal statement (miniF2F), given to the prover as the problem text. */
  informal?: string;
}

interface BenchFile {
  opens?: string[];
  theorems: BenchTheorem[];
}

type Strategy = "cascade" | "whole_proof" | "sketch" | "stepwise";
type Stage = "hammer" | "memory" | "whole_proof" | "sketch" | "stepwise" | "none";

/** Why a theorem was not proved — one bucket per theorem, coarsest signal first. */
export type FailureKind =
  | "statement_error"
  | "lean_unavailable"
  | "llm_error"
  | "no_candidate"
  | "unknown_identifier"
  | "type_mismatch"
  | "unsolved_goal"
  | "tactic_failed"
  | "missing_lemma"
  | "syntax_error"
  | "scope_error"
  | "timeout"
  | "sorry_left"
  | "axioms"
  | "statement_changed"
  | "budget_exhausted"
  /** The environment failed, not the prover: the model could not be reached or a Lean worker hung. Retried once. */
  | "infra_error"
  | "other";

interface BenchRow {
  id: string;
  difficulty: string;
  strategy: Strategy;
  ok: boolean;
  /** Stage that produced the accepted proof (cascade), or the stage run. */
  proved_by: Stage;
  rounds?: number;
  samples?: number;
  holes?: string;
  wall_ms: number;
  llm_calls: number;
  tokens: number;
  cost?: number;
  lean_verifications: number;
  lean_verify_ms: number;
  tactics?: string;
  failure?: { kind: FailureKind; detail: string };
  error?: string;
  /** Not run: the run's cost cap was reached first. */
  skipped?: boolean;
  /** Run a second time after an environment failure (the row is the second attempt). */
  retried?: boolean;
  /** Whole proof gave up after round 0 (--early-stop). */
  early_stop?: boolean;
  /** The theorem's cost cap stopped it (--cost-cap). */
  cost_capped?: boolean;
}

/** Run `fn` over `items` with at most `n` running at once; results keep the input order. */
export async function runPool<T, R>(items: T[], n: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}

function gitCommit(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function loadEnv(): void {
  for (const f of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(path.resolve(f));
    } catch {
      // absent — fine
    }
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

/** Map a Lean failure log to one failure bucket. */
export function classifyFailure(input: { log?: string; summary?: string; timedOut?: boolean; sorry?: boolean; axioms?: boolean; statementChanged?: boolean }): { kind: FailureKind; detail: string } {
  if (input.statementChanged) return { kind: "statement_changed", detail: "proved statement differs from the given one" };
  if (input.axioms) return { kind: "axioms", detail: "proof depends on disallowed axioms" };
  if (input.sorry) return { kind: "sorry_left", detail: "best candidate still contains sorry" };
  if (input.timedOut) return { kind: "budget_exhausted", detail: "time budget exhausted" };
  let text = input.log ?? input.summary ?? "";
  if (!text.trim()) return { kind: "other", detail: "" };
  // Candidate summaries are bare messages; the classifier keys on `error:` markers.
  if (!/(^|:\d+:\d+:\s*)error:/im.test(text)) text = `error: ${text}`;
  const classified = classifyLeanErrors(text);
  const first = classified[0];
  const detail = (input.summary ?? text).split("\n")[0].slice(0, 160);
  if (!first) return { kind: /timeout|timed out|deterministic/i.test(text) ? "timeout" : "other", detail };
  return { kind: first.kind as FailureKind, detail };
}

export function wholeProofFailure(r: WholeProofResult): { kind: FailureKind; detail: string } {
  if (r.unavailable) return { kind: "lean_unavailable", detail: r.log.split("\n")[0] ?? "" };
  // Our own cost cap, not the model being unreachable: never an infra_error (which would be retried).
  if (r.costCapped && !r.candidates.length) return { kind: "budget_exhausted", detail: "cost cap reached" };
  const samplingFailed = r.log.split("\n").find((l) => /sampling failed:/.test(l));
  if (r.candidates.length === 0 && samplingFailed) return { kind: "infra_error", detail: samplingFailed.replace(/^.*sampling failed:\s*/, "model call failed: ").slice(0, 160) };
  if (r.candidates.length === 0) return { kind: "no_candidate", detail: "no parseable proof was sampled" };
  const best = [...r.candidates].sort((a, b) => a.errors - b.errors)[0];
  const timedOut = /time budget/.test(r.log);
  if (best.errors === 0 && /sorry/i.test(best.summary)) return { kind: "sorry_left", detail: best.summary };
  return classifyFailure({ summary: best.summary, timedOut: timedOut && !best.summary });
}

function sketchFailure(r: SketchResult): { kind: FailureKind; detail: string } {
  if (r.unavailable) return { kind: "lean_unavailable", detail: "" };
  if (r.sketches === 0) return { kind: "no_candidate", detail: "no sketch elaborated" };
  const unsolved = r.log.split("\n").find((l) => /hole \d+ unsolved/.test(l));
  if (unsolved) return { kind: "unsolved_goal", detail: unsolved.trim().slice(0, 160) };
  return classifyFailure({ log: r.log, timedOut: /time budget/.test(r.log) });
}

async function main(): Promise<void> {
  loadEnv();
  const file = arg("file") ?? path.resolve("bench/theorems.json");
  const parsed = JSON.parse(await fs.readFile(file, "utf8")) as BenchTheorem[] | BenchFile;
  // Statements fetched before a repair was added are repaired on load (see fixStatement).
  const all = (Array.isArray(parsed) ? parsed : parsed.theorems).map((t) => ({ ...t, type: fixStatement(t.type) }));
  const opens = Array.isArray(parsed) ? undefined : parsed.opens;
  let only = arg("only")?.split(",").map((s) => s.trim()).filter(Boolean);
  // --only-failed <result.json>: the theorems that run did not prove (e.g. to try another prover on them).
  const onlyFailed = arg("only-failed");
  if (onlyFailed) {
    const prev = JSON.parse(await fs.readFile(onlyFailed, "utf8")) as { rows: { id: string; ok: boolean; skipped?: boolean }[] };
    only = prev.rows.filter((r) => !r.ok && !r.skipped).map((r) => r.id);
  }
  const difficulty = arg("difficulty");
  const limit = Number(arg("limit") ?? Infinity);
  const offset = Number(arg("offset") ?? 0);
  const theorems = all
    .filter((t) => (only ? only.includes(t.id) : true))
    .filter((t) => (difficulty ? t.difficulty === difficulty : true))
    .slice(offset, offset + limit);
  const strategy: Strategy = flag("stepwise") ? "stepwise" : ((arg("strategy") as Strategy | undefined) ?? "cascade");
  const samples = arg("samples") ? Number(arg("samples")) : undefined;
  const rounds = arg("rounds") ? Number(arg("rounds")) : undefined;
  const useMathlib = !flag("no-mathlib");
  const retrieval = !flag("no-retrieval");
  const budget = parseBudget(arg("budget")) ?? budgetPreset().budget;
  const { preset } = budgetPreset(budget);
  const concurrency = Math.max(1, Math.floor(Number(arg("concurrency") ?? 1)) || 1);
  const maxCost = arg("max-cost") !== undefined ? Number(arg("max-cost")) : undefined;
  const memory = (arg("memory") ?? "readonly") as "readonly" | "write" | "off";
  const costCap = arg("cost-cap") !== undefined ? Number(arg("cost-cap")) : proofCostCapUsd();
  if (costCap !== undefined && !(costCap > 0)) {
    console.error(`--cost-cap must be a positive number of dollars (got ${arg("cost-cap")})`);
    process.exit(2);
  }
  const earlyStop = flag("early-stop") || process.env.PROOF_EARLY_STOP === "true";
  if (earlyStop) process.env.PROOF_EARLY_STOP = "true";
  if (!["readonly", "write", "off"].includes(memory)) {
    console.error(`--memory must be readonly, write or off (got ${memory})`);
    process.exit(2);
  }
  if (memory === "off") process.env.PROOF_MEMORY_ENABLED = "false";
  const remember =
    memory === "write"
      ? (a: Parameters<typeof rememberVerifiedProof>[0]) => rememberVerifiedProof({ ...a, source: `bench:${path.basename(file)}`, opens })
      : async (_a: Parameters<typeof rememberVerifiedProof>[0]) => false;
  // One REPL worker per theorem in flight (the pool reads this when it is first used).
  if (concurrency > 1 && !process.env.LEAN_REPL_WORKERS) process.env.LEAN_REPL_WORKERS = String(Math.min(concurrency, 8));

  const lean = await checkLeanAvailable();
  if (!lean.ok) {
    console.error(`Lean unavailable: ${lean.message}`);
    process.exit(2);
  }
  if (!process.env.LLM_API_KEY && !process.env.LLM_PROVER_API_KEY) {
    console.error("LLM_API_KEY (or LLM_PROVER_API_KEY) is not set");
    process.exit(2);
  }

  console.log(
    `bench: ${theorems.length} theorems from ${path.basename(file)}, strategy=${strategy} budget=${budget}` +
      (samples ? ` samples=${samples}` : "") +
      (rounds !== undefined ? ` rounds=${rounds}` : "") +
      (opens?.length ? ` opens=${opens.join(" ")}` : "") +
      (concurrency > 1 ? ` concurrency=${concurrency} repl_workers=${process.env.LEAN_REPL_WORKERS}` : "") +
      (maxCost !== undefined ? ` max_cost=$${maxCost}` : "") +
      (costCap !== undefined ? ` cost_cap=$${costCap}/theorem` : "") +
      (earlyStop ? " early_stop" : "") +
      (retrieval ? "" : " no_retrieval") +
      ` memory=${memory}`,
  );

  const runStarted = Date.now();
  let spent = 0;
  let capped = false;
  const runTheorem = async (t: BenchTheorem): Promise<BenchRow> => {
    if (maxCost !== undefined && spent >= maxCost) {
      capped = true;
      return { id: t.id, difficulty: t.difficulty ?? "?", strategy, ok: false, proved_by: "none", skipped: true, wall_ms: 0, llm_calls: 0, tokens: 0, lean_verifications: 0, lean_verify_ms: 0 };
    }
    const started = Date.now();
    const row = await withUsageScope(async (metrics): Promise<BenchRow> => {
      const base = { id: t.id, difficulty: t.difficulty ?? "?", strategy };
      try {
        // The statement must elaborate before anything is measured.
        const preflightSource = assembleLeanSource({ theoremName: t.name, theoremType: t.type, stepCodes: ["sorry"], useMathlib, opens });
        const preflight = await verifyLeanSource(`bench-${t.id}`, preflightSource, { allowSorry: true, theoremName: t.name, checkAxioms: false, wantSignature: true });
        if (preflight.status === "unavailable") {
          return { ...base, ok: false, proved_by: "none", failure: { kind: "lean_unavailable", detail: preflight.log.slice(0, 160) }, ...fromMetrics(metrics(), started) };
        }
        if (!preflight.ok) {
          const detail = preflight.log.split("\n")[0].slice(0, 160);
          // A worker that timed out on a `sorry` statement hung; the statement itself was not judged.
          const kind: FailureKind = /timed out|was killed/i.test(preflight.log) ? "infra_error" : "statement_error";
          return { ...base, ok: false, proved_by: "none", failure: { kind, detail }, ...fromMetrics(metrics(), started) };
        }
        const initialGoal = preflight.goals?.[0];
        const expectedSignature = preflight.signature;
        const premises = retrieval
          ? (await buildProverContext({ theoremType: t.type, initialGoal, problemText: t.informal, useMathlib })).block || undefined
          : undefined;

        if (strategy === "stepwise") {
          const r = await runStepwise(t, useMathlib, opens, initialGoal);
          return { ...base, ok: r.ok, proved_by: r.ok ? "stepwise" : "none", samples: r.attempts, tactics: r.tactics, failure: r.ok ? undefined : r.failure, ...fromMetrics(metrics(), started) };
        }

        let failure: BenchRow["failure"];
        // 1. Hammer (cascade only).
        if (strategy === "cascade") {
          const hit = await hammerTheorem(preflightSource, { useMathlib });
          if (hit) {
            const proof = assembleLeanSource({ theoremName: t.name, theoremType: t.type, stepCodes: [hit.tactic], useMathlib, opens });
            const v = await verifyLeanSource(`bench-${t.id}`, proof, { theoremName: t.name, expectedSignature });
            if (v.ok) {
              void remember({ theoremName: t.name, theoremType: t.type, tactics: hit.tactic, strategy: "hammer", problemText: t.informal });
              return { ...base, ok: true, proved_by: "hammer", tactics: hit.tactic, ...fromMetrics(metrics(), started) };
            }
          }
        }
        // 1b. Memory replay (cascade only): a remembered proof of a similar theorem, verbatim.
        if (strategy === "cascade" && memory !== "off") {
          const recalled = await recallProofs({ theoremType: t.type, problemText: t.informal, excludeType: t.type, k: 3 }).catch(() => []);
          const replay = recalled.length
            ? await replayRecalled({ sessionId: `bench-${t.id}`, theoremName: t.name, theoremType: t.type, recalled, expectedSignature, useMathlib, opens })
            : undefined;
          if (replay) {
            void remember({ theoremName: t.name, theoremType: t.type, tactics: replay.tactics, strategy: "memory", problemText: t.informal });
            return { ...base, ok: true, proved_by: "memory", tactics: replay.tactics, ...fromMetrics(metrics(), started) };
          }
        }
        // 2. Whole proof.
        let wholeRounds: number | undefined;
        let wholeSamples: number | undefined;
        if (strategy === "cascade" || strategy === "whole_proof") {
          const r = await proveWholeTheorem({
            sessionId: `bench-${t.id}`,
            theoremName: t.name,
            theoremType: t.type,
            expectedSignature,
            problemText: t.informal,
            initialGoal,
            premises,
            opens,
            config: { ...preset.wholeProof, useMathlib, ...(samples !== undefined ? { samples } : {}), ...(rounds !== undefined ? { rounds } : {}) },
          });
          wholeRounds = r.rounds;
          wholeSamples = r.samples;
          if (r.ok) {
            void remember({ theoremName: t.name, theoremType: t.type, tactics: r.tactics ?? "", strategy: "whole_proof", problemText: t.informal });
            if (memory === "write" && r.repairedFrom)
              void rememberRepair({ theorem_name: t.name, theorem_type: t.type, failed_tactics: r.repairedFrom.tactics, feedback: r.repairedFrom.feedback, fixed_tactics: r.tactics ?? "", source: `bench:${path.basename(file)}` });
            return { ...base, ok: true, proved_by: "whole_proof", rounds: r.rounds, samples: r.samples, tactics: r.tactics, ...fromMetrics(metrics(), started) };
          }
          failure = wholeProofFailure(r);
            if (r.unavailable) return { ...base, ok: false, proved_by: "none", rounds: r.rounds, samples: r.samples, failure, ...fromMetrics(metrics(), started) };
          // Early stop / cost cap: the later stages are skipped too.
          if (r.gaveUpEarly || r.costCapped || costCapReached())
            return { ...base, ok: false, proved_by: "none", rounds: r.rounds, samples: r.samples, failure, ...(r.gaveUpEarly ? { early_stop: true } : {}), ...(r.costCapped || costCapReached() ? { cost_capped: true } : {}), ...fromMetrics(metrics(), started) };
        }
        // 3. Sketch-and-fill.
        let holes: string | undefined;
        // In the cascade, sketch-and-fill runs on hard theorems only (SKETCH_HARD_ONLY=false: on all of them):
        // on easy and medium ones it proved nothing in three baseline runs.
        const sketchHere = process.env.SKETCH_HARD_ONLY === "false" || !t.difficulty || t.difficulty === "hard";
        if (strategy === "sketch" || (strategy === "cascade" && sketchHere && (preset.sketchStage || process.env.SKETCH_ENABLED === "true"))) {
          const r = await proveBySketch({
            sessionId: `bench-${t.id}`,
            theoremName: t.name,
            theoremType: t.type,
            expectedSignature,
            problemText: t.informal,
            initialGoal,
            premises,
            opens,
            config: { ...preset.sketch, useMathlib, goalSearch: { ...preset.goalSearch, useMathlib } },
          });
          holes = `${r.holesSolved}/${r.holes}${r.holesByProver ? ` (${r.holesByProver} by the prover)` : ""}`;
          if (r.ok) {
            void remember({ theoremName: t.name, theoremType: t.type, tactics: r.tactics ?? "", strategy: "sketch", problemText: t.informal });
            return { ...base, ok: true, proved_by: "sketch", rounds: wholeRounds, samples: wholeSamples, holes, tactics: r.tactics, ...fromMetrics(metrics(), started) };
          }
          // The whole-proof verdict is the more informative one when both ran.
          failure ??= sketchFailure(r);
        }
        return { ...base, ok: false, proved_by: "none", rounds: wholeRounds, samples: wholeSamples, holes, failure: failure ?? { kind: "other", detail: "" }, ...fromMetrics(metrics(), started) };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (costCapReached()) return { ...base, ok: false, proved_by: "none", cost_capped: true, failure: { kind: "budget_exhausted", detail: "cost cap reached" }, ...fromMetrics(metrics(), started) };
        return { ...base, ok: false, proved_by: "none", error: msg, failure: { kind: "llm_error", detail: msg.slice(0, 160) }, ...fromMetrics(metrics(), started) };
      }
    }, { costCapUsd: costCap });
    spent += row.cost ?? 0;
    console.log(
      `${row.ok ? "PASS" : "FAIL"}  ${row.id.padEnd(28)} ${row.difficulty.padEnd(6)} ${row.proved_by.padEnd(11)} ` +
        `${(row.wall_ms / 1000).toFixed(1)}s  llm=${row.llm_calls} tok=${row.tokens}` +
        (row.cost !== undefined ? ` cost=${row.cost.toFixed(4)}` : "") +
        ` lean=${row.lean_verifications}` +
        (row.rounds !== undefined ? ` rounds=${row.rounds}` : "") +
        (row.holes ? ` holes=${row.holes}` : "") +
        (row.early_stop ? " early-stop" : "") +
        (row.cost_capped ? " capped" : "") +
        (row.failure ? `  [${row.failure.kind}] ${row.failure.detail.slice(0, 70)}` : ""),
    );
    return row;
  };
  const rows = await runPool(theorems, concurrency, runTheorem);
  // Theorems lost to the environment (model unreachable, a hung Lean worker — e.g. the machine slept)
  // are run once more at the end, so one outage does not count as prover failures.
  const infra = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.failure?.kind === "infra_error");
  if (infra.length && !flag("no-retry")) {
    console.log(`\nretrying ${infra.length} theorem(s) that failed for environment reasons`);
    const again = await runPool(infra.map(({ i }) => theorems[i]), concurrency, runTheorem);
    infra.forEach(({ i }, k) => (rows[i] = { ...again[k], retried: true }));
  }

  const skipped = rows.filter((r) => r.skipped);
  if (capped) console.log(`\ncost cap $${maxCost} reached: ${skipped.length} theorem(s) not started`);
  const ran = rows.filter((r) => !r.skipped);
  const passed = rows.filter((r) => r.ok).length;
  const sum = (f: (r: BenchRow) => number) => rows.reduce((a, r) => a + f(r), 0);
  const byDifficulty = ["easy", "medium", "hard"]
    .map((d) => {
      const rs = ran.filter((r) => r.difficulty === d);
      return rs.length ? `${d} ${rs.filter((r) => r.ok).length}/${rs.length}` : undefined;
    })
    .filter(Boolean);
  const histogram = (items: string[]) =>
    [...items.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>())]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ${n}`)
      .join(", ");
  console.log("\n" + "─".repeat(72));
  console.log(
    `pass ${passed}/${ran.length} (${ran.length ? ((100 * passed) / ran.length).toFixed(0) : 0}%)  ` +
      `[${byDifficulty.join(", ")}]  elapsed ${((Date.now() - runStarted) / 1000).toFixed(1)}s (sum of theorem times ${(sum((r) => r.wall_ms) / 1000).toFixed(1)}s)  ` +
      `llm calls ${sum((r) => r.llm_calls)}  tokens ${sum((r) => r.tokens)}` +
      (rows.some((r) => r.cost !== undefined) ? `  cost ${sum((r) => r.cost ?? 0).toFixed(4)}` : "") +
      `  lean verifications ${sum((r) => r.lean_verifications)}`,
  );
  if (passed) console.log(`proved by: ${histogram(rows.filter((r) => r.ok).map((r) => r.proved_by))}`);
  if (passed < ran.length) console.log(`failures:  ${histogram(ran.filter((r) => !r.ok).map((r) => r.failure?.kind ?? "other"))}`);

  const out = arg("json") ?? path.resolve("bench/results", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(
    out,
    JSON.stringify(
      {
        started_at: new Date(runStarted).toISOString(),
        elapsed_ms: Date.now() - runStarted,
        file: path.basename(file),
        strategy,
        budget,
        samples,
        rounds,
        concurrency,
        repl_workers: Number(process.env.LEAN_REPL_WORKERS ?? 1),
        memory,
        memory_size: memory === "off" ? 0 : await proofMemorySize().catch(() => 0),
        retrieval,
        max_cost: maxCost,
        ...(costCap !== undefined ? { theorem_cost_cap: costCap } : {}),
        ...(earlyStop ? { early_stop: true } : {}),
        commit: gitCommit(),
        model: process.env.LLM_MODEL,
        prover_model: process.env.LLM_PROVER_MODEL,
        pass: passed,
        total: ran.length,
        skipped: skipped.map((r) => r.id),
        proved_by: Object.fromEntries(rows.filter((r) => r.ok).map((r) => r.proved_by).reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>())),
        failures: Object.fromEntries(ran.filter((r) => !r.ok).map((r) => r.failure?.kind ?? "other").reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>())),
        rows,
      },
      null,
      2,
    ),
  );
  console.log(`results → ${out}`);

  shutdownReplPool();
}

function fromMetrics(m: RunMetrics, started: number) {
  return {
    wall_ms: Date.now() - started,
    llm_calls: m.llm_calls,
    tokens: m.prompt_tokens + m.completion_tokens,
    cost: m.estimated_cost,
    lean_verifications: m.lean_verifications,
    lean_verify_ms: m.lean_verify_ms,
  };
}

/** The stepwise pipeline on a Lean statement: enumerate → plan → search → final verify. */
async function runStepwise(
  t: BenchTheorem,
  useMathlib: boolean,
  opens: string[] | undefined,
  initialGoal: string | undefined,
): Promise<{ ok: boolean; attempts: number; tactics?: string; failure?: BenchRow["failure"] }> {
  const problemText = t.informal ?? `Prove in Lean 4: theorem ${t.name} ${t.type}`;
  const enumResult = await enumerateMethods(problemText);
  const method = enumResult.methods.reduce((b, c) => (c.confidence > b.confidence ? c : b));
  const plan = await planSteps(problemText, method, useMathlib);
  const steps: ProofStep[] = plan.steps.map((s: { index: number; plain_goal: string; lean_goal: string }) => ({
    ...s,
    plain_explanation: "",
    lean_code: "",
    status: "pending" as const,
  }));
  const session = {
    id: `bench-step-${t.id}`,
    problem_text: problemText,
    theorem_name: t.name,
    theorem_type: t.type,
    steps,
  } as unknown as Session;
  const result = await proofSearch({ session, method, theoremType: t.type, config: { useMathlib }, initialGoal });
  const codes = result.steps.map((s) => s.lean_code).filter(Boolean);
  const final = await verifyLeanSource(session.id, assembleLeanSource({ theoremName: t.name, theoremType: t.type, stepCodes: codes, useMathlib, opens }), { theoremName: t.name });
  const ok = final.ok && result.fullyVerified;
  return {
    ok,
    attempts: result.totalAttempts,
    tactics: codes.join("\n"),
    failure: ok ? undefined : classifyFailure({ log: final.log, sorry: !result.fullyVerified, axioms: (final.axioms?.disallowed.length ?? 0) > 0 }),
  };
}

if (process.argv[1] && /bench\.(ts|js|mts|mjs)$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
