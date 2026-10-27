/**
 * Angle mode of the geometry prover: statements whose angles are given and asked as
 * `Real.arccos (dot / (|QX| * |QZ|)) = q * π` with rational q — triangles with given angles and
 * points fixed by angles at two vertices (the "adventitious angles" family: 80°-80°-20° with
 * ∠PBC = 30°, ∠PCB = 10° → ∠BAP = 50°). The plain certificate search fails on these: a cosine
 * fixes a ray only up to reflection, every √ distance could have either sign, and cos 80°,
 * cos 20°, … are unrelated atoms. Here:
 *
 *  1. every angle hypothesis becomes `dot = cos α * (|QX| * |QZ|)` (Real.cos_arccos; the argument
 *     is in [-1, 1] because the arccos is neither 0 nor π);
 *  2. all angles are multiples of θ = π / N (N = 3, 6, 9, 12, 18 or 36): cos kθ and sin kθ are
 *     written as polynomials in c = cos θ, s = sin θ, reduced modulo s² + c² = 1 and
 *     T_{N/3}(c) = 1/2 (cos (N/3)θ = cos (π/3)) — whose real solutions are exactly the conjugates
 *     cos (mπ/N), sin (mπ/N) with m coprime to 2N, so an identity true in the figure is in the
 *     ideal. Each reduction is a `linear_combination` checked by Lean;
 *  3. orientation: the sign of each angle's cross product is proved (nlinarith from the
 *     hypotheses: a point inside a triangle, a coordinate's sign, …) or split into cases
 *     (`lt_trichotomy`; the zero case contradicts sin α ≠ 0). With the sign,
 *     `cross = ± sin α * (|QX| * |QZ|)` follows from (cross − S)(cross + S) = 0 — the unknown
 *     points are then fixed linearly, without the reflections;
 *  4. the asked angle β: `dot · sin β = ± cross · cos β` from a certificate over all of that, its
 *     cross product's sign, and then dot = cos β · |AB| · |AP| (the other root has the wrong
 *     sign), so `Real.arccos (dot / …) = β` by Real.arccos_cos.
 */
import { parseTerm, slice, unwrap, type Node } from "./expr";
import type { GoalState } from "./goal";
import { Frac, NotPolynomial, Poly, toPoly, VarTable } from "./poly";
import { findCertificate } from "./certificate";
import { Fail, haveFirst, heavy, proveNonzero, readFacts, state, tryParse, type Facts } from "./prove";
import type { TacticRunner } from "../tactic-runner";

/** Divisions of π the angle mode works with (θ = π / N); N / 3 gives the relation cos (N/3 · θ) = 1/2. */
const STEPS = [3, 6, 9, 12, 18, 36];

interface Angle {
  /** the hypothesis (undefined for the goal) */
  name?: string;
  /** `dot` and `|QX| * |QZ|` as printed */
  N: string;
  D: string;
  Dnode: Node;
  d1: { text: string; arg: string };
  d2: { text: string; arg: string };
  /** cross product text (QX × QZ), undefined when the vectors could not be read */
  cross?: string;
  /** the angle's text (`4 * Real.pi / 9`) and value / π */
  alpha: string;
  q: Frac;
}

function isArccos(n: Node): Node | undefined {
  const u = unwrap(n);
  return u.k === "app" && u.fn === "Real.arccos" && u.args.length === 1 ? u.args[0] : undefined;
}

/** q for a term `q * π` (π as Real.pi / π), else undefined. */
export function piMultiple(text: string): Frac | undefined {
  const n = tryParse(text);
  if (!n) return undefined;
  const vars = new VarTable(new Set());
  try {
    const p = toPoly(text, n, vars);
    if (vars.atoms.length !== 1 || !/^(Real\.pi|π)$/.test(vars.atoms[0].text)) return undefined;
    if (p.terms.size !== 1) return undefined;
    const c = p.terms.get(`v${vars.atoms[0].index}`);
    return c && c.n > 0n && c.n < c.d ? c : undefined;
  } catch (e) {
    if (e instanceof NotPolynomial) return undefined;
    throw e;
  }
}

function sqrtOf(src: string, n: Node): { text: string; arg: string } | undefined {
  const u = unwrap(n);
  if (u.k === "sqrt") return { text: slice(src, u), arg: slice(src, u.a) };
  if (u.k === "app" && u.fn === "Real.sqrt" && u.args.length === 1) return { text: slice(src, u), arg: slice(src, u.args[0]) };
  return undefined;
}

function polyOf(text: string, vars: VarTable): Poly | undefined {
  const n = tryParse(text);
  if (!n) return undefined;
  try {
    return toPoly(text, n, vars);
  } catch (e) {
    if (e instanceof NotPolynomial) return undefined;
    throw e;
  }
}

