/**
 * `npm run e2e:report [-- file.jsonl …] [--dir bench/results] [--out bench/E2E.md] [--set bench/heldout.json]`
 * — the report of the end-to-end runs (lib/e2e/report.ts) from their result files; no model calls.
 * The stored answers are compared again with the current matcher (runs on the set as it is now).
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseRun, type RunFile } from "../lib/e2e/outcome";
import { e2eReport } from "../lib/e2e/report";
import { readRuns, rematched } from "./e2e-eval";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const files = process.argv.slice(2).filter((a, i, xs) => !a.startsWith("--") && !(xs[i - 1] ?? "").startsWith("--"));
const runs: RunFile[] = files.length
  ? files.flatMap((f) => {
      const r = parseRun(f, readFileSync(f, "utf8"));
      return r ? [r] : [];
    })
  : readRuns(arg("dir") ?? path.join("bench", "results"));
const out = arg("out") ?? path.join("bench", "E2E.md");
writeFileSync(out, e2eReport(rematched(runs, arg("set") ?? path.join("bench", "heldout.json")), { now: new Date() }));
console.log(`${runs.length} run(s) → ${out}`);
