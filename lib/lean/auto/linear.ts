/**
 * Unknowns a system of linear equation hypotheses fixes ("3a = b + c + d, …" ⇒ d = 13/15): solved
 * exactly over ℚ (Gaussian elimination on the hypotheses as polynomials), then offered as one step
 * `(have h : d = 13 / 15 := by linarith; …; subst h …)` so the goal is about numbers.
 */
import { isInaccessible, type GoalState } from "../geometry/goal";
import { Frac, NotPolynomial, Poly, toPoly, VarTable, hasNonConstDivision } from "../geometry/poly";
import { tryParse } from "../geometry/prove";

const FIELD = /^(ℝ|ℚ|ℤ)$/;

/** variable index → value for the unknowns the linear hypotheses determine. */
export function solveLinear(st: GoalState): { name: string; value: Frac }[] {
  const names = st.hyps.filter((h) => FIELD.test(h.type.trim())).flatMap((h) => h.names).filter((n) => !isInaccessible(n));
  if (!names.length) return [];
  const vars = new VarTable(new Set(names));
  const rows: Map<number, Frac>[] = [];
  const consts: Frac[] = [];
  for (const h of st.hyps) {
    const n = tryParse(h.type);
    if (!n || n.k !== "bin" || n.op !== "=" || hasNonConstDivision(n)) continue;
    let p: Poly;
    try {
      p = toPoly(h.type, n.a, vars).sub(toPoly(h.type, n.b, vars));
    } catch (e) {
      if (e instanceof NotPolynomial) continue;
      throw e;
    }
    if (p.degree() !== 1) continue;
    const row = new Map<number, Frac>();
    let c = new Frac(0n);
    let ok = true;
    for (const [m, coef] of p.terms) {
      if (m === "") c = coef;
      else {
        const i = Number(m.slice(1));
        if (!/^v\d+$/.test(m) || i >= names.length) ok = false; // an atom (√, cos, …): not a plain unknown
        else row.set(i, coef);
      }
    }
    if (ok && row.size) {
      rows.push(row);
      consts.push(c.neg());
    }
  }
  if (!rows.length) return [];
  // Gauss–Jordan
  const n = names.length;
  const A = rows.map((r) => Array.from({ length: n }, (_, j) => r.get(j) ?? new Frac(0n)));
  const b = consts.slice();
  const pivots: number[] = [];
  let row = 0;
  for (let col = 0; col < n && row < A.length; col++) {
    const p = A.findIndex((r, i) => i >= row && !r[col].isZero());
    if (p < 0) continue;
    [A[row], A[p]] = [A[p], A[row]];
    [b[row], b[p]] = [b[p], b[row]];
    const inv = A[row][col].inv();
    A[row] = A[row].map((x) => x.mul(inv));
    b[row] = b[row].mul(inv);
    for (let i = 0; i < A.length; i++) {
      if (i === row || A[i][col].isZero()) continue;
      const f = A[i][col];
      A[i] = A[i].map((x, j) => x.add(A[row][j].mul(f).neg()));
      b[i] = b[i].add(b[row].mul(f).neg());
    }
    pivots.push(col);
    row++;
  }
  const out: { name: string; value: Frac }[] = [];
  pivots.forEach((col, r) => {
    // determined when no other (free) unknown is left in its row
    if (A[r].every((x, j) => j === col || x.isZero())) out.push({ name: names[col], value: b[r] });
  });
  return out;
}

export function fracLean(f: Frac): string {
  const s = f.d === 1n ? `${f.n < 0n ? -f.n : f.n}` : `${f.n < 0n ? -f.n : f.n} / ${f.d}`;
  return f.n < 0n ? `-(${s})` : s;
}

/** The step that fixes the solved unknowns, or undefined. */
export function linearValuesTactic(st: GoalState, fresh: (b: string) => string): string | undefined {
  const sol = solveLinear(st);
  if (!sol.length) return undefined;
  const hs = sol.map(() => fresh("hv"));
  const haves = sol.map((s, i) => `have ${hs[i]} : ${s.name} = ${fracLean(s.value)} := (by linarith)`).join("; ");
  return `(${haves}; subst ${hs.join(" ")})`;
}
