/**
 * Sparse polynomials with exact rational coefficients, built from parsed Lean terms. Local real
 * variables stay variables; everything else that is not arithmetic — `√E`, `|E|`, `Real.cos c`,
 * `Real.pi`, casts — becomes an atom (a fresh variable remembered with its exact source text),
 * which is how `ring` / `linear_combination` treat it too.
 */
import { slice, unwrap, type Node } from "./expr";

export class NotPolynomial extends Error {}

/** Expansion limits (scripts/poly_certificate.py has the same): beyond them a term is not used. */
export const MAX_DEGREE = 64;
export const MAX_TERMS = 4000;

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
}

export class Frac {
  readonly n: bigint;
  readonly d: bigint;
  constructor(n: bigint, d: bigint = 1n) {
    if (d === 0n) throw new NotPolynomial("division by zero");
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(n, d) || 1n;
    this.n = n / g;
    this.d = d / g;
  }
  static parse(text: string): Frac {
    const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
    if (!m) throw new NotPolynomial(`not a numeral: ${text}`);
    const frac = m[2] ?? "";
    return new Frac(BigInt(m[1] + frac), 10n ** BigInt(frac.length));
  }
  add(o: Frac) {
    return new Frac(this.n * o.d + o.n * this.d, this.d * o.d);
  }
  mul(o: Frac) {
    return new Frac(this.n * o.n, this.d * o.d);
  }
  neg() {
    return new Frac(-this.n, this.d);
  }
  inv() {
    return new Frac(this.d, this.n);
  }
  isZero() {
    return this.n === 0n;
  }
  toString() {
    return this.d === 1n ? this.n.toString() : `${this.n}/${this.d}`;
  }
}

/** Monomial key: "v0^2*v3" (variables sorted by index), "" for the constant. */
export type Mono = string;

function monoParts(m: Mono): [number, number][] {
  if (!m) return [];
  return m.split("*").map((p) => {
    const [v, e] = p.split("^");
    return [Number(v.slice(1)), e ? Number(e) : 1];
  });
}

function monoKey(parts: Map<number, number>): Mono {
  return [...parts.entries()]
    .filter(([, e]) => e > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([v, e]) => (e === 1 ? `v${v}` : `v${v}^${e}`))
    .join("*");
}

function monoMul(a: Mono, b: Mono): Mono {
  const m = new Map<number, number>();
  for (const [v, e] of [...monoParts(a), ...monoParts(b)]) m.set(v, (m.get(v) ?? 0) + e);
  return monoKey(m);
}

