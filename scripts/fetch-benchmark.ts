/**
 * Download a standard formal benchmark and convert it to the bench format
 * (`bench/*.json`, consumed by `npm run bench -- --file …`).
 *
 *   npm run bench:fetch                       # miniF2F test split → bench/minif2f-test.json
 *   npm run bench:fetch -- --split valid      # → bench/minif2f-valid.json
 *   npm run bench:fetch -- --limit 50 --out bench/minif2f-50.json
 *   npm run bench:fetch -- --url <jsonl url>  # another JSONL with the same fields
 *
 * Source: the Lean 4 / Mathlib port of miniF2F distributed with
 * DeepSeek-Prover-V1.5 (`datasets/minif2f.jsonl`; fields name, split,
 * informal_prefix, formal_statement, goal, header — 244 valid + 244 test
 * competition problems from AMC/AIME/IMO and MATH).
 *
 * Each theorem becomes { id, difficulty, name, type, informal } where
 * `type` is the single-line signature after the theorem name (the bench
 * re-assembles `theorem <name> <type> := by …`). The file-level `opens`
 * (`open BigOperators Real Nat Topology Rat`) are kept and passed to the
 * prover so the statements elaborate unchanged. Deprecated big-operator
 * syntax (`∑ x in s`) is rewritten to the current `∑ x ∈ s`.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const DEFAULT_URL = "https://raw.githubusercontent.com/deepseek-ai/DeepSeek-Prover-V1.5/main/datasets/minif2f.jsonl";

interface SourceRow {
  name: string;
  split?: string;
  informal_prefix?: string;
  formal_statement: string;
  goal?: string;
  header?: string;
}

export interface BenchFile {
  source: string;
  split?: string;
  fetched_at: string;
  opens: string[];
  theorems: Array<{ id: string; difficulty: "easy" | "medium" | "hard"; name: string; type: string; informal?: string; goal?: string }>;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Difficulty from the problem's origin, as commonly reported for miniF2F. */
export function difficultyOf(name: string): "easy" | "medium" | "hard" {
  if (/^(imo|imosl|aime|usamo|putnam)/.test(name)) return "hard";
  if (/^(amc|algebra|numbertheory|induction)/.test(name)) return "medium";
  return "easy"; // mathd_* (MATH dataset)
}

/** `theorem name <type> := by` (possibly multi-line) → single-line `<type>`. */
export function statementToType(formal: string, name: string): string | undefined {
  let s = formal.replace(/\r/g, "").trim();
  s = s.replace(/:=\s*by(?:\s+sorry)?\s*$/, "").replace(/:=\s*sorry\s*$/, "").replace(/:=\s*$/, "").trim();
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = s.match(new RegExp(`^(?:theorem|lemma)\\s+${escaped}\\b([\\s\\S]*)$`));
  if (!m) return undefined;
  let type = m[1].replace(/\s+/g, " ").trim();
  // Deprecated `∑ x in s, f` / `∏ x in s, f` → `∑ x ∈ s, f`.
  type = type.replace(/([∑∏])\s+([^,]+?)\s+in\s+/g, "$1 $2 ∈ ");
  if (!type || type.includes(":=")) return undefined;
  return type;
}

export function opensOf(header: string | undefined): string[] {
  const out = new Set<string>();
  for (const m of (header ?? "").matchAll(/^\s*open\s+([^\n]+)$/gm)) {
    for (const n of m[1].split(/\s+/)) if (n && !/^(in|hiding|renaming)$/.test(n)) out.add(n);
  }
  return [...out];
}

export function informalOf(prefix: string | undefined): string | undefined {
  if (!prefix) return undefined;
  const t = prefix.replace(/^\s*\/--\s*/, "").replace(/\s*-\/\s*$/, "").replace(/\s+/g, " ").trim();
  return t || undefined;
}

export function convert(rows: SourceRow[], opts: { split?: string; limit?: number; url: string }): BenchFile {
  const opens = new Set<string>();
  const theorems: BenchFile["theorems"] = [];
  for (const r of rows) {
    if (opts.split && r.split && r.split !== opts.split) continue;
    const type = statementToType(r.formal_statement, r.name);
    if (!type) {
      console.error(`[bench:fetch] skipped ${r.name}: could not parse statement`);
      continue;
    }
    for (const o of opensOf(r.header)) opens.add(o);
    theorems.push({ id: r.name, difficulty: difficultyOf(r.name), name: r.name, type, informal: informalOf(r.informal_prefix), goal: r.goal });
    if (opts.limit && theorems.length >= opts.limit) break;
  }
  return { source: opts.url, split: opts.split, fetched_at: new Date().toISOString(), opens: [...opens], theorems };
}

async function main(): Promise<void> {
  const url = arg("url") ?? DEFAULT_URL;
  const split = arg("split") ?? "test";
  const limit = arg("limit") ? Number(arg("limit")) : undefined;
  const out = arg("out") ?? path.resolve("bench", `minif2f-${split}.json`);
  console.error(`[bench:fetch] GET ${url}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const text = await res.text();
  const rows: SourceRow[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t) as SourceRow);
    } catch {
      console.error(`[bench:fetch] skipped an unparsable line`);
    }
  }
  const file = convert(rows, { split: split === "all" ? undefined : split, limit, url });
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(file, null, 2), "utf8");
  const byDiff = ["easy", "medium", "hard"].map((d) => `${d} ${file.theorems.filter((t) => t.difficulty === d).length}`).join(", ");
  console.error(`[bench:fetch] wrote ${file.theorems.length} theorems (${byDiff}; opens: ${file.opens.join(" ")}) → ${out}`);
}

if (process.argv[1] && /fetch-benchmark\.(ts|js|mts|mjs)$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
