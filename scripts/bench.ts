/**
 * Prover benchmark: runs the whole-proof loop (and optionally the stepwise
 * pipeline) over `bench/theorems.json` and reports pass rate, wall time,
 * LLM calls/tokens/cost and Lean verifications per theorem.
 *
 *   npm run bench -- [--stepwise] [--samples 4] [--rounds 2] [--only id,id]
 *                    [--difficulty easy|medium|hard] [--limit n] [--json path]
 *                    [--no-mathlib]   (core-Lean sandbox, e.g. CI smoke runs)
 *
 * Needs a configured LLM (LLM_API_KEY / LLM_PROVER_* in .env.local) and a
 * built Lean sandbox with Mathlib (LEAN_SANDBOX_PATH). Statements are given
 * directly in Lean, so autoformalization is not part of the measurement.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { checkLeanAvailable, verifyLeanSource } from "../lib/lean/sandbox";
import { shutdownReplPool } from "../lib/lean/repl";
import { withUsageScope, type RunMetrics } from "../lib/llm/usage-tracker";
import { proveWholeTheorem } from "../lib/prover/whole-proof";
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
}

interface BenchRow {
  id: string;
  difficulty: string;
  strategy: "whole_proof" | "stepwise";
  ok: boolean;
  rounds?: number;
  samples?: number;
  wall_ms: number;
  llm_calls: number;
  tokens: number;
  cost?: number;
  lean_verifications: number;
  lean_verify_ms: number;
  tactics?: string;
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

async function main(): Promise<void> {
  loadEnv();
  const file = arg("file") ?? path.resolve("bench/theorems.json");
  const all = JSON.parse(await fs.readFile(file, "utf8")) as BenchTheorem[];
  const only = arg("only")?.split(",").map((s) => s.trim()).filter(Boolean);
  const difficulty = arg("difficulty");
  const limit = Number(arg("limit") ?? Infinity);
  const theorems = all
    .filter((t) => (only ? only.includes(t.id) : true))
    .filter((t) => (difficulty ? t.difficulty === difficulty : true))
    .slice(0, limit);
  const stepwise = flag("stepwise");
  const samples = arg("samples") ? Number(arg("samples")) : undefined;
  const rounds = arg("rounds") ? Number(arg("rounds")) : undefined;
  const useMathlib = !flag("no-mathlib");

  const lean = await checkLeanAvailable();
  if (!lean.ok) {
    console.error(`Lean unavailable: ${lean.message}`);
    process.exit(2);
  }
  if (!process.env.LLM_API_KEY && !process.env.LLM_PROVER_API_KEY) {
    console.error("LLM_API_KEY (or LLM_PROVER_API_KEY) is not set");
    process.exit(2);
  }

  console.log(`bench: ${theorems.length} theorems, strategy=${stepwise ? "stepwise" : "whole_proof"}` +
    (samples ? ` samples=${samples}` : "") + (rounds !== undefined ? ` rounds=${rounds}` : ""));

  const rows: BenchRow[] = [];
  for (const t of theorems) {
    const started = Date.now();
    const row = await withUsageScope(async (metrics): Promise<BenchRow> => {
      const base = { id: t.id, difficulty: t.difficulty ?? "?", strategy: stepwise ? "stepwise" as const : "whole_proof" as const };
      try {
        if (!stepwise) {
          const r = await proveWholeTheorem({
            sessionId: `bench-${t.id}`,
            theoremName: t.name,
            theoremType: t.type,
            config: { samples, rounds, useMathlib },
          });
          return { ...base, ok: r.ok, rounds: r.rounds, samples: r.samples, tactics: r.tactics, ...fromMetrics(metrics(), started) };
        }
        const r = await runStepwise(t, useMathlib);
        return { ...base, ok: r.ok, samples: r.attempts, tactics: r.tactics, ...fromMetrics(metrics(), started) };
      } catch (e) {
        return { ...base, ok: false, error: e instanceof Error ? e.message : String(e), ...fromMetrics(metrics(), started) };
      }
    });
    rows.push(row);
    console.log(
      `${row.ok ? "PASS" : "FAIL"}  ${row.id.padEnd(18)} ${row.difficulty.padEnd(6)} ` +
        `${(row.wall_ms / 1000).toFixed(1)}s  llm=${row.llm_calls} tok=${row.tokens}` +
        (row.cost !== undefined ? ` cost=${row.cost.toFixed(4)}` : "") +
        ` lean=${row.lean_verifications}` +
        (row.rounds !== undefined ? ` rounds=${row.rounds}` : "") +
        (row.error ? `  ${row.error.slice(0, 80)}` : ""),
    );
  }

  const passed = rows.filter((r) => r.ok).length;
  const sum = (f: (r: BenchRow) => number) => rows.reduce((a, r) => a + f(r), 0);
  const byDifficulty = ["easy", "medium", "hard"].map((d) => {
    const rs = rows.filter((r) => r.difficulty === d);
    return rs.length ? `${d} ${rs.filter((r) => r.ok).length}/${rs.length}` : undefined;
  }).filter(Boolean);
  console.log("\n" + "─".repeat(72));
  console.log(
    `pass ${passed}/${rows.length} (${rows.length ? ((100 * passed) / rows.length).toFixed(0) : 0}%)  ` +
      `[${byDifficulty.join(", ")}]  wall ${(sum((r) => r.wall_ms) / 1000).toFixed(1)}s  ` +
      `llm calls ${sum((r) => r.llm_calls)}  tokens ${sum((r) => r.tokens)}` +
      (rows.some((r) => r.cost !== undefined) ? `  cost ${sum((r) => r.cost ?? 0).toFixed(4)}` : "") +
      `  lean verifications ${sum((r) => r.lean_verifications)}`,
  );

  const out = arg("json") ?? path.resolve("bench/results", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(
    out,
    JSON.stringify({ started_at: new Date().toISOString(), strategy: stepwise ? "stepwise" : "whole_proof", samples, rounds, rows }, null, 2),
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
async function runStepwise(t: BenchTheorem, useMathlib: boolean): Promise<{ ok: boolean; attempts: number; tactics?: string }> {
  const problemText = `Prove in Lean 4: theorem ${t.name} ${t.type}`;
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
  const preflight = await verifyLeanSource(session.id, assembleLeanSource({ theoremName: t.name, theoremType: t.type, stepCodes: ["sorry"], useMathlib }), { allowSorry: true });
  const result = await proofSearch({ session, method, theoremType: t.type, config: { useMathlib }, initialGoal: preflight.goals?.[0] });
  const codes = result.steps.map((s) => s.lean_code).filter(Boolean);
  const final = await verifyLeanSource(session.id, assembleLeanSource({ theoremName: t.name, theoremType: t.type, stepCodes: codes, useMathlib }), { theoremName: t.name });
  return { ok: final.ok && result.fullyVerified, attempts: result.totalAttempts, tactics: codes.join("\n") };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
