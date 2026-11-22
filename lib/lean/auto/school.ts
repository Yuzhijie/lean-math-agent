/**
 * Rules for the statements of primary and middle school problems (bench/school.json), where the
 * general finishers had nothing to hold on to:
 *
 *   roots        x² − 5x + 6 = 0 ⊢ x = 2 ∨ x = 3 (also 1 ± √2, three roots, a double root): the product
 *                of the (x − root) is 0 by nlinarith from the equation, then mul_eq_zero
 *   set-roots    ⊢ {x | P x} = {2, 3}: ext, membership written out (the two directions are then goals
 *                the other rules close)
 *   instances    a hypothesis ∀ x : ℝ, A = B: its instances at 0, 1, −1, 2 for nlinarith
 *   abs-interval ⊢ |x − 1| < 2 ↔ −1 < x ∧ x < 3
 *   vertex       ⊢ IsLeast {y | ∃ x, y = a x² + b x + c} m: the witness −b/2a and (x + b/2a)² ≥ 0
 *   mod-cases    ⊢ 6 ∣ n³ − n, Even (n² + n) for an integer or natural n: n mod d case by case
 *   pigeonhole   ⊢ ∃ i j, i ≠ j ∧ f i = f j
 *   special-angles (a rewrite step) sin, cos, tan of multiples of 30° and 45°, written in π or in
 *                degrees × π / 180: replaced by their values
 *
 * Checked in Lean 4.33.1 + Mathlib on the cases of bench/school.json.
 */
import { isInaccessible, type GoalState } from "../geometry/goal";
import { topIndex } from "../combinatorics/lets";
import { Frac, monoParts, NotPolynomial, toPoly, VarTable } from "../geometry/poly";
import { tryParse } from "../geometry/prove";
import { readExtremumGoal } from "./realopt";

const ID = "[A-Za-z_][\\w'₀-₉]*";
const NUMERIC = /^(ℝ|ℚ|ℤ)$/;

function split(t: string, sep: string): string[] {
  const out: string[] = [];
  let rest = t.trim();
  for (let i = topIndex(rest, sep); i >= 0; i = topIndex(rest, sep)) {
    out.push(rest.slice(0, i).trim());
    rest = rest.slice(i + sep.length).trim();
  }
  out.push(rest);
  return out;
}
const bare = (s: string) => {
  let t = s.trim();
  while (/^\(.*\)$/.test(t) && topIndex(t.slice(1, -1), ")") < 0 && balanced(t.slice(1, -1))) t = t.slice(1, -1).trim();
  return t;
};
function balanced(s: string): boolean {
  let d = 0;
  for (const c of s) {
    if (c === "(") d++;
    else if (c === ")" && --d < 0) return false;
  }
  return d === 0;
}
const mentions = (text: string, v: string) => new RegExp(`(?<![\\w'.₀-₉])${v.replace(/[.*+?^${}()|[\]\\']/g, "\\$&")}(?![\\w'₀-₉])`).test(text);

