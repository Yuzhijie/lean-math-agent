/**
 * Expert iteration (plan 7b P3): verified proofs as data.
 *
 * - harvestRows: benchmark result rows (ok, with tactics) + the bench file's statements → proofs to
 *   remember (scripts/proofs-harvest.ts).
 * - sftRecords / repairRecords: fine-tuning records in the native prover format the whole-proof loop
 *   already speaks (nativeProverPrompt → a `lean4` code block; the repair turn → the fixed proof),
 *   split train / eval by a stable hash of the statement (scripts/proofs-export.ts).
 * - memoryHitStats: leave-one-out "similar-theorem hit rate" of the memory — for each stored proof,
 *   do the proofs recalled for its statement (excluding itself) use the same tactics?
 *   (scripts/proofs-eval.ts; with --replay it also counts verbatim replays that Lean accepts).
 *
 * Benchmark test sets (miniF2F-test …) are kept out of the training split by default: a model
 * fine-tuned on them can no longer be measured on them.
 */
import { createHash } from "node:crypto";
import { nativeProverPrompt, nativeProverRepairPrompt } from "../llm/prompts";
import { recallScored, type ProofMemoryEntry, type RememberArgs, type RepairPair } from "../lean/proof-memory";

// ── Harvest ──────────────────────────────────────────────────────────

export interface HarvestTheorem {
  id: string;
  name: string;
  type: string;
  informal?: string;
}

export interface HarvestRow {
  id: string;
  ok: boolean;
  proved_by?: string;
  tactics?: string;
}

/** Proofs to remember from one result file's rows; rows whose theorem is unknown are counted as missing. */
export function harvestRows(
  rows: HarvestRow[],
  theorems: Map<string, HarvestTheorem>,
  meta: { source: string; opens?: string[] },
): { proofs: RememberArgs[]; missing: string[] } {
  const proofs: RememberArgs[] = [];
  const missing: string[] = [];
  for (const r of rows) {
    if (!r.ok || !r.tactics?.trim()) continue;
    const t = theorems.get(r.id);
    if (!t) {
      missing.push(r.id);
      continue;
    }
    proofs.push({
      theoremName: t.name,
      theoremType: t.type,
      tactics: r.tactics,
      strategy: r.proved_by,
      problemText: t.informal,
      source: meta.source,
      opens: meta.opens,
    });
  }
  return { proofs, missing };
}

// ── Export ───────────────────────────────────────────────────────────

/** A source that is a benchmark's test split (kept out of training by default). */
export function isTestSource(source: string | undefined): boolean {
  return !!source && /^bench:.*test/i.test(source);
}

/** "train" or "eval", stable for a statement (evalShare of statements go to eval). */
export function splitOf(theoremType: string, evalShare = 0.05): "train" | "eval" {
  const h = createHash("sha256").update(theoremType.replace(/\s+/g, " ").trim()).digest();
  return h.readUInt32BE(0) / 0x100000000 < evalShare ? "eval" : "train";
}

function leanBlock(name: string, type: string, tactics: string): string {
  const body = tactics
    .split("\n")
    .map((l) => (l.trim() ? `  ${l}` : l))
    .join("\n");
  return `theorem ${name} ${type} := by\n${body}`;
}

export interface SftRecord {
  messages: { role: "user" | "assistant"; content: string }[];
  meta: { id?: string; source?: string; strategy?: string; split: "train" | "eval" };
}

/** Prover fine-tuning records: the prompt the whole-proof loop sends a native prover → the verified proof. */
export function sftRecords(entries: ProofMemoryEntry[], opts: { evalShare?: number; includeTest?: boolean } = {}): { train: SftRecord[]; eval: SftRecord[]; excludedTest: number } {
  const train: SftRecord[] = [];
  const evalSet: SftRecord[] = [];
  let excludedTest = 0;
  for (const e of entries) {
    if (!opts.includeTest && isTestSource(e.source)) {
      excludedTest++;
      continue;
    }
    const split = splitOf(e.theorem_type, opts.evalShare);
    const rec: SftRecord = {
      messages: [
        { role: "user", content: nativeProverPrompt({ theoremName: e.theorem_name, theoremType: e.theorem_type, problemText: e.problem_text, opens: e.opens }) },
        { role: "assistant", content: "```lean4\n" + leanBlock(e.theorem_name, e.theorem_type, e.tactics) + "\n```" },
      ],
      meta: { id: e.id, source: e.source, strategy: e.strategy, split },
    };
    (split === "eval" ? evalSet : train).push(rec);
  }
  return { train, eval: evalSet, excludedTest };
}