/** `Real.arccos (N / (√A * √B)) = α` → the parts, with the cross product when N = a₁b₁ + a₂b₂ and A = |a|², B = |b|². */
export function readAngle(src: string, lhs: Node, rhs: Node, realVars: Set<string>): Angle | undefined {
  const arg = isArccos(lhs);
  if (!arg) return undefined;
  const alpha = slice(src, rhs);
  const q = piMultiple(alpha);
  if (!q) return undefined;
  const frac = unwrap(arg);
  if (frac.k !== "bin" || frac.op !== "/") return undefined;
  const den = unwrap(frac.b);
  if (den.k !== "bin" || den.op !== "*") return undefined;
  const s1 = sqrtOf(src, den.a);
  const s2 = sqrtOf(src, den.b);
  if (!s1 || !s2) return undefined;
  const angle: Angle = { N: slice(src, frac.a), D: slice(src, den), Dnode: den, d1: s1, d2: s2, alpha, q };
  // the vectors: N = a1 * b1 + a2 * b2
  const num = unwrap(frac.a);
  if (num.k === "bin" && num.op === "+") {
    const l = unwrap(num.a);
    const r = unwrap(num.b);
    if (l.k === "bin" && l.op === "*" && r.k === "bin" && r.op === "*") {
      const [a1, b1, a2, b2] = [l.a, l.b, r.a, r.b].map((x) => slice(src, x));
      const vars = new VarTable(realVars);
      const sq = (x: string, y: string) => polyOf(`(${x}) ^ 2 + (${y}) ^ 2`, vars);
      const A = polyOf(s1.arg, vars);
      const B = polyOf(s2.arg, vars);
      const pa = sq(a1, a2);
      const pb = sq(b1, b2);
      if (A && B && pa && pb) {
        if (A.sub(pa).isZero() && B.sub(pb).isZero()) angle.cross = `(${a1}) * (${b2}) - (${a2}) * (${b1})`;
        else if (A.sub(pb).isZero() && B.sub(pa).isZero()) angle.cross = `(${b1}) * (${a2}) - (${b2}) * (${a1})`;
      }
    }
  }
  return angle;
}

// ── polynomials in c = cos θ (v0), s = sin θ (v1) ────────────────────────────

function monoExps(m: string): Map<number, number> {
  const out = new Map<number, number>();
  if (!m) return out;
  for (const part of m.split("*")) {
    const [v, e] = part.split("^");
    out.set(Number(v.slice(1)), e ? Number(e) : 1);
  }
  return out;
}

function mono(exps: Map<number, number>, coef: Frac): Poly {
  let p = Poly.const(coef);
  for (const [v, e] of exps) if (e > 0) p = p.mul(Poly.variable(v).pow(e));
  return p;
}

const C = Poly.variable(0);
const S = Poly.variable(1);
const one = (n: bigint, d = 1n) => Poly.const(new Frac(n, d));

/** Chebyshev T_k(c): cos kθ as a polynomial in cos θ. */
export function chebyshev(k: number): Poly {
  let a = one(1n);
  let b = C;
  if (k === 0) return a;
  for (let i = 1; i < k; i++) [a, b] = [b, C.scale(new Frac(2n)).mul(b).sub(a)];
  return b;
}

/** R1 = s² + c² − 1, R2 = T_k(c) − 1/2. */
export function relations(k: number): { r1: Poly; r2: Poly } {
  return { r1: S.mul(S).add(C.mul(C)).sub(one(1n)), r2: chebyshev(k).sub(one(1n, 2n)) };
}

/** p = rest + q1·R1 + q2·R2 with s-degree ≤ 1 and c-degree < k in rest (R2 only when given). */
export function reduceTrig(p: Poly, k: number, useR2: boolean): { rest: Poly; q1: Poly; q2: Poly } {
  const { r1, r2 } = relations(k);
  const lead = r2.terms.get(k === 1 ? "v0" : `v0^${k}`)!;
  let rest = p;
  let q1 = new Poly();
  let q2 = new Poly();
  for (let guard = 0; guard < 5000; guard++) {
    let done = true;
    for (const [m, coef] of rest.terms) {
      const e = monoExps(m);
      const es = e.get(1) ?? 0;
      const ec = e.get(0) ?? 0;
      if (es >= 2) {
        e.set(1, es - 2);
        const t = mono(e, coef);
        rest = rest.sub(t.mul(r1));
        q1 = q1.add(t);
        done = false;
        break;
      }
      if (useR2 && ec >= k) {
        e.set(0, ec - k);
        const t = mono(e, coef.mul(lead.inv()));
        rest = rest.sub(t.mul(r2));
        q2 = q2.add(t);
        done = false;
        break;
      }
    }
    if (done) return { rest, q1, q2 };
  }
  throw new Fail("the trigonometric reduction did not settle");
}

