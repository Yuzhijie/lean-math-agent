/**
 * Symmetric inequalities in three positive reals with x · y · z = 1 — "prove the strengthened
 * inequality Σ 1/(1 + x)² ≥ 3/4 + 8(x + y + z − 3)/(2 + x + y + z + xy + yz + zx)², and from it the
 * least value of Σ 1/(1 + x)² and when it is taken" (a session's statement: the model's proofs
 * never got there, nlinarith has no hold on it).
 *
 * The method (the "pqr" substitution), every step checked by Lean:
 *   – each part `B ≤ A` as one fraction: A − B = N / Den, Den a product of factors without a
 *     negative coefficient (positive for positive x, y, z);
 *   – N is symmetric, so with xyz = 1 it is a polynomial G in p = x + y + z − 3 and
 *     q = xy + yz + zx − 3, both ≥ 0 by AM–GM, with p² + 6p − 3q ≥ 0 and q² + 6q − 3p ≥ 0
 *     (the squares of the differences);
 *   – G factored: every factor is an even power, has no negative coefficient, or is left to
 *     nlinarith with those four facts;
 *   – an equality case `A = B ↔ x = 1 ∧ y = 1 ∧ z = 1`: G = 0, where G is a combination of the two
 *     facts above (≥ 0) and monomials without a negative coefficient, one of them c·p with c > 0,
 *     forces p = 0, then q = 0, then (x − y)² + (y − z)² + (z − x)² = 0.
 * scripts/sym_inequality.py does the algebra (SymPy); nothing it says is trusted — `field_simp;
 * ring` checks the fraction, `linear_combination … * h` the reduction, positivity / nlinarith the
 * signs.
 */
import { isInaccessible, type GoalState } from "../geometry/goal";
import { parseTerm, ParseError, slice, unwrap, type Node } from "../geometry/expr";
import { Poly } from "../geometry/poly";
import { ID, Unsupported, letsUsed, num, power, runHelper as runScript, toAst, type Ast, type AstContext, type Sparse } from "./shared";

export { inlineLets, letsUsed } from "./shared";

/** The names the proof introduces itself; a statement that uses one is left to the other routes. */
const OWN = ["amgm_", "p_", "q_", "hpd_", "hqd_", "hp_", "hq_", "ht1_", "ht2_", "e_", "t_", "hfrac_", "hnum_", "hg_", "hden_", "hdiff_", "heq_", "hzero_", "hp0_", "hq0_", "hsq_", "hxy_", "hyz_"];

export interface SymmetricSetting {
  vars: [string, string, string];
  /** the hypotheses 0 < x, 0 < y, 0 < z, in the variables' order */
  positive: [string, string, string];
  /** the hypothesis x * y * z = 1 */
  product: string;
  /** let-bound names of the context with their values as Lean prints them */
  lets: Map<string, string>;
}

/** Three positive reals with product 1, as the goal's hypotheses say it. */
export function readSetting(st: GoalState): SymmetricSetting | undefined {
  const reals = new Set(st.hyps.filter((h) => h.type.trim() === "ℝ" && h.value === undefined).flatMap((h) => h.names));
  const lets = new Map<string, string>();
  for (const h of st.hyps) if (h.value !== undefined) for (const n of h.names) lets.set(n, h.value);
  let found: { vars: [string, string, string]; product: string } | undefined;
  for (const h of st.hyps) {
    const m = new RegExp(`^\\(?(${ID}) \\* (${ID})\\)? \\* (${ID}) = 1$`).exec(h.type.trim());
    if (!m || !h.names[0]) continue;
    const vars: [string, string, string] = [m[1], m[2], m[3]];
    if (new Set(vars).size === 3 && vars.every((v) => reals.has(v))) found = { vars, product: h.names[0] };
  }
  if (!found) return undefined;
  const pos = found.vars.map((v) => st.hyps.find((h) => new RegExp(`^(0 < ${v}|${v} > 0)$`).test(h.type.trim()))?.names[0]);
  if (pos.some((p) => !p)) return undefined;
  const names = [found.product, ...(pos as string[]), ...found.vars, ...lets.keys()];
  if (names.some((n) => isInaccessible(n) || OWN.includes(n) || /^hb\d+_$/.test(n))) return undefined;
  return { ...found, positive: pos as [string, string, string], lets };
}

export type Part =
  | { kind: "ineq"; /** `large - (small)` is shown ≥ 0 */ small: string; large: string }
  | { kind: "eqcase"; a: string; b: string };

