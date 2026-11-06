/**
 * `npm run auto:learn [--include-bench] [--limit n] [--list]`: turn the proof memory's stored
 * proofs into learned rules of the tactic search (lib/lean/auto/learned.ts) — each statement is
 * opened in Lean once to read its goal as printed. Proofs the program finds by itself (auto,
 * geometry, induction, …) and benchmark proofs (unless --include-bench) are left out.
 * `--list` prints the learned rules with their replay counts. Spends nothing.
 */
import { allProofs } from "../lib/lean/proof-memory";
import { learnedPath, learnFromProof, readLearned, worthLearning } from "../lib/lean/auto/learned";

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    const rules = readLearned();
    console.log(`${rules.length} learned rules in ${learnedPath()}`);
    for (const r of rules) console.log(`${r.id}  hits ${r.hits}/${r.tried}  ${r.strategy ?? "?"}  ${r.theorem ?? ""}  ⊢ ${r.goal.target.slice(0, 80)}`);
    return;
  }
  const bench = args.includes("--include-bench");
  const at = args.indexOf("--limit");
  const limit = at >= 0 ? Number(args[at + 1]) : Infinity;
  const entries = (await allProofs()).filter((e) => (bench && e.source?.startsWith("bench:") ? worthLearning(e.strategy, "solve") : worthLearning(e.strategy, e.source)));
  let added = 0;
  let seen = 0;
  for (const e of entries) {
    if (seen++ >= limit) break;
    const ok = await learnFromProof({ theoremName: e.theorem_name, theoremType: e.theorem_type, tactics: e.tactics, strategy: e.strategy, source: e.source, opens: e.opens, force: true });
    if (ok) added++;
    console.log(`${ok ? "learned" : "skipped"}  ${e.theorem_name}`);
  }
  console.log(`\n${added} new rules from ${Math.min(seen, entries.length)} proofs → ${learnedPath()}`);
  process.exit(0);
}
main();
