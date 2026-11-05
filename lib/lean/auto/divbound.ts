/**
 * "Find every n with a·n + b ∣ P(n)" over ℕ: the divisor also divides a constant, so n is bounded,
 * then every value is checked. From a hypothesis `A ∣ B` (A = a·n + b linear, B a polynomial in n,
 * no subtraction) the program computes a^d · B = A · Q + r (d = deg B, Q with integer
 * coefficients, r a nonzero integer); in ℤ, A ∣ a^d · B and A ∣ A · Q give A ∣ r, so
 * a·n + b ≤ |r| (Int.le_of_dvd), n ≤ K, and `interval_cases n` checks each value.
 *
 * n + 5 ∣ n² + 14 ∧ 2n + 1 ∣ n² + 4 ↔ n = 8 (n + 5 ∣ 39, so n ≤ 34) had defeated the tactic search.
 */
import { parseTerm, ParseError } from "../geometry/expr";
import { Frac, NotPolynomial, Poly, toPoly, VarTable } from "../geometry/poly";
import type { GoalState } from "../geometry/goal";
import { isInaccessible } from "../geometry/goal";
import { topIndex } from "../combinatorics/lets";

/** Largest bound handed to interval_cases. */
const MAX_BOUND = 150;

/** Coefficients of a univariate polynomial (index = power), or undefined when it has other variables. */
function coefficients(p: Poly, v: number): Frac[] | undefined {
  const out: Frac[] = [];
  for (const [mono, c] of p.terms) {
    let e = 0;
    if (mono) {
      const parts = mono.split("*");
      if (parts.length > 1) return undefined;
      const [name, pow] = parts[0].split("^");
      if (name !== `v${v}`) return undefined;
      e = pow ? Number(pow) : 1;
    }
    out[e] = c;
  }
  for (let i = 0; i < out.length; i++) out[i] ??= new Frac(0n);
  return out;
}

function polyText(cs: Frac[], x: string): string {
  const parts: string[] = [];
  for (let e = cs.length - 1; e >= 0; e--) {
    const c = cs[e];
    if (c.isZero()) continue;
    const mag = c.n < 0n ? -c.n : c.n;
    const sign = c.n < 0n ? "-" : "+";
    const pow = e === 0 ? "" : e === 1 ? x : `${x} ^ ${e}`;
    const term = e === 0 ? `${mag}` : mag === 1n ? pow : `${mag} * ${pow}`;
    parts.push(parts.length ? `${sign} ${term}` : sign === "-" ? `-${term}` : term);
  }
  return parts.length ? parts.join(" ") : "0";
}

export interface DivBound {
  variable: string;
  hyp: string;
  bound: number;
  /** the `have` that proves `n ≤ bound` (one tactic, parenthesised proofs) */
  have: string;
}

/** A bound on an ℕ variable from each hypothesis `a·n + b ∣ P(n)`. */
export function divisibilityBounds(st: GoalState): DivBound[] {
  const natVars = new Set(st.hyps.filter((h) => h.type.trim() === "ℕ").flatMap((h) => h.names).filter((n) => !isInaccessible(n)));
  if (!natVars.size) return [];
  const out: DivBound[] = [];
  for (const h of st.hyps) {
    const name = h.names[0];
    if (h.names.length !== 1 || isInaccessible(name)) continue;
    const ty = h.type.replace(/\s+/g, " ").trim();
    const at = topIndex(ty, " ∣ ");
    if (at < 0 || /[-/]|∀|∃|→/.test(ty)) continue;
    const [aText, bText] = [ty.slice(0, at).trim(), ty.slice(at + 3).trim()];
    const vars = new VarTable(natVars);
    let A: Poly, B: Poly;
    try {
      A = toPoly(aText, parseTerm(aText), vars);
      B = toPoly(bText, parseTerm(bText), vars);
    } catch (e) {
      if (e instanceof NotPolynomial || e instanceof ParseError) continue;
      throw e;
    }
    const used = new Set([...A.vars(), ...B.vars()]);
    if (used.size !== 1) continue;
    const v = [...used][0];
    const vname = vars.names[v];
    const ac = coefficients(A, v);
    const bc = coefficients(B, v);
    if (!ac || !bc || ac.length !== 2 || bc.length < 2) continue;
    const [b0, a1] = ac;
    if (a1.d !== 1n || b0.d !== 1n || a1.n < 1n || b0.n < 0n || bc.some((c) => c.d !== 1n || c.n < 0n)) continue;
    const a = a1.n;
    const b = b0.n;
    const deg = bc.length - 1;
    const M = a ** BigInt(deg);
    // M·B = A·Q + r by synthetic division at the root −b/a
    const mb = bc.map((c) => c.mul(new Frac(M)));
    const q: Frac[] = new Array(deg).fill(new Frac(0n));
    let rem = mb.slice();
    for (let e = deg; e >= 1; e--) {
      const lead = rem[e];
      const t = lead.mul(new Frac(1n, a)); // coefficient of n^(e-1) in Q
      q[e - 1] = t;
      rem[e] = new Frac(0n);
      rem[e - 1] = rem[e - 1].add(t.mul(new Frac(-b)));
    }
    rem = rem.slice(0, 1);
    const r = rem[0];
    if (r.isZero() || r.d !== 1n || q.some((c) => c.d !== 1n)) continue;
    const rAbs = r.n < 0n ? -r.n : r.n;
    if (rAbs < b) continue;
    const K = Number((rAbs - b) / a);
    if (K > MAX_BOUND) continue;
    const z = `(${vname} : ℤ)`;
    const AZ = polyText(ac, z);
    const BZ = polyText(bc, z);
    const QZ = polyText(q, z);
    const R = r.toString();
    const fromR = r.n < 0n ? "(dvd_neg.mp hd2)" : "hd2";
    const have =
      `have hbound : ${vname} ≤ ${K} := (by ` +
      `have hd1 : ${AZ} ∣ ${BZ} := (by exact_mod_cast ${name}); ` +
      `have hd2 : ${AZ} ∣ (${R} : ℤ) := (by ` +
      `have hd3 : (${BZ}) * ${M} = (${AZ}) * (${QZ}) + (${R}) := (by ring); ` +
      `have hd4 := dvd_mul_of_dvd_left hd1 ${M}; rw [hd3] at hd4; exact (dvd_add_right (dvd_mul_right _ _)).mp hd4); ` +
      `have hd5 := Int.le_of_dvd (by norm_num) ${fromR}; omega)`;
    out.push({ variable: vname, hyp: name, bound: K, have });
  }
  return out.sort((x, y) => x.bound - y.bound);
}

/** Finishers: the bound, then every value of the variable. */
export function divisibilityFinishers(st: GoalState): string[] {
  const best = new Map<string, DivBound>();
  for (const d of divisibilityBounds(st)) if (!best.has(d.variable)) best.set(d.variable, d);
  const out: string[] = [];
  for (const d of best.values()) for (const fin of ["omega", "simp_all", "norm_num at *", "decide"]) out.push(`(${d.have}; interval_cases ${d.variable} <;> ${fin})`);
  return out;
}
