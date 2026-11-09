/**
 * AM–GM under a product constraint: positive reals x₁ … xₙ (n = 2, 3) with x₁ · … · xₙ = mⁿ (m a
 * positive number) give n · m ≤ x₁ + … + xₙ — a fact nlinarith does not find itself (it is cubic for
 * n = 3), proved first with the squares of the differences, then the goal by nlinarith with that fact,
 * (xᵢ − xⱼ)², (xᵢ − m)² and the products of the positive variables.
 *
 * a, b, c > 0, abc = 1: (a² + b² + c²)/(a + b + c) = 1 ⇒ a = 1 needs a + b + c ≥ 3, since
 * (a − 1)² + (b − 1)² + (c − 1)² = 3 − (a + b + c) once a² + b² + c² = a + b + c.
 */
import { isInaccessible, type GoalState } from "../geometry/goal";
import { topIndex } from "../combinatorics/lets";

export interface ProductConstraint {
  vars: string[];
  /** m with x₁ · … · xₙ = mⁿ */
  mean: string;
  hyp: string;
}

const ID = "[A-Za-z_][\\w'₀-₉]*";

/** n-th root of a nonnegative rational written as p or p / q, when it is rational. */
function rationalRoot(text: string, n: number): string | undefined {
  const m = /^\(?(\d+)(?:\s*\/\s*(\d+))?\)?$/.exec(text.trim());
  if (!m) return undefined;
  const root = (x: bigint): bigint | undefined => {
    const r = BigInt(Math.round(Number(x) ** (1 / n)));
    return [r - 1n, r, r + 1n].find((d) => d >= 0n && d ** BigInt(n) === x);
  };
  const p = root(BigInt(m[1]));
  const q = m[2] ? root(BigInt(m[2])) : 1n;
  if (p === undefined || q === undefined || p === 0n) return undefined;
  return q === 1n ? `${p}` : `(${p} / ${q})`;
}

export function readProductConstraint(st: GoalState): ProductConstraint | undefined {
  const positive = new Set<string>();
  const reals = new Set(st.hyps.filter((h) => /^ℝ$/.test(h.type.trim())).flatMap((h) => h.names));
  for (const h of st.hyps) {
    const m = new RegExp(`^0 < (${ID})$`).exec(h.type.trim()) ?? new RegExp(`^(${ID}) > 0$`).exec(h.type.trim());
    if (m && reals.has(m[1])) positive.add(m[1]);
  }
  for (const h of st.hyps) {
    const name = h.names[0];
    if (!name || isInaccessible(name)) continue;
    const m = /^(.+?) = (.+)$/.exec(h.type.trim().replace(/\s+/g, " "));
    if (!m) continue;
    const vars = m[1].replace(/[()]/g, "").split(" * ").map((s) => s.trim());
    if (vars.length < 2 || vars.length > 3 || !vars.every((v) => positive.has(v)) || new Set(vars).size !== vars.length) continue;
    const mean = rationalRoot(m[2], vars.length);
    if (mean) return { vars, mean, hyp: name };
  }
  return undefined;
}

export function amgmFinishers(st: GoalState): string[] {
  const c = readProductConstraint(st);
  if (!c) return [];
  const { vars, mean } = c;
  const n = vars.length;
  const sum = vars.join(" + ");
  const pairs: [string, string][] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push([vars[i], vars[j]]);
  const pos = (v: string) => st.hyps.find((h) => new RegExp(`^0 < ${v}$|^${v} > 0$`).test(h.type.trim()))?.names[0];
  const posNames = vars.map(pos);
  const diffs = pairs.map(([a, b]) => `sq_nonneg (${a} - ${b})`);
  const prods = posNames.every(Boolean) ? pairs.map(([a, b]) => `mul_pos ${posNames[vars.indexOf(a)]} ${posNames[vars.indexOf(b)]}`) : [];
  const fact = `(${n} : ℝ) * ${mean} ≤ ${sum}`;
  // `only`: other hypotheses (a fraction the goal came with) made it take 6 s instead of 0.2 s
  const factProof = `nlinarith only [${[c.hyp, ...posNames.filter(Boolean), ...diffs, `sq_nonneg (${sum} - ${n} * ${mean})`, ...prods].join(", ")}]`;
  const shifted = vars.map((v) => `sq_nonneg (${v} - ${mean})`);
  const hints = (h: string) => [h, ...diffs, ...shifted, ...prods].join(", ");
  const have = `have hamgm : ${fact} := (by ${factProof})`;
  // the equality case a = 1 ∧ b = 1 ∧ c = 1: every part by the same nlinarith (splitting it first in the
  // search would go past its depth: ∧, ↔, intro, field_simp, ∧)
  const parts = topIndex(st.target, " ↔ ") >= 0 || topIndex(st.target, " → ") >= 0 ? 1 : conjuncts(st.target).length;
  // each part of an equality case: the squares are enough (the products made three nlinarith calls
  // take longer than the search's 10 s per tactic)
  const lean = ["hamgm", ...diffs, ...shifted].join(", ");
  const close = parts > 1 ? `refine ⟨${Array(parts).fill("?_").join(", ")}⟩ <;> nlinarith [${lean}]` : `nlinarith [${hints("hamgm")}]`;
  return [`(${have}; ${close})`, `(${have}; field_simp at *; ${close})`];
}

/** The top-level parts of P ∧ Q ∧ R. */
function conjuncts(t: string): string[] {
  const out: string[] = [];
  let rest = t.trim();
  for (let i = topIndex(rest, " ∧ "); i >= 0; i = topIndex(rest, " ∧ ")) {
    out.push(rest.slice(0, i));
    rest = rest.slice(i + 3);
  }
  out.push(rest);
  return out;
}
