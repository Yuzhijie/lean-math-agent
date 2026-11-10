/**
 * A goal `∃ O, …` (a point, or real numbers) whose body fixes the witness by equations that are
 * linear in it — "X lies on the circumcircle": `∃ O, |OA|² = |OB|² ∧ |OB|² = |OC|² ∧ |OC|² = |OX|²`,
 * where the squares of O cancel between the sides. The program solves those equations itself
 * (Gaussian elimination over the numbers ℚ(√r₁, √r₂, …): a coefficient is a polynomial in square
 * roots of rationals, its inverse found by multiplying with conjugates) and writes the witness; the
 * rest — every conjunct with the witness in place — is an equation like any other goal.
 *
 * Only equations whose witness coefficients are such numbers are used to solve (the third one above
 * has X's coordinates there, and is left to be proved); the constant parts may hold anything.
 */
import { parseTerm, slice, unwrap, type Node } from "./expr";
import { Frac, monoKey, monoParts, NotPolynomial, Poly, toPoly, VarTable } from "./poly";

export interface Witness {
  /** The tactic that provides it: `refine ⟨(x, y), ?_⟩`. */
  tactic: string;
  /** The witness components as Lean text, in order. */
  values: string[];
}

/** Square roots of rational numbers among the table's atoms: variable index → the rational. */
function numericRoots(vars: VarTable): Map<number, Frac> {
  const out = new Map<number, Frac>();
  for (const a of vars.atoms) {
    if (a.kind !== "sqrt" || !a.argNode) continue;
    try {
      const v = toPoly(a.arg!, parseTerm(a.arg!), new VarTable(new Set())).constValue();
      if (v && v.n > 0n) out.set(a.index, v);
    } catch {
      // not a number
    }
  }
  return out;
}

/** s^k → r^(k div 2) · s^(k mod 2) for every numeric root s = √r. */
function reduce(p: Poly, roots: Map<number, Frac>): Poly {
  let out = new Poly();
  for (const [m, c] of p.terms) {
    let coef = c;
    const parts = new Map<number, number>();
    for (const [v, e] of monoParts(m)) {
      const r = roots.get(v);
      if (r) {
        for (let i = 0; i < Math.floor(e / 2); i++) coef = coef.mul(r);
        if (e % 2) parts.set(v, 1);
      } else parts.set(v, e);
    }
    out = out.add(new Poly(new Map([[monoKey(parts), coef]])));
  }
  return out;
}

/** The inverse of a nonzero number of ℚ(√r…) written with the roots, or undefined. */
function inverse(p: Poly, roots: Map<number, Frac>): Poly | undefined {
  let num = Poly.const(new Frac(1n));
  let den = reduce(p, roots);
  for (const s of roots.keys()) {
    if (!den.vars().has(s)) continue;
    // den = A + B·s → conjugate A − B·s
    let conj = new Poly();
    for (const [m, c] of den.terms) {
      const odd = monoParts(m).some(([v, e]) => v === s && e % 2 === 1);
      conj = conj.add(new Poly(new Map([[m, odd ? c.neg() : c]])));
    }
    num = reduce(num.mul(conj), roots);
    den = reduce(den.mul(conj), roots);
  }
  const d = den.constValue();
  if (!d || d.isZero()) return undefined;
  return num.scale(d.inv());
}

function conjuncts(n: Node): Node[] {
  const u = unwrap(n);
  return u.k === "bin" && u.op === "∧" ? [...conjuncts(u.a), ...conjuncts(u.b)] : [u];
}

const IDENT = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The witness of an `∃` goal fixed by linear equations, or undefined. `realVars`: the context's
 * real variables (they may occur in the constant parts).
 */
