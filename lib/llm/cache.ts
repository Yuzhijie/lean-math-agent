// ── LRU Response Cache ────────────────────────────────────────────────
//
// In-memory LRU cache for LLM text responses with optional disk persistence.
// Key: SHA-256 hash of (model, messages JSON, temperature).
// Eviction: Least Recently Used when cache reaches maxSize.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChatMessage } from "./client";

export class LruCache {
  private store = new Map<string, string>();
  private readonly maxSize: number;
  private persistPath?: string;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private static readonly PERSIST_DEBOUNCE_MS = 500;

  constructor(maxSize: number, persistPath?: string) {
    this.maxSize = Math.max(1, maxSize);
    this.persistPath = persistPath;
  }

  /** Load cache entries from a JSON file on disk. */
  static async loadFromDisk(
    persistPath: string,
    maxSize: number,
  ): Promise<LruCache> {
    const cache = new LruCache(maxSize, persistPath);
    try {
      const data = await fs.readFile(persistPath, "utf8");
      const entries: [string, string][] = JSON.parse(data);
      for (const [k, v] of entries) {
        cache.store.set(k, v);
        if (cache.store.size >= maxSize) break;
      }
    } catch {
      // File doesn't exist or is corrupt — start empty
    }
    return cache;
  }

  /** Retrieve a cached value. Moves the entry to the most-recent position. */
  get(key: string): string | undefined {
    const value = this.store.get(key);
    if (value === undefined) return undefined;
    // Move to end (most-recent) by re-inserting
    this.store.delete(key);
    this.store.set(key, value);
    return value;
  }

  /** Store a value. Evicts the least-recently-used entry if at capacity. */
  set(key: string, value: string): void {
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxSize) {
      // Evict the oldest (first) entry
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) {
        this.store.delete(oldest);
      }
    }
    this.store.set(key, value);
    this.schedulePersist();
  }

  /** Clear all cached entries. */
  clear(): void {
    this.store.clear();
    this.schedulePersist();
  }

  /** Current number of cached entries. */
  get size(): number {
    return this.store.size;
  }

  /** Write all entries to disk (debounced). */
  private schedulePersist(): void {
    if (!this.persistPath) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.writeToDisk().catch(() => {/* silent */});
    }, LruCache.PERSIST_DEBOUNCE_MS);
  }

  private async writeToDisk(): Promise<void> {
    if (!this.persistPath) return;
    const dir = path.dirname(this.persistPath);
    await fs.mkdir(dir, { recursive: true });
    const entries: [string, string][] = [...this.store.entries()];
    await fs.writeFile(this.persistPath, JSON.stringify(entries), "utf8");
  }
}

// ── Cache key builder ─────────────────────────────────────────────────

/**
 * Build a deterministic cache key from request parameters.
 * Uses SHA-256 to keep keys short and uniform.
 */
export function buildCacheKey(
  model: string,
  messages: ChatMessage[],
  temperature: number,
): string {
  const payload = JSON.stringify({ model, messages, temperature });
  return createHash("sha256").update(payload).digest("hex");
}

// ── Global cache instance (lazy-initialized) ──────────────────────────

let globalCache: LruCache | null = null;
let globalCacheInitPromise: Promise<LruCache> | null = null;

const LLM_CACHE_PATH =
  process.env.LLM_CACHE_PATH ?? ".data/llm-cache.json";
const LLM_CACHE_MAX = Number(process.env.LLM_CACHE_MAX ?? 500);

export function getGlobalCache(maxSize: number): LruCache {
  // Synchronous fallback — if async init hasn't completed, return
  // a non-persisted cache to avoid blocking callers.
  if (!globalCache) {
    globalCache = new LruCache(maxSize);
    // Kick off async load in background; replace when ready
    if (!globalCacheInitPromise) {
      globalCacheInitPromise = LruCache.loadFromDisk(
        LLM_CACHE_PATH,
        LLM_CACHE_MAX,
      ).then((loaded) => {
        // Merge any entries written before load completed
        if (globalCache && globalCache.size === 0) {
          globalCache = loaded;
        }
        return loaded;
      });
    }
  }
  return globalCache;
}

/** Reset the global cache (for testing). */
export function resetGlobalCache(): void {
  globalCache = null;
  globalCacheInitPromise = null;
}
