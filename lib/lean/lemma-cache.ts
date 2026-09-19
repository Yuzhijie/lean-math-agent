import { promises as fs } from "node:fs";
import path from "node:path";
import type { MathDomain } from "../types";

export interface LemmaEntry {
  name: string;          // e.g., "Nat.add_comm"
  type_signature: string; // e.g., "∀ (n m : ℕ), n + m = m + n"
  module: string;         // e.g., "Mathlib.Data.Nat.Basic"
  tags: string[];         // e.g., ["arithmetic", "commutativity"]
  description: string;    // brief Chinese description
}

const CACHE_FILE = path.join("lean-sandbox", "lemma-cache.json");

/**
 * Lemma cache for fast retrieval of Mathlib lemmas.
 * Supports search by name, type signature, and tags.
 */
export class LemmaCache {
  private lemmas: LemmaEntry[] = [];
  private nameIndex: Map<string, LemmaEntry> = new Map();
  private tagIndex: Map<string, LemmaEntry[]> = new Map();

  /**
   * Load lemma cache from file. If missing, uses built-in common lemmas.
   */
  async initialize(): Promise<void> {
    try {
      const data = await fs.readFile(CACHE_FILE, "utf8");
      this.lemmas = JSON.parse(data);
    } catch {
      // Use built-in common lemmas
      this.lemmas = COMMON_LEMMAS;
    }
    this.buildIndices();
  }

  private buildIndices(): void {
    this.nameIndex.clear();
    this.tagIndex.clear();

    for (const lemma of this.lemmas) {
      this.nameIndex.set(lemma.name, lemma);
      for (const tag of lemma.tags) {
        const existing = this.tagIndex.get(tag) ?? [];
        existing.push(lemma);
        this.tagIndex.set(tag, existing);
      }
    }
  }

  /** Get a lemma by exact name. */
  get(name: string): LemmaEntry | undefined {
    return this.nameIndex.get(name);
  }

  /** Search by name prefix or substring. */
  searchByName(pattern: string): LemmaEntry[] {
    const lower = pattern.toLowerCase();
    return this.lemmas.filter(
      (l) => l.name.toLowerCase().includes(lower),
    );
  }

  /** Fuzzy search by type signature pattern. */
  searchBySignature(typePattern: string): LemmaEntry[] {
    const lower = typePattern.toLowerCase();
    return this.lemmas.filter(
      (l) => l.type_signature.toLowerCase().includes(lower),
    );
  }

  /** Search by tag. */
  searchByTag(tag: string): LemmaEntry[] {
    return this.tagIndex.get(tag) ?? [];
  }

  /** Get all available tags. */
  getTags(): string[] {
    return [...this.tagIndex.keys()];
  }

  /** Get total lemma count. */
  get size(): number {
    return this.lemmas.length;
  }

