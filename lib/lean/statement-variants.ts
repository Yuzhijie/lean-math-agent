/**
 * The same statement written another way: what a second formalization of a problem changes
 * without changing its meaning — the names of bound variables (a prime, another letter, a
 * subscript, the other case), `∀ x, P → Q` against `(x) (h : P) : Q`, `n ≥ 5` against `5 ≤ n`.
 * A prover the program wrote for a kind of statement
 * should prove every such variant; `npm run lean:variants` (lib/pipeline/prover-variants.ts)
 * measures whether it does, and Lean itself confirms each variant says the same thing
 * (`A ↔ B` by `Iff.rfl`: the two are equal up to renaming and unfolding `≥`).
 *
 * Pure text rewriting on the theorem type (`: P`, or binders before the colon). A rewrite that
 * cannot be done safely gives no variant rather than a doubtful one.
 */
import { splitTopLevelColon, typeToProp } from "./statement-prop";
import { boundNames, closing, CLOSE, GREEK, ID_CONT, ID_START, identifiers, KEYWORDS, OPEN, renameBound, topIndexOf } from "./statement-text";

export const VARIANT_KINDS = ["prime", "letters", "subscript", "case", "binders", "flip"] as const;
export type VariantKind = (typeof VARIANT_KINDS)[number];

export interface StatementVariant {
  kind: VariantKind;
  /** The theorem type, rewritten. */
  type: string;
  /** What was changed, for the report. */
  note: string;
}

const LATIN = "abcdefghijklmnopqrstuvwxyz";

/** name → new name for one renaming scheme; undefined when the scheme changes nothing. */
function renaming(theoremType: string, scheme: "prime" | "letters" | "subscript" | "case"): Map<string, string> | undefined {
  const bound = boundNames(theoremType);
  const used = new Set(identifiers(theoremType).map((t) => t.text));
  const map = new Map<string, string>();
  const fresh = (candidates: string[]): string | undefined => candidates.find((c) => !used.has(c) && !KEYWORDS.has(c) && ![...map.values()].includes(c));
  for (const name of bound) {
    let to: string | undefined;
    if (scheme === "prime") to = fresh([`${name}'`, `${name}''`]);
    else if (scheme === "subscript") {
      // the variables: `x` → `x₁` (how coordinates and sequences are often named)
      if ([...name].length === 1) to = fresh([`${name}₁`, `${name}₂`, `${name}₃`]);
    } else if (scheme === "letters") {
      const pool = (alphabet: string) => fresh([...alphabet.slice(alphabet.indexOf(name) + 3), ...alphabet.slice(0, alphabet.indexOf(name))].filter((c) => c !== name));
      if (name.length === 1 && LATIN.includes(name)) to = pool(LATIN);
      else if (name.length === 1 && LATIN.toUpperCase().includes(name)) to = pool(LATIN.toUpperCase());
      else if (name.length === 1 && GREEK.includes(name)) to = pool(GREEK);
      else to = fresh([`${name}₁`, `${name}₂`]);
    } else if (name.length > 1 && /^[A-Za-z]/.test(name)) {
      const toggled = (name[0] === name[0].toUpperCase() ? name[0].toLowerCase() : name[0].toUpperCase()) + name.slice(1);
      to = fresh([toggled, `${toggled}_`]);
    }
    if (to) map.set(name, to);
  }
  return map.size ? map : undefined;
}

const stripOuter = (s: string): string => {
  let t = s.trim();
  while (t.startsWith("(") && closing(t, 0) === t.length - 1) t = t.slice(1, -1).trim();
  return t;
};

