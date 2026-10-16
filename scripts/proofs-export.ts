/**
 * `npm run proofs:export` — the proof memory and the repair pairs as fine-tuning data
 * (plan 7b P3, expert iteration). Writes to --out (default data/proof-dataset):
 *
 *   proofs.jsonl        every stored proof: statement, tactics, full Lean source, strategy, source
 *   sft-train.jsonl     {"messages": [user: the native prover prompt, assistant: ```lean4 proof```]}
 *   sft-eval.jsonl      the same for ~5% of statements (stable hash split, --eval-share)
 *   repair-train.jsonl  {"messages": [user: failed proof + Lean's errors, assistant: fixed proof]}
 *   repair-eval.jsonl
 *   README.md           counts, split, what was left out and why
 *
 * Proofs of benchmark test sets (source bench:*test*) stay out of the sft/repair files unless
 * --include-test: a prover fine-tuned on miniF2F-test can no longer be measured on it.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { allProofs, readRepairs } from "../lib/lean/proof-memory";
import { isTestSource, repairRecords, sftRecords } from "../lib/prover/dataset";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");

function count<T>(xs: T[], key: (x: T) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

async function main(): Promise<void> {
  for (const f of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(path.resolve(f));
    } catch {
      // optional
    }
  }
  const out = path.resolve(arg("out") ?? "data/proof-dataset");
  const evalShare = arg("eval-share") !== undefined ? Number(arg("eval-share")) : 0.05;
  const includeTest = flag("include-test");
  const entries = await allProofs();
  const pairs = await readRepairs();
  const sft = sftRecords(entries, { evalShare, includeTest });
  const rep = repairRecords(pairs, { evalShare, includeTest });

  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(
    path.join(out, "proofs.jsonl"),
    jsonl(
      entries.map((e) => ({
        id: e.id,
        theorem_name: e.theorem_name,
        theorem_type: e.theorem_type,
        tactics: e.tactics,
        strategy: e.strategy,
        source: e.source ?? "solve",
        opens: e.opens,
        problem_text: e.problem_text,
        uses: e.uses,
        replay_hits: e.replay_hits ?? 0,
      })),
    ),
  );
  await fs.writeFile(path.join(out, "sft-train.jsonl"), jsonl(sft.train));
  await fs.writeFile(path.join(out, "sft-eval.jsonl"), jsonl(sft.eval));
  await fs.writeFile(path.join(out, "repair-train.jsonl"), jsonl(rep.train));
  await fs.writeFile(path.join(out, "repair-eval.jsonl"), jsonl(rep.eval));

  const readme = [
    "# Proof dataset",
    "",
    `Exported by \`npm run proofs:export\` on ${new Date().toISOString().slice(0, 10)} from the proof memory (${entries.length} verified proofs) and ${pairs.length} repair pairs.`,
    "",
    "| File | Records |",
    "| --- | --- |",
    `| proofs.jsonl | ${entries.length} |`,
    `| sft-train.jsonl | ${sft.train.length} |`,
    `| sft-eval.jsonl | ${sft.eval.length} |`,
    `| repair-train.jsonl | ${rep.train.length} |`,
    `| repair-eval.jsonl | ${rep.eval.length} |`,
    "",
    `Split: ${Math.round(evalShare * 100)}% of statements to eval by a stable hash of the statement, so the same theorem never lands in both.`,
    includeTest
      ? "Benchmark test sets are included (--include-test): do not measure a model trained on these files on those benchmarks."
      : `Left out of sft/repair: ${sft.excludedTest} proofs and ${rep.excludedTest} repair pairs from benchmark test sets (${count(entries.filter((e) => isTestSource(e.source)), (e) => e.source ?? "?")
          .map(([k, n]) => `${k} ${n}`)
          .join(", ") || "none"}); pass --include-test to keep them.`,
    "",
    "Format: chat messages in the native prover format the whole-proof loop uses (lib/llm/prompts.ts nativeProverPrompt / nativeProverRepairPrompt); the assistant turn is the verified proof in a `lean4` block. Every proof passed the verifier: no sorry, standard axioms only, statement unchanged.",
    "",
    "| Source | Proofs |",
    "| --- | --- |",
    ...count(entries, (e) => e.source ?? "solve").map(([k, n]) => `| ${k} | ${n} |`),
    "",
    "| Found by | Proofs |",
    "| --- | --- |",
    ...count(entries, (e) => e.strategy ?? "?").map(([k, n]) => `| ${k} | ${n} |`),
    "",
  ].join("\n");
  await fs.writeFile(path.join(out, "README.md"), readme);
  console.log(`wrote ${out}: ${entries.length} proofs, sft ${sft.train.length}/${sft.eval.length}, repairs ${rep.train.length}/${rep.eval.length}` + (sft.excludedTest ? ` (${sft.excludedTest} test-set proofs left out)` : ""));
}

if (process.argv[1] && /proofs-export\.(ts|js|mts|mjs)$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