/** The chain cos jθ = C_j, sin jθ = S_j (j = 1..K), each from the one before by cos_add / sin_add. */
export function trigChain(K: number, k: number): { cos: Poly; sin: Poly; cosQ: [Poly, Poly]; sinQ: [Poly, Poly] }[] {
  const out: { cos: Poly; sin: Poly; cosQ: [Poly, Poly]; sinQ: [Poly, Poly] }[] = [];
  out[1] = { cos: C, sin: S, cosQ: [new Poly(), new Poly()], sinQ: [new Poly(), new Poly()] };
  for (let j = 2; j <= K; j++) {
    const prev = out[j - 1];
    // cos jθ is still unreduced by R2 at j = k: it is what R2 is read from
    const useR2 = j > k;
    const rc = reduceTrig(prev.cos.mul(C).sub(prev.sin.mul(S)), k, useR2);
    const rs = reduceTrig(prev.sin.mul(C).add(prev.cos.mul(S)), k, useR2);
    out[j] = { cos: rc.rest, sin: rs.rest, cosQ: [rc.q1, rc.q2], sinQ: [rs.q1, rs.q2] };
  }
  return out;
}

function isqrt(n: bigint): bigint | undefined {
  if (n < 0n) return undefined;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x * x === n ? x : undefined;
}

function ratSqrt(c: Frac): Frac | undefined {
  const n = isqrt(c.n);
  const d = isqrt(c.d);
  return n !== undefined && d !== undefined ? new Frac(n, d) : undefined;
}

// ── the proof ─────────────────────────────────────────────────────────────────

function lcm(a: bigint, b: bigint): bigint {
  const g = (x: bigint, y: bigint): bigint => (y === 0n ? x : g(y, x % y));
  return (a / g(a, b)) * b;
}

/** θ = π / N for the given multiples of π, or undefined. */
export function chooseStep(qs: Frac[]): number | undefined {
  const den = qs.reduce((acc, q) => lcm(acc, q.d), 1n);
  return STEPS.find((n) => BigInt(n) % den === 0n);
}

interface Ctx {
  run: TacticRunner;
  N: number;
  /** names of the facts this mode added */
  sinPos: Map<string, string>;
  /** (√E) ^ 2 = E per root text */
  sq: Map<string, string>;
  /** sin α ^ 2 + cos α ^ 2 = 1 per angle text */
  pyth: Map<string, string>;
  /** the relations R1, R2 (names) */
  rel?: { r1: string; r2: string };
}

const lin = (parts: [Poly, string][], names: string[]): string => {
  const terms = parts.filter(([p]) => !p.isZero()).map(([p, h]) => `(${p.toLean(names)}) * ${h}`);
  return terms.length ? `linear_combination ${terms.join(" + ")}` : "ring";
};

async function apply(run: TacticRunner, tactic: string, what: string): Promise<void> {
  if (!(await run.apply(tactic))) throw new Fail(`${what}: ${run.lastError().split("\n")[0]}`);
}

/** The trigonometric facts: chain, relations, every cos/sin of the angles as a polynomial in cos θ, sin θ. */
async function trigSetup(run: TacticRunner, N: number, angles: string[]): Promise<{ r1: string; r2: string }> {
  const k0 = N / 3;
  const theta = `Real.pi / ${N}`;
  const names = [`Real.cos (${theta})`, `Real.sin (${theta})`];
  const ks = angles.map((a) => {
    const q = piMultiple(a)!;
    return Number((q.n * BigInt(N)) / q.d);
  });
  const K = Math.max(k0, ...ks, 1);
  const chain = trigChain(K, k0);
  const hR1 = run.fresh("hR");
  await apply(run, `have ${hR1} : Real.sin (${theta}) ^ 2 + Real.cos (${theta}) ^ 2 = 1 := Real.sin_sq_add_cos_sq _`, "sin² + cos²");
  const hR2 = run.fresh("hR");
  const hc: string[] = [];
  const hs: string[] = [];
  hc[1] = run.fresh("hcos");
  hs[1] = run.fresh("hsin");
  await apply(run, `have ${hc[1]} : Real.cos (1 * (${theta})) = Real.cos (${theta}) := by rw [one_mul]`, "cos θ");
  await apply(run, `have ${hs[1]} : Real.sin (1 * (${theta})) = Real.sin (${theta}) := by rw [one_mul]`, "sin θ");
  if (k0 === 1) {
    await apply(run, `have ${hR2} : ${chebyshev(1).toLean(names)} = 1 / 2 := by rw [show (${theta} : ℝ) = Real.pi / 3 by ring]; exact Real.cos_pi_div_three`, "cos (π/3)");
  }
  for (let j = 2; j <= K; j++) {
    const step = `rw [show (${j} : ℝ) * (${theta}) = ${j - 1} * (${theta}) + ${theta} by ring`;
    const lc = (q: [Poly, Poly]) => lin([[q[0], hR1], [q[1], hR2]], names);
    hc[j] = run.fresh("hcos");
    await apply(run, heavy(`have ${hc[j]} : Real.cos (${j} * (${theta})) = ${chain[j].cos.toLean(names)} := by ${step}, Real.cos_add, ${hc[j - 1]}, ${hs[j - 1]}]; ${lc(chain[j].cosQ)}`), `cos ${j}θ`);
    hs[j] = run.fresh("hsin");
    await apply(run, heavy(`have ${hs[j]} : Real.sin (${j} * (${theta})) = ${chain[j].sin.toLean(names)} := by ${step}, Real.sin_add, ${hs[j - 1]}, ${hc[j - 1]}]; ${lc(chain[j].sinQ)}`), `sin ${j}θ`);
    if (j === k0) {
      await apply(run, `have ${hR2} : ${chebyshev(k0).toLean(names)} = 1 / 2 := by rw [← Real.cos_pi_div_three, show (Real.pi / 3 : ℝ) = ${k0} * (${theta}) by ring, ${hc[k0]}]`, `cos (${k0}θ) = 1/2`);
    }
  }
  // the angles themselves
  const seen = new Set<string>();
  for (const [i, a] of angles.entries()) {
    if (seen.has(a) || a.replace(/\s+/g, "") === theta.replace(/\s+/g, "")) continue;
    seen.add(a);
    const k = ks[i];
    for (const [fn, h] of [["cos", hc[k]], ["sin", hs[k]]] as const) {
      await apply(run, `have ${run.fresh("hang")} : Real.${fn} (${a}) = ${(fn === "cos" ? chain[k].cos : chain[k].sin).toLean(names)} := by rw [show (${a} : ℝ) = ${k} * (${theta}) by ring]; exact ${h}`, `${fn} (${a})`);
    }
  }
  return { r1: hR1, r2: hR2 };
}

