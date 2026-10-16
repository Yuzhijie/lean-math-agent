/**
 * `npm run proofs:harvest -- bench/results/*.json` — put every proof a benchmark run verified into
 * the proof memory (plan 7b P3, expert iteration). Benchmark runs keep the memory read-only by
 * default (so runs do not depend on each other); harvesting is the deliberate step that grows it.
 *
 *   --bench-dir dir   where the bench files named in the results live (default bench/)
 *   --dry-run         count what would be added, write nothing
 *
 * Each result file names its bench file (`file`); statements come from there, repaired the way
 * the benchmark repairs them on load (fixStatement), so the stored statement is the one that was
 * proved. A proof of a statement already in memory replaces it only when shorter.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { proofMemoryPath, proofMemorySize, rememberProofs, type RememberArgs } from "../lib/lean/proof-memory";
import { harvestRows, type HarvestRow, type HarvestTheorem } from "../lib/prover/dataset";
import { fixStatement } from "./fetch-benchmark";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function loadEnv(): void {
  for (const f of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(path.resolve(f));
    } catch {
      // optional
    }
  }
}

async function main(): Promise<void> {
  loadEnv();
  const benchDir = arg("bench-dir") ?? "bench";
  const argv = process.argv.slice(2);
  const files = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--bench-dir");
  if (!files.length) {
    console.error("usage: npm run proofs:harvest -- bench/results/*.json [--bench-dir bench] [--dry-run]");
    process.exit(2);
  }
  const benchCache = new Map<string, { theorems: Map<string, HarvestTheorem>; opens?: string[] } | null>();
  const loadBench = async (name: string) => {
    if (benchCache.has(name)) return benchCache.get(name)!;
    let out: { theorems: Map<string, HarvestTheorem>; opens?: string[] } | null = null;
    try {
      const parsed = JSON.parse(await fs.readFile(path.resolve(benchDir, name), "utf8")) as HarvestTheorem[] | { opens?: string[]; theorems: HarvestTheorem[] };
      const list = Array.isArray(parsed) ? parsed : parsed.theorems;
      out = { theorems: new Map(list.map((t) => [t.id, { ...t, type: fixStatement(t.type) }])), opens: Array.isArray(parsed) ? undefined : parsed.opens };
    } catch {
      out = null;
    }
    benchCache.set(name, out);
    return out;
  };

  const all: RememberArgs[] = [];
  for (const f of files) {
    let result: { file?: string; rows?: HarvestRow[] };
    try {
      result = JSON.parse(await fs.readFile(f, "utf8"));
    } catch (e) {
      console.warn(`skip ${f}: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    if (!result.file || !Array.isArray(result.rows)) {
      console.warn(`skip ${f}: not a bench result (no file / rows)`);
      continue;
    }
    const bench = await loadBench(result.file);
    if (!bench) {
      console.warn(`skip ${f}: bench file ${path.join(benchDir, result.file)} not found`);
      continue;
    }
    const { proofs, missing } = harvestRows(result.rows, bench.theorems, { source: `bench:${result.file}`, opens: bench.opens });
    console.log(`${path.basename(f)}: ${proofs.length} verified proofs${missing.length ? `, ${missing.length} with unknown theorem ids` : ""}`);
    all.push(...proofs);
  }

  const before = await proofMemorySize();
  if (flag("dry-run")) {
    const distinct = new Set(all.map((p) => p.theoremType.replace(/\s+/g, " ").trim())).size;
    console.log(`dry run: ${all.length} proofs of ${distinct} distinct statements; memory has ${before}`);
    return;
  }
  const r = await rememberProofs(all);
  const after = await proofMemorySize();
  console.log(`memory ${proofMemoryPath()}: ${before} → ${after} proofs (${r.added} new, ${r.updated} already there, ${r.skipped} skipped)`);
  if (after < 1000) console.log(`P3 target: more than 1000 proofs — ${1000 - after} to go`);
}

if (process.argv[1] && /proofs-harvest\.(ts|js|mts|mjs)$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