export function existsWitness(target: string, realVars: Set<string>): Witness | undefined {
  let t: Node;
  try {
    t = unwrap(parseTerm(target));
  } catch {
    return undefined;
  }
  if (t.k !== "quant" || t.q !== "∃") return undefined;
  const names = t.binders.flatMap((b) => b.names);
  if (!names.length || names.length > 4) return undefined;
  let body = slice(target, t.body);
  // each bound name: a point (used as O.1 / O.2) or a real number
  const comps: { name: string; pair: boolean; vars: string[] }[] = [];
  let k = 0;
  const fresh = () => {
    let v: string;
    do v = `wv${k++}`;
    while (body.includes(v) || realVars.has(v));
    return v;
  };
  for (const n of names) {
    const proj = new RegExp(`(?<![\\w'.])${IDENT(n)}\\.([12])(?![\\w'])`, "g");
    if (proj.test(body)) {
      const [x, y] = [fresh(), fresh()];
      body = body.replace(proj, (_, i) => (i === "1" ? x : y));
      if (new RegExp(`(?<![\\w'.])${IDENT(n)}(?![\\w'])`).test(body)) return undefined; // used whole too
      comps.push({ name: n, pair: true, vars: [x, y] });
    } else {
      const v = fresh();
      body = body.replace(new RegExp(`(?<![\\w'.])${IDENT(n)}(?![\\w'])`, "g"), v);
      comps.push({ name: n, pair: false, vars: [v] });
    }
  }
  const unknowns = comps.flatMap((c) => c.vars);
  let parsed: Node;
  try {
    parsed = parseTerm(body);
  } catch {
    return undefined;
  }
  const vars = new VarTable(new Set([...realVars, ...unknowns]));
  const idx = unknowns.map((u) => vars.variable(u));
  const rows: { coef: Poly[]; rest: Poly }[] = [];
  for (const c of conjuncts(parsed)) {
    if (c.k !== "bin" || c.op !== "=") continue;
    let p: Poly;
    try {
      p = toPoly(body, c.a, vars).sub(toPoly(body, c.b, vars));
    } catch (e) {
      if (e instanceof NotPolynomial) continue;
      throw e;
    }
    const coef = idx.map(() => new Poly());
    let rest = new Poly();
    let linear = true;
    for (const [m, cf] of p.terms) {
      const parts = monoParts(m);
      const hit = parts.filter(([v]) => idx.includes(v));
      const term = new Poly(new Map([[m, cf]]));
      if (!hit.length) rest = rest.add(term);
      else if (hit.length === 1 && hit[0][1] === 1) {
        const j = idx.indexOf(hit[0][0]);
        coef[j] = coef[j].add(new Poly(new Map([[monoKey(new Map(parts.filter(([v]) => v !== hit[0][0]))), cf]])));
      } else linear = false;
    }
    if (linear && coef.some((q) => !q.isZero())) rows.push({ coef, rest });
  }
  const roots = numericRoots(vars);
  const numeric = (q: Poly) => [...q.vars()].every((v) => roots.has(v));
  const usable = rows.filter((r) => r.coef.every(numeric)).map((r) => ({ coef: r.coef.map((q) => reduce(q, roots)), rest: reduce(r.rest, roots) }));
  // Gauss–Jordan: coef · w + rest = 0
  const solved = new Map<number, { coef: Poly[]; rest: Poly }>();
  const pool = [...usable];
  for (let j = 0; j < idx.length; j++) {
    const at = pool.findIndex((r) => !r.coef[j].isZero() && inverse(r.coef[j], roots));
    if (at < 0) return undefined;
    const [piv] = pool.splice(at, 1);
    const inv = inverse(piv.coef[j], roots)!;
    const row = { coef: piv.coef.map((q) => reduce(q.mul(inv), roots)), rest: reduce(piv.rest.mul(inv), roots) };
    for (const r of pool) {
      const f = r.coef[j];
      if (f.isZero()) continue;
      r.coef = r.coef.map((q, i) => reduce(q.sub(f.mul(row.coef[i])), roots));
      r.rest = reduce(r.rest.sub(f.mul(row.rest)), roots);
    }
    for (const r of solved.values()) {
      const f = r.coef[j];
      if (f.isZero()) continue;
      r.coef = r.coef.map((q, i) => reduce(q.sub(f.mul(row.coef[i])), roots));
      r.rest = reduce(r.rest.sub(f.mul(row.rest)), roots);
    }
    solved.set(j, row);
  }
  // reduced rows: w_j + rest_j = 0
  const value = new Map<number, Poly>();
  for (const [j, r] of solved) value.set(j, r.rest.neg());
  const text = (j: number) => value.get(j)!.toLean(vars.names);
  const values = unknowns.map((_, j) => text(j));
  let j = 0;
  const parts = comps.map((c) => (c.pair ? `(${text(j++)}, ${text(j++)})` : text(j++)));
  return { tactic: `refine ⟨${parts.join(", ")}, ?_⟩`, values };
}
