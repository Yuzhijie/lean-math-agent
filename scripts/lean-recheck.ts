/**
 * `npm run lean:recheck` — re-run the steps that need no model (hammer cascade, single tactics, the
 * order proofs the program writes) on the Lean statements stored in past sessions, with the current
 * code. Nothing is spent. Writes bench/LEAN-RECHECK.md.
 *
 *   --limit n        only the first n problems
 *   --only-failed    skip problems that were proved when they were solved
 *   --out path       report path (default bench/LEAN-RECHECK.md)
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { listSessionsFromDisk } from "../lib/session-store";
import { checkLeanAvailable } from "../lib/lean/sandbox";
import { shutdownReplPool } from "../lib/lean/repl";
import { hugePower } from "../lib/compute/nat-expr";
import { proveWithoutModel } from "../lib/pipeline/lean-attempt";
import { recheckItems, recheckReport, type RecheckResult } from "../lib/pipeline/lean-recheck";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  for (const f of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(path.resolve(f));
    } catch {
      // optional
    }
  }
  const lean = await checkLeanAvailable();
  if (!lean.ok) {
    console.error(`lean:recheck needs Lean: ${lean.message}`);
    process.exit(2);
  }
  let items = recheckItems(await listSessionsFromDisk());
  if (flag("only-failed")) items = items.filter((i) => i.before !== "proved");
  const limit = Number(arg("limit"));
  if (arg("limit") !== undefined && Number.isFinite(limit) && limit > 0) items = items.slice(0, limit);
  console.log(`${items.length} problem(s) with a stored statement`);

  const results: RecheckResult[] = [];
  for (const [k, item] of items.entries()) {
    const started = Date.now();
    if (!item.theoremName || !item.theoremType) {
      results.push({ item, checked: false, ms: 0 });
      continue;
    }
    let now: RecheckResult["now"];
    try {
      const r = await proveWithoutModel({
        sessionId: `recheck-${item.sessionId}`,
        theoremName: item.theoremName,
        theoremType: item.theoremType,
        expectedSignature: item.expectedSignature,
        useMathlib: true,
        huge: !!hugePower(item.theoremType),
      });
      if (r.proof) now = { strategy: r.proof.strategy, attempts: r.proof.attempts };
    } catch (e) {
      console.error(`  #${k + 1}: ${e instanceof Error ? e.message : String(e)}`);
    }
    results.push({ item, checked: true, ...(now ? { now } : {}), ms: Date.now() - started });
    console.log(`#${k + 1} ${item.before.padEnd(12)} → ${now ? `proved (${now.strategy})` : "—"}  ${item.problem.slice(0, 60)}`);
  }

  let commit: string | undefined;
  try {
    commit = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    commit = undefined;
  }
  const out = arg("out") ?? "bench/LEAN-RECHECK.md";
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, recheckReport(results, { date: new Date().toISOString().slice(0, 10), commit }));
  console.log(`wrote ${out}`);
  await shutdownReplPool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
