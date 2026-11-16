/**
 * Reading the text of a theorem type: its identifiers, its brackets, the names it binds, and a
 * renaming of those names. Shared by the reading form the provers get (lib/lean/reading-form.ts)
 * and the variants `npm run lean:variants` measures them on (lib/lean/statement-variants.ts).
 * Text only — Lean decides whether a rewritten statement says the same.
 */
import { splitTopLevelColon } from "./statement-prop";

export const GREEK = "αβγδεζηθικμνξορςστυφχψω"; // no λ (fun) and no π (Real.pi's notation)
export const ID_START = `A-Za-z_${GREEK}`;
export const ID_CONT = `${ID_START}0-9'₀-₉!?`;
const ID_RE = new RegExp(`[${ID_START}][${ID_CONT}]*`, "y");
export const KEYWORDS = new Set(["fun", "let", "if", "then", "else", "by", "at", "with", "in", "do", "have", "show", "from", "Type", "Prop", "Sort", "_"]);

export const OPEN = "([{⟨⦃";
export const CLOSE = ")]}⟩⦄";

export interface Token {
  text: string;
  start: number;
  end: number;
  /** An identifier (not a keyword, not a member after a dot). */
  id: boolean;
}

/** Identifiers with their places; a name after a dot (`s.card`, `Finset.range`) is a member, not an identifier of its own. */
export function identifiers(text: string): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < text.length; ) {
    ID_RE.lastIndex = i;
    const m = ID_RE.exec(text);
    if (!m) {
      i++;
      continue;
    }
    const member = i > 0 && text[i - 1] === ".";
    // a digit before it: part of a numeral or of `x₁`-like text already consumed
    const glued = i > 0 && /[0-9₀-₉']/.test(text[i - 1]);
    out.push({ text: m[0], start: i, end: i + m[0].length, id: !member && !glued && !KEYWORDS.has(m[0]) });
    i += m[0].length;
  }
  return out;
}

/** Index of the first of `seps` at depth 0 from `from` (the longest separator that matches), or -1. */
export function topIndexOf(text: string, seps: string[], from = 0): { at: number; sep: string } {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    if (depth < 0) return { at: -1, sep: "" };
    if (depth === 0 || (depth === 1 && OPEN.includes(c))) {
      if (depth !== 0) continue;
      const sep = seps.filter((s) => text.startsWith(s, i)).sort((a, b) => b.length - a.length)[0];
      if (sep) return { at: i, sep };
    }
  }
  return { at: -1, sep: "" };
}

/** The matching closing bracket of the opening one at `open`, or -1. */
export function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (OPEN.includes(text[i])) depth++;
    else if (CLOSE.includes(text[i])) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export const idsIn = (text: string) => identifiers(text).filter((t) => t.id).map((t) => t.text);

/** The names a binder list introduces: `x y : T`, `(x : T) (h : P)`, `x ∈ s`, `n ≥ 1`, `(a, b)`, `⟨a, b⟩`. */
export function binderNames(segment: string): string[] {
  const names: string[] = [];
  let rest = segment;
  for (;;) {
    rest = rest.trimStart();
    if (!rest) break;
    if (OPEN.includes(rest[0])) {
      const close = closing(rest, 0);
      if (close < 0) break;
      const inner = rest.slice(1, close);
      const colon = topIndexOf(inner, [":"]);
      // `[Fintype α]` names nothing; `[inst : Fintype α]`, `(x y : T)`, `(a, b)` do
      if (rest[0] !== "[" || colon.at >= 0) names.push(...idsIn(colon.at >= 0 ? inner.slice(0, colon.at) : inner));
      rest = rest.slice(close + 1);
      continue;
    }
    // bare names up to the type or the bound: everything after it is not a name
    const stop = topIndexOf(rest, [":", "∈", "∉", "⊆", "⊂", "<", "≤", ">", "≥", "≠"]);
    const open = [...rest].findIndex((c) => OPEN.includes(c));
    if (open >= 0 && (stop.at < 0 || open < stop.at)) {
      names.push(...idsIn(rest.slice(0, open)));
      rest = rest.slice(open);
      continue;
    }
    names.push(...idsIn(stop.at >= 0 ? rest.slice(0, stop.at) : rest));
    break;
  }
  return names;
}

export const BINDER_HEADS = ["∀", "∃!", "∃", "∑", "∏", "⋃", "⋂", "⨆", "⨅"];

/**
 * Every name the statement binds: the binders before the colon, lets, quantifiers and big
 * operators, `fun`, set-builder braces. In order of first appearance.
 */
export function boundNames(theoremType: string): string[] {
  const t = theoremType;
  const names: string[] = [];
  const add = (xs: string[]) => {
    for (const x of xs) if (!names.includes(x) && !KEYWORDS.has(x)) names.push(x);
  };
  const colon = splitTopLevelColon(t);
  if (colon?.binders) add(binderNames(colon.binders));
  for (let i = 0; i < t.length; i++) {
    const head = BINDER_HEADS.find((h) => t.startsWith(h, i));
    if (head) {
      const end = topIndexOf(t, [","], i + head.length);
      if (end.at >= 0) add(binderNames(t.slice(i + head.length, end.at)));
      i += head.length - 1;
      continue;
    }
    const word = /^(fun|let|λ)(?![A-Za-z0-9_'])/.exec(t.slice(i));
    if (word && (i === 0 || !new RegExp(`[${ID_CONT}.]`).test(t[i - 1]))) {
      const from = i + word[0].length;
      if (word[1] === "let") {
        ID_RE.lastIndex = from + (t.slice(from).length - t.slice(from).trimStart().length);
        const m = ID_RE.exec(t);
        if (m) add([m[0]]);
      } else {
        const end = topIndexOf(t, ["=>", "↦"], from);
        if (end.at >= 0) add(binderNames(t.slice(from, end.at)));
      }
      i = from - 1;
      continue;
    }
    if (t[i] === "{") {
      const close = closing(t, i);
      if (close < 0) continue;
      const inner = t.slice(i + 1, close);
      const bar = topIndexOf(inner, ["|"]);
      // `{x : T | …}`, `{x | …}`, `{(a, b) : T | …}`, `{x ∈ s | …}` — not `{|a - b|}`, not a literal `{1, 2}`
      if (bar.at > 0 && inner.slice(0, bar.at).trim() && topIndexOf(inner.slice(0, bar.at), [","]).at < 0 && /^[\s(⟨]*[A-Za-z_αβγδεζηθικμνξορςστυφχψω]/.test(inner)) add(binderNames(inner.slice(0, bar.at)));
    }
  }
  return names;
}

/** The statement with every bound name replaced as `map` says (names it does not list stay). */
export function renameBound(theoremType: string, map: Map<string, string>): string {
  let out = "";
  let at = 0;
  for (const tok of identifiers(theoremType)) {
    if (!tok.id) continue;
    const to = map.get(tok.text);
    if (to === undefined) continue;
    out += theoremType.slice(at, tok.start) + to;
    at = tok.end;
  }
  return out + theoremType.slice(at);
}