/** `∀ x y : T, R` / `∀ (x : T) (h : P), R` → the binders as parenthesized groups and R; undefined for `∀ x ∈ s, …` and the like. */
function leadingForall(text: string): { groups: string; rest: string } | undefined {
  if (!text.startsWith("∀")) return undefined;
  const comma = topIndexOf(text, [","], 1);
  if (comma.at < 0) return undefined;
  const segment = text.slice(1, comma.at).trim();
  const rest = text.slice(comma.at + 1).trim();
  if (!segment || !rest) return undefined;
  if (OPEN.includes(segment[0])) {
    // only groups: `(x : T) {y : U} [inst]`
    let s = segment;
    while (s) {
      if (!"([{⦃".includes(s[0])) return undefined;
      const close = closing(s, 0);
      if (close < 0) return undefined;
      s = s.slice(close + 1).trimStart();
    }
    return { groups: segment, rest };
  }
  const colon = topIndexOf(segment, [":"]);
  // bare names with one type; a bound (`x ∈ s`, `n ≥ 1`) or no type at all is left alone
  if (colon.at < 0 || !/^[\sA-Za-z0-9_'₀-₉αβγδεζηθικμνξορςστυφχψω]+$/.test(segment.slice(0, colon.at))) return undefined;
  return { groups: `(${segment})`, rest };
}

const STARTS_BINDER = /^(∀|∃|∑|∏|fun\b|let\b|λ|¬)/;

/**
 * `: ∀ (x : T), P → Q → R` → `(x : T) (h₁ : P) (h₂ : Q) : R`, and a statement with binders before
 * the colon → `: ∀ binders, goal`. Undefined when neither applies.
 */
function binderVariant(theoremType: string): string | undefined {
  const parts = splitTopLevelColon(theoremType);
  if (!parts) return undefined;
  if (parts.binders) return `: ∀ ${parts.binders}, ${parts.goal}`;
  let rest = stripOuter(parts.goal);
  const used = new Set(identifiers(theoremType).map((t) => t.text));
  const groups: string[] = [];
  let hyp = 0;
  for (let round = 0; round < 8; round++) {
    const fa = leadingForall(rest);
    let moved = false;
    if (fa) {
      groups.push(fa.groups);
      rest = stripOuter(fa.rest);
      moved = true;
    }
    // the antecedents of an implication chain — not past a binder (its scope takes the rest) or an ↔ (it binds weaker)
    for (;;) {
      if (STARTS_BINDER.test(rest) || topIndexOf(rest, ["↔"]).at >= 0) break;
      const arrow = topIndexOf(rest, ["→"]);
      if (arrow.at < 0) break;
      const antecedent = rest.slice(0, arrow.at).trim();
      // `A ∧ ∀ x, P x → Q x`: the arrow is inside the quantifier's scope, not the statement's
      if (!antecedent || topIndexOf(antecedent, ["∀", "∃", "∑", "∏", "fun ", "let ", "λ"]).at >= 0) break;
      const named = antecedent.startsWith("(") && closing(antecedent, 0) === antecedent.length - 1 ? topIndexOf(antecedent.slice(1, -1), [":"]) : undefined;
      if (named && named.at >= 0 && new RegExp(`^\\s*[${ID_START}][\\s${ID_CONT}]*$`).test(antecedent.slice(1, 1 + named.at))) {
        // `(D E : ℝ × ℝ) → …`: a binder written with an arrow, not a hypothesis
        groups.push(antecedent);
      } else {
        let name = `hv${++hyp}`;
        while (used.has(name)) name = `hv${++hyp}`;
        groups.push(`(${name} : ${stripOuter(antecedent)})`);
      }
      rest = stripOuter(rest.slice(arrow.at + 1));
      moved = true;
    }
    if (!moved) break;
  }
  return groups.length ? `${groups.join(" ")} : ${rest}` : undefined;
}

const RELS: Record<string, string> = { "≤": "≥", "≥": "≤", "<": ">", ">": "<" };
const BEFORE_OPERAND = /(^|[(,:|;]|→|∧|∨|↔|¬|=>|:=)\s*$/;
const AFTER_OPERAND = /^\s*($|[),;\]}]|→|∧|∨|↔)/;
const ATOM_LEFT = new RegExp(`(?:[${ID_START}][${ID_CONT}.]*|[0-9]+(?:\\.[0-9]+)?)$`);
const ATOM_RIGHT = new RegExp(`^(?:[${ID_START}][${ID_CONT}.]*|[0-9]+(?:\\.[0-9]+)?)`);

/**
 * Every comparison between two plain operands (a name, a number, one parenthesized term) turned
 * round: `0 < n` → `n > 0`, `k ≤ (n + 1)` → `(n + 1) ≥ k`. Operands that are part of something
 * larger (`x + y ≤ 10`, `f n < 3`) and bounds in binders (`∀ n ≥ 1`) are left as they are.
 */
