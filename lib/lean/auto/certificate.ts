/**
 * An equation goal that follows from the equation hypotheses by algebra alone: the coefficients
 * c_i with goal = Σ c_i · h_i are computed (scripts/poly_certificate.py, the geometry prover's
 * certificate search), and `linear_combination Σ c_i * h_i` closes it. Over ℝ, ℚ, ℤ, ℂ (a ring:
 * linear_combination subtracts). Square roots, |…|, trigonometric values are atoms.
 */
import type { GoalState } from "../geometry/goal";
import { isInaccessible } from "../geometry/goal";
import { findCertificate } from "../geometry/certificate";
import { NotPolynomial, Poly, toPoly, VarTable, hasNonConstDivision } from "../geometry/poly";
import { tryParse } from "../geometry/prove";

const RING = /^(ℝ|ℚ|ℤ|ℂ)$/;

export async function certificateTactic(st: GoalState, timeoutSec = 10): Promise<string | undefined> {
  const t = tryParse(st.target);
  if (!t || t.k !== "bin" || t.op !== "=" || hasNonConstDivision(t)) return undefined;
  const ringVars = st.hyps.filter((h) => RING.test(h.type.trim())).flatMap((h) => h.names).filter((n) => !isInaccessible(n));
  const naturals = st.hyps.some((h) => /^ℕ$/.test(h.type.trim()));
  if (!ringVars.length || naturals) return undefined;
  const vars = new VarTable(new Set(ringVars));
  let goal: Poly;
  try {
    goal = toPoly(st.target, t.a, vars).sub(toPoly(st.target, t.b, vars));
  } catch (e) {
    if (e instanceof NotPolynomial) return undefined;
    throw e;
  }
  if (goal.isZero()) return "ring";
  const hyps: { name: string; poly: Poly }[] = [];
  for (const h of st.hyps) {
    if (h.names.length !== 1 || isInaccessible(h.names[0])) continue;
    const n = tryParse(h.type);
    if (!n || n.k !== "bin" || n.op !== "=" || hasNonConstDivision(n)) continue;
    try {
      hyps.push({ name: h.names[0], poly: toPoly(h.type, n.a, vars).sub(toPoly(h.type, n.b, vars)) });
    } catch (e) {
      if (!(e instanceof NotPolynomial)) throw e;
    }
  }
  if (!hyps.length) return undefined;
  const cert = await findCertificate({ vars: vars.names.map((_, i) => `v${i}`), hyps, goal, multipliers: [], timeoutSec });
  if (!cert.ok || cert.multiplier.length) return undefined;
  const combo = [...cert.coefficients].map(([h, c]) => `(${c.toLean(vars.names)}) * ${h}`).join(" + ");
  return combo ? `linear_combination ${combo}` : undefined;
}
