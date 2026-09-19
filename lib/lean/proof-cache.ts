// ── Proof Pattern Cache ────────────────────────────────────────────────
//
// Caches successful proof patterns keyed by (theorem_signature, method_category).
// When a similar theorem is proven successfully with a given method, the
// tactic sequence is cached for future reuse. Persisted to disk.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const PROOF_CACHE_MAX = 128;
const PROOF_CACHE_PATH =
  process.env.PROOF_CACHE_PATH ?? ".data/proof-cache.json";

export interface ProofPattern {
  lean_tactics: string[];
  method_category: string;
  success: boolean;
  created_at: number;
}

interface CacheEntry {
  key: string;
  pattern: ProofPattern;
}

// ── In-memory LRU store ───────────────────────────────────────────────

const store = new Map<string, ProofPattern>();
let loaded = false;
let loadPromise: Promise<void> | null = null;

function buildKey(
  theoremSignature: string,
  methodCategory: string,
): string {
  const normalized = theoremSignature
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return createHash("sha256")
    .update(JSON.stringify({ sig: normalized, cat: methodCategory }))
    .digest("hex");
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const data = await fs.readFile(PROOF_CACHE_PATH, "utf8");
      const entries: CacheEntry[] = JSON.parse(data);
      for (const e of entries) {
        store.set(e.key, e.pattern);
        if (store.size >= PROOF_CACHE_MAX) break;
      }
    } catch {
      // File doesn't exist or is corrupt — start empty
    }
    loaded = true;
  })();
  return loadPromise;
}

async function persistToDisk(): Promise<void> {
  try {
    const dir = path.dirname(PROOF_CACHE_PATH);
    await fs.mkdir(dir, { recursive: true });
    const entries: CacheEntry[] = [...store.entries()].map(
      ([key, pattern]) => ({ key, pattern }),
    );
    await fs.writeFile(PROOF_CACHE_PATH, JSON.stringify(entries, null, 2), "utf8");
  } catch {
    // Silently ignore write failures
  }
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Look up a cached proof pattern for a theorem + method combination.
 * Returns undefined if no matching pattern exists.
 */
export async function lookupProofPattern(
  theoremSignature: string,
  methodCategory: string,
): Promise<ProofPattern | undefined> {
  await ensureLoaded();
  const key = buildKey(theoremSignature, methodCategory);
  const pattern = store.get(key);
  if (pattern === undefined) return undefined;
  // LRU: move to most-recent position
  store.delete(key);
  store.set(key, pattern);
  return pattern;
}

/**
 * Store a proof pattern for future reuse.
 */
export async function storeProofPattern(
  theoremSignature: string,
  methodCategory: string,
  pattern: Omit<ProofPattern, "created_at">,
): Promise<void> {
  await ensureLoaded();
  const key = buildKey(theoremSignature, methodCategory);
  const entry: ProofPattern = { ...pattern, created_at: Date.now() };

  if (store.has(key)) {
    store.delete(key);
  } else if (store.size >= PROOF_CACHE_MAX) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, entry);
  await persistToDisk();
}

/** Clear all cached proof patterns (for testing). */
export function clearProofCache(): void {
  store.clear();
  loaded = false;
  loadPromise = null;
}

/** Current proof cache size (for testing/monitoring). */
export function proofCacheSize(): number {
  return store.size;
}
