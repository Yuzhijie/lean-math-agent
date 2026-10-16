/**
 * Proof memory: every proof the verifier accepted is stored (statement +
 * tactic script + how it was found) and the most similar ones are shown
 * to the prover as worked examples for new theorems. Similar statements
 * tend to have similar proofs — a few-shot hint that is always faithful
 * (every example was machine-checked) and grows with use.
 *
 * Storage is a JSON file (PROOF_MEMORY_PATH, default
 * `.data/proof-memory.json`), capped at PROOF_MEMORY_MAX entries (default
 * 10000, LRU by last use). Similarity is BM25 over the theorem statement plus
 * the informal problem text (`lib/search/bm25.ts`).
 *
 * Expert iteration (plan 7b P3): the memory is also the dataset. Benchmark
 * runs are harvested into it (`npm run proofs:harvest`), recalled proofs are
 * first replayed verbatim before any model is asked (lib/prover/replay.ts),
 * repaired proofs are kept as before/after pairs (`.data/proof-repairs.jsonl`),
 * and `npm run proofs:export` writes fine-tuning files from both.
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
  /** Where the proof came from: "solve", "bench:<file>" (harvested), … */
  source?: string;
  /** Namespaces the proof was checked under (`open … in`). */
  opens?: string[];
  /** Times a replay of this proof proved another theorem. */
  replay_hits?: number;
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
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10000;
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
  source?: string;
  opens?: string[];
}

/**
 * Store a verified proof. A proof of the same statement replaces the old
 * one (shorter scripts win ties). Returns the stored entry, or undefined
 * when memory is disabled or the script is empty.
 */
export async function rememberProof(args: RememberArgs): Promise<ProofMemoryEntry | undefined> {
  if (!proofMemoryEnabled()) return undefined;
  const entries = await load();
  const entry = upsert(entries, args);
  if (!entry) return undefined;
  trim(entries);
  await save(entries);
  return entry;
}

/** Store many verified proofs with one write; returns how many were new and how many replaced an older proof. */
export async function rememberProofs(list: RememberArgs[]): Promise<{ added: number; updated: number; skipped: number }> {
  if (!proofMemoryEnabled()) return { added: 0, updated: 0, skipped: list.length };
  const entries = await load();
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const args of list) {
    const before = entries.length;
    const e = upsert(entries, args);
    if (!e) skipped++;
    else if (entries.length > before) added++;
    else updated++;
  }
  trim(entries);
  await save(entries);
  return { added, updated, skipped };
}

function trim(entries: ProofMemoryEntry[]): void {
  const max = maxEntries();
  if (entries.length > max) {
    entries.sort((a, b) => a.last_used_at.localeCompare(b.last_used_at));
    entries.splice(0, entries.length - max);
  }
}

function upsert(entries: ProofMemoryEntry[], args: RememberArgs): ProofMemoryEntry | undefined {
  const tactics = args.tactics.trim();
  if (!tactics || /\b(sorry|admit)\b/.test(tactics)) return undefined;
  const key = statementKey(args.theoremType);
  const now = new Date().toISOString();
  const existingIdx = entries.findIndex((e) => statementKey(e.theorem_type) === key);
  let entry: ProofMemoryEntry;
  if (existingIdx >= 0) {
    const old = entries[existingIdx];
    entry = {
      ...old,
      tactics: tactics.length <= old.tactics.length ? tactics : old.tactics,
      strategy: tactics.length <= old.tactics.length ? (args.strategy ?? old.strategy) : old.strategy,
      problem_text: args.problemText ?? old.problem_text,
      source: old.source ?? args.source,
      opens: old.opens ?? args.opens,
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
      ...(args.source ? { source: args.source } : {}),
      ...(args.opens?.length ? { opens: args.opens } : {}),
      created_at: now,
      last_used_at: now,
      uses: 0,
    };
    entries.push(entry);
  }
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
  return (await recallScored(args)).map((h) => h.entry);
}

/** Like recallProofs, with the BM25 score of each hit; `touch: false` leaves use counts alone (evaluation). */
export async function recallScored(args: RecallArgs & { touch?: boolean; among?: ProofMemoryEntry[] }): Promise<{ entry: ProofMemoryEntry; score: number }[]> {
  if (!proofMemoryEnabled()) return [];
  const entries = args.among ?? (await load());
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
  if (args.touch !== false && !args.among) {
    const now = new Date().toISOString();
    for (const h of hits) {
      h.item.uses += 1;
      h.item.last_used_at = now;
    }
    if (hits.length) void save(entries).catch(() => undefined);
  }
  return hits.map((h) => ({ entry: h.item, score: h.score }));
}

/** Count a replay that proved another theorem with this entry's proof. */
export async function noteReplayHit(id: string): Promise<void> {
  const entries = await load();
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  e.replay_hits = (e.replay_hits ?? 0) + 1;
  e.last_used_at = new Date().toISOString();
  await save(entries).catch(() => undefined);
}

/** Every stored proof (a copy of the list; for export and evaluation). */
export async function allProofs(): Promise<ProofMemoryEntry[]> {
  return [...(await load())];
}

// ── Repair pairs: a failed proof, Lean's feedback, and the proof that fixed it ──

export interface RepairPair {
  theorem_name: string;
  theorem_type: string;
  failed_tactics: string;
  feedback: string;
  fixed_tactics: string;
  source?: string;
  created_at: string;
}

export function proofRepairsPath(): string {
  return process.env.PROOF_REPAIRS_PATH ?? path.join(path.dirname(proofMemoryPath()), "proof-repairs.jsonl");
}

/** Append a repair pair (best effort; one JSON line per pair). */
export async function rememberRepair(pair: Omit<RepairPair, "created_at">): Promise<boolean> {
  if (!proofMemoryEnabled()) return false;
  if (!pair.failed_tactics.trim() || !pair.fixed_tactics.trim() || /\b(sorry|admit)\b/.test(pair.fixed_tactics)) return false;
  try {
    const p = proofRepairsPath();
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.appendFile(p, JSON.stringify({ ...pair, feedback: pair.feedback.slice(0, 4000), created_at: new Date().toISOString() }) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

export async function readRepairs(): Promise<RepairPair[]> {
  try {
    const text = await fs.readFile(proofRepairsPath(), "utf8");
    return text
      .split("\n")
      .filter((l) => l.trim())
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as RepairPair];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
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
