/**
 * Proof memory: every proof the verifier accepted is stored (statement +
 * tactic script + how it was found) and the most similar ones are shown
 * to the prover as worked examples for new theorems. Similar statements
 * tend to have similar proofs — a few-shot hint that is always faithful
 * (every example was machine-checked) and grows with use.
 *
 * Storage is a JSON file (PROOF_MEMORY_PATH, default
 * `.data/proof-memory.json`), capped at PROOF_MEMORY_MAX entries (LRU by
 * last use). Similarity is BM25 over the theorem statement plus the
 * informal problem text (`lib/search/bm25.ts`).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { Bm25Index, leanTokens, weightedQuery } from "../search/bm25";

export interface ProofMemoryEntry {
  id: string;
  theorem_name: string;
  theorem_type: string;
  tactics: string;
  strategy?: string;
  problem_text?: string;
  created_at: string;
  last_used_at: string;
  uses: number;
}

interface MemoryFile {
  version: 1;
  entries: ProofMemoryEntry[];
}

export function proofMemoryPath(): string {
  return process.env.PROOF_MEMORY_PATH ?? ".data/proof-memory.json";
}

export function proofMemoryEnabled(): boolean {
  return process.env.PROOF_MEMORY_ENABLED !== "false";
}

function maxEntries(): number {
  const n = Number(process.env.PROOF_MEMORY_MAX);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2000;
}

// One in-process copy per file path; writes are serialized.
let cache: { path: string; entries: ProofMemoryEntry[] } | undefined;
let writeChain: Promise<void> = Promise.resolve();

async function load(): Promise<ProofMemoryEntry[]> {
  const p = proofMemoryPath();
  if (cache && cache.path === p) return cache.entries;
  let entries: ProofMemoryEntry[] = [];
  try {
    const data = JSON.parse(await fs.readFile(p, "utf8")) as MemoryFile;
    if (data && Array.isArray(data.entries)) {
      entries = data.entries.filter((e) => e && typeof e.theorem_type === "string" && typeof e.tactics === "string");
    }
  } catch {
    entries = [];
  }
  cache = { path: p, entries };
  return entries;
}

async function save(entries: ProofMemoryEntry[]): Promise<void> {
  const p = proofMemoryPath();
  const run = async () => {
    await fs.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ version: 1, entries } satisfies MemoryFile, null, 0), "utf8");
    await fs.rename(tmp, p);
  };
  writeChain = writeChain.then(run, run);
  return writeChain;
}

/** Drop the in-memory copy (tests). */
export function resetProofMemoryCache(): void {
  cache = undefined;
}

/** Normalize a statement for duplicate detection. */
function statementKey(theoremType: string): string {
  return theoremType.replace(/\s+/g, " ").trim();
}

export interface RememberArgs {
  theoremName: string;
  theoremType: string;
  tactics: string;
  strategy?: string;
  problemText?: string;
}

/**
 * Store a verified proof. A proof of the same statement replaces the old
 * one (shorter scripts win ties). Returns the stored entry, or undefined
 * when memory is disabled or the script is empty.
 */
export async function rememberProof(args: RememberArgs): Promise<ProofMemoryEntry | undefined> {
  if (!proofMemoryEnabled()) return undefined;
  const tactics = args.tactics.trim();
  if (!tactics || /\b(sorry|admit)\b/.test(tactics)) return undefined;
  const entries = await load();
  const key = statementKey(args.theoremType);
  const now = new Date().toISOString();
  const existingIdx = entries.findIndex((e) => statementKey(e.theorem_type) === key);
  let entry: ProofMemoryEntry;
  if (existingIdx >= 0) {
    const old = entries[existingIdx];
    entry = {
      ...old,
      tactics: tactics.length <= old.tactics.length ? tactics : old.tactics,
      strategy: args.strategy ?? old.strategy,
      problem_text: args.problemText ?? old.problem_text,
      last_used_at: now,
    };
    entries[existingIdx] = entry;
  } else {
    entry = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      theorem_name: args.theoremName,
      theorem_type: args.theoremType,
      tactics,
      strategy: args.strategy,
      problem_text: args.problemText,
      created_at: now,
      last_used_at: now,
      uses: 0,
    };
    entries.push(entry);
  }
  const max = maxEntries();
  if (entries.length > max) {
    entries.sort((a, b) => a.last_used_at.localeCompare(b.last_used_at));
    entries.splice(0, entries.length - max);
  }
  await save(entries);
  return entry;
}

export interface RecallArgs {
  theoremType: string;
  problemText?: string;
  /** Exclude proofs of this exact statement (the theorem being proved). */
  excludeType?: string;
  k?: number;
}

/** The k most similar remembered proofs (empty when disabled or nothing stored). */
export async function recallProofs(args: RecallArgs): Promise<ProofMemoryEntry[]> {
  if (!proofMemoryEnabled()) return [];
  const entries = await load();
  if (entries.length === 0) return [];
  const excludeKey = args.excludeType !== undefined ? statementKey(args.excludeType) : undefined;
  const index = new Bm25Index<ProofMemoryEntry>();
  for (const e of entries) {
    if (excludeKey !== undefined && statementKey(e.theorem_type) === excludeKey) continue;
    index.add(e, [...leanTokens(e.theorem_type), ...leanTokens(e.problem_text ?? "")]);
  }
  const query = weightedQuery([
    { text: args.theoremType, weight: 2 },
    ...(args.problemText ? [{ text: args.problemText, weight: 0.5 }] : []),
  ]);
  const hits = index.search(query, args.k ?? 3).filter((h) => h.score > 0);
  const now = new Date().toISOString();
  for (const h of hits) {
    h.item.uses += 1;
    h.item.last_used_at = now;
  }
  if (hits.length) void save(entries).catch(() => undefined);
  return hits.map((h) => h.item);
}

/** Prompt block with remembered proofs as worked examples, or "". */
export function formatRecalledProofs(entries: ProofMemoryEntry[]): string {
  if (entries.length === 0) return "";
  const blocks = entries.map(
    (e) =>
      "```lean\n" +
      `theorem ${e.theorem_name} ${e.theorem_type} := by\n` +
      e.tactics
        .split("\n")
        .map((l) => (l.trim() ? `  ${l}` : l))
        .join("\n") +
      "\n```",
  );
  return `Verified proofs of similar theorems (machine-checked; adapt the approach, do not copy blindly):\n${blocks.join("\n")}`;
}

/** Number of stored proofs. */
export async function proofMemorySize(): Promise<number> {
  return (await load()).length;
}
