/**
 * The one way of writing a statement that the provers read.
 *
 * A prover the program wrote recognises its kind of statement in the text and in the goals Lean
 * prints. The same statement can be written in several ways — `n ≥ 5` or `5 ≤ n`, `∀ ε > 0, P` or
 * `∀ ε, 0 < ε → P`, `m'` or `x₁` for a bound name — and a prover written on one of them does not
 * see its statement in the others (measured: `npm run lean:variants`, bench/VARIANTS.md). So the
 * stages that read the statement (lib/lean/prover-stages.ts) get it in one form:
 *
 *   1. bound names with a prime or a subscript become plain ones (`n'` → another letter,
 *      `x₁` → `x_1`, `h₀` → `h_0`);
 *   2. a bound in a binder that points the other way is written out
 *      (`∀ x > a, P` → `∀ x, a < x → P`; `∃ x ≥ a, P` → `∃ x, a ≤ x ∧ P`);
 *   3. every `≥` and `>` whose two sides can be told from the text is turned round into `≤`, `<`.
 *
 * Each step keeps the meaning (renaming a bound name; what the binder notation unfolds to; `a ≥ b`
 * is by definition `b ≤ a`). Nothing here is trusted, though: a proof found for the reading form
 * is checked by Lean against the statement as it was written (inOriginal in
 * lib/lean/prover-stages.ts, with originalSource and bridgeBody below), and
 * a rewrite that cannot be done safely is not done — the text stays as it is there.
 *
 * Pure text; no Lean, no model.
 */
import { splitTopLevelColon } from "./statement-prop";
import { boundNames, closing, GREEK, ID_CONT, ID_START, identifiers, OPEN, renameBound, topIndexOf } from "./statement-text";

export interface ReadingForm {
  /** The statement as the provers read it. */
  type: string;
  /** Whether it differs from the statement as written. */
  changed: boolean;
  /** The names it gave: reading name → the name in the statement. */
  names: Map<string, string>;
}

// ── 1. plain names ──────────────────────────────────────────────────────

const SUBSCRIPTS = "₀₁₂₃₄₅₆₇₈₉";
const ALPHABETS = ["abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRSTUVWXYZ", GREEK];

/**
 * A plain name for a bound name with a prime or a subscript, one nothing else in the statement
 * has. A primed letter becomes another letter of its alphabet (`n'` → `o`): the provers were
 * written on one-letter variables, and any letter does. Otherwise the marks are spelled out
 * (`x₁` → `x_1`, `Valid'` → `Valid_p`, `a₁₂''` → `a_12_pp`).
 */