/** The parts of the goal: `A ≤ B` / `A ≥ B`, and `A = B ↔ x = 1 ∧ y = 1 ∧ z = 1`; undefined when any part is something else. */
export function readParts(target: string, vars: readonly string[]): Part[] | undefined {
  let root: Node;
  try {
    root = parseTerm(target);
  } catch (e) {
    if (e instanceof ParseError) return undefined;
    throw e;
  }
  const conj: Node[] = [];
  const flatten = (n: Node) => {
    const u = unwrap(n);
    if (u.k === "bin" && u.op === "∧") {
      flatten(u.a);
      flatten(u.b);
    } else conj.push(u);
  };
  flatten(root);
  const text = (n: Node) => slice(target, n);
  const parts: Part[] = [];
  for (const n of conj) {
    if (n.k !== "bin") return undefined;
    if (n.op === "≤") parts.push({ kind: "ineq", small: text(n.a), large: text(n.b) });
    else if (n.op === "≥") parts.push({ kind: "ineq", small: text(n.b), large: text(n.a) });
    else if (n.op === "↔") {
      const left = unwrap(n.a);
      if (left.k !== "bin" || left.op !== "=") return undefined;
      const eqs: Node[] = [];
      const flat = (x: Node) => {
        const u = unwrap(x);
        if (u.k === "bin" && u.op === "∧") {
          flat(u.a);
          flat(u.b);
        } else eqs.push(u);
      };
      flat(n.b);
      const named = eqs.map((q) => (q.k === "bin" && q.op === "=" && /^\(?1\)?$/.test(text(q.b)) ? text(q.a) : undefined));
      if (named.length !== 3 || [...named].sort().join() !== [...vars].sort().join()) return undefined;
      parts.push({ kind: "eqcase", a: text(left.a), b: text(left.b) });
    } else return undefined;
  }
  return parts.length ? parts : undefined;
}

// ── the helper ────────────────────────────────────────────────────────

interface HelperPart {
  ok: boolean;
  why?: string;
  /** the part is false at x = y = z = 1 */
  false_at_one?: boolean;
  den_const: string;
  den: { poly: Sparse; exp: number }[];
  N: Sparse;
  cof: Sparse;
  g_const: string;
  g: { poly: Sparse; exp: number; kind: "even" | "coef" | "other" }[];
  /** G multiplied out, in P and Q */
  expanded: Sparse;
  /** G − λ(P² + 6P − 3Q) − μ(Q² + 6Q − 3P): what is left of G beside the two facts */
  rest: Sparse;
  /** the rest has no negative coefficient */
  expanded_coef: boolean;
  linear: "P" | "Q" | null;
}

interface HelperAnswer {
  rewrites: { id: number; product: [number, number][]; cof: Sparse }[];
  parts: HelperPart[];
}

const runHelper = (body: string, timeoutMs: number) => runScript<HelperAnswer>("sym_inequality.py", body, timeoutMs);

// ── the proof ─────────────────────────────────────────────────────────

/** What the helper needs to know of one statement, and what came back: the script is written from these. */
export interface Plan {
  setting: SymmetricSetting;
  parts: Part[];
  bases: string[];
  /** per part: the ids of the bases in it */
  partBases: number[][];
  answer: HelperAnswer;
  /** per part: the helper's part (for an equality case: the orientation that is ≥ 0) and whether its two sides were swapped */
  chosen: { part: HelperPart; swapped: boolean }[];
}

/** The helper's request for a goal, or why the goal is not of this kind. */
export function request(st: GoalState): { setting: SymmetricSetting; parts: Part[]; bases: string[]; partBases: number[][]; specs: { lhs: Ast; rhs: Ast }[]; specOf: number[][] } | string {
  const setting = readSetting(st);
  if (!setting) return "not three positive reals with product 1";
  const parts = readParts(st.target, setting.vars);
  if (!parts) return "a part of the goal is neither an inequality (≤, ≥) nor an equality case";
  const ctx: AstContext = { vars: setting.vars, lets: setting.lets, bases: [] };
  const specs: { lhs: Ast; rhs: Ast }[] = [];
  const specOf: number[][] = [];
  const partBases: number[][] = [];
  try {
    for (const p of parts) {
      const from = ctx.bases.length;
      const [a, b] = p.kind === "ineq" ? [p.large, p.small] : [p.a, p.b];
      const lhs = toAst(a, parseTerm(a), ctx);
      const rhs = toAst(b, parseTerm(b), ctx);
      partBases.push(ctx.bases.map((_, i) => i).slice(from));
      if (p.kind === "ineq") {
        specOf.push([specs.length]);
        specs.push({ lhs, rhs });
      } else {
        // an equality case: whichever of A − B, B − A is never negative
        specOf.push([specs.length, specs.length + 1]);
        specs.push({ lhs, rhs }, { lhs: rhs, rhs: lhs });
      }
    }
  } catch (e) {
    if (e instanceof Unsupported || e instanceof ParseError) return `an expression the route does not read (${e.message})`;
    throw e;
  }
  return { setting, parts, bases: ctx.bases, partBases, specs, specOf };
}

