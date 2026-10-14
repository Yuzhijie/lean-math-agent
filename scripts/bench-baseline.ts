/**
 * Baseline in one command (upgrade plan 7b, P0): re-run the same 20 miniF2F theorems as the
 * first run (cascade, normal budget) to check the tuning since, then the whole miniF2F test
 * split (244) on the low budget, and write bench/BASELINE.md from every miniF2F result so far.
 *
 *   npm run bench:baseline -- [--concurrency 3] [--max-cost 12] [--skip-retest] [--skip-full]
 *   npm run bench:baseline -- --rerun bench/results/<full>.json
 *       re-run only the theorems a fix touched — statements changed by fixStatement and rows lost
 *       to the environment (model unreachable, a hung Lean worker) — merge them into that run
 *       (re-classifying the old failure buckets) and rewrite the report
 *
 *   npm run bench:baseline -- --prover bench/results/<full>-merged.json
 *       try the configured prover (LLM_PROVER_MODEL) on the theorems that run did not prove, merge
 *       the result into a copy of it ("<full>-prover.json") and rewrite the report
 *
 * On macOS the runs are wrapped in `caffeinate -i` so the machine does not sleep mid-run.
 * Needs what `npm run bench` needs (LLM key in .env.local, built Lean sandbox with the REPL).
 * Spends real money: the first run cost $0.57 for 20 theorems; --max-cost caps the full run.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { rerunIds } from "./bench-merge";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const FILE = "bench/minif2f-test.json";
const RESULTS = "bench/results";
const concurrency = arg("concurrency") ?? "3";
const maxCost = arg("max-cost") ?? "12";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

function run(label: string, script: string, args: string[]): void {
  console.log(`\n=== ${label} ===\n$ tsx ${script} ${args.join(" ")}`);
  const cmd = [process.execPath, path.join("node_modules", "tsx", "dist", "cli.mjs"), script, ...args];
  // A sleeping Mac stalls the model calls and the Lean workers (2026-10-14: 8 theorems lost in one stretch).
  const [bin, ...rest] = process.platform === "darwin" && existsSync("/usr/bin/caffeinate") ? ["/usr/bin/caffeinate", "-i", ...cmd] : cmd;
  const r = spawnSync(bin, rest, { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`${label} failed (exit ${r.status ?? r.signal})`);
    process.exit(r.status ?? 1);
  }
}

if (!existsSync(FILE)) run("download miniF2F", "scripts/fetch-benchmark.ts", []);

const rerunOf = arg("rerun");
if (rerunOf) {
  const ids = rerunIds(JSON.parse(readFileSync(rerunOf, "utf8")), JSON.parse(readFileSync(FILE, "utf8")));
  console.log(`Re-running ${ids.length} theorem(s): ${ids.join(", ")}`);
  const budget = (JSON.parse(readFileSync(rerunOf, "utf8")) as { budget?: string }).budget ?? "low";
  const out = `${RESULTS}/${stamp}-rerun${ids.length}.json`;
  if (ids.length) {
    run("re-run", "scripts/bench.ts", ["--file", FILE, "--budget", budget, "--concurrency", concurrency, "--max-cost", maxCost, "--only", ids.join(","), "--json", out]);
  }
  const merged = rerunOf.replace(/\.json$/, "") + "-merged.json";
  run("merge", "scripts/bench-merge.ts", [rerunOf, ...(ids.length ? [out] : []), "--out", merged]);
}

const proverOf = arg("prover");
if (proverOf) {
  if (!process.env.LLM_PROVER_MODEL && !process.env.LLM_PROVER_MODELS) {
    for (const f of [".env.local", ".env"]) {
      try {
        process.loadEnvFile(f);
      } catch {
        /* absent */
      }
    }
  }
  const model = process.env.LLM_PROVER_MODEL ?? process.env.LLM_PROVER_MODELS;
  if (!model) {
    console.error("Set LLM_PROVER_MODEL (and LLM_PROVER_BASE_URL / LLM_PROVER_API_KEY) in .env.local first; check it with npm run prover:check");
    process.exit(2);
  }
  const budget = (JSON.parse(readFileSync(proverOf, "utf8")) as { budget?: string }).budget ?? "low";
  const out = `${RESULTS}/${stamp}-prover-failed.json`;
  console.log(`Trying ${model} on the theorems ${proverOf} did not prove (budget ${budget}, cost cap $${maxCost})`);
  run("prover on the failures", "scripts/bench.ts", ["--file", FILE, "--budget", budget, "--concurrency", concurrency, "--max-cost", maxCost, "--only-failed", proverOf, "--json", out]);
  run("merge", "scripts/bench-merge.ts", [proverOf, out, "--out", proverOf.replace(/(-merged)?\.json$/, "") + "-prover.json"]);
}

if (!rerunOf && !proverOf) console.log(
  `Baseline plan: ${flag("skip-retest") ? "" : "retest 20 (normal budget), "}${flag("skip-full") ? "" : `miniF2F test 244 (low budget, stops starting new theorems after $${maxCost})`}; ` +
    `${concurrency} theorems at a time.`,
);

if (!flag("skip-retest") && !rerunOf && !proverOf) {
  run("retest: the same 20 theorems as the first run", "scripts/bench.ts", [
    "--file", FILE, "--limit", "20", "--budget", "normal", "--concurrency", concurrency, "--json", `${RESULTS}/${stamp}-retest20.json`,
  ]);
}
if (!flag("skip-full") && !rerunOf && !proverOf) {
  run("full: miniF2F test split, low budget", "scripts/bench.ts", [
    "--file", FILE, "--budget", "low", "--concurrency", concurrency, "--max-cost", maxCost, "--json", `${RESULTS}/${stamp}-minif2f-low.json`,
  ]);
}

// Every miniF2F result so far (the first run included) goes into the report; a merged file
// stands in for the run it was merged from, and re-run files are folded into it.
const files = existsSync(RESULTS)
  ? readdirSync(RESULTS)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(RESULTS, f))
      .filter((f) => {
        try {
          return (JSON.parse(readFileSync(f, "utf8")) as { file?: string }).file === path.basename(FILE);
        } catch {
          return false;
        }
      })
      // Folded files (re-runs, prover tries) are inside their merged result; a merged file stands in for its source.
      .filter((f) => !/-(rerun\d+|prover-failed)\.json$/.test(f))
      .filter((f, _i, all) => !all.includes(f.replace(/\.json$/, "") + "-merged.json"))
  : [];
run("report", "scripts/bench-report.ts", [...files, "--out", "bench/BASELINE.md", "--title", "Prover baseline (miniF2F test)"]);