  /**
   * Suggest relevant lemmas based on problem text and optional domain.
   * Uses keyword matching on the problem text (both Chinese and English patterns)
   * combined with domain-based filtering.
   */
  suggestLemmas(problemText: string, domain?: MathDomain, maxResults = 10): LemmaEntry[] {
    const text = problemText.toLowerCase();
    const scored = new Map<string, { lemma: LemmaEntry; score: number }>();

    // Keyword → tag/pattern matching
    for (const [keyword, tags] of KEYWORD_TAG_MAP) {
      if (text.includes(keyword)) {
        for (const tag of tags) {
          const matches = this.searchByTag(tag);
          for (const lemma of matches) {
            const existing = scored.get(lemma.name);
            scored.set(lemma.name, {
              lemma,
              score: (existing?.score ?? 0) + 1,
            });
          }
        }
      }
    }

    // Domain-based boost: add lemmas commonly needed for this domain
    if (domain) {
      const domainTags = DOMAIN_TAG_MAP[domain];
      if (domainTags) {
        for (const tag of domainTags) {
          const matches = this.searchByTag(tag);
          for (const lemma of matches) {
            const existing = scored.get(lemma.name);
            scored.set(lemma.name, {
              lemma,
              score: (existing?.score ?? 0) + 0.5,
            });
          }
        }
      }
    }

    // Sort by score descending, return top results
    return [...scored.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map((s) => s.lemma);
  }
}

/**
 * Built-in common lemmas for when the full cache is not available.
 */
const COMMON_LEMMAS: LemmaEntry[] = [
  // Nat arithmetic
  { name: "Nat.add_comm", type_signature: "∀ (n m : ℕ), n + m = m + n", module: "Mathlib", tags: ["arithmetic", "commutativity"], description: "自然数加法交换律" },
  { name: "Nat.add_assoc", type_signature: "∀ (n m k : ℕ), n + m + k = n + (m + k)", module: "Mathlib", tags: ["arithmetic", "associativity"], description: "自然数加法结合律" },
  { name: "Nat.add_zero", type_signature: "∀ (n : ℕ), n + 0 = n", module: "Mathlib", tags: ["arithmetic", "zero"], description: "自然数加零" },
  { name: "Nat.zero_add", type_signature: "∀ (n : ℕ), 0 + n = n", module: "Mathlib", tags: ["arithmetic", "zero"], description: "自然数零加" },
  { name: "Nat.mul_comm", type_signature: "∀ (n m : ℕ), n * m = m * n", module: "Mathlib", tags: ["arithmetic", "commutativity"], description: "自然数乘法交换律" },
  { name: "Nat.mul_assoc", type_signature: "∀ (n m k : ℕ), n * m * k = n * (m * k)", module: "Mathlib", tags: ["arithmetic", "associativity"], description: "自然数乘法结合律" },
  { name: "Nat.mul_one", type_signature: "∀ (n : ℕ), n * 1 = n", module: "Mathlib", tags: ["arithmetic", "one"], description: "自然数乘一" },
  { name: "Nat.add_succ", type_signature: "∀ (n m : ℕ), n + succ m = succ (n + m)", module: "Mathlib", tags: ["arithmetic", "successor"], description: "自然数加后继" },
  { name: "Nat.mul_add", type_signature: "∀ (n m k : ℕ), n * (m + k) = n * m + n * k", module: "Mathlib", tags: ["arithmetic", "distributivity"], description: "自然数乘法分配律" },
  { name: "Nat.mul_zero", type_signature: "∀ (n : ℕ), n * 0 = 0", module: "Mathlib", tags: ["arithmetic", "zero"], description: "自然数乘零" },

  // Int arithmetic
  { name: "Int.add_comm", type_signature: "∀ (n m : ℤ), n + m = m + n", module: "Mathlib", tags: ["arithmetic", "commutativity", "int"], description: "整数加法交换律" },
  { name: "Int.mul_comm", type_signature: "∀ (n m : ℤ), n * m = m * n", module: "Mathlib", tags: ["arithmetic", "commutativity", "int"], description: "整数乘法交换律" },
  { name: "Int.add_zero", type_signature: "∀ (n : ℤ), n + 0 = n", module: "Mathlib", tags: ["arithmetic", "zero", "int"], description: "整数加零" },

  // Ordering
  { name: "Nat.le_refl", type_signature: "∀ (n : ℕ), n ≤ n", module: "Mathlib", tags: ["ordering", "reflexivity"], description: "自然数小于等于自反性" },
  { name: "Nat.lt_succ_self", type_signature: "∀ (n : ℕ), n < n + 1", module: "Mathlib", tags: ["ordering", "successor"], description: "自然数小于后继" },

  // Logic
  { name: "not_not", type_signature: "∀ {p : Prop}, ¬¬p → p", module: "Mathlib", tags: ["logic", "negation"], description: "双重否定消除" },
  { name: "and_comm", type_signature: "∀ {p q : Prop}, p ∧ q ↔ q ∧ p", module: "Mathlib", tags: ["logic", "conjunction"], description: "与运算交换律" },
  { name: "or_comm", type_signature: "∀ {p q : Prop}, p ∨ q ↔ q ∨ p", module: "Mathlib", tags: ["logic", "disjunction"], description: "或运算交换律" },

  // Batteries — additional data structures and utilities
  { name: "Batteries.Data.List.Basic", type_signature: "List utility lemmas", module: "Batteries", tags: ["data", "list"], description: "Batteries 列表工具引理" },
  { name: "Batteries.Data.Array.Basic", type_signature: "Array utility lemmas", module: "Batteries", tags: ["data", "array"], description: "Batteries 数组工具引理" },
  { name: "Batteries.Tactic.Rcases", type_signature: "Enhanced case splitting", module: "Batteries", tags: ["tactic", "cases"], description: "增强版 rcases 策略" },

  // Aesop — automated proof search
  { name: "aesop", type_signature: "Tactic aesop : auto proof search", module: "Aesop", tags: ["tactic", "automation"], description: "Aesop 自动证明搜索策略，适用于命题逻辑和简单构造子目标" },
];

// ── Keyword → Tag mapping for lemma suggestion ─────────────────────

/** Maps problem text keywords (Chinese + English) to lemma tags. */
const KEYWORD_TAG_MAP: Array<[string, string[]]> = [
  // Chinese keywords
  ["交换律", ["commutativity"]],
  ["交换", ["commutativity"]],
  ["结合律", ["associativity"]],
  ["结合", ["associativity"]],
  ["分配律", ["distributivity"]],
  ["分配", ["distributivity"]],
  ["加法", ["arithmetic"]],
  ["乘法", ["arithmetic"]],
  ["自然数", ["arithmetic"]],
  ["整数", ["arithmetic", "int"]],
  ["小于", ["ordering"]],
  ["大于", ["ordering"]],
  ["不等", ["ordering"]],
  ["等于", ["arithmetic"]],
  ["零", ["zero"]],
  ["后继", ["successor"]],
  ["否定", ["negation"]],
  ["逻辑", ["logic"]],
  ["集合", ["data"]],
  ["列表", ["list"]],
  // English keywords
  ["commutativity", ["commutativity"]],
  ["commutative", ["commutativity"]],
  ["associativity", ["associativity"]],
  ["associative", ["associativity"]],
  ["distributive", ["distributivity"]],
  ["distributivity", ["distributivity"]],
  ["addition", ["arithmetic"]],
  ["multiplication", ["arithmetic"]],
  ["natural number", ["arithmetic"]],
  ["integer", ["arithmetic", "int"]],
  ["inequality", ["ordering"]],
  ["ordering", ["ordering"]],
  ["zero", ["zero"]],
  ["successor", ["successor"]],
  ["negation", ["negation"]],
  ["logic", ["logic"]],
];

/** Maps math domains to commonly-needed lemma tags. */
const DOMAIN_TAG_MAP: Partial<Record<MathDomain, string[]>> = {
  number_theory: ["arithmetic", "ordering"],
  competition_number_theory: ["arithmetic", "ordering"],
  algebra: ["arithmetic", "associativity", "commutativity", "distributivity"],
  competition_elementary: ["arithmetic", "ordering"],
  combinatorics: ["arithmetic", "data"],
  competition_combinatorics: ["arithmetic", "data"],
  set_theory: ["data"],
  competition_set_theory: ["data"],
};

// ── Singleton accessor for quick lemma suggestions ──────────────────

let _sharedCache: LemmaCache | null = null;

/**
 * Suggest relevant Mathlib lemmas for a given problem.
 * Lazily initializes a shared LemmaCache instance.
 */
export async function suggestLemmasForProblem(
  problemText: string,
  domain?: MathDomain,
  maxResults?: number,
): Promise<LemmaEntry[]> {
  if (!_sharedCache) {
    _sharedCache = new LemmaCache();
    await _sharedCache.initialize();
  }
  return _sharedCache.suggestLemmas(problemText, domain, maxResults);
}
