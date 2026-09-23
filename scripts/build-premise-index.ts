/**
 * Build the premise-retrieval index from the sandbox's Mathlib.
 *
 *   npm run premises:build                       # default module prefixes
 *   npm run premises:build -- --all              # every Mathlib theorem (large, slow)
 *   npm run premises:build -- --prefix Mathlib.NumberTheory --prefix Mathlib.Data.Nat
 *   npm run premises:build -- --defs             # also definitions (names + types)
 *   npm run premises:build -- --from decls.jsonl # reuse a DumpDecls dump
 *   npm run premises:build -- --out .data/premise-index.json
 *
 * Runs `lake env lean --run scripts/lean/DumpDecls.lean` inside
 * LEAN_SANDBOX_PATH (default ./lean-sandbox), which imports Mathlib and
 * prints one JSON object per theorem, then writes the compact index that
 * `lib/lean/premises.ts` loads (PREMISE_INDEX_PATH). Importing Mathlib
 * needs a few GB of RAM and the dump takes minutes; the result is a file
 * of a few MB for the default prefixes.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import type { PremiseIndexFile } from "../lib/lean/premises";

const DEFAULT_PREFIXES = [
  "Mathlib.Algebra",
  "Mathlib.Order",
  "Mathlib.Data.Nat",
  "Mathlib.Data.Int",
  "Mathlib.Data.Rat",
  "Mathlib.Data.Real",
  "Mathlib.Data.Complex",
  "Mathlib.Data.Finset",
  "Mathlib.Data.Fintype",
  "Mathlib.Data.Fin",
  "Mathlib.Data.Set",
  "Mathlib.Data.List",
  "Mathlib.Data.Multiset",
  "Mathlib.Data.ZMod",
  "Mathlib.NumberTheory",
  "Mathlib.Combinatorics",
  "Mathlib.Analysis.SpecialFunctions",
  "Mathlib.Analysis.MeanInequalities",
  "Mathlib.Analysis.Convex.SpecificFunctions",
  "Mathlib.Logic",
  "Mathlib.Tactic.Positivity",
  "Init",
  "Batteries.Data.Nat",
  "Batteries.Data.Int",
  "Batteries.Data.List",
];

function loadEnv(): void {
  for (const f of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(path.resolve(f));
    } catch {
      // absent — fine
    }
  }
}

interface Args {
  prefixes: string[];
  all: boolean;
  defs: boolean;
  from?: string;
  out: string;
  max?: number;
  imports: string[];
}

function parseArgs(argv: string[]): Args {
  const a: Args = { prefixes: [], all: false, defs: false, out: "", imports: [] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--prefix") a.prefixes.push(argv[++i]);
    else if (v === "--all") a.all = true;
    else if (v === "--defs") a.defs = true;
    else if (v === "--from") a.from = argv[++i];
    else if (v === "--out") a.out = argv[++i];
    else if (v === "--max") a.max = Number(argv[++i]);
    else if (v === "--import") a.imports.push(argv[++i]);
  }
  return a;
}

interface Row {
  n: string;
  t: string;
  m: string;
  k: string;
}

/** Declarations that are never useful as premises even when not internal. */
function skip(row: Row): boolean {
  const n = row.n;
  if (/\.(?:proof_\d+|match_\d+|eq_\d+|_eq_\d+|_unfold|_sunfold|injEq|sizeOf_spec|inj|ext_iff)$/.test(n)) return true;
  if (/(?:^|\.)(?:inst[A-Z_]|Aux|aux)/.test(n)) return true;
  if (/^(?:Lean|Std|IO|System|Mathlib\.Tactic|Aesop|Qq|ProofWidgets|Plausible|LeanSearchClient|ImportGraph)\b/.test(n) && !/^Std\.(?:Data\.)?(?:Nat|Int)/.test(n)) return true;
  if (row.m.startsWith("Mathlib.Tactic") && !row.m.startsWith("Mathlib.Tactic.Positivity")) return true;
  if (row.t.length < 3 || row.t.length > 400) return true;
  if (/\bsorryAx\b|autoParam|optParam/.test(row.t)) return true;
  return false;
}

async function* dumpRows(a: Args): AsyncGenerator<Row> {
  if (a.from) {
    const rl = createInterface({ input: createReadStream(a.from, "utf8") });
    for await (const line of rl) {
      if (line.startsWith("{")) yield JSON.parse(line) as Row;
    }
    return;
  }
  const sandbox = path.resolve(process.env.LEAN_SANDBOX_PATH ?? "lean-sandbox");
  const script = path.resolve("scripts/lean/DumpDecls.lean");
  const leanArgs = ["env", "lean", "--run", script];
  for (const m of a.imports.length ? a.imports : ["Mathlib"]) leanArgs.push("--import", m);
  for (const p of a.all ? [] : a.prefixes.length ? a.prefixes : DEFAULT_PREFIXES) leanArgs.push("--prefix", p);
  if (a.defs) leanArgs.push("--defs");
  if (a.max) leanArgs.push("--max", String(a.max));
  console.error(`[premises] cd ${sandbox} && lake ${leanArgs.join(" ")}`);
  const child = spawn("lake", leanArgs, { cwd: sandbox, stdio: ["ignore", "pipe", "inherit"] });
  const rl = createInterface({ input: child.stdout });
  for await (const line of rl) {
    if (line.startsWith("{")) yield JSON.parse(line) as Row;
  }
  const code = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 1)));
  if (code !== 0) throw new Error(`lean exited with code ${code}`);
}

async function main(): Promise<void> {
  loadEnv();
  const a = parseArgs(process.argv.slice(2));
  const out = a.out || process.env.PREMISE_INDEX_PATH || ".data/premise-index.json";
  const entries: PremiseIndexFile["entries"] = [];
  const seen = new Set<string>();
  let read = 0;
  for await (const row of dumpRows(a)) {
    read++;
    if (seen.has(row.n) || skip(row)) continue;
    seen.add(row.n);
    entries.push(row.k === "def" ? [row.n, row.t, row.m, "def"] : [row.n, row.t, row.m]);
    if (entries.length % 20_000 === 0) console.error(`[premises] ${entries.length} kept / ${read} read`);
  }
  entries.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const file: PremiseIndexFile = {
    version: 1,
    source: a.from ? path.basename(a.from) : `Mathlib (${a.all ? "all" : (a.prefixes.length ? a.prefixes : DEFAULT_PREFIXES).length + " prefixes"})`,
    built_at: new Date().toISOString(),
    entries,
  };
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(file), "utf8");
  const bytes = (await fs.stat(out)).size;
  console.error(`[premises] wrote ${entries.length} declarations (${(bytes / 1e6).toFixed(1)} MB) to ${out}; ${read} read`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
