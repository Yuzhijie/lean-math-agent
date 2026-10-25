/**
 * A statement written as a chain of `let`s (`: (let V : T := v; let W := w; body)`), split into
 * its definitions and its body — at the top level only (brackets, braces and `⟨⟩` nest).
 */
export interface LetDef {
  name: string;
  /** Declared type, when written (`let V : T := v`). */
  type?: string;
  value: string;
}

const OPEN = "([{⟨";
const CLOSE = ")]}⟩";

/** Index of `sep` at depth 0 from `from`, or -1. */
export function topIndex(s: string, sep: string, from = 0): number {
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    else if (depth === 0 && s.startsWith(sep, i)) return i;
  }
  return -1;
}

/** `(…)` around the whole text removed (once or more). */
export function stripParens(s: string): string {
  let t = s.trim();
  for (;;) {
    if (!t.startsWith("(") || !t.endsWith(")")) return t;
    let depth = 0;
    let closesAtEnd = true;
    for (let i = 0; i < t.length; i++) {
      if (OPEN.includes(t[i])) depth++;
      else if (CLOSE.includes(t[i])) depth--;
      if (depth === 0 && i < t.length - 1) {
        closesAtEnd = false;
        break;
      }
    }
    if (!closesAtEnd) return t;
    t = t.slice(1, -1).trim();
  }
}

export const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** The lets of a theorem type with no binders before the colon; undefined when it is not a let chain. */
export function splitLets(theoremType: string): { lets: LetDef[]; body: string } | undefined {
  let t = squash(theoremType);
  if (!t.startsWith(":")) return undefined;
  t = stripParens(t.slice(1));
  const lets: LetDef[] = [];
  while (t.startsWith("let ")) {
    const head = /^let ([A-Za-z_][\w'₀-₉]*)\s*/.exec(t);
    if (!head) return undefined;
    let rest = t.slice(head[0].length);
    let type: string | undefined;
    if (rest.startsWith(":") && !rest.startsWith(":=")) {
      const eq = topIndex(rest, ":=");
      if (eq < 0) return undefined;
      type = rest.slice(1, eq).trim();
      rest = rest.slice(eq);
    }
    if (!rest.startsWith(":=")) return undefined;
    rest = rest.slice(2);
    const semi = topIndex(rest, ";");
    if (semi < 0) return undefined;
    lets.push({ name: head[1], ...(type ? { type } : {}), value: rest.slice(0, semi).trim() });
    t = stripParens(rest.slice(semi + 1).trim());
  }
  return lets.length ? { lets, body: t } : undefined;
}
