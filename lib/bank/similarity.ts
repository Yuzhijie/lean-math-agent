/**
 * Duplicate detection for question stems.
 *
 * - fingerprint: hash of the normalised stem — equal fingerprints are the
 *   same question (spacing, punctuation width, LaTeX spelling ignored).
 * - similarity: Jaccard overlap of character 3-grams of the normalised
 *   stem; works for Chinese and English alike. ≥ NEAR_DUPLICATE means
 *   "probably the same question with small changes".
 */
import { createHash } from "node:crypto";

export const NEAR_DUPLICATE = 0.8;
/** Generated questions closer than this to a bank question are rejected as copies. */
export const TOO_CLOSE = 0.7;

const FULLWIDTH: Record<string, string> = {
  "，": ",", "。": ".", "：": ":", "；": ";", "（": "(", "）": ")", "？": "?", "！": "!",
  "【": "[", "】": "]", "“": '"', "”": '"', "‘": "'", "’": "'", "－": "-", "＋": "+", "＝": "=",
};

/** Normalise a stem for comparison: case, width, whitespace, common LaTeX spellings, math delimiters. */
export function normaliseStem(text: string): string {
  let s = text.normalize("NFKC").toLowerCase();
  s = s.replace(/[，。：；（）？！【】“”‘’－＋＝]/g, (c) => FULLWIDTH[c] ?? c);
  s = s
    .replace(/\\left|\\right|\\displaystyle|\\,|\\;|\\!|\\quad/g, "")
    .replace(/\\dfrac|\\tfrac/g, "\\frac")
    .replace(/\\times/g, "×")
    .replace(/\\cdot/g, "·")
    .replace(/\\div/g, "÷")
    .replace(/\\le(q)?\b/g, "≤")
    .replace(/\\ge(q)?\b/g, "≥")
    .replace(/\$+|\\\(|\\\)|\\\[|\\\]/g, "")
    .replace(/\{\s*\}/g, "")
    .replace(/^\s*(?:\(?\d{1,3}[.)、．]|q\d{1,3}[.:]?|question\s+\d{1,3}[.:]?|第\s*\d+\s*题[.:、]?|例\s*\d+[.:、]?)\s*/, "");
  return s.replace(/\s+/g, "");
}

export function fingerprint(text: string): string {
  return createHash("sha256").update(normaliseStem(text)).digest("hex").slice(0, 32);
}

function shingles(norm: string, n = 3): Set<string> {
  const out = new Set<string>();
  const chars = [...norm];
  if (chars.length <= n) {
    if (chars.length) out.add(chars.join(""));
    return out;
  }
  for (let i = 0; i + n <= chars.length; i++) out.add(chars.slice(i, i + n).join(""));
  return out;
}

/** Jaccard similarity of character 3-grams, 0..1. */
export function stemSimilarity(a: string, b: string): number {
  const A = shingles(normaliseStem(a));
  const B = shingles(normaliseStem(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Pre-computed shingles for comparing one stem against many. */
export class StemIndex<T> {
  private readonly entries: Array<{ item: T; set: Set<string>; fp: string }> = [];
  add(item: T, stem: string) {
    const norm = normaliseStem(stem);
    this.entries.push({ item, set: shingles(norm), fp: fingerprint(stem) });
  }
  get size() {
    return this.entries.length;
  }
  /** Most similar entry to `stem` (exact fingerprint match scores 1). */
  nearest(stem: string): { item: T; score: number } | undefined {
    const fp = fingerprint(stem);
    const Q = shingles(normaliseStem(stem));
    let best: { item: T; score: number } | undefined;
    for (const e of this.entries) {
      let score: number;
      if (e.fp === fp) score = 1;
      else {
        if (!Q.size || !e.set.size) continue;
        let inter = 0;
        for (const x of Q) if (e.set.has(x)) inter++;
        score = inter / (Q.size + e.set.size - inter);
      }
      if (!best || score > best.score) best = { item: e.item, score };
      if (score === 1) break;
    }
    return best;
  }
}