/** Repair fine-tuning records: failed proof + Lean's feedback → the proof that verified. */
export function repairRecords(pairs: RepairPair[], opts: { evalShare?: number; includeTest?: boolean } = {}): { train: SftRecord[]; eval: SftRecord[]; excludedTest: number } {
  const train: SftRecord[] = [];
  const evalSet: SftRecord[] = [];
  let excludedTest = 0;
  for (const p of pairs) {
    if (!opts.includeTest && isTestSource(p.source)) {
      excludedTest++;
      continue;
    }
    const split = splitOf(p.theorem_type, opts.evalShare);
    const rec: SftRecord = {
      messages: [
        { role: "user", content: nativeProverRepairPrompt({ previousCode: leanBlock(p.theorem_name, p.theorem_type, p.failed_tactics), feedback: p.feedback }) },
        { role: "assistant", content: "```lean4\n" + leanBlock(p.theorem_name, p.theorem_type, p.fixed_tactics) + "\n```" },
      ],
      meta: { source: p.source, split },
    };
    (split === "eval" ? evalSet : train).push(rec);
  }
  return { train, eval: evalSet, excludedTest };
}

// ── Hit rate ─────────────────────────────────────────────────────────

const NOT_TACTICS = new Set(["by", "at", "with", "using", "only", "fun", "then", "else", "if", "in", "do", "show", "from", "this", "at", "generalizing"]);

/** The tactic names a script uses (first word of each step; `<;>`, `;`, `·` split steps). */
export function tacticNames(tactics: string): Set<string> {
  const out = new Set<string>();
  for (const raw of tactics.split(/\n|<;>|;|·|\(|\)|\bby\b/)) {
    const m = /^\s*([a-z_][a-z_0-9!?']*)/.exec(raw);
    if (m && !NOT_TACTICS.has(m[1])) out.add(m[1]);
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface HitStats {
  entries: number;
  /** Entries with at least one recalled neighbour (score > 0). */
  withNeighbour: number;
  /** Entries whose recalled neighbours (top k) include one using the same tactics (Jaccard ≥ threshold). */
  hits: number;
  hitRate: number;
  meanBestJaccard: number;
  k: number;
  threshold: number;
  bySource: Record<string, { entries: number; hits: number }>;
}

/** Leave-one-out: recall for every stored proof's statement among the others. */
export async function memoryHitStats(entries: ProofMemoryEntry[], opts: { k?: number; threshold?: number } = {}): Promise<HitStats> {
  const k = opts.k ?? 2;
  const threshold = opts.threshold ?? 0.5;
  let withNeighbour = 0;
  let hits = 0;
  let sumBest = 0;
  const bySource: HitStats["bySource"] = {};
  for (const e of entries) {
    const recalled = await recallScored({ theoremType: e.theorem_type, problemText: e.problem_text, excludeType: e.theorem_type, k, touch: false, among: entries });
    const own = tacticNames(e.tactics);
    const best = recalled.reduce((m, r) => Math.max(m, jaccard(own, tacticNames(r.entry.tactics))), 0);
    const src = (e.source ?? "solve").replace(/^bench:/, "");
    bySource[src] ??= { entries: 0, hits: 0 };
    bySource[src].entries++;
    if (recalled.length) withNeighbour++;
    sumBest += best;
    if (recalled.length && best >= threshold) {
      hits++;
      bySource[src].hits++;
    }
  }
  return {
    entries: entries.length,
    withNeighbour,
    hits,
    hitRate: entries.length ? hits / entries.length : 0,
    meanBestJaccard: entries.length ? sumBest / entries.length : 0,
    k,
    threshold,
    bySource,
  };
}
