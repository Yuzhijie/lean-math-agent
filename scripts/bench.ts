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
import path from "node:path";
import { checkLeanAvailable, verifyLeanSource } from "../lib/lean/sandbox";
import { shutdownReplPool } from "../lib/lean/repl";
import { withUsageScope, type RunMetrics } from "../lib/llm/usage-tracker";
import { proveWholeTheorem, type WholeProofResult } from "../lib/prover/whole-proof";
import { proveBySketch, type SketchResult } from "../lib/prover/sketch";
import { budgetPreset, parseBudget } from "../lib/prover/budget";
import { buildProverContext, rememberVerifiedProof } from "../lib/prover/context";
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
type Stage = "hammer" | "whole_proof" | "sketch" | "stepwise" | "none";

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
  if (!/error:/i.test(text)) text = `error: ${text}`;
  const classified = classifyLeanErrors(text);
  const first = classified[0];
  const detail = (input.summary ?? text).split("\n")[0].slice(0, 160);
  if (!first) return { kind: /timeout|timed out|deterministic/i.test(text) ? "timeout" : "other", detail };
  return { kind: first.kind as FailureKind, detail };
}

function wholeProofFailure(r: WholeProofResult): { kind: FailureKind; detail: string } {
  if (r.unavailable) return { kind: "lean_unavailable", detail: r.log.split("\n")[0] ?? "" };
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
  const all = Array.isArray(parsed) ? parsed : parsed.theorems;
  const opens = Array.isArray(parsed) ? undefined : parsed.opens;
  const only = arg("only")?.split(",").map((s) => s.trim()).filter(Boolean);
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
      (opens?.length ? ` opens=${opens.join(" ")}` : ""),
  );

  const rows: BenchRow[] = [];
  for (const t of theorems) {
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
          return { ...base, ok: false, proved_by: "none", failure: { kind: "statement_error", detail: preflight.log.split("\n")[0].slice(0, 160) }, ...fromMetrics(metrics(), started) };
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
              void rememberVerifiedProof({ theoremName: t.name, theoremType: t.type, tactics: hit.tactic, strategy: "hammer", problemText: t.informal });
              return { ...base, ok: true, proved_by: "hammer", tactics: hit.tactic, ...fromMetrics(metrics(), started) };
            }
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
            void rememberVerifiedProof({ theoremName: t.name, theoremType: t.type, tactics: r.tactics ?? "", strategy: "whole_proof", problemText: t.informal });
            return { ...base, ok: true, proved_by: "whole_proof", rounds: r.rounds, samples: r.samples, tactics: r.tactics, ...fromMetrics(metrics(), started) };
          }
          failure = wholeProofFailure(r);
          if (r.unavailable) return { ...base, ok: false, proved_by: "none", rounds: r.rounds, samples: r.samples, failure, ...fromMetrics(metrics(), started) };
        }
        // 3. Sketch-and-fill.
        let holes: string | undefined;
        if (strategy === "cascade" || strategy === "sketch") {
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
          holes = `${r.holesSolved}/${r.holes}`;
          if (r.ok) {
            void rememberVerifiedProof({ theoremName: t.name, theoremType: t.type, tactics: r.tactics ?? "", strategy: "sketch", problemText: t.informal });
            return { ...base, ok: true, proved_by: "sketch", rounds: wholeRounds, samples: wholeSamples, holes, tactics: r.tactics, ...fromMetrics(metrics(), started) };
          }
          // The whole-proof verdict is the more informative one when both ran.
          failure ??= sketchFailure(r);
        }
        return { ...base, ok: false, proved_by: "none", rounds: wholeRounds, samples: wholeSamples, holes, failure: failure ?? { kind: "other", detail: "" }, ...fromMetrics(metrics(), started) };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ...base, ok: false, proved_by: "none", error: msg, failure: { kind: "llm_error", detail: msg.slice(0, 160) }, ...fromMetrics(metrics(), started) };
      }
    });
    rows.push(row);
    console.log(
      `${row.ok ? "PASS" : "FAIL"}  ${row.id.padEnd(28)} ${row.difficulty.padEnd(6)} ${row.proved_by.padEnd(11)} ` +
        `${(row.wall_ms / 1000).toFixed(1)}s  llm=${row.llm_calls} tok=${row.tokens}` +
        (row.cost !== undefined ? ` cost=${row.cost.toFixed(4)}` : "") +
        ` lean=${row.lean_verifications}` +
        (row.rounds !== undefined ? ` rounds=${row.rounds}` : "") +
        (row.holes ? ` holes=${row.holes}` : "") +
        (row.failure ? `  [${row.failure.kind}] ${row.failure.detail.slice(0, 70)}` : ""),
    );
  }

  const passed = rows.filter((r) => r.ok).length;
  const sum = (f: (r: BenchRow) => number) => rows.reduce((a, r) => a + f(r), 0);
  const byDifficulty = ["easy", "medium", "hard"]
    .map((d) => {
      const rs = rows.filter((r) => r.difficulty === d);
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
    `pass ${passed}/${rows.length} (${rows.length ? ((100 * passed) / rows.length).toFixed(0) : 0}%)  ` +
      `[${byDifficulty.join(", ")}]  wall ${(sum((r) => r.wall_ms) / 1000).toFixed(1)}s  ` +
      `llm calls ${sum((r) => r.llm_calls)}  tokens ${sum((r) => r.tokens)}` +
      (rows.some((r) => r.cost !== undefined) ? `  cost ${sum((r) => r.cost ?? 0).toFixed(4)}` : "") +
      `  lean verifications ${sum((r) => r.lean_verifications)}`,
  );
  if (passed) console.log(`proved by: ${histogram(rows.filter((r) => r.ok).map((r) => r.proved_by))}`);
  if (passed < rows.length) console.log(`failures:  ${histogram(rows.filter((r) => !r.ok).map((r) => r.failure?.kind ?? "other"))}`);

  const out = arg("json") ?? path.resolve("bench/results", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(
    out,
    JSON.stringify(
      {
        started_at: new Date().toISOString(),
        file: path.basename(file),
        strategy,
        budget,
        samples,
        rounds,
        pass: passed,
        total: rows.length,
        proved_by: Object.fromEntries(rows.filter((r) => r.ok).map((r) => r.proved_by).reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>())),
        failures: Object.fromEntries(rows.filter((r) => !r.ok).map((r) => r.failure?.kind ?? "other").reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>())),
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