/** 0 < sin α for an angle in (0, π). */
async function sinPos(ctx: Ctx, alpha: string): Promise<string> {
  const known = ctx.sinPos.get(alpha);
  if (known) return known;
  const name = ctx.run.fresh("hsinpos");
  await apply(ctx.run, `have ${name} : 0 < Real.sin (${alpha}) := Real.sin_pos_of_pos_of_lt_pi (by positivity) (by linarith only [Real.pi_pos])`, `sin (${alpha}) > 0`);
  ctx.sinPos.set(alpha, name);
  return name;
}

/** Proof terms of the positive facts in context (0 < t), for nlinarith. */
function positives(f: Facts): string[] {
  return f.lts.map((l) => {
    const lo = unwrap(l.lo);
    return lo.k === "num" && lo.text === "0" ? l.name : `(sub_pos.mpr ${l.name})`;
  });
}

/** The sign of an expression from the hypotheses: 1, -1 or 0 (unknown); adds the fact. */
async function proveSign(run: TacticRunner, expr: string): Promise<{ sign: 1 | -1; name: string } | undefined> {
  const f = readFacts(state(run));
  // the case facts first, then the statement's own; lengths and sines carry no side information
  const rank = (name: string) => (/^hside\d+$/.test(name) ? 0 : /^h(dpos|sinpos|den|fac|pos)\d+$/.test(name) ? 2 : 1);
  const pos = positives({ ...f, lts: [...f.lts].sort((a, b) => rank(a.name) - rank(b.name)).filter((l) => rank(l.name) < 2) }).slice(0, 8);
  const prods: string[] = [];
  for (let i = 0; i < pos.length; i++) for (let j = i; j < pos.length; j++) prods.push(`mul_pos ${pos[i]} ${pos[j]}`);
  const hints = [...pos, ...prods].join(", ");
  const name = run.fresh("hside");
  for (const [sign, stmt] of [
    [1, `0 < ${expr}`],
    [-1, `${expr} < 0`],
  ] as const) {
    const proofs = [`by nlinarith only [${hints}]`, `by positivity`];
    if (await haveFirst(run, name, stmt, proofs)) return { sign, name };
  }
  return undefined;
}

/** Equations in context as polynomials, for a certificate. */
function contextHyps(st: GoalState, vars: VarTable): { name: string; poly: Poly }[] {
  const f = readFacts(st);
  const out: { name: string; poly: Poly }[] = [];
  for (const e of f.eqs) {
    // the chain cos jθ / sin jθ is only a means to the per-angle facts; arccos terms are not algebra
    if (/^h(cos|sin|key|sq0)\d+$/.test(e.name) || e.text.includes("Real.arccos")) continue;
    try {
      out.push({ name: e.name, poly: toPoly(e.text, e.node.a, vars).sub(toPoly(e.text, e.node.b, vars)) });
    } catch (err) {
      if (!(err instanceof NotPolynomial)) throw err;
    }
  }
  return out;
}

