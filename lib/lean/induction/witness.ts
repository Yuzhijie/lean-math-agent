/**
 * The quotient for a divisibility step `d ∣ E(k + 1)` from `hm : E(k) = d * m`, computed exactly:
 * E is a polynomial in k and in powers b ^ (a·k + c) with numeric b. For a constant multiplier
 * c (1, or b ^ a for a power in E — 8 for 8 ^ k, 9 for 3 ^ (2 k)) the rest E(k + 1) − c·E(k)
 * must have every coefficient divisible by d; then E(k + 1) = d · (c·m + rest / d).
 *
 * Two spellings of the quotient: with the bases as written, `(3 ^ k) ^ 2` for 3 ^ (2 k) — what
 * `ring` (inside linear_combination) identifies with the statement's powers — and flat, `9 ^ k`,
 * for omega in ℕ with subtraction after the powers are normalized (omega needs it linear).
 *   7 ∣ 8 ^ k - 1 → 8 ^ (k+1) - 1 = 7 · (8 m + 1);   7 ∣ 3 ^ (2k) - 2 ^ k → 7 · (9 m + 2 ^ k).
 */
import { ParseError, parseTerm, unwrap, type Node } from "../geometry/expr";
import { Frac, NotPolynomial, Poly } from "../geometry/poly";

export interface DvdWitness {
  /** Lean text of W in E(k + 1) = d * W with the statement's bases (for linear_combination). */
  quotient: string;
  /** W with every power as (b ^ a) ^ k → `9 ^ k`; undefined when it is not linear (omega). */
  flat?: string;
  /** The c of `linear_combination c * hm`. */
  multiplier: string;
  divisor: bigint;
  /** Bases of the flat powers (`9` for 9 ^ k), for the facts 1 ≤ b ^ k. */
  bases: bigint[];
  /** Some exponent is a·k + c with a > 1: the flat form needs the powers normalized first. */
  scaled: boolean;
}

/** Split `A ∣ B` at its top-level `∣`. */
export function splitDvd(text: string): [string, string] | undefined {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if ("([{⟨".includes(c)) depth++;
    else if (")]}⟩".includes(c)) depth--;
    else if (c === "∣" && depth === 0) return [text.slice(0, i).trim(), text.slice(i + 1).trim()];
  }
  return undefined;
}

class Vars {
  /** index 0 = k, then one variable per base (`b ^ k`), m is added last */
  readonly names: string[];
  readonly bases = new Map<string, number>();
  /** b ^ a for every power b ^ (a k + c) met: the multipliers to try */
  readonly multipliers = new Set<string>();
  scaled = false;
  constructor(
    readonly k: string,
    /** flat: one variable per b ^ a (`9 ^ k`); else per b (`(3 ^ k) ^ 2`) */
    readonly flat: boolean,
  ) {
    this.names = [k];
  }
  base(value: bigint): number {
    const key = value.toString();
    let i = this.bases.get(key);
    if (i === undefined) {
      i = this.names.length;
      this.bases.set(key, i);
      this.names.push(`${value < 0n ? `(${value})` : value} ^ ${this.k}`);
    }
    return i;
  }
}

function intConst(p: Poly): bigint | undefined {
  const c = p.constValue();
  return c && c.d === 1n ? c.n : undefined;
}

