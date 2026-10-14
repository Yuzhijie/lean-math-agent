/**
 * Baseline in one command (upgrade plan 7b, P0): re-run the same 20 miniF2F theorems as the
 * first run (cascade, normal budget) to check the tuning since, then the whole miniF2F test
 * split (244) on the low budget, and write bench/BASELINE.md from every miniF2F result so far.
 *
 *   npm run bench:baseline -- [--concurrency 3] [--max-cost 12] [--skip-retest] [--skip-full]
 *
 * Needs what `npm run bench` needs (LLM key in .env.local, built Lean sandbox with the REPL).
 * Spends real money: the first run cost $0.57 for 20 theorems; --max-cost caps the full run.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

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
  const r = spawnSync(process.execPath, [path.join("node_modules", "tsx", "dist", "cli.mjs"), script, ...args], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`${label} failed (exit ${r.status ?? r.signal})`);
    process.exit(r.status ?? 1);
  }
}

if (!existsSync(FILE)) run("download miniF2F", "scripts/fetch-benchmark.ts", []);

console.log(
  `Baseline plan: ${flag("skip-retest") ? "" : "retest 20 (normal budget), "}${flag("skip-full") ? "" : `miniF2F test 244 (low budget, stops starting new theorems after $${maxCost})`}; ` +
    `${concurrency} theorems at a time.`,
);

if (!flag("skip-retest")) {
  run("retest: the same 20 theorems as the first run", "scripts/bench.ts", [
    "--file", FILE, "--limit", "20", "--budget", "normal", "--concurrency", concurrency, "--json", `${RESULTS}/${stamp}-retest20.json`,
  ]);
}
if (!flag("skip-full")) {
  run("full: miniF2F test split, low budget", "scripts/bench.ts", [
    "--file", FILE, "--budget", "low", "--concurrency", concurrency, "--max-cost", maxCost, "--json", `${RESULTS}/${stamp}-minif2f-low.json`,
  ]);
}

// Every miniF2F result so far (the first run included) goes into the report.
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
  : [];
run("report", "scripts/bench-report.ts", [...files, "--out", "bench/BASELINE.md", "--title", "Prover baseline (miniF2F test)"]);