/** `have name : L = R := by linear_combination …` with the coefficients from a certificate over the context. */
async function haveByCertificate(run: TacticRunner, name: string, L: string, R: string, what: string, ctx?: Ctx): Promise<void> {
  const st = state(run);
  const f = readFacts(st);
  const vars = new VarTable(f.realVars);
  const lp = polyOf(L, vars);
  const rp = polyOf(R, vars);
  if (!lp || !rp) throw new Fail(`${what}: not polynomial`);
  const hyps = contextHyps(st, vars);
  const goal = lp.sub(rp);
  if (process.env.GEOMETRY_DEBUG) {
    console.error(`[geometry] angle goal ${what}: ${goal.toLean(vars.names)} = 0`);
  }
  let field: { c: number; s: number; r1: string; r2: string } | undefined;
  if (ctx?.rel) {
    const theta = `Real.pi / ${ctx.N}`;
    const c = polyOf(`Real.cos (${theta})`, vars);
    const s = polyOf(`Real.sin (${theta})`, vars);
    const ci = c ? [...c.vars()][0] : undefined;
    const si = s ? [...s.vars()][0] : undefined;
    if (ci !== undefined && si !== undefined) field = { c: ci, s: si, r1: ctx.rel.r1, r2: ctx.rel.r2 };
  }
  const cert = await findCertificate({ vars: vars.names.map((_, i) => `v${i}`), hyps, goal, multipliers: [], timeoutSec: 90, ...(field ? { field } : {}) });
  if (!cert.ok) throw new Fail(`${what}: ${cert.reason}`);
  // a chain: one fact per unknown, `v = e`, each from the hypotheses and the facts before it
  const stepName = new Map<string, string>();
  const combo = (coefs: Map<string, Poly>) =>
    [...coefs]
      .map(([h, c]) => {
        const ref = h.startsWith("step:") ? stepName.get(h.slice(5)) : h;
        if (!ref) throw new Fail(`${what}: a step refers to an unknown fact`);
        return `(${c.toLean(vars.names)}) * ${ref}`;
      })
      .join(" + ") || "0";
  for (const st of cert.steps ?? []) {
    const sname = run.fresh("hstep");
    const stmt = `${vars.names[st.var]} = ${st.expr.toLean(vars.names)}`;
    const t = heavy(`have ${sname} : ${stmt} := by linear_combination ${combo(st.coefficients)}`);
    if (!(await run.apply(t))) throw new Fail(`${what} (step ${st.name}): ${run.lastError().split("\n")[0]}`);
    stepName.set(st.name, sname);
  }
  const tactic = heavy(`have ${name} : ${L} = ${R} := by linear_combination ${combo(cert.coefficients)}`);
  if (await run.apply(tactic)) return;
  // tactic mode keeps the default heartbeat budget whatever the statement sets; the whole script
  // is checked with a larger one, so a big certificate stands in as `sorry` here and is checked there
  if (/maximum number of heartbeats/.test(run.lastError()) && (await run.apply(`have ${name} : ${L} = ${R} := sorry`, tactic))) return;
  throw new Fail(`${what}: ${run.lastError().split("\n")[0]}`);
}

/**
 * `|u| * |v| ≠ 0` for a product of two lengths: each √E with E = (a − b)² + (c − d)² is nonzero by
 * the hypothesis that those two points differ (found by comparing polynomials, one attempt), a
 * constant E by norm_num; otherwise the general proof (slower: it tries several ways).
 */
async function lengthsNonzero(run: TacticRunner, src: string, a: Angle, f: Facts): Promise<string> {
  const vars = new VarTable(f.realVars);
  const one = async (d: { text: string; arg: string }): Promise<string | undefined> => {
    const name = run.fresh("hlen");
    const E = polyOf(d.arg, vars);
    if (!E) return undefined;
    const c = E.constValue();
    if (c) return (await run.apply(`have ${name} : ${d.text} ≠ 0 := by norm_num`)) ? name : undefined;
    for (const p of f.pointNes) {
      const u = `(${slice(p.text, p.a)}) - (${slice(p.text, p.b)})`;
      const v = `(${slice(p.text, p.c)}) - (${slice(p.text, p.d)})`;
      const P = polyOf(`(${u}) ^ 2 + (${v}) ^ 2`, vars);
      if (!P || !P.sub(E).isZero()) continue;
      const tac = `have ${name} : ${d.text} ≠ 0 := (Real.sqrt_pos.mpr (by rcases not_and_or.mp ${p.name} with h' | h' <;> nlinarith only [sq_pos_of_ne_zero (sub_ne_zero.mpr h'), sq_nonneg (${u}), sq_nonneg (${v})])).ne'`;
      if (await run.apply(tac)) return name;
    }
    return undefined;
  };
  const h1 = await one(a.d1);
  const h2 = h1 && (await one(a.d2));
  if (h1 && h2) {
    const name = run.fresh("hden");
    if (await run.apply(`have ${name} : (${a.D}) ≠ 0 := mul_ne_zero ${h1} ${h2}`)) return name;
  }
  return proveNonzero(run, src, a.Dnode, f);
}

