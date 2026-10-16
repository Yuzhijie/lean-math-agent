/**
 * `npm run proofs:import -- <file.jsonl | url>` — add proofs from a published dataset to the proof
 * memory, each one re-checked by this project's Lean sandbox first (plan 7b P3: the memory only
 * holds proofs that our verifier accepted — no sorry, standard axioms, the statement unchanged).
 * Many published proofs were written for older Mathlib versions; those that no longer compile are
 * simply left out and counted.
 *
 *   --limit n          import at most n rows (after de-duplication)
 *   --concurrency n    Lean checks at once (default 4; LEAN_REPL_WORKERS follows)
 *   --source name      source label (default import:<file name>)
 *   --dry-run          parse and count, check nothing
 *
 * Accepted rows (JSON lines, or one JSON array), the field names used by common Lean 4 datasets:
 *   - full_proof: a whole declaration `theorem name … := by …`, or
 *   - formal_statement (`theorem name … := by sorry`) + proof (tactics, with or without `by`);
 *   - optional header (its `open …` lines are kept), informal_prefix / informal / natural_language_statement.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { assembleLeanSource } from "../lib/lean/assemble";
import { allProofs, rememberProofs, type RememberArgs } from "../lib/lean/proof-memory";
import { mainAssignmentIndex, validateTheoremStatement } from "../lib/lean/sanitize";
import { checkLeanAvailable, verifyLeanSource } from "../lib/lean/sandbox";
import { shutdownReplPool } from "../lib/lean/repl";
import { extractTactics } from "../lib/prover/whole-proof";
import { fixStatement, informalOf, opensOf } from "./fetch-benchmark";
import { runPool } from "./bench";

export interface ParsedProof {
  name: string;
  type: string;
  tactics: string;
  informal?: string;
  opens: string[];
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

/** One dataset row → a statement and its tactic proof; a reason when it cannot be read. */
export function parseExternalRow(row: Record<string, unknown>): ParsedProof | { error: string } {
  let decl = str(row.full_proof) ?? str(row.full_code);
  const statement = str(row.formal_statement);
  if (!decl || !/\b(theorem|lemma)\b/.test(decl)) {
    const proof = str(row.proof) ?? str(row.tactics) ?? (decl && !/\b(theorem|lemma)\b/.test(decl) ? decl : undefined);
    if (!statement || !proof) return { error: "no full_proof, or formal_statement + proof" };
    const head = statement.replace(/:=\s*(by)?\s*(sorry)?\s*$/, "").trimEnd();
    decl = `${head} := by\n${proof.replace(/^\s*by\b/, "")}`;
  }
  decl = decl.replace(/\r/g, "");
  const m = /(?:^|\n)\s*(?:theorem|lemma)\s+([^\s(:{[⦃]+)/.exec(decl);
  if (!m) return { error: "no theorem declaration" };
  const name = m[1];
  const afterName = decl.slice(m.index! + m[0].length);
  const assign = mainAssignmentIndex(afterName);
  if (assign < 0) return { error: "no `:=` after the statement" };
  const type = fixStatement(afterName.slice(0, assign).replace(/\s+/g, " ").trim().replace(/([∑∏])\s+([^,]+?)\s+in\s+/g, "$1 $2 ∈ "));
  const valid = validateTheoremStatement(name, type);
  if (!valid.ok) return { error: valid.reason };
  const tactics = extractTactics(decl.slice(m.index!), name);
  if (!tactics?.trim() || /\b(sorry|admit)\b/.test(tactics)) return { error: "no complete proof" };
  const informal = informalOf(str(row.informal_prefix)) ?? str(row.informal)?.trim() ?? str(row.natural_language_statement)?.trim();
  return { name, type, tactics: tactics.trim(), informal, opens: opensOf(str(row.header) ?? decl) };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function readRows(src: string): Promise<Record<string, unknown>[]> {
  const text = /^https?:\/\//.test(src) ? await (await fetch(src, { signal: AbortSignal.timeout(300_000) })).text() : await fs.readFile(src, "utf8");
  const t = text.trim();
  if (t.startsWith("[")) return JSON.parse(t) as Record<string, unknown>[];
  return t.split("\n").flatMap((l) => {
    try {
      return l.trim() ? [JSON.parse(l) as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

async function main(): Promise<void> {
  for (const f of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(path.resolve(f));
    } catch {
      // optional
    }
  }
  const argv = process.argv.slice(2);
  const valued = new Set(["--limit", "--concurrency", "--source"]);
  const src = argv.find((a, i) => !a.startsWith("--") && !valued.has(argv[i - 1]));
  if (!src) {
    console.error("usage: npm run proofs:import -- <file.jsonl | url> [--limit n] [--concurrency n] [--dry-run]");
    process.exit(2);
  }
  const source = arg("source") ?? `import:${path.basename(src).replace(/\?.*$/, "")}`;
  const rows = await readRows(src);
  const have = new Set((await allProofs()).map((e) => e.theorem_type.replace(/\s+/g, " ").trim()));
  const errors = new Map<string, number>();
  const todo: ParsedProof[] = [];
  const seen = new Set<string>();
  let duplicate = 0;
  for (const row of rows) {
    const p = parseExternalRow(row);
    if ("error" in p) {
      errors.set(p.error, (errors.get(p.error) ?? 0) + 1);
      continue;
    }
    const key = p.type.replace(/\s+/g, " ").trim();
    if (seen.has(key) || have.has(key)) {
      duplicate++;
      continue;
    }
    seen.add(key);
    todo.push(p);
  }
  const limit = arg("limit") !== undefined ? Number(arg("limit")) : todo.length;
  const batch = todo.slice(0, limit);
  console.log(`${rows.length} rows: ${todo.length} new statements with proofs, ${duplicate} already in memory or repeated, ${[...errors.values()].reduce((a, b) => a + b, 0)} unreadable`);
  for (const [e, n] of [...errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`  unreadable: ${e} (${n})`);
  if (flag("dry-run")) return;

  const lean = await checkLeanAvailable();
  if (!lean.ok) {
    console.error(`Lean is needed to check every proof before it is stored: ${lean.message}`);
    process.exit(2);
  }
  const concurrency = Math.max(1, Number(arg("concurrency") ?? 4));
  if (!process.env.LEAN_REPL_WORKERS) process.env.LEAN_REPL_WORKERS = String(Math.min(concurrency, 8));
  let done = 0;
  let ok = 0;
  const accepted: RememberArgs[] = [];
  await runPool(batch, concurrency, async (p) => {
    const sourceText = assembleLeanSource({ theoremName: p.name, theoremType: p.type, stepCodes: [p.tactics], useMathlib: true, opens: p.opens });
    const v = await verifyLeanSource(`import-${p.name}`, sourceText, { theoremName: p.name }).catch(() => undefined);
    done++;
    if (v?.ok) {
      ok++;
      accepted.push({ theoremName: p.name, theoremType: p.type, tactics: p.tactics, strategy: "imported", problemText: p.informal, source, opens: p.opens });
    }
    if (done % 25 === 0 || done === batch.length) console.log(`  checked ${done}/${batch.length}: ${ok} accepted`);
    // Store as we go, so a long import that is stopped keeps what it checked.
    if (accepted.length >= 50) await rememberProofs(accepted.splice(0));
  });
  if (accepted.length) await rememberProofs(accepted.splice(0));
  shutdownReplPool();
  const size = (await allProofs()).length;
  console.log(`imported ${ok} of ${batch.length} checked proofs (${batch.length - ok} did not compile here); memory now ${size}`);
}

if (process.argv[1] && /proofs-import\.(ts|js|mts|mjs)$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
