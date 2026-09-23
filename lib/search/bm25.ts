/**
 * Small in-memory BM25 index over Lean text (declaration names, statement
 * types, goal states). Shared by premise retrieval and proof memory.
 *
 * Tokenization is tuned to Mathlib's naming convention: notation symbols
 * are mapped to the words Mathlib uses in lemma names (`≤` → `le`, `*` →
 * `mul`, `∑` → `sum`, `ℕ` → `nat`, `2` → `two` …), identifiers are split
 * on `.`/`_`/camelCase, and one-letter tokens (variable names) are dropped.
 * A goal such as `⊢ a * b ≤ (a ^ 2 + b ^ 2) / 2` therefore shares tokens
 * with `mul_le_mul`, `sq_nonneg`, `two_mul`, `add_pow_two`, ….
 */

const SYMBOLS: Array<[RegExp, string]> = [
  [/\b(?:Type|Sort)\s*(?:[uv]_?\d*)?\b|\b[uv]_\d+\b/g, " "],
  [/ℕ|\bNat\b/g, " nat "],
  [/ℤ|\bInt\b/g, " int "],
  [/ℚ|\bRat\b/g, " rat "],
  [/ℝ|\bReal\b/g, " real "],
  [/ℂ|\bComplex\b/g, " complex "],
  [/≤/g, " le "],
  [/≥/g, " ge le "],
  [/</g, " lt "],
  [/>/g, " gt lt "],
  [/≠/g, " ne "],
  [/\+/g, " add "],
  [/\*/g, " mul "],
  [/(^|[\s(])-\s*(?=[a-zA-Z(])/g, "$1 neg "],
  [/-/g, " sub "],
  [/\//g, " div "],
  [/\^\s*2(?![\d.])/g, " sq "],
  [/\^/g, " pow "],
  [/%/g, " mod "],
  [/∣/g, " dvd "],
  [/√/g, " sqrt "],
  [/\|([^|\n]*)\|/g, " abs $1 "],
  [/\|/g, " "],
  [/∑/g, " sum "],
  [/∏/g, " prod "],
  [/¬/g, " not "],
  [/∧/g, " and "],
  [/∨/g, " or "],
  [/↔/g, " iff "],
  [/∃/g, " exists "],
  [/∈/g, " mem "],
  [/∉/g, " not mem "],
  [/⊆/g, " subset "],
  [/∪/g, " union "],
  [/∩/g, " inter "],
  [/∅/g, " empty "],
  [/∘/g, " comp "],
  [/π/g, " pi "],
  [/⁻¹/g, " inv "],
  [/!/g, " factorial "],
  [/∀|→|⊢|↑|⋯|:=|[:,()\[\]{}⟨⟩=λ]/g, " "],
];

const NUMBER_WORDS: Record<string, string> = { "0": "zero", "1": "one", "2": "two", "3": "three", "4": "four" };

const STOP = new Set([
  "type", "sort", "prop", "inst", "fun", "let", "this", "u", "v", "w", "self", "h", "hx", "hy", "hn", "hab", "true",
]);

export function leanTokens(text: string): string[] {
  let s = text.replace(/\r/g, " ");
  for (const [re, rep] of SYMBOLS) s = s.replace(re, rep);
  const out: string[] = [];
  for (const raw of s.split(/[\s._'’`"]+/)) {
    if (!raw) continue;
    // camelCase → separate words; digits → words
    const parts = raw
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/\s+/);
    for (const p of parts) {
      let t = p.toLowerCase();
      if (!t) continue;
      if (NUMBER_WORDS[t]) t = NUMBER_WORDS[t];
      if (/^\d+$/.test(t)) continue;
      if (/^u\d*$/.test(t) || /^u_\d+$/.test(t)) continue;
      // Hypothesis-style names (h₁, hab₂ …) and subscripts.
      t = t.replace(/[₀-₉]/g, "");
      if (t.length < 2 || STOP.has(t)) continue;
      out.push(t);
    }
  }
  return out;
}

export interface Bm25Doc<T> {
  item: T;
  /** Tokens of the document (already tokenized). */
  tokens: string[];
}

export interface Bm25Hit<T> {
  item: T;
  score: number;
}

export interface WeightedQuery {
  /** token → weight (default 1). */
  weights: Map<string, number>;
}

/** Build a weighted query from several text fields. */
export function weightedQuery(fields: Array<{ text: string; weight?: number }>): WeightedQuery {
  const weights = new Map<string, number>();
  for (const f of fields) {
    const w = f.weight ?? 1;
    for (const t of leanTokens(f.text)) weights.set(t, (weights.get(t) ?? 0) + w);
  }
  // Damp repeated tokens: weight grows sub-linearly with repetitions.
  for (const [t, w] of weights) weights.set(t, Math.sqrt(w));
  return { weights };
}

export class Bm25Index<T> {
  private readonly docs: Bm25Doc<T>[] = [];
  private readonly postings = new Map<string, Array<[number, number]>>(); // token → [docId, tf]
  private readonly lengths: number[] = [];
  private totalLen = 0;
  private avgLen = 0;
  private readonly k1: number;
  private readonly b: number;

  constructor(opts: { k1?: number; b?: number } = {}) {
    this.k1 = opts.k1 ?? 1.2;
    this.b = opts.b ?? 0.75;
  }

  get size(): number {
    return this.docs.length;
  }

  add(item: T, tokens: string[]): number {
    const id = this.docs.length;
    this.docs.push({ item, tokens });
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [t, n] of tf) {
      let list = this.postings.get(t);
      if (!list) this.postings.set(t, (list = []));
      list.push([id, n]);
    }
    this.lengths.push(tokens.length);
    this.totalLen += tokens.length;
    this.avgLen = this.totalLen / this.lengths.length;
    return id;
  }

  idf(token: string): number {
    const df = this.postings.get(token)?.length ?? 0;
    if (df === 0) return 0;
    return Math.log(1 + (this.docs.length - df + 0.5) / (df + 0.5));
  }

  search(query: WeightedQuery, k: number, filter?: (item: T) => boolean): Bm25Hit<T>[] {
    const scores = new Map<number, number>();
    for (const [token, w] of query.weights) {
      const list = this.postings.get(token);
      if (!list) continue;
      const idf = this.idf(token);
      for (const [id, tf] of list) {
        const dl = this.lengths[id];
        const norm = tf * (this.k1 + 1) / (tf + this.k1 * (1 - this.b + (this.b * dl) / (this.avgLen || 1)));
        scores.set(id, (scores.get(id) ?? 0) + w * idf * norm);
      }
    }
    const hits: Bm25Hit<T>[] = [];
    for (const [id, score] of scores) {
      const item = this.docs[id].item;
      if (filter && !filter(item)) continue;
      hits.push({ item, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }
}