function plainName(name: string, used: Set<string>): string {
  const letter = /^(.)'+$/u.exec(name)?.[1];
  const alphabet = letter && ALPHABETS.find((a) => a.includes(letter));
  if (letter && alphabet) {
    const from = alphabet.indexOf(letter);
    const free = [...alphabet.slice(from + 1), ...alphabet.slice(0, from)].find((c) => !used.has(c));
    if (free) return free;
  }
  let to = name.replace(/[₀-₉]+/g, (d) => `_${[...d].map((c) => SUBSCRIPTS.indexOf(c)).join("")}`).replace(/'+/g, (p) => `_${"p".repeat(p.length)}`);
  while (used.has(to)) to += "_";
  return to;
}

/**
 * Bound names with a prime or a subscript replaced by plain ones — the binders before the colon
 * too: one rule for every bound name, so that a prover meets no prime and no subscript in the
 * statement or in the goals Lean prints; a proof that names them is given the statement's own
 * names back (scriptInOriginalNames).
 */
function plainNames(theoremType: string): { type: string; names: Map<string, string> } {
  const used = new Set(identifiers(theoremType).map((t) => t.text));
  const map = new Map<string, string>();
  for (const name of boundNames(theoremType)) {
    if (!/['₀-₉]/.test(name)) continue;
    const to = plainName(name, used);
    used.add(to);
    map.set(name, to);
  }
  if (!map.size) return { type: theoremType, names: new Map() };
  return { type: renameBound(theoremType, map), names: new Map([...map].map(([from, to]) => [to, from])) };
}

// ── 2. bounds in binders ────────────────────────────────────────────────

const BRACKET_OPEN = `${OPEN}⌊⌈`;
const BRACKET_CLOSE = ")]}⟩⦄⌋⌉";

/** Where the scope that starts at `from` ends: the first bracket closed that was not opened in it, a `;` or the `then` / `else` of an `if` around it outside brackets, or the end. */
function scopeEnd(t: string, from: number): number {
  let depth = 0;
  for (let i = from; i < t.length; i++) {
    if (BRACKET_OPEN.includes(t[i])) depth++;
    else if (BRACKET_CLOSE.includes(t[i])) {
      if (depth === 0) return i;
      depth--;
    } else if (depth === 0) {
      if (t[i] === ";") return i;
      const w = wordAt(t, i);
      if (w === "then" || w === "else") return i;
      if (w) i += w.length - 1;
    }
  }
  return t.length;
}

const hasTop = (text: string, seps: string[]) => topIndexOf(text, seps).at >= 0;
const BOUND_BINDER = new RegExp(`(∀|∃)(\\s*)([${ID_START}][${ID_CONT}]*)\\s*(≥|>)\\s*`, "g");

/** `∀ x > a, P` → `∀ x, a < x → P` and `∃ x ≥ a, P` → `∃ x, a ≤ x ∧ P`: what the notation stands for, with the comparison turned round. */
export function expandBinderBounds(text: string): string {
  let t = text;
  let from = 0;
  for (let guard = 0; guard < 200; guard++) {
    BOUND_BINDER.lastIndex = from;
    const m = BOUND_BINDER.exec(t);
    if (!m) break;
    const [, quantifier, gap, name, rel] = m;
    const after = m.index + m[0].length;
    const comma = topIndexOf(t, [","], after);
    const bound = comma.at >= 0 ? t.slice(after, comma.at).trim() : "";
    // the bound is one term: nothing in it that ends a term
    if (!bound || hasTop(bound, ["∧", "∨", "→", "↔", ";", ":", "=", "≤", "<", "≥", ">"])) {
      from = after;
      continue;
    }
    const end = scopeEnd(t, comma.at + 1);
    const body = t.slice(comma.at + 1, end);
    const inner = body.trim();
    if (!inner) {
      from = after;
      continue;
    }
    const lead = /^\s*/.exec(body)![0] || " ";
    const trail = /\s*$/.exec(body)![0];
    const op = rel === ">" ? "<" : "≤";
    // `→` binds tighter than `↔`, `∧` tighter than `∨`, `→`, `↔`: the scope keeps its extent in brackets
    const scoped = quantifier === "∀" ? (hasTop(inner, ["↔"]) ? `(${inner})` : inner) : hasTop(inner, ["∨", "→", "↔"]) ? `(${inner})` : inner;
    t = `${t.slice(0, m.index)}${quantifier}${gap}${name},${lead}${bound} ${op} ${name} ${quantifier === "∀" ? "→" : "∧"} ${scoped}${trail}${t.slice(end)}`;
    from = m.index + quantifier.length;
  }
  return t;
}

// ── 3. comparisons ──────────────────────────────────────────────────────

/** A comparison that was looked at and stays as written: marked, so that it is not looked at again — and still a relation to its neighbours. */
const KEPT_GE = "\uE000";
const KEPT_GT = "\uE001";
const RELATIONS = `=≠<>≤≥∣∈∉⊆⊂⊇⊃≡≈∼${KEPT_GE}${KEPT_GT}`;
const QUANTIFIERS = "∀∃λ";
const BIG_OPERATORS = "∑∏⋃⋂⨆⨅∫";
const WORD_AT = new RegExp(`[${ID_START}][${ID_CONT}]*`, "y");
const NAME_CHAR = new RegExp(`[${ID_CONT}.]`);
/** Words a comparison's side ends at / words that are no part of a side at all. */
const ENDS_SIDE = new Set(["if", "then", "else", "by", "with", "in", "at", "do", "from", "show", "have"]);
const NO_SIDE = new Set(["fun", "let"]);

/** The word that starts at `i` (a whole word, not the tail of a name), or undefined. */
function wordAt(t: string, i: number): string | undefined {
  if (i > 0 && NAME_CHAR.test(t[i - 1])) return undefined;
  WORD_AT.lastIndex = i;
  return WORD_AT.exec(t)?.[0];
}

const NAME_PART = new RegExp(`[${ID_CONT}]`);

/** The word that ends at `i` (inclusive), or undefined. */
function wordEndingAt(t: string, i: number): string | undefined {
  if (i + 1 < t.length && NAME_PART.test(t[i + 1])) return undefined;
  let k = i;
  while (k >= 0 && NAME_PART.test(t[k])) k--;
  if (k >= 0 && t[k] === ".") return undefined;
  return wordAt(t, k + 1) === t.slice(k + 1, i + 1) ? t.slice(k + 1, i + 1) : undefined;
}

/** The binder a comma closes: where its head stands and whether it is a big operator (`∑ i ∈ s,`), or undefined (`∀ x,`: the comma ends what is before it). */
function bigOperatorOf(t: string, comma: number): number | undefined {
  let depth = 0;
  for (let k = comma - 1; k >= 0; k--) {
    const c = t[k];
    if (BRACKET_CLOSE.includes(c)) depth++;
    else if (BRACKET_OPEN.includes(c)) {
      if (depth === 0) return undefined;
      depth--;
    } else if (depth === 0) {
      if (c === "," || c === ";") return undefined;
      if (BIG_OPERATORS.includes(c)) return k;
      if (QUANTIFIERS.includes(c)) return undefined;
      const w = wordEndingAt(t, k);
      if (w && NO_SIDE.has(w)) return undefined;
    }
  }
  return undefined;
}

/** Where the left side of the comparison at `i` starts, or -1 when the text does not say. */
function leftSideStart(t: string, i: number): number {
  let depth = 0;
  let start = 0;
  const bars: number[] = [];
  scan: for (let k = i - 1; k >= 0; k--) {
    const c = t[k];
    if (BRACKET_CLOSE.includes(c)) {
      depth++;
      continue;
    }
    if (BRACKET_OPEN.includes(c)) {
      if (depth === 0) {
        start = k + 1;
        break;
      }
      depth--;
      continue;
    }
    if (depth > 0) continue;
    switch (c) {
      case "|":
        // `||`, `|>`, `<|`: not a bar of an absolute value or of a set
        if (t[k + 1] === "|" || t[k - 1] === "|" || t[k + 1] === ">" || t[k - 1] === "<") return -1;
        bars.push(k);
        continue;
      case ",": {
        const head = bigOperatorOf(t, k);
        if (head === undefined) {
          start = k + 1;
          break scan;
        }
        k = head; // `∑ i ∈ s, f i ≥ 5`: the sum is the left side
        continue;
      }
      case ";":
      case ":":
      case "∧":
      case "∨":
      case "→":
      case "↔":
      case "¬":
      case "↦":
        start = k + 1;
        break scan;
      case "=":
        if (t[k - 1] !== ":") return -1;
        start = k + 1; // `:=`
        break scan;
      case ">":
        if (t[k - 1] !== "=" && t[k - 1] !== "-") return -1;
        start = k + 1; // `=>`, `->`
        break scan;
      case "/":
        if (t[k - 1] !== "/") continue;
        start = k + 1; // `{x : T // p x}`
        break scan;
      default:
        break;
    }
    if (RELATIONS.includes(c)) return -1; // `a = b ≥ c`: not one comparison
    if (QUANTIFIERS.includes(c) || BIG_OPERATORS.includes(c)) return -1; // `∀ n ≥ 5,`: a bound in a binder
    const w = wordEndingAt(t, k);
    if (w) {
      if (NO_SIDE.has(w)) return -1;
      if (ENDS_SIDE.has(w)) {
        start = k + 1;
        break;
      }
      k -= w.length - 1;
    }
  }
  // bars: `|x|` come in pairs; an odd one is the bar of `{x | …}`, the first of them
  bars.sort((a, b) => a - b);
  const inSide = bars.filter((b) => b >= start);
  if (inSide.length % 2 === 1) start = inSide[0] + 1;
  return t.slice(start, i).trim() ? start : -1;
}

/** Where the right side of the comparison at `i` ends (exclusive), or -1. */
function rightSideEnd(t: string, i: number): number {
  let depth = 0;
  let bars = 0;
  let pending = 0;
  let end = t.length;
  scan: for (let j = i + 1; j < t.length; j++) {
    const c = t[j];
    if (BRACKET_OPEN.includes(c)) {
      depth++;
      continue;
    }
    if (BRACKET_CLOSE.includes(c)) {
      if (depth === 0) {
        end = j;
        break;
      }
      depth--;
      continue;
    }
    if (depth > 0) continue;
    if (pending > 0) {
      // in the binder of a `∑ i ∈ s,` on this side: up to its comma
      if (c === ",") pending--;
      else if (BIG_OPERATORS.includes(c)) pending++;
      continue;
    }
    switch (c) {
      case "|":
        if (t[j + 1] === "|" || t[j - 1] === "|" || t[j + 1] === ">" || t[j - 1] === "<") return -1;
        bars++;
        continue;
      case ",":
        end = j;
        break scan;
      case ";":
      case ":":
      case "∧":
      case "∨":
      case "→":
      case "↔":
        end = j;
        break scan;
      case "/":
        if (t[j + 1] === "/") return -1;
        continue;
      default:
        break;
    }
    if (BIG_OPERATORS.includes(c)) {
      pending++;
      continue;
    }
    if (RELATIONS.includes(c) || QUANTIFIERS.includes(c) || c === "¬" || c === "↦") return -1;
    const w = wordAt(t, j);
    if (w) {
      if (NO_SIDE.has(w) || w === "if" || w === "by" || w === "have" || w === "show" || w === "from") return -1;
      if (ENDS_SIDE.has(w)) {
        end = j;
        break;
      }
      j += w.length - 1;
    }
  }
  if (bars % 2 === 1 || pending > 0) return -1;
  return t.slice(i + 1, end).trim() ? end : -1;
}

/**
 * Every `a ≥ b` → `b ≤ a` and `a > b` → `b < a` whose two sides the text delimits: up to a
 * connective, a comma, a bracket, a keyword. A comparison it cannot delimit safely (a bound in a
 * binder, a chain, an unusual operator next to it) stays as written.
 */
export function comparisonsLeft(text: string): string {
  let t = text;
  for (let guard = 0; guard < 500; guard++) {
    let at = -1;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === "≥") {
        at = i;
        break;
      }
      // `=>`, `->`, `|>`, `>>`, `>=`: not the relation
      if (t[i] === ">" && !"=-|>".includes(t[i - 1] ?? " ") && !">=".includes(t[i + 1] ?? " ")) {
        at = i;
        break;
      }
    }
    if (at < 0) break;
    const ge = t[at] === "≥";
    const start = leftSideStart(t, at);
    const end = start < 0 ? -1 : rightSideEnd(t, at);
    if (start < 0 || end < 0) {
      t = `${t.slice(0, at)}${ge ? KEPT_GE : KEPT_GT}${t.slice(at + 1)}`;
      continue;
    }
    const left = t.slice(start, at);
    const right = t.slice(at + 1, end);
    const lead = /^\s*/.exec(left)![0];
    const trail = /\s*$/.exec(right)![0];
    t = `${t.slice(0, start)}${lead}${right.trim()} ${ge ? "≤" : "<"} ${left.trim()}${trail}${t.slice(end)}`;
  }
  return t.replaceAll(KEPT_GE, "≥").replaceAll(KEPT_GT, ">");
}

// ── the reading form ────────────────────────────────────────────────────

const cache = new Map<string, ReadingForm>();

/** The statement as the provers read it (see the top of this file). */
export function readingForm(theoremType: string): ReadingForm {
  // PROVER_READING_FORM=0: the provers get the statement as written (to measure what the reading form is worth)
  if (process.env.PROVER_READING_FORM === "0") return { type: theoremType, changed: false, names: new Map() };
  const hit = cache.get(theoremType);
  if (hit) return hit;
  let form: ReadingForm;
  try {
    const plain = plainNames(theoremType);
    const type = comparisonsLeft(expandBinderBounds(plain.type));
    form = { type, changed: type !== theoremType, names: plain.names };
  } catch {
    form = { type: theoremType, changed: false, names: new Map() }; // text this cannot read: as written
  }
  if (cache.size > 500) cache.clear();
  cache.set(theoremType, form);
  return form;
}

// ── back to the statement as written ────────────────────────────────────

/** A script written for the reading form, with the names of the statement as written. */
export function scriptInOriginalNames(tactics: string, form: ReadingForm): string {
  return form.names.size ? renameBound(tactics, form.names) : tactics;
}

/** The script of a source's body: without the two spaces every line of it has. */
export const unindent = (body: string) => body.replace(/\n+$/, "").replace(/^ {2}/gm, "");

const indentBy = (s: string, n: number) =>
  s
    .split("\n")
    .map((line) => (line.trim() ? `${" ".repeat(n)}${line}` : line))
    .join("\n");

/**
 * The source of a proof of the statement as written, from the source of a proof of its reading
 * form (as a prover assembled it: options, opens, `theorem NAME TYPE := by`, the script): the
 * same script with the statement's own names, under the statement as written. Undefined when the
 * source is not of that shape.
 */
export function originalSource(source: string, theoremName: string, theoremType: string, form: ReadingForm): { source: string; tactics: string } | undefined {
  const head = `theorem ${theoremName} ${form.type} := by\n`;
  const at = source.indexOf(head);
  if (at < 0) return undefined;
  const body = scriptInOriginalNames(source.slice(at + head.length), form);
  return { source: `${source.slice(0, at)}theorem ${theoremName} ${theoremType} := by\n${body}`, tactics: unindent(body) };
}

/** The names `intro` takes for a binder list, in order (`_` for an instance without a name), and those passed back explicitly. */
function binderIntro(binders: string): { intro: string[]; explicit: string[] } | undefined {
  const intro: string[] = [];
  const explicit: string[] = [];
  let rest = binders.trim();
  while (rest) {
    if (!OPEN.includes(rest[0])) return undefined;
    const close = closing(rest, 0);
    if (close < 0) return undefined;
    const inner = rest.slice(1, close);
    const colon = topIndexOf(inner, [":"]);
    if (colon.at < 0) {
      if (rest[0] !== "[") return undefined;
      intro.push("_");
    } else {
      const names = inner.slice(0, colon.at).trim().split(/\s+/).filter(Boolean);
      if (!names.length || names.some((n) => !new RegExp(`^[${ID_START}][${ID_CONT}]*$`).test(n) && n !== "_")) return undefined;
      intro.push(...names);
      if (rest[0] === "(") explicit.push(...names);
    }
    rest = rest.slice(close + 1).trim();
  }
  return { intro, explicit };
}

/**
 * When the script does not run under the statement as written (it matches the reading form's
 * spelling somewhere): the reading form proved as a `have` inside the proof of the statement as
 * written, which then follows from it — the two are the same proposition. `body` is the script,
 * indented as in a source (two spaces), with the statement's own names. Undefined for a statement
 * with a universe written `Type*` among its binders (it cannot be restated inside a proof).
 */
export function bridgeBody(form: ReadingForm, body: string): string | undefined {
  // the reading form with the statement's own names: only the spelling differs from the statement
  const reading = form.names.size ? renameBound(form.type, form.names) : form.type;
  const parts = splitTopLevelColon(reading);
  if (!parts?.goal) return undefined;
  if (/\b(Type|Sort)\*/.test(parts.binders)) return undefined;
  const script = indentBy(body.replace(/\n+$/, ""), 2);
  if (!parts.binders) return [`  have reading : ${parts.goal} := by`, script, "  exact reading"].join("\n");
  const names = binderIntro(parts.binders);
  if (!names) return undefined;
  return [`  have reading : ∀ ${parts.binders}, ${parts.goal} := by`, `    intro ${names.intro.join(" ")}`, script, `  exact reading ${names.explicit.join(" ")}`.trimEnd()].join("\n");
}