/** `Real.sq_sqrt` and `Real.sqrt_nonneg` for the square roots of numbers in `text` (√2, √(3 / 4), Real.sqrt 5). */
export function sqrtFacts(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:√|Real\.sqrt\s+)(\d+(?:\.\d+)?|\([\d\s./*+]+\))/g)) {
    out.add(`Real.sq_sqrt (show (0 : ℝ) ≤ ${m[1]} by norm_num)`);
    out.add(`Real.sqrt_nonneg ${m[1]}`);
  }
  return [...out];
}

/** The roots a goal `x = r₁ ∨ x = r₂ ∨ …` (or `x = r`) names for one variable; the roots are closed terms. */
function namedRoots(st: GoalState): { v: string; roots: string[] } | undefined {
  const vars = new Set(st.hyps.filter((h) => NUMERIC.test(h.type.trim())).flatMap((h) => h.names).filter((n) => !isInaccessible(n)));
  const parts = split(st.target, " ∨ ").map(bare);
  let v: string | undefined;
  const roots: string[] = [];
  for (const p of parts) {
    const m = new RegExp(`^(${ID}) = (.+)$`).exec(p);
    if (!m || !vars.has(m[1]) || (v && v !== m[1])) return undefined;
    v = m[1];
    if ([...vars].some((x) => mentions(m[2], x)) || /[=<>≤≥∧∨↔→]/.test(m[2])) return undefined;
    roots.push(m[2].trim());
  }
  return v && roots.length ? { v, roots } : undefined;
}

export function rootsFinishers(st: GoalState): string[] {
  const r = namedRoots(st);
  if (!r) return [];
  // the equations that say something about the variable, of degree two or more in it
  const eqs = st.hyps.filter((h) => h.names[0] && !isInaccessible(h.names[0]) && / = /.test(h.type) && !/[∀∃→∧∨↔]/.test(h.type) && mentions(h.type, r.v));
  if (!eqs.some((h) => new RegExp(`${r.v} \\^ \\d|${r.v} \\* ${r.v}`).test(h.type))) return [];
  const hints = [...eqs.map((h) => h.names[0]), ...sqrtFacts(`${st.target} ${eqs.map((h) => h.type).join(" ")}`)].join(", ");
  const factor = (root: string) => `(${r.v} - ${/^[\w.]+$/.test(root) ? root : `(${root})`})`;
  if (r.roots.length === 1) {
    // a double root: (x − r)² = 0
    return [`(have hroot : ${factor(r.roots[0])} ^ 2 = 0 := (by nlinarith [${hints}]); exact sub_eq_zero.mp (pow_eq_zero_iff two_ne_zero |>.mp hroot))`];
  }
  return [`(have hroot : ${r.roots.map(factor).join(" * ")} = 0 := (by nlinarith [${hints}]); simp only [mul_eq_zero, sub_eq_zero] at hroot; tauto)`];
}

/**
 * ⊢ (x = 2 ∧ y = 3) ∨ (x = 3 ∧ y = 2) from equations in x and y (x + y = 5, x y = 6): the first
 * unknown's values as roots, then in each case the other unknowns by linarith.
 */
export function solutionPairsFinishers(st: GoalState): string[] {
  const vars = new Set(st.hyps.filter((h) => NUMERIC.test(h.type.trim())).flatMap((h) => h.names).filter((n) => !isInaccessible(n)));
  const cases = split(st.target, " ∨ ").map((d) => split(bare(d), " ∧ ").map((e) => new RegExp(`^(${ID}) = (.+)$`).exec(bare(e))));
  if (cases.length < 2 || cases.some((c) => c.length < 2 || c.length !== cases[0].length)) return [];
  const names = cases[0].map((m) => m?.[1]);
  const closed = (t: string) => ![...vars].some((x) => mentions(t, x)) && !/[=<>≤≥∧∨↔→]/.test(t);
  if (!cases.every((c) => c.every((m, i) => m && m[1] === names[i] && vars.has(m[1]) && closed(m[2]))) || new Set(names).size !== names.length) return [];
  const x = names[0]!;
  const eqs = st.hyps.filter((h) => h.names[0] && !isInaccessible(h.names[0]) && / = /.test(h.type) && !/[∀∃→∧∨↔]/.test(h.type) && names.some((v) => mentions(h.type, v!)));
  if (!eqs.length) return [];
  const roots = [...new Set(cases.map((c) => c[0]![2].trim()))];
  const hints = [...eqs.map((h) => h.names[0]), ...sqrtFacts(`${st.target} ${eqs.map((h) => h.type).join(" ")}`)].join(", ");
  const factor = (root: string) => `(${x} - ${/^[\w.]+$/.test(root) ? root : `(${root})`})`;
  // the i-th of n disjuncts
  const inj = (i: number, n: number, t: string): string => (n === 1 ? t : i === 0 ? `Or.inl ${t}` : `Or.inr ${n === 2 ? t : `(${inj(i - 1, n - 1, t)})`}`);
  const pair = `⟨${names.map(() => "by linarith").join(", ")}⟩`;
  const pick = cases.map((_, i) => `exact ${inj(i, cases.length, pair)}`).join(" | ");
  const product = roots.length === 1 ? `${factor(roots[0])} ^ 2` : roots.map(factor).join(" * ");
  const open = roots.length === 1 ? `have hcase : ${x} = ${roots[0]} := sub_eq_zero.mp (pow_eq_zero_iff two_ne_zero |>.mp hroot)` : `simp only [mul_eq_zero, sub_eq_zero] at hroot; rcases hroot with ${roots.map(() => "hcase").join(" | ")}`;
  // each equation times the unknown (x + y = 5 gives x² + x y = 5 x): nlinarith multiplies hypotheses with each other, not with a variable
  const times = eqs.slice(0, 3).map((h, i) => {
    const at = topIndex(h.type, " = ");
    return { name: `hmul${i}`, have: `have hmul${i} : (${h.type.slice(0, at).trim()}) * ${x} = (${h.type.slice(at + 3).trim()}) * ${x} := (by rw [${h.names[0]}])` };
  });
  const all = [hints, ...times.map((t) => t.name)].join(", ");
  return [`(${times.map((t) => `${t.have}; `).join("")}have hroot : ${product} = 0 := (by nlinarith [${all}]); ${open} <;> first | ${pick})`];
}

/** A hypothesis `x = r₁ ∨ x = r₂ ∨ …` with closed roots: each root put in, the goal is then about numbers. */
export function rootCheckFinishers(st: GoalState): string[] {
  const vars = new Set(st.hyps.filter((h) => NUMERIC.test(h.type.trim())).flatMap((h) => h.names).filter((n) => !isInaccessible(n)));
  for (const h of st.hyps) {
    const name = h.names[0];
    const parts = split(h.type, " ∨ ").map(bare);
    if (!name || isInaccessible(name) || parts.length < 2 || /^∀|^∃/.test(st.target)) continue;
    const ms = parts.map((p) => new RegExp(`^(${ID}) = (.+)$`).exec(p));
    if (!ms.every((m) => m && vars.has(m[1]) && m[1] === ms[0]![1] && ![...vars].some((x) => mentions(m[2], x)) && !/[=<>≤≥∧∨↔→]/.test(m[2]))) continue;
    const cases = `rcases ${name} with ${parts.map(() => "rfl").join(" | ")}`;
    const facts = sqrtFacts(`${h.type} ${st.target}`);
    return [`(${cases} <;> norm_num)`, ...(facts.length ? [`(${cases} <;> nlinarith [${facts.join(", ")}])`] : []), `(${cases} <;> simp)`];
  }
  return [];
}

/** ⊢ {x | P x} = {a, b, …} (also with the sides exchanged): membership on both sides, written out. */
export function setRootsStep(st: GoalState): string | undefined {
  const t = st.target.trim();
  const m = new RegExp(`^\\{(${ID})(?: : [^|]+)? \\| [\\s\\S]+\\} = \\{[^|{}]*\\}$`).exec(t) ?? new RegExp(`^\\{[^|{}]*\\} = \\{(${ID})(?: : [^|]+)? \\| [\\s\\S]+\\}$`).exec(t);
  if (!m) return undefined;
  const taken = new Set(st.hyps.flatMap((h) => h.names));
  const x = taken.has(m[1]) ? `${m[1]}'` : m[1];
  return `(ext ${x}; simp only [Set.mem_setOf_eq, Set.mem_insert_iff, Set.mem_singleton_iff, Set.mem_empty_iff_false])`;
}

/** Hypotheses `∀ x : ℝ, A = B`: their instances at a few numbers, for linarith / nlinarith. */
export function instanceFinishers(st: GoalState): string[] {
  const hs = st.hyps.filter((h) => h.names[0] && !isInaccessible(h.names[0]) && new RegExp(`^∀ \\(?${ID} : (ℝ|ℚ)\\)?, [^∀∃→]* = [^∀∃→]*$`).test(h.type.trim()));
  if (!hs.length || /^∀|^∃/.test(st.target)) return [];
  const facts = hs.slice(0, 3).flatMap((h) => ["0", "1", "(-1)", "2"].map((x) => `${h.names[0]} ${x}`)).join(", ");
  return [`linarith [${facts}]`, `nlinarith [${facts}]`];
}

/** ⊢ |E| < c ↔ a < x ∧ x < b (≤ too): the absolute value as two inequalities. */
export function absIntervalFinishers(st: GoalState): string[] {
  const t = st.target;
  if (topIndex(t, " ↔ ") < 0 || !/\|[^|]+\| (<|≤) /.test(t) || /^∀|^∃/.test(t)) return [];
  const open = "simp only [abs_lt, abs_le]";
  return [`(${open}; constructor <;> intro habs <;> constructor <;> linarith [habs.1, habs.2])`, `(${open}; constructor <;> intro habs <;> (first | linarith | (constructor <;> linarith) | (obtain ⟨h1, h2⟩ := habs; constructor <;> linarith)))`];
}

const leanFrac = (f: Frac) => {
  const s = f.toString();
  return s.includes("/") || s.startsWith("-") ? `(${s.replace("/", " / ")})` : s;
};

/** ⊢ IsLeast {y | ∃ x, y = a x² + b x + c} m (IsGreatest): reached at the vertex, and the square is ≥ 0. */
export function vertexFinishers(st: GoalState): string[] {
  const g = readExtremumGoal(st.target);
  if (!g || g.vars.length !== 1 || g.conjuncts.length !== 1) return [];
  const m = new RegExp(`^${g.setVar.replace(/[.*+?^${}()|[\]\\']/g, "\\$&")} = (.+)$`).exec(g.conjuncts[0].trim());
  const node = m ? tryParse(m[1]) : undefined;
  if (!m || !node) return [];
  const x = g.vars[0].replace(/\s*:.*$/, "").replace(/[()]/g, "").trim();
  let a: Frac | undefined;
  let b = new Frac(0n);
  try {
    const p = toPoly(m[1], node, new VarTable(new Set([x])));
    for (const [mono, c] of p.terms) {
      const parts = monoParts(mono);
      if (!parts.length) continue;
      if (parts.length !== 1 || parts[0][0] !== 0 || parts[0][1] > 2) return [];
      if (parts[0][1] === 2) a = c;
      else b = c;
    }
  } catch (e) {
    if (e instanceof NotPolynomial) return [];
    throw e;
  }
  if (!a || a.isZero()) return [];
  const x0 = leanFrac(b.neg().mul(a.mul(new Frac(2n)).inv()));
  return [`(refine ⟨⟨${x0}, by norm_num⟩, ?_⟩; rintro _ ⟨${x}, rfl⟩; nlinarith [sq_nonneg (${x} - ${x0})])`];
}

/** ⊢ d ∣ P n, Even (P n), Odd (P n), P n % d = r for one integer or natural variable: n mod d, case by case. */
export function modCasesFinishers(st: GoalState): string[] {
  const t = st.target.trim();
  const dvd = /^(\d+) ∣ (.+)$/.exec(t);
  const parity = /^(Even|Odd) (.+)$/.exec(t);
  const rem = /^(.+) % (\d+) = \d+$/.exec(t);
  const d = dvd ? Number(dvd[1]) : parity ? 2 : rem ? Number(rem[2]) : 0;
  const expr = dvd?.[2] ?? parity?.[2] ?? rem?.[1] ?? "";
  if (d < 2 || d > 30 || /[∀∃]/.test(t)) return [];
  const ints = st.hyps.filter((h) => /^(ℤ|ℕ)$/.test(h.type.trim())).flatMap((h) => h.names.map((n) => ({ n, nat: h.type.trim() === "ℕ" }))).filter((v) => !isInaccessible(v.n) && mentions(expr, v.n));
  if (ints.length !== 1) return [];
  const { n, nat } = ints[0];
  // truncated subtraction is not arithmetic mod d
  if (nat && / - /.test(expr)) return [];
  const cases = Array.from({ length: d }, (_, r) => `${n} % ${d} = ${r}`).join(" ∨ ");
  const pat = Array(d).fill("hmod").join(" | ");
  const lemmas = nat
    ? ["Nat.dvd_iff_mod_eq_zero", "Nat.even_iff", "Nat.odd_iff", "pow_succ", "Nat.add_mod", "Nat.mul_mod", "hmod"]
    : ["Int.dvd_iff_emod_eq_zero", "Int.even_iff", "Int.odd_iff", "pow_succ", "Int.sub_emod", "Int.add_emod", "Int.mul_emod", "hmod"];
  const head = `have hmod : ${cases} := (by omega); rcases hmod with ${pat}`;
  return [`(${head} <;> simp [${lemmas.join(", ")}])`, `(${head} <;> simp [${lemmas.join(", ")}] at * <;> omega)`];
}

/** ⊢ ∃ i j, i ≠ j ∧ f i = f j: more pigeons than holes. */
export function pigeonholeFinishers(st: GoalState): string[] {
  const m = new RegExp(`^∃ (${ID}) (${ID}), \\1 ≠ \\2 ∧ (${ID}) \\1 = \\3 \\2$`).exec(st.target.trim());
  return m ? [`exact Fintype.exists_ne_map_eq_of_card_lt ${m[3]} (by simp)`, `exact Fintype.exists_ne_map_eq_of_card_lt ${m[3]} (by decide)`] : [];
}

// ── sin, cos, tan of the special angles ──

/** The angle as a multiple k of π / 12 (15°), when `arg` is a rational multiple of π. */
function twelfths(arg: string): number | undefined {
  const expr = arg.replace(/Real\.pi|π/g, "PI");
  if (!/PI/.test(expr) || !/^[\d\s.*/+\-()PI]+$/.test(expr)) return undefined;
  const at = (pi: number): number | undefined => {
    try {
      // digits, arithmetic and PI only (checked above)
      const v = Function("PI", `"use strict"; return (${expr});`)(pi) as unknown;
      return typeof v === "number" && Number.isFinite(v) ? v : undefined;
    } catch {
      return undefined;
    }
  };
  const q = at(1);
  const q2 = at(2);
  if (q === undefined || q2 === undefined || Math.abs(q2 - 2 * q) > 1e-9) return undefined;
  const k = Math.round(q * 12);
  return Math.abs(q * 12 - k) < 1e-9 ? k : undefined;
}

/** k twelfths of π in [0, π] with a special value: its base form, and whether it is π minus an acute base. */
const BASE: Record<number, { text: string; name: string }> = {
  0: { text: "0", name: "zero" },
  2: { text: "Real.pi / 6", name: "pi_div_six" },
  3: { text: "Real.pi / 4", name: "pi_div_four" },
  4: { text: "Real.pi / 3", name: "pi_div_three" },
  6: { text: "Real.pi / 2", name: "pi_div_two" },
  12: { text: "Real.pi", name: "pi" },
};

/**
 * The rewrite that replaces sin / cos / tan of the special angles in the goal by their values:
 * each argument brought to π/6, π/4, π/3, π/2 (or π minus one of them) by `ring`, then Mathlib's
 * value lemmas. Undefined when the goal has no such term.
 */
export function specialAnglesStep(st: GoalState): string | undefined {
  const rewrites: string[] = [];
  const seen = new Set<string>();
  let found = false;
  for (const m of st.target.matchAll(/Real\.(sin|cos|tan) (\([^()]*(?:\([^()]*\)[^()]*)*\)|π|Real\.pi|0)/g)) {
    const fn = m[1];
    const arg = bare(m[2]);
    const k = twelfths(arg === "0" ? "0 * Real.pi" : arg);
    if (k === undefined || k < 0 || k > 12) continue;
    const sup = k > 6 && k < 12 ? BASE[12 - k] : undefined;
    const base = sup ? undefined : BASE[k];
    if (!sup && !base) continue;
    // tan (π / 2) is 0 in Lean, not what a problem means
    if (fn === "tan" && k === 6) continue;
    found = true;
    const to = sup ? `Real.pi - ${sup.text}` : base!.text;
    const key = `${arg}→${to}`;
    if (arg.replace(/\s+/g, "") !== to.replace(/\s+/g, "").replace(/Real\.pi/g, /π/.test(arg) ? "π" : "Real.pi") && !seen.has(key)) {
      seen.add(key);
      rewrites.push(`show (${arg} : ℝ) = ${to} by ring`);
    }
  }
  if (!found) return undefined;
  const values = ["sin", "cos", "tan"].flatMap((fn) => [`Real.${fn}_pi_sub`, ...Object.values(BASE).filter((b) => !(fn === "tan" && b.name === "pi_div_two")).map((b) => `Real.${fn}_${b.name}`)]);
  return `(${rewrites.length ? `rw [${rewrites.join(", ")}]; ` : ""}simp only [${values.join(", ")}])`;
}