/** Step 1 for one hypothesis: `Real.arccos (N / D) = α` → `N = Real.cos α * D`. */
async function dotFact(ctx: Ctx, a: Angle, f: Facts, src: string): Promise<{ dot: string; dpos: string }> {
  const run = ctx.run;
  const hD = await lengthsNonzero(run, src, a, f);
  const dot = run.fresh("hdot");
  const x = `${a.N} / (${a.D})`;
  const tac = [
    `have ${dot} : ${a.N} = Real.cos (${a.alpha}) * (${a.D}) := by`,
    `  have harc1 : -1 ≤ ${x} := by`,
    `    by_contra hc`,
    `    rw [Real.arccos_of_le_neg_one (not_le.mp hc).le] at ${a.name}`,
    `    linarith only [Real.pi_pos, ${a.name}]`,
    `  have harc2 : ${x} ≤ 1 := by`,
    `    by_contra hc`,
    `    rw [Real.arccos_of_one_le (not_le.mp hc).le] at ${a.name}`,
    `    linarith only [Real.pi_pos, ${a.name}]`,
    `  rw [← div_eq_iff ${hD}, ← ${a.name}, Real.cos_arccos harc1 harc2]`,
  ].join("\n");
  await apply(run, tac, `cos of the angle ${a.alpha}`);
  const dpos = run.fresh("hdpos");
  await apply(run, `have ${dpos} : 0 < ${a.D} := lt_of_le_of_ne (mul_nonneg (Real.sqrt_nonneg _) (Real.sqrt_nonneg _)) (Ne.symm ${hD})`, "positive lengths");
  return { dot, dpos };
}

/**
 * X² − (sin α · D)² as a combination of the facts (Lagrange's identity X² + N² = |a|²|b|² is what
 * `ring` checks): −d₂²·(d₁² = A) − A·(d₂² = B) − D²·(sin² + cos² = 1) − (N + cos α · D)·(N = cos α · D).
 */
function lagrange(ctx: Ctx, a: Ready, sign: 1 | -1): string {
  const h1 = ctx.sq.get(a.d1.text);
  const h2 = ctx.sq.get(a.d2.text);
  const hp = ctx.pyth.get(a.alpha);
  if (!h1 || !h2 || !hp) throw new Fail("missing facts for the cross product");
  const t = (c: string, h: string) => `(${sign === 1 ? "" : "-"}(${c})) * ${h}`;
  return [t(`-(${a.d2.text}) ^ 2`, h1), t(`-(${a.d1.arg})`, h2), t(`-(${a.D}) ^ 2`, hp), t(`-((${a.N}) + Real.cos (${a.alpha}) * (${a.D}))`, a.dot)].join(" + ");
}

/** Step 3 for one angle: `cross = ± sin α * D` once the sign of the cross product is known. */
async function crossFact(ctx: Ctx, a: Angle & { dot: string; dpos: string }, sign: 1 | -1, side: string): Promise<void> {
  const run = ctx.run;
  const hsin = await sinPos(ctx, a.alpha);
  const S = `Real.sin (${a.alpha}) * (${a.D})`;
  const signed = sign === 1 ? S : `-(${S})`;
  const key = run.fresh("hkey");
  await apply(run, heavy(`have ${key} : ((${a.cross}) - (${signed})) * ((${a.cross}) + (${signed})) = 0 := by linear_combination ${lagrange(ctx, a, 1)}`), `cross product of ${a.alpha}`);
  const name = run.fresh("hcross");
  const tac = [
    `have ${name} : ${a.cross} = ${signed} := by`,
    `  have hS : 0 ≤ ${S} := mul_nonneg ${hsin}.le ${a.dpos}.le`,
    `  rcases mul_eq_zero.mp ${key} with h | h`,
    `  · linarith only [h]`,
    `  · linarith only [h, hS, ${side}]`,
  ].join("\n");
  await apply(run, tac, `the side of ${a.alpha}`);
}

/** The zero case of a split: cross = 0 contradicts sin α ≠ 0. */
async function zeroCase(ctx: Ctx, a: Angle & { dot: string; dpos: string }, hz: string): Promise<void> {
  const run = ctx.run;
  const hsin = await sinPos(ctx, a.alpha);
  const sq = run.fresh("hsq0");
  await apply(run, heavy(`have ${sq} : (Real.sin (${a.alpha}) * (${a.D})) ^ 2 = 0 := by linear_combination ${lagrange(ctx, a, -1)} + (${a.cross}) * ${hz}`), "collinear case");
  await apply(run, `exact absurd ${sq} (pow_pos (mul_pos ${hsin} ${a.dpos}) 2).ne'`, "collinear case");
}

type Ready = Angle & { dot: string; dpos: string };