/** Why there is no plan; `counterexample` when an inequality of the goal is false at x = y = z = 1. */
export interface NoPlan {
  reason: string;
  counterexample?: string;
}

/** Ask the helper; a plan, or why there is none. */
export async function plan(st: GoalState, timeoutMs = 45_000): Promise<Plan | NoPlan> {
  const req = request(st);
  if (typeof req === "string") return { reason: req };
  const answer = await runHelper(JSON.stringify({ parts: req.specs, timeout: Math.ceil(timeoutMs / 1000) }), timeoutMs + 2_000);
  if (!answer) return { reason: "the algebra helper did not answer (python3 with SymPy, scripts/sym_inequality.py)" };
  const chosen: Plan["chosen"] = [];
  for (const [i, p] of req.parts.entries()) {
    const options = req.specOf[i].map((k, j) => ({ part: answer.parts[k], swapped: j === 1 }));
    const good = options.find((o) => o.part?.ok && (p.kind === "ineq" || (o.part.expanded_coef && o.part.linear)));
    if (!good) {
      const why = options.map((o) => o.part?.why).find(Boolean);
      const where = req.parts.length > 1 ? `part ${i + 1}: ` : "";
      if (p.kind === "ineq" && options[0].part?.false_at_one) {
        const [x, y, z] = req.setting.vars;
        return { reason: `${where}${p.small} ≤ ${p.large} is false at ${x} = ${y} = ${z} = 1`, counterexample: `${x} = ${y} = ${z} = 1` };
      }
      return { reason: p.kind === "ineq" ? `${where}${why ?? "no reduction"}` : `${where}${why ?? "the equality case does not follow from the reduced form (beside p² ≥ 3q and q² ≥ 3p it needs a term c·p or c·q and no negative coefficient)"}` };
    }
    chosen.push(good);
  }
  return { setting: req.setting, parts: req.parts, bases: req.bases, partBases: req.partBases, answer, chosen };
}