function conv(n: Node, v: Vars): Poly {
  switch (n.k) {
    case "num":
      return Poly.const(Frac.parse(n.text));
    case "ident":
      if (n.name === v.k) return Poly.variable(0);
      throw new NotPolynomial(`unknown name ${n.name}`);
    case "paren":
    case "asc":
    case "cast":
      return conv(n.a, v);
    case "neg":
      return conv(n.a, v).neg();
    case "bin": {
      if (n.op === "+") return conv(n.a, v).add(conv(n.b, v));
      if (n.op === "-") return conv(n.a, v).sub(conv(n.b, v));
      if (n.op === "*") return conv(n.a, v).mul(conv(n.b, v));
      if (n.op === "^") {
        const e = conv(n.b, v);
        const ec = intConst(e);
        if (ec !== undefined) {
          if (ec < 0n || ec > 64n) throw new NotPolynomial("exponent out of range");
          return conv(n.a, v).pow(Number(ec));
        }
        // b ^ (a k + c), b a number
        const b = intConst(conv(n.a, v));
        if (b === undefined) throw new NotPolynomial("power of a non-number with a variable exponent");
        if (e.degree() !== 1 || [...e.vars()].some((x) => x !== 0)) throw new NotPolynomial("exponent not linear in k");
        const a = e.terms.get("v0");
        const c = e.terms.get("") ?? new Frac(0n);
        if (!a || a.d !== 1n || c.d !== 1n || a.n <= 0n || c.n < 0n || a.n > 8n || c.n > 16n) throw new NotPolynomial("exponent out of range");
        if (b === 0n) throw new NotPolynomial("power of zero");
        const coef = Poly.const(new Frac(b ** c.n));
        if (b === 1n) return coef;
        v.multipliers.add((b ** a.n).toString());
        if (a.n > 1n) v.scaled = true;
        return v.flat ? coef.mul(Poly.variable(v.base(b ** a.n))) : coef.mul(Poly.variable(v.base(b)).pow(Number(a.n)));
      }
      throw new NotPolynomial(`operator ${n.op}`);
    }
    default:
      throw new NotPolynomial(`term ${n.k}`);
  }
}

interface Split {
  c: bigint;
  q: Poly;
  names: string[];
  vars: Vars;
}

function splits(d: bigint, src1: string, src0: string, k: string, mName: string, flat: boolean): Split[] {
  const v = new Vars(k, flat);
  const e1 = conv(parseTerm(src1), v);
  const e0 = conv(parseTerm(src0), v);
  const m = v.names.length;
  const names = [...v.names, mName];
  const out: Split[] = [];
  for (const c of [1n, ...[...v.multipliers].map((x) => BigInt(x))]) {
    const rest = e1.sub(e0.scale(new Frac(c)));
    if ([...rest.terms.values()].some((x) => x.d !== 1n || x.n % d !== 0n)) continue;
    out.push({ c, q: rest.scale(new Frac(1n, d)).add(Poly.variable(m).scale(new Frac(c))), names, vars: v });
  }
  return out;
}

/** Simpler first: fewer powers in the quotient, then fewer terms (8 m + 1 before m + 8 ^ k). */
function size(s: Split): number {
  const m = s.names.length - 1;
  return [...s.q.vars()].filter((x) => x !== 0 && x !== m).length * 100 + s.q.terms.size;
}

/**
 * The witnesses for `target` (`d ∣ E(k+1)`, as Lean prints it with the step's names) from the
 * induction hypothesis `ih` (`d ∣ E(k)`), simplest first; none when the expressions are out of
 * reach or no constant multiplier leaves a rest divisible by d.
 */
export function divisibilityWitnesses(target: string, ih: string, k: string, mName = "m"): DvdWitness[] {
  const t = splitDvd(target);
  const h = splitDvd(ih);
  if (!t || !h || t[0].replace(/\s+/g, "") !== h[0].replace(/\s+/g, "")) return [];
  try {
    const d = intConst(conv(unwrap(parseTerm(t[0])), new Vars(k, false)));
    if (d === undefined || d <= 1n) return [];
    const ring = splits(d, t[1], h[1], k, mName, false).sort((a, b) => size(a) - size(b));
    const flat = splits(d, t[1], h[1], k, mName, true);
    return ring.map((s) => {
      const f = flat.find((x) => x.c === s.c);
      return {
        quotient: s.q.toLean(s.names),
        ...(f && f.q.degree() <= 1 ? { flat: f.q.toLean(f.names) } : {}),
        multiplier: s.c < 0n ? `(${s.c})` : s.c.toString(),
        divisor: d,
        bases: f ? [...f.vars.bases.keys()].map((x) => BigInt(x)) : [],
        scaled: s.vars.scaled,
      };
    });
  } catch (e) {
    if (e instanceof NotPolynomial || e instanceof ParseError) return [];
    throw e;
  }
}