export class Poly {
  constructor(readonly terms: Map<Mono, Frac> = new Map()) {}
  static const(c: Frac): Poly {
    return c.isZero() ? new Poly() : new Poly(new Map([["", c]]));
  }
  static variable(i: number): Poly {
    return new Poly(new Map([[`v${i}`, new Frac(1n)]]));
  }
  isZero() {
    return this.terms.size === 0;
  }
  constValue(): Frac | undefined {
    if (this.terms.size === 0) return new Frac(0n);
    if (this.terms.size === 1 && this.terms.has("")) return this.terms.get("");
    return undefined;
  }
  add(o: Poly): Poly {
    const t = new Map(this.terms);
    for (const [m, c] of o.terms) {
      const s = (t.get(m) ?? new Frac(0n)).add(c);
      if (s.isZero()) t.delete(m);
      else t.set(m, s);
    }
    return new Poly(t);
  }
  scale(c: Frac): Poly {
    if (c.isZero()) return new Poly();
    return new Poly(new Map([...this.terms].map(([m, x]) => [m, x.mul(c)])));
  }
  neg(): Poly {
    return this.scale(new Frac(-1n));
  }
  sub(o: Poly): Poly {
    return this.add(o.neg());
  }
  mul(o: Poly): Poly {
    if (this.degree() + o.degree() > MAX_DEGREE) throw new NotPolynomial("degree too high");
    let out = new Poly();
    for (const [ma, ca] of this.terms) {
      const t = new Map<Mono, Frac>();
      for (const [mb, cb] of o.terms) {
        const m = monoMul(ma, mb);
        const s = (t.get(m) ?? new Frac(0n)).add(ca.mul(cb));
        if (s.isZero()) t.delete(m);
        else t.set(m, s);
      }
      out = out.add(new Poly(t));
      if (out.terms.size > MAX_TERMS) throw new NotPolynomial("too many terms");
    }
    return out;
  }
  /** Variables renumbered (old index → new index); every variable must be mapped. */
  rename(map: Map<number, number>): Poly {
    const t = new Map<Mono, Frac>();
    for (const [m, c] of this.terms) {
      const parts = new Map<number, number>();
      for (const [v, e] of monoParts(m)) {
        const to = map.get(v);
        if (to === undefined) throw new NotPolynomial(`variable v${v} not mapped`);
        parts.set(to, (parts.get(to) ?? 0) + e);
      }
      t.set(monoKey(parts), c);
    }
    return new Poly(t);
  }
  pow(n: number): Poly {
    if (n * this.degree() > MAX_DEGREE) throw new NotPolynomial("degree too high");
    let out = Poly.const(new Frac(1n));
    for (let i = 0; i < n; i++) out = out.mul(this);
    return out;
  }
  degree(): number {
    let d = 0;
    for (const m of this.terms.keys()) d = Math.max(d, monoParts(m).reduce((s, [, e]) => s + e, 0));
    return d;
  }
  vars(): Set<number> {
    const s = new Set<number>();
    for (const m of this.terms.keys()) for (const [v] of monoParts(m)) s.add(v);
    return s;
  }
  /** Sparse JSON for scripts/poly_certificate.py: [[coef, {v0: 2, …}], …]. */
  toSparse(): [string, Record<string, number>][] {
    return [...this.terms].map(([m, c]) => [c.toString(), Object.fromEntries(monoParts(m).map(([v, e]) => [`v${v}`, e]))]);
  }
  static fromSparse(sp: [string, Record<string, number>][]): Poly {
    let out = new Poly();
    for (const [coef, mono] of sp) {
      const [n, d] = coef.split("/");
      const parts = new Map<number, number>();
      for (const [v, e] of Object.entries(mono)) {
        if (!/^v\d+$/.test(v)) throw new NotPolynomial(`bad variable ${v}`);
        parts.set(Number(v.slice(1)), e);
      }
      out = out.add(new Poly(new Map([[monoKey(parts), new Frac(BigInt(n), BigInt(d ?? "1"))]])));
    }
    return out;
  }
  /** Lean text, each variable printed as `names[i]` (wrapped in parentheses unless a plain name). */
  toLean(names: string[]): string {
    if (this.isZero()) return "0";
    const wrap = (t: string) => (/^[A-Za-z_][\w'.]*$/.test(t) ? t : `(${t})`);
    const terms = [...this.terms].sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0));
    const parts: string[] = [];
    for (const [i, [m, c]] of terms.entries()) {
      const neg = c.n < 0n;
      const abs = neg ? c.neg() : c;
      const factors = monoParts(m).map(([v, e]) => (e === 1 ? wrap(names[v]) : `${wrap(names[v])} ^ ${e}`));
      const coef = abs.d === 1n ? abs.n.toString() : `(${abs.n} / ${abs.d})`;
      const body = factors.length === 0 ? coef : abs.n === 1n && abs.d === 1n ? factors.join(" * ") : [coef, ...factors].join(" * ");
      parts.push(i === 0 ? (neg ? `-${body}` : body) : `${neg ? "-" : "+"} ${body}`);
    }
    return parts.join(" ");
  }
}

export type AtomKind = "sqrt" | "abs" | "sin" | "cos" | "arccos" | "other";

export interface Atom {
  index: number;
  kind: AtomKind;
  /** Exact source text of the atom (whitespace collapsed). */
  text: string;
  /** For √E / |E| / sin c / cos c: the source text of E or c. */
  arg?: string;
  argNode?: Node;
}

/**
 * Variables: the local real variables first (by name), then atoms as they are met. Shared by all
 * the hypotheses and the goal of one problem, so the same atom text is the same variable.
 */
export class VarTable {
  readonly names: string[] = [];
  private byName = new Map<string, number>();
  readonly atoms: Atom[] = [];
  private byText = new Map<string, number>();

  constructor(readonly realVars: Set<string>) {}

  variable(name: string): number {
    let i = this.byName.get(name);
    if (i === undefined) {
      i = this.names.push(name) - 1;
      this.byName.set(name, i);
    }
    return i;
  }