/** The proof script for the goal after the intros (the statement's own names in the context). */
export function script(pl: Plan): string {
  const { setting, parts, bases, answer } = pl;
  const [x, y, z] = setting.vars;
  const [hx, hy, hz] = setting.positive;
  const h = setting.product;
  const xyz = [...setting.vars];
  const pq = ["p_", "q_"];
  const lean = (s: Sparse, names: string[]) => Poly.fromSparse(s).toLean(names);
  const out: string[] = [];
  const push = (indent: number, ...lines: string[]) => out.push(...lines.map((l) => "  ".repeat(indent) + l));

  // AM–GM, the two sums as variables, the four facts about them
  push(
    0,
    "have amgm_ : ∀ a b c : ℝ, 0 < a → 0 < b → 0 < c → a * b * c = 1 → 3 ≤ a + b + c := by",
    "  intro a b c ha hb hc habc",
    // `only`: with the statement's hypotheses in reach nlinarith multiplies them too (8 s instead of a fraction of one)
    "  nlinarith only [habc, ha, hb, hc, sq_nonneg (a - b), sq_nonneg (b - c), sq_nonneg (c - a), sq_nonneg (a + b + c - 3), mul_pos ha hb, mul_pos hb hc, mul_pos hc ha]",
    `obtain ⟨p_, hpd_⟩ : ∃ p_ : ℝ, p_ = ${x} + ${y} + ${z} - 3 := ⟨_, rfl⟩`,
    `obtain ⟨q_, hqd_⟩ : ∃ q_ : ℝ, q_ = ${x} * ${y} + ${y} * ${z} + ${z} * ${x} - 3 := ⟨_, rfl⟩`,
    "have hp_ : 0 ≤ p_ := by",
    "  rw [hpd_]",
    `  linarith [amgm_ ${x} ${y} ${z} ${hx} ${hy} ${hz} ${h}]`,
    "have hq_ : 0 ≤ q_ := by",
    `  have e_ : ${x} * ${y} * (${y} * ${z}) * (${z} * ${x}) = 1 := by linear_combination (${x} * ${y} * ${z} + 1) * ${h}`,
    "  rw [hqd_]",
    `  linarith [amgm_ (${x} * ${y}) (${y} * ${z}) (${z} * ${x}) (mul_pos ${hx} ${hy}) (mul_pos ${hy} ${hz}) (mul_pos ${hz} ${hx}) e_]`,
    "have ht1_ : 0 ≤ p_ ^ 2 + 6 * p_ - 3 * q_ := by",
    `  have e_ : p_ ^ 2 + 6 * p_ - 3 * q_ = ((${x} - ${y}) ^ 2 + (${y} - ${z}) ^ 2 + (${z} - ${x}) ^ 2) / 2 := by`,
    "    rw [hpd_, hqd_]",
    "    ring",
    "  rw [e_]",
    "  positivity",
    "have ht2_ : 0 ≤ q_ ^ 2 + 6 * q_ - 3 * p_ := by",
    `  have e_ : q_ ^ 2 + 6 * q_ - 3 * p_ = ((${x} * ${y} - ${y} * ${z}) ^ 2 + (${y} * ${z} - ${z} * ${x}) ^ 2 + (${z} * ${x} - ${x} * ${y}) ^ 2) / 2 := by`,
    "    rw [hpd_, hqd_]",
    `    linear_combination (3 * (${x} + ${y} + ${z})) * ${h}`,
    "  rw [e_]",
    "  positivity",
  );
  // a denominator base that is a product of the others once xyz = 1
  const rewriteOf = new Map<number, string>();
  const stated = new Set<string>();
  for (const r of answer.rewrites) {
    const text = bases[r.id];
    if (text === undefined) continue;
    const name = `hb${r.id}_`;
    if (!stated.has(text)) {
      const product = r.product.map(([j, e]) => power(bases[j], e)).join(" * ");
      push(0, `have ${name} : ${text} = ${product} := by linear_combination (${lean(r.cof, xyz)}) * ${h}`);
      stated.add(text);
      rewriteOf.set(r.id, name);
    } else {
      const first = [...rewriteOf.entries()].find(([j]) => bases[j] === text);
      if (first) rewriteOf.set(r.id, first[1]);
    }
  }

  const fraction = (i: number, indent: number) => {
    const { part, swapped } = pl.chosen[i];
    const p = parts[i];
    const [a, b] = p.kind === "ineq" ? [p.large, p.small] : swapped ? [p.b, p.a] : [p.a, p.b];
    const diff = `${a} - (${b})`;
    const N = lean(part.N, xyz);
    const den = [num(part.den_const), ...part.den.map((d) => power(lean(d.poly, xyz), d.exp))].join(" * ");
    // an equality case reads the form multiplied out: every monomial is ≥ 0 there
    const G = p.kind === "eqcase" ? lean(part.expanded, pq) : [num(part.g_const), ...part.g.map((g) => power(lean(g.poly, pq), g.exp))].join(" * ");
    const used = letsUsed(diff, setting.lets);
    const rws = [...new Set(pl.partBases[i].map((id) => rewriteOf.get(id)).filter((n): n is string => !!n))];
    push(
      indent,
      `have hfrac_ : ${diff} = (${N}) / (${den}) := by`,
      ...(used.length ? [`  simp only [${used.join(", ")}]`] : []),
      ...(rws.length ? [`  rw [${rws.join(", ")}]`] : []),
      "  field_simp",
      "  ring",
      `have hnum_ : ${N} = ${G} := by`,
      "  rw [hpd_, hqd_]",
      `  linear_combination (${lean(part.cof, xyz)}) * ${h}`,
      `have hden_ : (0:ℝ) < ${den} := by positivity`,
    );
    return { diff, N, den, G, part, a, b };
  };

  /** A term proving 0 ≤ g_const · Π factor ^ exp. */
  const nonneg = (part: HelperPart) => {
    const terms = [`(by norm_num : (0:ℝ) ≤ ${num(part.g_const)})`];
    for (const g of part.g) {
      const f = lean(g.poly, pq);
      if (g.kind === "even") terms.push("Even.pow_nonneg (by decide) _");
      else {
        const why = g.kind === "coef" ? "positivity" : "nlinarith only [hp_, hq_, ht1_, ht2_, mul_nonneg hp_ hq_, sq_nonneg p_, sq_nonneg q_, sq_nonneg (p_ - q_), sq_nonneg (p_ + q_)]";
        const base = `(by ${why} : (0:ℝ) ≤ ${f})`;
        terms.push(g.exp === 1 ? base : `pow_nonneg ${base} ${g.exp}`);
      }
    }
    return terms.reduce((acc, t) => `mul_nonneg (${acc}) (${t})`);
  };

  const many = parts.length > 1;
  if (many) push(0, `refine ⟨${parts.map(() => "?_").join(", ")}⟩`);
  for (const [i, p] of parts.entries()) {
    const from = out.length;
    const ind = many ? 1 : 0;
    if (p.kind === "ineq") {
      const f = fraction(i, ind);
      push(ind, `have hg_ : (0:ℝ) ≤ ${f.G} := ${nonneg(f.part)}`, `have hdiff_ : 0 ≤ ${f.diff} := by`, "  rw [hfrac_, hnum_]", "  exact div_nonneg hg_ hden_.le", "exact sub_nonneg.mp hdiff_");
    } else {
      push(ind, "constructor", "· intro heq_");
      const f = fraction(i, ind + 1);
      const viaQ = f.part.linear === "Q";
      const [first, second, fact] = viaQ ? ["q_", "p_", "ht2_"] : ["p_", "q_", "ht1_"];
      const [h1, h2] = viaQ ? ["hq0_", "hp0_"] : ["hp0_", "hq0_"];
      const [pos1, pos2] = viaQ ? ["hq_", "hp_"] : ["hp_", "hq_"];
      // the form is 0, and it is two facts ≥ 0 plus monomials ≥ 0: the monomial c·p (or c·q) is ≤ 0
      const monomials = Poly.fromSparse(f.part.rest)
        .toSparse()
        .map(([, m]) => [m.v0 ?? 0, m.v1 ?? 0] as const)
        .filter(([i, j]) => i + j > 1)
        .map(([i, j]) => {
          // as terms: a `by positivity` inside linarith's list is elaborated too late for it to read
          const pw = (hyp: string, e: number) => (e === 1 ? hyp : `pow_nonneg ${hyp} ${e}`);
          return i && j ? `mul_nonneg (${pw("hp_", i)}) (${pw("hq_", j)})` : pw(i ? "hp_" : "hq_", i || j);
        });
      push(
        ind + 1,
        `have hzero_ : ${f.G} = 0 := by`,
        `  have e_ : (${f.N}) / (${f.den}) = 0 := by`,
        "    rw [← hfrac_]",
        "    linarith only [heq_]",
        "  rw [div_eq_zero_iff] at e_",
        "  rcases e_ with e_ | e_",
        "  · rw [← hnum_]",
        "    exact e_",
        "  · exact absurd e_ hden_.ne'",
        `have ${h1} : ${first} = 0 := le_antisymm (by linarith only [${["hzero_", "hp_", "hq_", "ht1_", "ht2_", ...monomials].join(", ")}]) ${pos1}`,
        `have ${h2} : ${second} = 0 := by`,
        `  have t_ := ${fact}`,
        `  rw [${h1}] at t_`,
        `  exact le_antisymm (by linarith only [t_]) ${pos2}`,
        "rw [hpd_] at hp0_",
        "rw [hqd_] at hq0_",
        `have hsq_ : (${x} - ${y}) ^ 2 + (${y} - ${z}) ^ 2 + (${z} - ${x}) ^ 2 = 0 := by linear_combination (2 * (${x} + ${y} + ${z}) + 6) * hp0_ - 6 * hq0_`,
        `have hxy_ : ${x} - ${y} = 0 := (pow_eq_zero_iff (by norm_num : (2:ℕ) ≠ 0)).mp (by linarith only [hsq_, sq_nonneg (${x} - ${y}), sq_nonneg (${y} - ${z}), sq_nonneg (${z} - ${x})])`,
        `have hyz_ : ${y} - ${z} = 0 := (pow_eq_zero_iff (by norm_num : (2:ℕ) ≠ 0)).mp (by linarith only [hsq_, sq_nonneg (${x} - ${y}), sq_nonneg (${y} - ${z}), sq_nonneg (${z} - ${x})])`,
        "exact ⟨by linarith only [hp0_, hxy_, hyz_], by linarith only [hp0_, hxy_, hyz_], by linarith only [hp0_, hxy_, hyz_]⟩",
      );
      const used = letsUsed(`${p.a} ${p.b}`, setting.lets);
      push(ind, "· rintro ⟨rfl, rfl, rfl⟩", used.length ? `  norm_num [${used.join(", ")}]` : "  norm_num");
    }
    if (many) out[from] = `· ${out[from].slice(2)}`;
  }
  return out.join("\n");
}