function flipVariant(theoremType: string): { type: string; count: number } {
  let out = "";
  let at = 0;
  let count = 0;
  const t = theoremType;
  for (let i = 0; i < t.length; i++) {
    if (!(t[i] in RELS) || t[i - 1] !== " " || t[i + 1] !== " ") continue;
    // left operand, ending just before the space
    const leftEnd = i - 1;
    let leftStart: number;
    if (t[leftEnd - 1] === ")") {
      let depth = 0;
      leftStart = -1;
      for (let k = leftEnd - 1; k >= at; k--) {
        if (CLOSE.includes(t[k])) depth++;
        else if (OPEN.includes(t[k])) {
          depth--;
          if (depth === 0) {
            leftStart = k;
            break;
          }
        }
      }
      // `f (x)`, `s.filter (…)`: an application, not a plain operand
      if (leftStart < 0 || new RegExp(`[${ID_CONT}.]\\s*$`).test(t.slice(0, leftStart))) continue;
    } else {
      const m = ATOM_LEFT.exec(t.slice(at, leftEnd));
      if (!m) continue;
      leftStart = leftEnd - m[0].length;
    }
    if (!BEFORE_OPERAND.test(t.slice(0, leftStart))) continue;
    // right operand, starting just after the space
    const rightStart = i + 2;
    let rightEnd: number;
    if (t[rightStart] === "(") {
      const close = closing(t, rightStart);
      if (close < 0) continue;
      rightEnd = close + 1;
    } else {
      const m = ATOM_RIGHT.exec(t.slice(rightStart));
      if (!m) continue;
      rightEnd = rightStart + m[0].length;
    }
    if (!AFTER_OPERAND.test(t.slice(rightEnd))) continue;
    out += `${t.slice(at, leftStart)}${t.slice(rightStart, rightEnd)} ${RELS[t[i]]} ${t.slice(leftStart, leftEnd)}`;
    at = rightEnd;
    i = rightEnd - 1;
    count++;
  }
  return { type: out + t.slice(at), count };
}

/** The variants of a statement, at most one of each kind, each different from the statement. */
export function statementVariants(theoremType: string, kinds: readonly VariantKind[] = VARIANT_KINDS): StatementVariant[] {
  const out: StatementVariant[] = [];
  const base = theoremType.trim();
  const push = (kind: VariantKind, type: string | undefined, note: string) => {
    if (type && type.trim() !== base && !out.some((v) => v.type === type)) out.push({ kind, type: type.trim(), note });
  };
  for (const kind of kinds) {
    if (kind === "prime" || kind === "letters" || kind === "subscript" || kind === "case") {
      const map = renaming(base, kind);
      if (map) push(kind, renameBound(base, map), [...map].map(([a, b]) => `${a} → ${b}`).join(", "));
    } else if (kind === "binders") {
      const v = binderVariant(base);
      push(kind, v, v?.startsWith(":") ? "binders moved behind the colon as ∀" : "∀ and the hypotheses moved before the colon");
    } else {
      const f = flipVariant(base);
      if (f.count) push(kind, f.type, `${f.count} comparison(s) turned round`);
    }
  }
  return out;
}

/**
 * The statement of "the variant says what the statement says", as a theorem type: `A ↔ B`,
 * which `exact Iff.rfl` proves when the two differ only by renaming, by where the binders stand
 * and by `≥` for `≤`.
 */
export function equivalenceType(theoremType: string, variantType: string): string | undefined {
  // `Type*` is a new universe each time it is written, and so is `Type _` in a theorem's
  // statement: two of them are not the same proposition. One named universe on both sides is
  // (the theorem then declares it: `theorem NAME.{u_same} …`).
  const oneUniverse = (t: string | null) => t?.replace(/\b(Type|Sort)\*/g, `$1 ${EQUIVALENCE_UNIVERSE}`);
  const a = oneUniverse(typeToProp(theoremType));
  const b = oneUniverse(typeToProp(variantType));
  return a && b ? `: (${a}) ↔ (${b})` : undefined;
}

/** The universe equivalenceType writes for `Type*`; a statement that has it is declared `NAME.{u_same}`. */
export const EQUIVALENCE_UNIVERSE = "u_same";

/** The one tactic that proves it. */
export const EQUIVALENCE_TACTIC = "exact Iff.rfl";