  atom(src: string, n: Node): number {
    const text = slice(src, n);
    const known = this.byText.get(text);
    if (known !== undefined) return known;
    const i = this.names.push(text) - 1;
    this.byText.set(text, i);
    const u = unwrap(n);
    let kind: AtomKind = "other";
    let argNode: Node | undefined;
    if (u.k === "sqrt" || (u.k === "app" && u.fn === "Real.sqrt" && u.args.length === 1)) {
      kind = "sqrt";
      argNode = u.k === "sqrt" ? u.a : u.args[0];
    } else if (u.k === "abs") {
      kind = "abs";
      argNode = u.a;
    } else if (u.k === "app" && u.args.length === 1 && /^(Real\.)?(sin|cos|arccos)$/.test(u.fn)) {
      kind = u.fn.replace(/^Real\./, "") as AtomKind;
      argNode = u.args[0];
    }
    this.atoms.push({ index: i, kind, text, ...(argNode ? { arg: slice(src, argNode), argNode } : {}) });
    return i;
  }
}

/** The term as a polynomial; throws NotPolynomial (a non-constant denominator, a proposition, …). */
export function toPoly(src: string, n: Node, vars: VarTable): Poly {
  switch (n.k) {
    case "num":
      return Poly.const(Frac.parse(n.text));
    case "paren":
    case "asc":
      return toPoly(src, n.a, vars);
    case "ident":
      if (vars.realVars.has(n.name)) return Poly.variable(vars.variable(n.name));
      if (/^(Real\.pi|π)$/.test(n.name)) return Poly.variable(vars.atom(src, n));
      throw new NotPolynomial(`unknown name ${n.name}`);
    case "neg":
      return toPoly(src, n.a, vars).neg();
    case "sqrt":
    case "abs":
    case "cast":
      return Poly.variable(vars.atom(src, n));
    case "app":
      if (/^(Real\.)?(sqrt|sin|cos|arccos|tan|exp|log)$/.test(n.fn) || n.fn.startsWith("Real.")) return Poly.variable(vars.atom(src, n));
      throw new NotPolynomial(`unknown function ${n.fn}`);
    case "bin": {
      const { op } = n;
      if (op === "+" || op === "-" || op === "*") {
        const a = toPoly(src, n.a, vars);
        const b = toPoly(src, n.b, vars);
        return op === "+" ? a.add(b) : op === "-" ? a.sub(b) : a.mul(b);
      }
      if (op === "/") {
        const b = toPoly(src, n.b, vars).constValue();
        if (!b || b.isZero()) throw new NotPolynomial("non-constant denominator");
        return toPoly(src, n.a, vars).scale(b.inv());
      }
      if (op === "^") {
        const e = unwrap(n.b);
        if (e.k !== "num" || !/^\d+$/.test(e.text) || Number(e.text) > 12) throw new NotPolynomial("exponent");
        return toPoly(src, n.a, vars).pow(Number(e.text));
      }
      throw new NotPolynomial(`operator ${op}`);
    }
    default:
      throw new NotPolynomial(n.k);
  }
}

/** Every top-level denominator that is not a constant, as nodes (for the nonzero facts). */
export function hasNonConstDivision(n: Node): boolean {
  switch (n.k) {
    case "bin":
      if (n.op === "/") {
        try {
          // a numeral or numeral expression is fine
          const b = unwrap(n.b);
          if (!isNumeric(b)) return true;
        } catch {
          return true;
        }
      }
      return hasNonConstDivision(n.a) || hasNonConstDivision(n.b);
    case "neg":
    case "paren":
    case "asc":
      return hasNonConstDivision(n.a);
    default:
      return false; // atoms (√, |…|, functions) keep their insides to themselves
  }
}

export function isNumeric(n: Node): boolean {
  const u = unwrap(n);
  if (u.k === "num") return true;
  if (u.k === "neg") return isNumeric(u.a);
  if (u.k === "bin" && ["+", "-", "*", "/"].includes(u.op)) return isNumeric(u.a) && isNumeric(u.b);
  if (u.k === "bin" && u.op === "^") return isNumeric(u.a) && unwrap(u.b).k === "num";
  return false;
}