/** Steps 3–4 from angle i on, splitting into cases where a side is not decided by the hypotheses. */
async function sides(ctx: Ctx, angles: Ready[], i: number, goal: Ready, finish: () => Promise<void>): Promise<void> {
  const run = ctx.run;
  for (; i < angles.length; i++) {
    const a = angles[i];
    if (!a.cross) continue;
    const s = await proveSign(run, a.cross);
    if (s) {
      await crossFact(ctx, a, s.sign, s.name);
      continue;
    }
    // split: a < 0 | a = 0 | 0 < a
    const [hn, hz, hp] = [run.fresh("hside"), run.fresh("hzero"), run.fresh("hside")];
    await apply(run, `rcases lt_trichotomy (${a.cross}) 0 with ${hn} | ${hz} | ${hp}`, "case split on a side");
    const open = run.goals().length;
    await crossFact(ctx, a, -1, hn);
    await sides(ctx, angles, i + 1, goal, finish);
    if (run.goals().length !== open - 1) throw new Fail("a case stayed open");
    await zeroCase(ctx, a, hz);
    await crossFact(ctx, a, 1, hp);
    await sides(ctx, angles, i + 1, goal, finish);
    return;
  }
  await finish();
}

/** Step 4: the asked angle. */
async function closeGoal(ctx: Ctx, g: Angle): Promise<void> {
  const run = ctx.run;
  if (!g.cross) throw new Fail("the asked angle's vectors could not be read");
  const s = await proveSign(run, g.cross);
  if (!s) throw new Fail("could not decide the side of the asked angle");
  const hsin = await sinPos(ctx, g.alpha);
  const X = s.sign === 1 ? `(${g.cross})` : `(-(${g.cross}))`;
  const cosSign = g.q.n * 2n < g.q.d ? 1 : g.q.n * 2n > g.q.d ? -1 : 0;
  const htan = run.fresh("htan");
  await haveByCertificate(run, htan, `(${g.N}) * Real.sin (${g.alpha})`, `${X} * Real.cos (${g.alpha})`, "the asked angle", ctx);
  const key = run.fresh("hkey");
  {
    // N² − cos²β·D² = (N sin β + X cos β)·(N sin β − X cos β) − cos²β·(D² − |a|²|b|²) − N²·(sin² + cos² − 1), with N² + X² = |a|²|b|²
    const h1 = ctx.sq.get(g.d1.text);
    const h2 = ctx.sq.get(g.d2.text);
    const hp = ctx.pyth.get(g.alpha);
    if (!h1 || !h2 || !hp) throw new Fail("missing facts for the asked angle");
    const cb = `Real.cos (${g.alpha})`;
    const sb = `Real.sin (${g.alpha})`;
    const combo = [
      `((${g.N}) * ${sb} + ${X} * ${cb}) * ${htan}`,
      `(-(${cb}) ^ 2 * (${g.d2.text}) ^ 2) * ${h1}`,
      `(-(${cb}) ^ 2 * (${g.d1.arg})) * ${h2}`,
      `(-(${g.N}) ^ 2) * ${hp}`,
    ].join(" + ");
    await apply(run, heavy(`have ${key} : ((${g.N}) - ${cb} * (${g.D})) * ((${g.N}) + ${cb} * (${g.D})) = 0 := by linear_combination ${combo}`), "the asked angle's cosine");
  }
  const fin = run.fresh("hfin");
  const hx = s.sign === 1 ? s.name : `(neg_pos.mpr ${s.name})`;
  const dn = `mul_nonneg (Real.sqrt_nonneg _) (Real.sqrt_nonneg _)`;
  let lines: string[];
  if (cosSign === 0) {
    lines = [`have ${fin} : ${g.N} = Real.cos (${g.alpha}) * (${g.D}) := by`, `  have hc0 : Real.cos (${g.alpha}) = 0 := by rw [show (${g.alpha} : ℝ) = Real.pi / 2 by ring]; exact Real.cos_pi_div_two`, `  rw [hc0] at ${htan} ⊢`, `  nlinarith only [${hsin}, ${htan}]`];
  } else {
    const hcos =
      cosSign === 1
        ? `Real.cos_pos_of_mem_Ioo ⟨by linarith only [Real.pi_pos], by linarith only [Real.pi_pos]⟩`
        : `Real.cos_neg_of_pi_div_two_lt_of_lt (by linarith only [Real.pi_pos]) (by linarith only [Real.pi_pos])`;
    const rel = cosSign === 1 ? "0 < Real.cos" : "Real.cos";
    const relEnd = cosSign === 1 ? "" : " < 0";
    lines = [
      `have ${fin} : ${g.N} = Real.cos (${g.alpha}) * (${g.D}) := by`,
      `  have hc : ${rel} (${g.alpha})${relEnd} := ${hcos}`,
      `  have hD : 0 ≤ ${g.D} := ${dn}`,
      `  have hx : 0 < ${X} := ${hx}`,
      `  have hcD : ${cosSign === 1 ? "0 ≤" : ""} Real.cos (${g.alpha}) * (${g.D})${cosSign === 1 ? "" : " ≤ 0"} := by nlinarith only [hc, hD]`,
      `  have hN : ${cosSign === 1 ? `0 < ${g.N}` : `${g.N} < 0`} := by nlinarith only [${htan}, ${hsin}, mul_pos hx ${cosSign === 1 ? "hc" : "(neg_pos.mpr hc)"}]`,
      `  rcases mul_eq_zero.mp ${key} with h | h`,
      `  · linarith only [h]`,
      `  · linarith only [h, hN, hcD]`,
    ];
  }
  await apply(run, lines.join("\n"), "the asked angle from its tangent");
  await apply(run, `exact ${fin}`, "the asked angle");
}

/**
 * The goal `Real.arccos (…) = q * π` with angle hypotheses of the same kind: steps 1–4. Throws Fail
 * (the caller restores the state and goes on with the general route).
 */
export async function angleProof(run: TacticRunner): Promise<void> {
  const st0 = state(run);
  const t = tryParse(st0.target);
  if (!t || t.k !== "bin" || t.op !== "=") throw new Fail("not an angle goal");
  const f0 = readFacts(st0);
  const goal = readAngle(st0.target, t.a, t.b, f0.realVars);
  if (!goal) throw new Fail("the asked angle is not arccos (dot / (|u| |v|)) = q π");
  const hyps: Angle[] = [];
  for (const h of st0.hyps) {
    const n = tryParse(h.type);
    if (!n || n.k !== "bin" || n.op !== "=") continue;
    const a = readAngle(h.type, n.a, n.b, f0.realVars);
    if (a) hyps.push({ ...a, name: h.names[0] });
  }
  if (!hyps.length) throw new Fail("no given angles");
  const N = chooseStep([goal.q, ...hyps.map((a) => a.q)]);
  if (!N) throw new Fail("the angles are not multiples of π / 36");
  const ctx: Ctx = { run, N, sinPos: new Map(), sq: new Map(), pyth: new Map() };

  // the goal's denominator first (the facts below do not change it)
  const hDg = await lengthsNonzero(run, st0.target, goal, f0);
  // the goal becomes `dot = cos β * (|u| * |v|)` once, while the context is small (in a case of a
  // split the same step took over a minute)
  await apply(
    run,
    `refine (congrArg Real.arccos ((div_eq_iff ${hDg}).mpr ?_)).trans (Real.arccos_cos (by positivity) (by linarith only [Real.pi_pos]))`,
    "the asked angle as an equation",
  );
  // 1. cosines
  const ready: Ready[] = [];
  for (const a of hyps) {
    const f = readFacts(state(run));
    const h = state(run).hyps.find((x) => x.names.includes(a.name!));
    if (!h) continue;
    ready.push({ ...a, ...(await dotFact(ctx, a, f, h.type)) });
  }
  // square roots: √E ^ 2 = E, and roots of the same E (written in another order) equal
  {
    const roots = new Map<string, string>();
    for (const a of [...ready, goal]) for (const d of [a.d1, a.d2]) roots.set(d.text, d.arg);
    const f = readFacts(state(run));
    const vars = new VarTable(f.realVars);
    const polys: { text: string; arg: string; p?: Poly }[] = [...roots].map(([text, arg]) => ({ text, arg, p: polyOf(arg, vars) }));
    for (const r of polys) {
      const name = run.fresh("hsqd");
      await apply(run, heavy(`have ${name} : (${r.text}) ^ 2 = ${r.arg} := Real.sq_sqrt (by positivity)`), "square of a length");
      ctx.sq.set(r.text, name);
      // a constant length: √((0 - 1) ^ 2 + (0 - 0) ^ 2) = 1 (else its sign stays open for the algebra)
      const c = r.p?.constValue();
      const q = c && c.n > 0n ? ratSqrt(c) : undefined;
      if (q) {
        const ql = q.d === 1n ? q.n.toString() : `(${q.n} / ${q.d} : ℝ)`;
        await apply(run, `have ${run.fresh("hlen")} : ${r.text} = ${ql} := by rw [show (${r.arg} : ℝ) = (${ql}) ^ 2 by norm_num, Real.sqrt_sq (by norm_num)]`, "a constant length");
      }
    }
    for (let i = 0; i < polys.length; i++)
      for (let j = i + 1; j < polys.length; j++) {
        const [a, b] = [polys[i], polys[j]];
        if (a.p && b.p && a.p.sub(b.p).isZero()) await apply(run, `have ${run.fresh("hsame")} : ${a.text} = ${b.text} := congrArg Real.sqrt (by ring)`, "equal lengths");
      }
  }
  // 2. trigonometry
  ctx.rel = await trigSetup(run, N, [...ready.map((a) => a.alpha), goal.alpha]);
  for (const a of new Set([...ready.map((x) => x.alpha), goal.alpha])) {
    const name = run.fresh("hpyth");
    await apply(run, `have ${name} : Real.sin (${a}) ^ 2 + Real.cos (${a}) ^ 2 = 1 := Real.sin_sq_add_cos_sq _`, "sin² + cos²");
    ctx.pyth.set(a, name);
    await sinPos(ctx, a); // before any case split, so every case has it
  }
  // 3–4
  await sides(ctx, ready, 0, { ...goal, dot: "", dpos: "" }, async () => closeGoal(ctx, goal));
}

export { isArccos as isArccosTerm };
export { parseTerm };
