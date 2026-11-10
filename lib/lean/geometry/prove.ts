/**
 * Geometry (and real-algebra) proofs the program writes itself, for statements in coordinates:
 * points as `ℝ × ℝ`, distances as `√(…)`, angles as `Real.arccos (dot / (dist * dist))`, areas
 * with `|…|`, conditions as polynomial equations. In REPL tactic mode, reading Lean's goal after
 * each step:
 *
 *  1. normalize — unfold the `let`s (`simp only []`), `intro` binders and hypotheses, split ∧ / ∃
 *     (`casesm*`, then `rename_i` so every name is usable), substitute point definitions
 *     (`subst`), split points into coordinates (`obtain ⟨Ax, Ay⟩ := A`), simp the pair algebra;
 *  2. reduce the goal — `refine ⟨?_, ?_⟩` for ∧, `Prod.mk.injEq` for pairs, an angle goal
 *     `Real.arccos X = c` becomes `X = Y` (the given angle `Real.arccos Y = c`) or `X = cos c`
 *     (`Real.arccos_cos`), top-level fractions are cleared with `div_eq_div_iff` / `div_eq_iff` /
 *     `eq_div_iff` after the denominators are proved nonzero (never `field_simp`: it rewrites inside
 *     the square roots, and the atoms stop matching the hypotheses);
 *  3. algebra facts for the atoms — `√E ^ 2 = E` (Real.sq_sqrt), `|E| ^ 2 = E ^ 2`,
 *     `sin c ^ 2 + cos c ^ 2 = 1`;
 *  4. nondegeneracy — every `a ≠ b`, `¬(a = b ∧ c = d)` (two points differ), `a < b`, and
 *     `L + R` for a goal `L = R` with both sides nonnegative (squaring both sides), each proved
 *     nonzero in Lean, offered as multipliers;
 *  5. the certificate — scripts/poly_certificate.py finds m and c_i with m·(L − R) = Σ c_i·h_i;
 *     the proof is `linear_combination`, through `mul_eq_zero` when m ≠ 1.
 *
 * Every step is a tactic checked by Lean, and the finished script is verified like any other
 * proof (statement lock, axioms, no sorry).
 */
import { ParseError, parseTerm, slice, unwrap, type Node } from "./expr";
import { isInaccessible, parseGoal, type GoalState } from "./goal";
import { Frac, NotPolynomial, Poly, toPoly, VarTable, hasNonConstDivision, isNumeric, type Atom } from "./poly";
import { findCertificate } from "./certificate";
import { existsWitness } from "./witness";
import { angleProof, chooseStep, piMultiple, scaledFieldRoots, sqrtTexts, trigSetup } from "./angles";

export type { TacticRunner } from "../tactic-runner";
import type { TacticRunner } from "../tactic-runner";

export interface GeometryOutcome {
  ok: boolean;
  reason?: string;
}

const PAIR_SIMP = "simp only [Prod.mk.injEq, ne_eq, Prod.mk_sub_mk, Prod.mk_add_mk, Prod.smul_mk, smul_eq_mul, Prod.neg_mk] at *";
const MAX_INTROS = 60;

export class Fail extends Error {}

/**
 * A tactic that may compute a lot (ring normal forms of big certificates, nlinarith): in tactic
 * mode each tactic gets its own budget, but the whole proof is checked as one declaration, so the
 * heavy steps carry a larger heartbeat limit of their own (never 0).
 */
export function heavy(tactic: string): string {
  const n = Number(process.env.GEOMETRY_MAX_HEARTBEATS ?? 1_000_000);
  return `set_option maxHeartbeats ${Number.isFinite(n) && n > 0 ? Math.floor(n) : 1_000_000} in ${tactic}`;
}

export function tryParse(text: string): Node | undefined {
  try {
    return parseTerm(text);
  } catch (e) {
    if (e instanceof ParseError) return undefined;
    throw e;
  }
}

export function state(run: TacticRunner): GoalState {
  const g = run.goals()[0];
  const st = g ? parseGoal(g) : null;
  if (!st) throw new Fail("could not read the goal");
  return st;
}

function allNames(st: GoalState): Set<string> {
  return new Set(st.hyps.flatMap((h) => h.names));
}

function fresh(base: string, taken: Set<string>): string {
  let name = base;
  for (let k = 1; taken.has(name); k++) name = `${base}_${k}`;
  taken.add(name);
  return name;
}

const isReal = (type: string) => /^ℝ$/.test(type.trim());
const isPoint = (type: string) => /^ℝ\s*×\s*ℝ$/.test(type.trim());

/** Step 1: unfold lets, intro everything, split ∧/∃, name everything, substitute and split points. */
export async function normalize(run: TacticRunner): Promise<void> {
  await run.apply("simp only []");
  if (!run.goals().length) return;
  let hyp = 0;
  for (let i = 0; i < MAX_INTROS; i++) {
    const st = state(run);
    const t = tryParse(st.target);
    if (!t) break;
    const taken = allNames(st);
    if (t.k === "quant" && t.q === "∀") {
      const names = t.binders.flatMap((b) => b.names).map((n) => fresh(n.replace(/✝.*$/, "") || "x", taken));
      if (!(await run.apply(`intro ${names.join(" ")}`))) break;
    } else if (t.k === "bin" && t.op === "→") {
      while (taken.has(`h${hyp}`)) hyp++;
      if (!(await run.apply(`intro h${hyp}`))) break;
      hyp++;
    } else break;
  }
  await splitAndName(run);
  if (!run.goals().length) return;
  // point definitions: `D = (…)` → substitute
  for (let round = 0; round < 8; round++) {
    const st = state(run);
    const points = new Set(st.hyps.filter((h) => isPoint(h.type) && h.value === undefined).flatMap((h) => h.names));
    let done = false;
    for (const h of st.hyps) {
      const t = tryParse(h.type);
      if (!t || t.k !== "bin" || t.op !== "=") continue;
      const a = unwrap(t.a);
      const b = unwrap(t.b);
      if ((a.k === "ident" && points.has(a.name)) || (b.k === "ident" && points.has(b.name))) {
        if (await run.apply(`subst ${h.names[0]}`)) {
          done = true;
          break;
        }
      }
    }
    if (!done) break;
  }
  // split the remaining points into coordinates
  const coords = new Set<string>();
  {
    const st = state(run);
    const taken = allNames(st);
    for (const h of st.hyps) {
      if (!isPoint(h.type) || h.value !== undefined) continue;
      for (const p of h.names) {
        if (isInaccessible(p)) continue;
        const x = fresh(`${p}x`, taken);
        const y = fresh(`${p}y`, taken);
        if (await run.apply(`obtain ⟨${x}, ${y}⟩ := ${p}`)) {
          coords.add(x);
          coords.add(y);
        }
      }
    }
  }
  await run.apply(PAIR_SIMP);
  if (!run.goals().length) return;
  await splitAndName(run);
  // coordinates the statement defines one by one (D.1 = (1 - t) * B.1 + t * C.1): substituted, so
  // the point is its formula everywhere (fewer unknowns, and D ≠ A becomes a fact about t)
  for (let round = 0; round < 16 && coords.size && run.goals().length; round++) {
    const st = state(run);
    let done = false;
    for (const h of st.hyps) {
      const t = tryParse(h.type);
      if (!t || t.k !== "bin" || t.op !== "=" || isInaccessible(h.names[0] ?? "")) continue;
      const a = unwrap(t.a);
      const b = unwrap(t.b);
      const side = a.k === "ident" && coords.has(a.name) ? { v: a.name, e: slice(h.type, t.b) } : b.k === "ident" && coords.has(b.name) ? { v: b.name, e: slice(h.type, t.a) } : undefined;
      if (!side || new RegExp(`(^|[^\\w.'])${side.v}($|[^\\w'])`).test(side.e)) continue;
      if (await run.apply(`subst ${h.names[0]}`)) {
        coords.delete(side.v);
        done = true;
        break;
      }
    }
    if (!done) break;
  }
}

async function splitAndName(run: TacticRunner): Promise<void> {
  await run.apply("casesm* _ ∧ _, ∃ _, _");
  if (!run.goals().length) return;
  const st = state(run);
  const taken = allNames(st);
  const names: string[] = [];
  for (const h of st.hyps) {
    for (const n of h.names) {
      if (!isInaccessible(n)) continue;
      names.push(fresh(isReal(h.type) ? "x" : isPoint(h.type) ? "P" : "h", taken));
    }
  }
  if (names.length) await run.apply(`rename_i ${names.join(" ")}`);
}

function isArccos(n: Node): Node | undefined {
  const u = unwrap(n);
  return u.k === "app" && u.fn === "Real.arccos" && u.args.length === 1 ? u.args[0] : undefined;
}

/** Step 2 for angle goals: `Real.arccos X = c` → `X = Y` or `X = Real.cos c`. */
async function reduceAngle(run: TacticRunner, st: GoalState, target: Node & { k: "bin" }): Promise<void> {
  const c = slice(st.target, target.b);
  for (const h of st.hyps) {
    const t = tryParse(h.type);
    if (t && t.k === "bin" && t.op === "=" && isArccos(t.a) && slice(h.type, t.b) === c) {
      if ((await run.apply(`conv_rhs => rw [← ${h.names[0]}]`)) && (await run.apply("congr 1"))) return;
    }
  }
  const bounds = `(Real.arccos_cos (by positivity : (0:ℝ) ≤ ${c}) (by nlinarith [Real.pi_pos, Real.pi_gt_three] : ${c} ≤ Real.pi))`;
  if ((await run.apply(`conv_rhs => rw [← ${bounds}]`)) && (await run.apply("congr 1"))) {
    // known values: cos (π / 2) = 0, cos (π / 3) = 1 / 2, …
    await run.apply("simp only [Real.cos_pi_div_two, Real.cos_pi_div_three, Real.cos_pi_div_four, Real.cos_pi_div_six, Real.cos_pi, Real.cos_zero]");
    return;
  }
  throw new Fail(`could not turn the angle goal into an equation of cosines (${run.lastError().split("\n")[0]})`);
}

/** Context hypotheses that are real equations / disequalities / strict inequalities. */
export interface Facts {
  st: GoalState;
  realVars: Set<string>;
  eqs: { name: string; node: Node & { k: "bin" }; text: string }[];
  nes: { name: string; a: Node; b: Node; text: string }[];
  pointNes: { name: string; a: Node; b: Node; c: Node; d: Node; text: string }[];
  lts: { name: string; lo: Node; hi: Node; text: string }[];
}

export function readFacts(st: GoalState): Facts {
  const realVars = new Set(st.hyps.filter((h) => isReal(h.type) && h.value === undefined).flatMap((h) => h.names));
  const f: Facts = { st, realVars, eqs: [], nes: [], pointNes: [], lts: [] };
  for (const h of st.hyps) for (const name of h.names) {
    if (isInaccessible(name) || h.value !== undefined) continue;
    const t = tryParse(h.type);
    if (!t) continue;
    if (t.k === "bin" && t.op === "=") f.eqs.push({ name, node: t, text: h.type });
    else if (t.k === "bin" && t.op === "≠") f.nes.push({ name, a: t.a, b: t.b, text: h.type });
    else if (t.k === "not") {
      const u = unwrap(t.a);
      if (u.k === "bin" && u.op === "=") f.nes.push({ name, a: u.a, b: u.b, text: h.type });
      else if (u.k === "bin" && u.op === "∧") {
        const l = unwrap(u.a);
        const r = unwrap(u.b);
        if (l.k === "bin" && l.op === "=" && r.k === "bin" && r.op === "=") f.pointNes.push({ name, a: l.a, b: l.b, c: r.a, d: r.b, text: h.type });
      }
    } else if (t.k === "bin" && (t.op === "<" || t.op === ">")) {
      f.lts.push({ name, lo: t.op === "<" ? t.a : t.b, hi: t.op === "<" ? t.b : t.a, text: h.type });
    }
  }
  return f;
}

/** `b` for every `b ^ 2` in a term (hints for nlinarith). */
function squareBases(src: string): string[] {
  const n = tryParse(src);
  const out: string[] = [];
  const walk = (x: Node) => {
    const u = unwrap(x);
    if (u.k === "bin") {
      if (u.op === "^" && unwrap(u.b).k === "num" && (unwrap(u.b) as { text: string }).text === "2") out.push(slice(src, u.a));
      walk(u.a);
      walk(u.b);
    } else if (u.k === "neg") walk(u.a);
  };
  if (n) walk(n);
  return [...new Set(out)].slice(0, 8);
}

/** Proofs tried for `0 ≤ E` / `0 < E`. */
export function positivityProofs(E: string, f: Facts, strict: boolean): string[] {
  const rel = strict ? "<" : "≤";
  const out = [`(show (0:ℝ) ${rel} ${E} by positivity)`];
  // `0 < a` hypotheses as they are, `a < b` as `0 < b - a`; each also squared
  const pos = f.lts.map((l) => {
    const lo = unwrap(l.lo);
    return lo.k === "num" && lo.text === "0" ? l.name : `(sub_pos.mpr ${l.name})`;
  });
  const squares = squareBases(E).map((b) => `sq_nonneg (${b})`);
  out.push(`(show (0:ℝ) ${rel} ${E} by nlinarith [${[...squares, ...pos, ...pos.map((p) => `mul_pos ${p} ${p}`)].join(", ")}])`);
  for (const p of f.pointNes) {
    const u = `(${slice(p.text, p.a)}) - (${slice(p.text, p.b)})`;
    const v = `(${slice(p.text, p.c)}) - (${slice(p.text, p.d)})`;
    out.push(`(show (0:ℝ) ${rel} ${E} by rcases not_and_or.mp ${p.name} with h' | h' <;> nlinarith [sq_pos_of_ne_zero (sub_ne_zero.mpr h'), sq_nonneg (${u}), sq_nonneg (${v}), ${squares.join(", ") || "sq_nonneg (0:ℝ)"}])`);
  }
  return out;
}

/** `have name : stmt := proof` with the first proof Lean accepts. */
export async function haveFirst(run: TacticRunner, name: string, stmt: string, proofs: string[]): Promise<boolean> {
  for (const p of proofs) if (await run.apply(heavy(`have ${name} : ${stmt} := ${p}`))) return true;
  return false;
}

/** Factors of a product / power (for nonzero proofs of denominators). */
function factors(n: Node): Node[] {
  const u = unwrap(n);
  if (u.k === "bin" && u.op === "*") return [...factors(u.a), ...factors(u.b)];
  if (u.k === "bin" && u.op === "^") return factors(u.a);
  return [u];
}

/** Names of the facts this prover adds (hden3, hfac4, hm5, …). */
const OWN = /^(hden|hfac|hm|hmul|hkey|hsq|habs|htrig|hpos|hnn|hprod|hsr|hcb|hang)\d+$/;

/**
 * `0 < u² + v²` from a `≠` hypothesis that fails when u = v = 0: two points are distinct because the
 * triangle is not degenerate (`(B - A) × (C - A) ≠ 0` gives A ≠ B). The cofactors writing the
 * hypothesis's two sides' difference in u and v come from the certificate search.
 */
async function distinctProofs(E: string, f: Facts): Promise<string[]> {
  const n = tryParse(E);
  const u0 = n ? unwrap(n) : undefined;
  if (!u0 || u0.k !== "bin" || u0.op !== "+") return [];
  const sq = (x: Node) => {
    const y = unwrap(x);
    return y.k === "bin" && y.op === "^" && unwrap(y.b).k === "num" && (unwrap(y.b) as { text: string }).text === "2" ? slice(E, y.a) : undefined;
  };
  const u = sq(u0.a);
  const v = sq(u0.b);
  if (!u || !v || !f.nes.length) return [];
  const out: string[] = [];
  for (const h of f.nes.slice(0, 4)) {
    const vars = new VarTable(f.realVars);
    let goal: Poly, pu: Poly, pv: Poly;
    try {
      goal = toPoly(h.text, h.a, vars).sub(toPoly(h.text, h.b, vars));
      pu = toPoly(u, tryParse(u)!, vars);
      pv = toPoly(v, tryParse(v)!, vars);
    } catch {
      continue;
    }
    // the statement's equations too (D = (1 - t)·B + t·C on BC: D = A would put A on BC)
    const eqs: { name: string; poly: Poly }[] = [];
    for (const e of f.eqs.slice(0, 20)) {
      try {
        eqs.push({ name: e.name, poly: toPoly(e.text, e.node.a, vars).sub(toPoly(e.text, e.node.b, vars)) });
      } catch {
        /* not polynomial */
      }
    }
    const cert = await findCertificate({ vars: [], hyps: [{ name: "hu", poly: pu }, { name: "hv", poly: pv }, ...eqs], goal, multipliers: [] });
    if (!cert.ok || cert.multiplier.length) continue;
    // one line: a multi-line term cannot carry the `set_option … in` the caller puts in front
    // linear_combination takes hypothesis names, not inline proofs
    const zero = (x: string) => `(by nlinarith only [h0, sq_nonneg (${u}), sq_nonneg (${v})])`;
    const combo = [...cert.coefficients].map(([k, c]) => `(${c.toLean(vars.names)}) * ${k}`).join(" + ") || "0";
    out.push(`(lt_of_le_of_ne (by positivity) (fun h0 => ${h.name} (by have hu : (${u}) = 0 := ${zero(u)}; have hv : (${v}) = 0 := ${zero(v)}; linear_combination ${combo})))`);
  }
  return out;
}

/** Prove `D ≠ 0` for a denominator; returns the hypothesis name. */
export async function proveNonzero(run: TacticRunner, src: string, D: Node, f: Facts): Promise<string> {
  const text = slice(src, D);
  const name = run.fresh("hden");
  const direct = [`(show (${text}) ≠ 0 by positivity)`, `(show (${text}) ≠ 0 by norm_num)`];
  // a number written with square roots of rationals: its sign from the bounds of the roots
  const sign = rootNumberSign(src, D);
  if (sign) direct.unshift(sign.positive ? `(show (0:ℝ) < ${text} by nlinarith [${sign.hints}]).ne'` : `(show ${text} < (0:ℝ) by nlinarith [${sign.hints}]).ne`);
  if (await haveFirst(run, name, `(${text}) ≠ 0`, direct)) return name;
  // factor by factor: √E needs 0 < E (or an equal square root that is known positive)
  const parts: string[] = [];
  for (const fac of factors(D)) {
    const ft = slice(src, fac);
    const fname = run.fresh("hfac");
    const proofs: string[] = [];
    if (fac.k === "sqrt" || (fac.k === "app" && fac.fn === "Real.sqrt")) {
      const E = slice(src, fac.k === "sqrt" ? fac.a : fac.args[0]);
      for (const p of positivityProofs(E, f, true)) proofs.push(`(Real.sqrt_pos.mpr ${p}).ne'`);
      for (const p of await distinctProofs(E, f)) proofs.push(`(Real.sqrt_pos.mpr ${p}).ne'`);
      // √E = √F with √F known positive
      for (const e of f.eqs) {
        const l = slice(e.text, e.node.a);
        const r = slice(e.text, e.node.b);
        // rewrite √E (this factor) into the other side √F
        const other = l === ft ? e.node.b : r === ft ? e.node.a : undefined;
        if (!other) continue;
        const o = unwrap(other);
        if (o.k !== "sqrt") continue;
        const F = slice(e.text, o.a);
        const rw = l === ft ? e.name : `← ${e.name}`;
        for (const p of positivityProofs(F, f, true)) proofs.push(`(by rw [${rw}]; exact (Real.sqrt_pos.mpr ${p}).ne')`);
      }
    } else {
      proofs.push(`(show (${ft}) ≠ 0 by positivity)`, `(show (${ft}) ≠ 0 by norm_num)`);
      for (const p of positivityProofs(ft, f, true)) proofs.push(`${p}.ne'`);
    }
    if (!(await haveFirst(run, fname, `(${ft}) ≠ 0`, proofs))) throw new Fail(`could not show that ${ft} is not zero`);
    parts.push(fname);
  }
  // combine (the factors' product, as Lean would group it, may differ: let `simp`/`positivity` close it from the parts)
  const combine = [`(show (${text}) ≠ 0 by simp only [ne_eq, mul_eq_zero, pow_eq_zero_iff, not_or]; exact ⟨${parts.join(", ")}⟩)`, `(show (${text}) ≠ 0 by simp [${parts.join(", ")}])`, `(show (${text}) ≠ 0 by positivity)`];
  if (parts.length === 1) combine.unshift(parts[0]);
  if (parts.length === 2) combine.unshift(`mul_ne_zero ${parts[0]} ${parts[1]}`);
  if (await haveFirst(run, name, `(${text}) ≠ 0`, combine)) return name;
  throw new Fail(`could not show that ${text} is not zero`);
}

/** sin c > 0 (and cos c > 0) for a numeric angle c in (0, π) (in (0, π/2)), for the nonzero proofs. */
async function trigFacts(run: TacticRunner, done: Set<string>): Promise<void> {
  const st = state(run);
  const seen = new Set<string>();
  for (const m of (st.target + "\n" + st.hyps.map((h) => h.type).join("\n")).matchAll(/Real\.(sin|cos) (\([^()]*\))/g)) seen.add(m[2]);
  for (const c of seen) {
    if (done.has(c) || !/^\([\d\s*/+.]*Real\.pi[\d\s*/+.]*\)$/.test(c)) continue;
    done.add(c);
    await run.apply(`have ${run.fresh("hpos")} : 0 < Real.sin ${c} := Real.sin_pos_of_pos_of_lt_pi (by positivity) (by nlinarith [Real.pi_pos])`);
    await run.apply(`have ${run.fresh("hpos")} : 0 < Real.cos ${c} := Real.cos_pos_of_mem_Ioo ⟨by nlinarith [Real.pi_pos], by nlinarith [Real.pi_pos]⟩`);
  }
}

/** `|E|` with a numeric E: its sign is known, so it is rewritten away (the areas of fixed triangles). */
async function numericAbs(run: TacticRunner): Promise<void> {
  const st = state(run);
  const seen = new Set<string>();
  const found: { text: string; arg: string; nonneg: boolean; hints?: string }[] = [];
  const walk = (src: string, n: Node) => {
    const u = unwrap(n);
    if (u.k === "abs") {
      if (isNumeric(u.a)) {
        const arg = slice(src, u.a);
        if (!seen.has(arg)) {
          seen.add(arg);
          try {
            const v = toPoly(src, u.a, new VarTable(new Set())).constValue();
            if (v) found.push({ text: slice(src, u), arg, nonneg: v.n >= 0n });
          } catch {
            // not a number after all
          }
        }
      } else {
        const r = rootNumberSign(src, u.a);
        const arg = slice(src, u.a);
        if (r && !seen.has(arg)) {
          seen.add(arg);
          found.push({ text: slice(src, u), arg, nonneg: r.positive, hints: r.hints });
        } else if (!r) walk(src, u.a);
      }
      return;
    }
    for (const k of ["a", "b"] as const) {
      const c = (u as Record<string, unknown>)[k];
      if (c && typeof c === "object" && "k" in (c as object)) walk(src, c as Node);
    }
    if (u.k === "app") for (const a of u.args) walk(src, a);
  };
  for (const text of [st.target, ...st.hyps.map((h) => h.type)]) {
    const n = tryParse(text);
    if (n) walk(text, n);
  }
  for (const a of found) {
    const lemma = a.hints
      ? a.nonneg
        ? `abs_of_pos (show (0:ℝ) < ${a.arg} by nlinarith [${a.hints}])`
        : `abs_of_neg (show ${a.arg} < (0:ℝ) by nlinarith [${a.hints}])`
      : a.nonneg
        ? `abs_of_nonneg (show (0:ℝ) ≤ ${a.arg} by norm_num)`
        : `abs_of_neg (show ${a.arg} < (0:ℝ) by norm_num)`;
    await run.apply(`simp only [${lemma}] at *`);
  }
}

/**
 * The sign of a number written with square roots of positive rationals (`(0 - (3 + √3) / 6) * …`), with
 * the facts nlinarith proves it from — √r ^ 2 = r, 0 ≤ √r, lo < √r < hi to six digits; undefined when it
 * is not such a number or too close to 0 to tell.
 */
export function rootNumberSign(src: string, n: Node): { positive: boolean; hints: string } | undefined {
  const vars = new VarTable(new Set());
  let p: Poly;
  try {
    p = toPoly(src, n, vars);
  } catch {
    return undefined;
  }
  if (!vars.atoms.length) return undefined;
  const value = new Map<number, number>();
  const hints: string[] = [];
  for (const a of vars.atoms) {
    if (a.kind !== "sqrt" || !a.argNode || !isNumeric(a.argNode)) return undefined;
    let r: Frac | undefined;
    try {
      r = toPoly(a.arg!, parseTerm(a.arg!), new VarTable(new Set())).constValue();
    } catch {
      return undefined;
    }
    if (!r || r.n <= 0n) return undefined;
    const x = Math.sqrt(Number(r.n) / Number(r.d));
    value.set(a.index, x);
    // strict on both sides, also for a perfect square (√1: 0.999999 < √1 < 1.000001)
    const lo = Math.ceil(x * 1e6) - 1;
    const hi = Math.floor(x * 1e6) + 1;
    const R = `(${a.arg} : ℝ)`;
    hints.push(
      `Real.sq_sqrt (show (0:ℝ) ≤ ${R} by norm_num)`,
      `Real.sqrt_nonneg ${R}`,
      `(Real.lt_sqrt (by norm_num)).mpr (by norm_num : ((${lo} / 1000000 : ℝ)) ^ 2 < ${R})`,
      `(Real.sqrt_lt' (by norm_num)).mpr (by norm_num : ${R} < ((${hi} / 1000000 : ℝ)) ^ 2)`,
    );
  }
  let v = 0;
  for (const [m, c] of p.terms) {
    let t = Number(c.n) / Number(c.d);
    for (const part of m ? m.split("*") : []) {
      const [x, e] = part.split("^");
      t *= value.get(Number(x.slice(1)))! ** (e ? Number(e) : 1);
    }
    v += t;
  }
  if (!Number.isFinite(v) || Math.abs(v) < 1e-4) return undefined;
  return { positive: v > 0, hints: hints.join(", ") };
}

/** Step 2: clear top-level fractions. */
async function clearFractions(run: TacticRunner): Promise<void> {
  const st = state(run);
  const t = tryParse(st.target);
  if (!t || t.k !== "bin" || t.op !== "=") throw new Fail("goal is not an equation");
  const L = unwrap(t.a);
  const R = unwrap(t.b);
  const frac = (n: Node) => n.k === "bin" && n.op === "/" && !isNumeric(n.b);
  if (!frac(L) && !frac(R)) return;
  const f = readFacts(st);
  if (frac(L) && frac(R)) {
    const a = await proveNonzero(run, st.target, (L as Node & { k: "bin" }).b, f);
    const b = await proveNonzero(run, st.target, (R as Node & { k: "bin" }).b, f);
    if (!(await run.apply(`rw [div_eq_div_iff ${a} ${b}]`))) throw new Fail(`could not clear the fractions: ${run.lastError().split("\n")[0]}`);
  } else if (frac(L)) {
    const a = await proveNonzero(run, st.target, (L as Node & { k: "bin" }).b, f);
    if (!(await run.apply(`rw [div_eq_iff ${a}]`))) throw new Fail(`could not clear the fraction: ${run.lastError().split("\n")[0]}`);
  } else {
    const b = await proveNonzero(run, st.target, (R as Node & { k: "bin" }).b, f);
    if (!(await run.apply(`rw [eq_div_iff ${b}]`))) throw new Fail(`could not clear the fraction: ${run.lastError().split("\n")[0]}`);
  }
}

/** Step 3: facts about the atoms of the goal and the hypotheses. */
async function atomFacts(run: TacticRunner, done: Set<string>): Promise<void> {
  const st = state(run);
  const f = readFacts(st);
  const vars = new VarTable(f.realVars);
  const goalNode = tryParse(st.target);
  const texts: [string, Node][] = [...(goalNode ? [[st.target, goalNode] as [string, Node]] : []), ...f.eqs.map((e) => [e.text, e.node] as [string, Node])];
  for (const [src, n] of texts) {
    if (n.k !== "bin") continue;
    try {
      toPoly(src, n.a, vars);
      toPoly(src, n.b, vars);
    } catch (e) {
      if (!(e instanceof NotPolynomial)) throw e;
    }
  }
  // the arguments of constant square roots as polynomials (this also meets nested atoms: √5 in √(10 + 2 * √5))
  const argPolys = constantSqrtArgs(vars);
  const sqNames = sqNamesOf(done);
  const trig = new Set<string>();
  for (const a of vars.atoms) {
    if (done.has(a.text) || !a.arg) continue;
    done.add(a.text);
    if (a.kind === "sqrt") {
      const name = run.fresh("hsq");
      if (
        await haveFirst(
          run,
          name,
          `(${a.text}) ^ 2 = ${a.arg}`,
          positivityProofs(a.arg, f, false).map((p) => `Real.sq_sqrt ${p}`),
        )
      )
        sqNames.set(a.index, name);
      await sqrtOfSquare(run, a.arg, a.text, f);
    } else if (a.kind === "abs") {
      await run.apply(`have ${run.fresh("habs")} : (${a.text}) ^ 2 = (${a.arg}) ^ 2 := sq_abs _`);
    } else if ((a.kind === "sin" || a.kind === "cos") && !trig.has(a.arg)) {
      trig.add(a.arg);
      await run.apply(`have ${run.fresh("htrig")} : Real.sin ${a.arg} ^ 2 + Real.cos ${a.arg} ^ 2 = 1 := Real.sin_sq_add_cos_sq _`);
    }
  }
  // the same length written two ways (√((p - 0)² + …) from an angle, √((0 - p)² + …) from a
  // distance): one fact, else the certificate also allows the second to be minus the first (and a
  // 20° angle's p = −cos · b branch kept "BD = DE" from following)
  const roots = vars.atoms.filter((a) => a.kind === "sqrt" && a.arg);
  const argOf = new Map<string, Poly | undefined>();
  for (const a of roots) {
    try {
      argOf.set(a.text, toPoly(a.arg!, parseTerm(a.arg!), vars));
    } catch {
      argOf.set(a.text, undefined);
    }
  }
  for (let i = 0; i < roots.length; i++)
    for (let j = i + 1; j < roots.length; j++) {
      const [a, b] = [roots[i], roots[j]];
      const key = `same:${a.text}|${b.text}`;
      const pa = argOf.get(a.text);
      const pb = argOf.get(b.text);
      if (done.has(key) || !pa || !pb || !pa.sub(pb).isZero()) continue;
      done.add(key);
      await run.apply(`have ${run.fresh("hsame")} : ${a.text} = ${b.text} := congrArg Real.sqrt (by ring)`);
    }
  await productFacts(run, vars, argPolys, sqNames, done);
}

/**
 * `√E = X` (or `-X`) when E is X² as a polynomial and the sign of X is known: lengths along an axis,
 * √((0 - b) ^ 2 + (0 - 0) ^ 2) = b for 0 < b. The certificate then substitutes the root away; with
 * √(b²) and √(c²) kept as unknowns, "∠BAD = ∠ACB ⇒ AD ⊥ BC" needed b² · c² · … as a multiplier.
 */
async function sqrtOfSquare(run: TacticRunner, arg: string, root: string, f: Facts): Promise<void> {
  const argNode = tryParse(arg);
  if (!argNode) return;
  const table = new VarTable(f.realVars); // one numbering for E and X
  let E: Poly;
  try {
    E = toPoly(arg, argNode, table);
  } catch (e) {
    if (e instanceof NotPolynomial) return;
    throw e;
  }
  for (const X of squareBases(arg)) {
    const xNode = tryParse(X);
    if (!xNode) continue;
    let px: Poly;
    try {
      px = toPoly(X, xNode, table);
    } catch (e) {
      if (e instanceof NotPolynomial) continue;
      throw e;
    }
    if (px.constValue() !== undefined || !px.mul(px).sub(E).isZero()) continue;
    const square = `rw [show (${arg}) = (${X}) ^ 2 by ring]`;
    const name = run.fresh("hsr");
    const pos = positivityProofs(X, f, false).map((p) => `(by ${square}; exact Real.sqrt_sq ${p})`);
    if (await haveFirst(run, name, `${root} = ${X}`, pos)) return;
    const neg = positivityProofs(`-(${X})`, f, false).map((p) => `(by ${square}; rw [Real.sqrt_sq_eq_abs]; exact abs_of_nonpos (neg_nonneg.mp ${p}))`);
    if (await haveFirst(run, name, `${root} = -(${X})`, neg)) return;
  }
}

/** Square-fact names per atom index, kept with the `done` set of one proof (atoms keep their index there). */
const SQ_NAMES = new WeakMap<Set<string>, Map<number, string>>();
function sqNamesOf(done: Set<string>): Map<number, string> {
  let m = SQ_NAMES.get(done);
  if (!m) SQ_NAMES.set(done, (m = new Map()));
  return m;
}

/** √E atoms whose E has no variables (only numbers and other such roots) → E as a polynomial. */
function constantSqrtArgs(vars: VarTable): Map<number, Poly> {
  const out = new Map<number, Poly>();
  for (let i = 0; i < vars.atoms.length; i++) {
    const a = vars.atoms[i];
    if (a.kind !== "sqrt" || !a.arg) continue;
    const n = tryParse(a.arg);
    if (!n) continue;
    try {
      const p = toPoly(a.arg, n, vars);
      out.set(a.index, p);
    } catch (e) {
      if (!(e instanceof NotPolynomial)) throw e;
    }
  }
  // only roots whose inner atoms are such roots too
  let changed = true;
  while (changed) {
    changed = false;
    for (const [i, p] of out)
      if ([...p.vars()].some((v) => !out.has(v))) {
        out.delete(i);
        changed = true;
      }
  }
  return out;
}

function monoExps(m: string): Map<number, number> {
  const out = new Map<number, number>();
  if (!m) return out;
  for (const part of m.split("*")) {
    const [v, e] = part.split("^");
    out.set(Number(v.slice(1)), e ? Number(e) : 1);
  }
  return out;
}

function monoPoly(exps: Map<number, number>, c: Frac): Poly {
  let p = Poly.const(c);
  for (const [v, e] of exps) if (e > 0) p = p.mul(Poly.variable(v).pow(e));
  return p;
}

/**
 * p with every s² of a constant root s = √E replaced by E: p = r + Σ cof_s · (s² − E).
 * Undefined when it does not settle (it always does for constant nested roots).
 */
export function reduceSquares(p: Poly, args: Map<number, Poly>): { r: Poly; cof: Map<number, Poly> } | undefined {
  let r = p;
  const cof = new Map<number, Poly>();
  for (let step = 0; step < 500; step++) {
    let hit: { m: string; c: Frac; v: number } | undefined;
    for (const [m, c] of r.terms) {
      for (const [v, e] of monoExps(m))
        if (e >= 2 && args.has(v)) {
          hit = { m, c, v };
          break;
        }
      if (hit) break;
    }
    if (!hit) return { r, cof };
    const exps = monoExps(hit.m);
    exps.set(hit.v, exps.get(hit.v)! - 2);
    const rest = monoPoly(exps, hit.c);
    r = r.sub(monoPoly(monoExps(hit.m), hit.c)).add(rest.mul(args.get(hit.v)!));
    cof.set(hit.v, (cof.get(hit.v) ?? new Poly()).add(rest));
  }
  return undefined;
}

function isqrt(n: bigint): bigint | undefined {
  if (n < 0n) return undefined;
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x * x === n ? x : undefined;
}

/** q with q² = c for a positive rational c. */
function ratSqrt(c: Frac): Frac | undefined {
  if (c.n <= 0n) return undefined;
  const n = isqrt(c.n);
  const d = isqrt(c.d);
  return n !== undefined && d !== undefined ? new Frac(n, d) : undefined;
}

/** r = λ·g for a rational λ, else undefined. */
function ratio(r: Poly, g: Poly): Frac | undefined {
  const first = [...g.terms.entries()][0];
  if (!first) return undefined;
  const rc = r.terms.get(first[0]);
  if (!rc) return undefined;
  const lam = rc.mul(first[1].inv());
  return r.sub(g.scale(lam)).isZero() ? lam : undefined;
}

function fracLean(q: Frac): string {
  return q.d === 1n ? q.n.toString() : `(${q.n} / ${q.d} : ℝ)`;
}

/**
 * Products of constant square roots that simplify: √(10 + 2 * √5) * √(10 - 2 * √5) = 4 * √5 (a
 * regular pentagon's coordinates). The algebra only knows each s² = E, which leaves the sign of
 * s₁·s₂ open, so no certificate exists without this fact. Proved with Real.sqrt_mul and the
 * square facts (linear_combination).
 */
async function productFacts(run: TacticRunner, vars: VarTable, args: Map<number, Poly>, sqNames: Map<number, string>, done: Set<string>): Promise<void> {
  const roots: Atom[] = vars.atoms.filter((a) => args.has(a.index) && sqNames.has(a.index));
  if (roots.length < 2 || roots.length > 8) return;
  const names = vars.names;
  const reduced = new Map<number, { r: Poly; cof: Map<number, Poly> }>();
  for (const a of roots) {
    const red = reduceSquares(args.get(a.index)!, args);
    if (red) reduced.set(a.index, red);
  }
  const lc = (cofs: Map<number, Poly>[]): string | undefined => {
    const total = new Map<number, Poly>();
    for (const c of cofs) for (const [v, p] of c) total.set(v, (total.get(v) ?? new Poly()).add(p));
    const parts: string[] = [];
    for (const [v, p] of total) {
      if (p.isZero()) continue;
      const h = sqNames.get(v);
      if (!h) return undefined;
      parts.push(`(${p.toLean(names)}) * ${h}`);
    }
    return parts.length ? `linear_combination ${parts.join(" + ")}` : "ring";
  };
  for (let i = 0; i < roots.length; i++)
    for (let j = i + 1; j < roots.length; j++) {
      const a = roots[i];
      const b = roots[j];
      const key = `prod:${a.text}*${b.text}`;
      if (done.has(key)) continue;
      done.add(key);
      const prod = reduceSquares(args.get(a.index)!.mul(args.get(b.index)!), args);
      if (!prod || prod.r.isZero()) continue;
      // √A·√B = q (A·B = q²) or q·√G (A·B = q²·G for another root √G)
      let rhs: string | undefined;
      let eq: string | undefined;
      let finish: string[] = [];
      const c = prod.r.constValue();
      const q0 = c ? ratSqrt(c) : undefined;
      if (q0) {
        const proof = lc([prod.cof]);
        if (!proof) continue;
        rhs = fracLean(q0);
        eq = `show (${a.arg}) * (${b.arg}) = (${rhs}) ^ 2 by ${proof}`;
        finish = [`Real.sqrt_sq (by norm_num)`];
      } else {
        for (const t of roots) {
          if (t.index === a.index || t.index === b.index) continue;
          const g = reduced.get(t.index);
          if (!g) continue;
          const lam = ratio(prod.r, g.r);
          const q = lam ? ratSqrt(lam) : undefined;
          if (!q) continue;
          const negG = new Map([...g.cof].map(([v, p]) => [v, p.scale(lam!).neg()] as [number, Poly]));
          const proof = lc([prod.cof, negG]);
          if (!proof) continue;
          const ql = fracLean(q);
          rhs = `${ql} * ${t.text}`;
          eq = `show (${a.arg}) * (${b.arg}) = (${ql}) ^ 2 * (${t.arg}) by ${proof}`;
          finish = [`Real.sqrt_mul (by positivity) (${t.arg})`, `Real.sqrt_sq (by norm_num)`];
          break;
        }
      }
      if (!rhs || !eq) continue;
      const nonneg = (x: Atom) => [
        `(show (0:ℝ) ≤ ${x.arg} by positivity)`,
        `(show (0:ℝ) ≤ ${x.arg} by nlinarith [${[...sqNames.values()].join(", ")}, ${roots.map((r) => `Real.sqrt_nonneg (${r.arg})`).join(", ")}])`,
      ];
      const name = run.fresh("hprod");
      const proofs = [...nonneg(a), ...nonneg(b)].map((p, k) => {
        const first = k < 2 ? a : b;
        const other = k < 2 ? b : a;
        const swap = k < 2 ? "" : `rw [mul_comm]; `;
        return `by ${swap}rw [← Real.sqrt_mul ${p} (${other.arg}), ${k < 2 ? eq : eq!.replace(`(${a.arg}) * (${b.arg})`, `(${b.arg}) * (${a.arg})`).replace(/ by (linear_combination|ring)/, " by $1")}, ${finish.join(", ")}]`;
        void first;
      });
      await haveFirst(run, name, `${a.text} * ${b.text} = ${rhs}`, proofs);
    }
}

/**
 * Steps 4–5; when no certificate exists and both sides are nonnegative (`√X = √Y / 2`), square
 * both sides (`pow_left_inj₀`) and try once more — over the reals that is what the algebra misses.
 */
/**
 * The trigonometric field for an equation whose context still has cos / sin of π/N with N ∈ {9, 12,
 * 18, 36, …} (values the simp lemmas do not give): the angle mode's relations (angles.ts trigSetup —
 * sin² + cos² = 1, T_{N/3}(cos θ) = 1/2, sin θ as a polynomial in cos θ for even N, each angle as a
 * polynomial in cos θ, sin θ) are added once per context, and the certificate search works modulo
 * them. A distance goal with a 20° angle (AB = AC, ∠A = 20°, BD = BE = BC ⇒ BDE equilateral) had no
 * certificate: cos (π/9) was a free atom.
 */
async function trigField(run: TacticRunner, done: Set<string>, N: number): Promise<Field | undefined> {
  const st = state(run);
  const angles = contextAngles(st);
  // once per context: the relations' names, kept while they are still in this goal's hypotheses
  const names = new Set(st.hyps.flatMap((h) => h.names));
  for (const k of done) {
    const m = /^field:(\d+)=(\S+)\|(\S+)$/.exec(k);
    if (m && Number(m[1]) === N && names.has(m[2]) && names.has(m[3])) return { N, r1: m[2], r2: m[3] };
  }
  try {
    const rel = await trigSetup(run, N, [...angles]);
    const r1 = rel.r3 ?? rel.r1;
    done.add(`field:${N}=${r1}|${rel.r2}`);
    return { N, r1, r2: rel.r2 };
  } catch (e) {
    if (e instanceof Fail) return undefined;
    throw e;
  }
}

/**
 * `∃ w, v * w = 1` for each positive real variable (`0 < v`), once per context: the certificate
 * script cancels such a v from a hypothesis (b · (p − c · r) = 0 → p = c · r; a free scale b had kept
 * the linear substitutions from p). Returns the scales with their positivity facts.
 */
async function addInverses(run: TacticRunner, done: Set<string>): Promise<{ v: string; pos: string }[]> {
  const st = state(run);
  const f = readFacts(st);
  const names = new Set(st.hyps.flatMap((h) => h.names));
  const out: { v: string; pos: string }[] = [];
  for (const h of st.hyps) {
    const m = /^0 < ([^\s()]+)$/.exec(h.type.trim()) ?? /^([^\s()]+) > 0$/.exec(h.type.trim());
    const pos = h.names[0];
    if (!m || !pos || isInaccessible(pos) || !f.realVars.has(m[1])) continue;
    const v = m[1];
    const key = [...done].find((k) => k.startsWith(`inv:${v}=`) && names.has(k.slice(`inv:${v}=`.length)));
    if (!key) {
      const w = run.fresh("cw");
      const hw = run.fresh("hcw");
      if (!(await run.apply(`obtain ⟨${w}, ${hw}⟩ : ∃ w : ℝ, ${v} * w = 1 := ⟨${v}⁻¹, mul_inv_cancel₀ (ne_of_gt ${pos})⟩`))) continue;
      done.add(`inv:${v}=${hw}`);
    }
    out.push({ v, pos });
  }
  return out;
}

interface Field {
  N: number;
  r1: string;
  r2: string;
}

async function closeEquation(run: TacticRunner, atomsDone: Set<string>, trigDone: Set<string> = new Set()): Promise<void> {
  try {
    await closeEquationOnce(run);
    return;
  } catch (e) {
    if (!(e instanceof NoCertificate)) throw e;
    // the trigonometric field of the angles (π/N), then the next finer one (π/2N): a figure fixed
    // by ∠A = 20° with C = (1, 0) has height ½ · cot 10°, a number of Q(cos 10°, sin 10°) only
    let N = fieldStep(run);
    while (N) {
      const mark = run.save();
      const saved = [new Set(atomsDone), new Set(trigDone)];
      try {
        if (await fieldRoute(run, N, atomsDone, trigDone)) return;
      } catch (err) {
        if (!(err instanceof Fail)) throw err;
        if (process.env.GEOMETRY_DEBUG) console.error(`[geometry] field π/${N}: ${err.message}`);
      }
      run.restore(mark);
      atomsDone.clear();
      trigDone.clear();
      for (const k of saved[0]) atomsDone.add(k);
      for (const k of saved[1]) trigDone.add(k);
      N = finerStep(N);
    }
    await squareBoth(run, atomsDone, e);
  }
}

/** The step π/N of the angles in context that the field needs (N > 6), or undefined. */
function fieldStep(run: TacticRunner): number | undefined {
  const angles = contextAngles(state(run));
  const qs = [...angles].map((a) => piMultiple(a));
  if (!qs.length || qs.some((q) => !q)) return undefined;
  const N = chooseStep(qs as Frac[]);
  // π/3 and π/6 have known values (simp); the field is for the others
  return N && N > 6 ? N : undefined;
}

/** The next step after π/N whose field contains Q(cos π/N, sin π/N) and the half angles: 9 → 18 → 36. */
function finerStep(N: number): number | undefined {
  return [18, 36].find((n) => n > N && n % N === 0);
}

function contextAngles(st: GoalState): Set<string> {
  const angles = new Set<string>();
  for (const m of (st.target + "\n" + st.hyps.map((h) => h.type).join("\n")).matchAll(/Real\.(?:sin|cos) \(([^()]*Real\.pi[^()]*)\)/g)) angles.add(m[1].trim());
  return angles;
}

/** One field: the certificate modulo it, then the values (scaledFieldRoots), then both sides squared. True when the goal closed. */
async function fieldRoute(run: TacticRunner, N: number, atomsDone: Set<string>, trigDone: Set<string>): Promise<boolean> {
  const field = await trigField(run, trigDone, N);
  if (!field) return false;
  try {
    await closeEquationOnce(run, field);
    return true;
  } catch (e2) {
    if (!(e2 instanceof NoCertificate)) throw e2;
  }
  // the figure is fixed up to its size: lengths and coordinates are b^k times numbers of the
  // field; with 1 / b in context those values are found and proved one by one (fieldRoots)
  const scales = await addInverses(run, trigDone);
  const roots = await scaledFieldRoots(run, field.N, { r1: field.r1, r2: field.r2 }, scales);
  // a length of the goal still unknown (its sign is not algebra): straight to squaring both sides
  const open = roots && sqrtTexts(state(run).target).some((r) => !roots.has(r.text));
  if (roots && !open) {
    try {
      await closeEquationOnce(run, field);
      return true;
    } catch (e3) {
      if (!(e3 instanceof NoCertificate)) throw e3;
    }
  }
  await squareBoth(run, atomsDone, new NoCertificate("no polynomial certificate in the field"), field);
  return true;
}

/** Both sides nonnegative: the squares are equal instead (pow_left_inj₀), then the certificate. Throws `e` when that does not apply. */
async function squareBoth(run: TacticRunner, atomsDone: Set<string>, e: Error, field?: Field): Promise<void> {
  const st = state(run);
  const t = tryParse(st.target);
  if (!t || t.k !== "bin" || t.op !== "=") throw e;
  const L = slice(st.target, t.a);
  const R = slice(st.target, t.b);
  const f = readFacts(st);
  const hL = run.fresh("hnn");
  const hR = run.fresh("hnn");
  if (!(await haveFirst(run, hL, `(0:ℝ) ≤ ${L}`, positivityProofs(L, f, false))) || !(await haveFirst(run, hR, `(0:ℝ) ≤ ${R}`, positivityProofs(R, f, false)))) throw e;
  if (!(await run.apply(`rw [← pow_left_inj₀ ${hL} ${hR} two_ne_zero]`))) throw e;
  await atomFacts(run, atomsDone);
  await closeEquationOnce(run, field);
}

class NoCertificate extends Fail {}

async function closeEquationOnce(run: TacticRunner, field?: Field): Promise<void> {
  const st = state(run);
  const f = readFacts(st);
  const t = tryParse(st.target);
  if (!t || t.k !== "bin" || t.op !== "=") throw new Fail("goal is not an equation");
  if (hasNonConstDivision(t)) throw new Fail("the goal still has a fraction inside");
  const vars = new VarTable(f.realVars);
  let goal: Poly;
  try {
    goal = toPoly(st.target, t.a, vars).sub(toPoly(st.target, t.b, vars));
  } catch (e) {
    if (e instanceof NotPolynomial) throw new Fail(`the goal is not polynomial (${e.message})`);
    throw e;
  }
  const hyps: { name: string; poly: Poly }[] = [];
  for (const e of f.eqs) {
    // the trigonometric chain is only a means to the per-angle facts (as in the angle mode)
    // and the roots' own steps ((v − F)(v + F) = 0, the chain facts) are implied by `v = F`
    if (field && /^h(cos|sin|root|step)\d+$/.test(e.name)) continue;
    try {
      hyps.push({ name: e.name, poly: toPoly(e.text, e.node.a, vars).sub(toPoly(e.text, e.node.b, vars)) });
    } catch (err) {
      if (!(err instanceof NotPolynomial)) throw err;
    }
  }
  // multipliers, each proved nonzero in Lean first
  const mults: { name: string; poly: Poly; text: string }[] = [];
  const offer = async (text: string, poly: () => Poly, proofs: string[]) => {
    let p: Poly;
    try {
      p = poly();
    } catch (err) {
      if (err instanceof NotPolynomial) return;
      throw err;
    }
    if (p.constValue() !== undefined || mults.length >= 6) return;
    const name = run.fresh("hm");
    if (await haveFirst(run, name, `${text} ≠ 0`, proofs)) mults.push({ name, poly: p, text });
  };
  for (const n of f.nes) {
    if (OWN.test(n.name)) continue; // the nonzero facts this prover added itself
    const text = `(${slice(n.text, n.a)}) - (${slice(n.text, n.b)})`;
    await offer(text, () => toPoly(n.text, n.a, vars).sub(toPoly(n.text, n.b, vars)), [`sub_ne_zero.mpr ${n.name}`]);
  }
  for (const p of f.pointNes) {
    const u = `(${slice(p.text, p.a)}) - (${slice(p.text, p.b)})`;
    const v = `(${slice(p.text, p.c)}) - (${slice(p.text, p.d)})`;
    const text = `((${u}) ^ 2 + (${v}) ^ 2)`;
    await offer(
      text,
      () => {
        const a = toPoly(p.text, p.a, vars).sub(toPoly(p.text, p.b, vars));
        const b = toPoly(p.text, p.c, vars).sub(toPoly(p.text, p.d, vars));
        return a.mul(a).add(b.mul(b));
      },
      [`(show (0:ℝ) < ${text} by rcases not_and_or.mp ${p.name} with h' | h' <;> nlinarith [sq_pos_of_ne_zero (sub_ne_zero.mpr h'), sq_nonneg (${u}), sq_nonneg (${v})]).ne'`],
    );
  }
  for (const l of f.lts) {
    const text = `(${slice(l.text, l.hi)}) - (${slice(l.text, l.lo)})`;
    await offer(text, () => toPoly(l.text, l.hi, vars).sub(toPoly(l.text, l.lo, vars)), [`(sub_pos.mpr ${l.name}).ne'`]);
  }
  {
    // squaring both sides: L + R > 0 when both are nonnegative
    const L = slice(st.target, t.a);
    const R = slice(st.target, t.b);
    const text = `((${L}) + (${R}))`;
    await offer(text, () => toPoly(st.target, t.a, vars).add(toPoly(st.target, t.b, vars)), [`(show (0:ℝ) < ${text} by positivity).ne'`]);
  }

  if (process.env.GEOMETRY_DEBUG) {
    const show = (p: Poly) => p.toLean(vars.names);
    console.error(`[geometry] goal: ${show(goal)} = 0`);
    for (const h of hyps) console.error(`[geometry]   ${h.name}: ${show(h.poly)} = 0`);
    for (const m of mults) console.error(`[geometry]   mult ${m.name}: ${show(m.poly)}`);
  }
  if (goal.isZero()) {
    // a ring identity
    if (!(await run.apply(heavy("ring")))) throw new Fail(`ring failed: ${run.lastError().split("\n")[0]}`);
    return;
  }
  if (!vars.names.length) throw new Fail("the goal is a false numeric identity");
  const sqrtVars = vars.atoms.filter((a) => a.kind === "sqrt").map((a) => a.index);
  const atomVar = (text: string) => {
    try {
      const p = toPoly(text, parseTerm(text), vars);
      const vs = [...p.vars()];
      return vs.length === 1 ? vs[0] : undefined;
    } catch {
      return undefined;
    }
  };
  const fc = field && atomVar(`Real.cos (Real.pi / ${field.N})`);
  const fs = field && atomVar(`Real.sin (Real.pi / ${field.N})`);
  // the field's system is bigger (the trigonometric relations, the roots): more time
  const fieldReq = field && fc !== undefined && fs !== undefined ? { field: { c: fc, s: fs, r1: field.r1, r2: field.r2 }, timeoutSec: 60 } : {};
  let cert = await findCertificate({ vars: vars.names.map((_, i) => `v${i}`), hyps, goal, multipliers: mults, needed: true, sqrtVars, ...fieldReq });
  if (!cert.ok && cert.needed?.length) {
    // The goal follows once some other factor is known nonzero (the ideal quotient names it, e.g. the
    // positive b²(1 − t) + c²t an equal-angle condition leaves): prove each in Lean, then ask again.
    const extra: { name: string; poly: Poly; text: string }[] = [];
    for (const p of cert.needed) {
      const text = p.toLean(vars.names);
      const name = await factorNonzero(run, text, readFacts(state(run)));
      if (process.env.GEOMETRY_DEBUG) console.error(`[geometry]   needed factor ${text}: ${name ?? "not shown nonzero"}`);
      if (!name) {
        extra.length = 0;
        break;
      }
      extra.push({ name, poly: p, text: `(${text})` });
    }
    if (extra.length) cert = await findCertificate({ vars: vars.names.map((_, i) => `v${i}`), hyps, goal, multipliers: [...mults, ...extra], sqrtVars, ...fieldReq });
    if (cert.ok) mults.push(...extra);
  }
  if (!cert.ok) throw new NoCertificate(`no polynomial certificate: ${cert.reason}`);
  const names = vars.names;
  const combo = [...cert.coefficients].map(([h, c]) => `(${c.toLean(names)}) * ${h}`).join(" + ") || "0";
  const L = slice(st.target, t.a);
  const R = slice(st.target, t.b);
  const before = run.goals().length;
  if (!cert.multiplier.length) {
    if (!(await run.apply(heavy(`linear_combination ${combo}`)))) throw new Fail(`linear_combination failed: ${run.lastError().split("\n")[0]}`);
  } else {
    // each factor ≠ 0: it is the candidate itself, or a factor of it (factor = 0 makes the candidate 0)
    const used: { name: string; text: string }[] = [];
    for (const m of cert.multiplier) {
      const src = mults.find((x) => x.name === m.source);
      if (!src) throw new Fail("the certificate used an unknown factor");
      const c = m.cofactor.constValue();
      if (c && !c.isZero() && c.n === c.d) {
        used.push({ name: src.name, text: src.text });
        continue;
      }
      const text = m.factor.toLean(names);
      const name = run.fresh("hm");
      if (!(await run.apply(heavy(`have ${name} : ${text} ≠ 0 := fun h0 => ${src.name} (by linear_combination (${m.cofactor.toLean(names)}) * h0)`)))) {
        throw new Fail(`could not split off the factor ${text}: ${run.lastError().split("\n")[0]}`);
      }
      used.push({ name, text });
    }
    const prod = used.map((m) => `(${m.text})`).join(" * ");
    const proof = used.slice(1).reduce((acc, m) => `(mul_ne_zero ${acc} ${m.name})`, used[0].name);
    const hmul = run.fresh("hmul");
    const hkey = run.fresh("hkey");
    if (!(await run.apply(`have ${hmul} : ${prod} ≠ 0 := ${proof}`))) throw new Fail(`could not combine the nonzero factors: ${run.lastError().split("\n")[0]}`);
    if (!(await run.apply(heavy(`have ${hkey} : ${prod} * ((${L}) - (${R})) = 0 := by linear_combination ${combo}`)))) {
      throw new Fail(`linear_combination failed: ${run.lastError().split("\n")[0]}`);
    }
    if (!(await run.apply(heavy(`linear_combination (mul_eq_zero.mp ${hkey}).resolve_left ${hmul}`)))) throw new Fail(`could not cancel the factor: ${run.lastError().split("\n")[0]}`);
  }
  if (run.goals().length >= before) throw new Fail("the goal stayed open");
}

/** `F ≠ 0` for a factor the certificate needs (positive or negative); the hypothesis name, or undefined. */
async function factorNonzero(run: TacticRunner, text: string, f: Facts): Promise<string | undefined> {
  for (const negate of [false, true]) {
    const src = negate ? `-(${text})` : text;
    const node = tryParse(src);
    if (!node) return undefined;
    const mark = run.save();
    try {
      const h = await proveNonzero(run, src, node, f);
      if (!negate) return h;
      const name = run.fresh("hm");
      if (await run.apply(`have ${name} : (${text}) ≠ 0 := fun h0 => ${h} (by linear_combination (-1 : ℝ) * h0)`)) return name;
      run.restore(mark);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      run.restore(mark);
    }
  }
  return undefined;
}

/** `N / D` with `D = √A * √B` (an angle's cosine as the statement writes it). */
function cosineParts(src: string, x: Node): { N: string; Dnode: Node; D: string; A?: string; B?: string; cross?: string } | undefined {
  const frac = unwrap(x);
  if (frac.k !== "bin" || frac.op !== "/") return undefined;
  const den = unwrap(frac.b);
  const out: { N: string; Dnode: Node; D: string; A?: string; B?: string; cross?: string } = { N: slice(src, frac.a), Dnode: frac.b, D: slice(src, frac.b) };
  if (den.k === "bin" && den.op === "*") {
    const s1 = unwrap(den.a);
    const s2 = unwrap(den.b);
    if (s1.k === "sqrt" && s2.k === "sqrt") {
      out.A = slice(src, s1.a);
      out.B = slice(src, s2.a);
    }
  }
  // N = a1 * b1 + a2 * b2: the cross product a1 * b2 - a2 * b1 (Lagrange: A·B − N² = cross²)
  const num = unwrap(frac.a);
  if (num.k === "bin" && num.op === "+") {
    const l = unwrap(num.a);
    const r = unwrap(num.b);
    if (l.k === "bin" && l.op === "*" && r.k === "bin" && r.op === "*") {
      out.cross = `(${slice(src, l.a)}) * (${slice(src, r.b)}) - (${slice(src, r.a)}) * (${slice(src, l.b)})`;
    }
  }
  return out;
}

/** `-1 ≤ N / D ∧ N / D ≤ 1` by Cauchy–Schwarz; the hypothesis name, or undefined. */
async function cosineBounds(run: TacticRunner, c: { N: string; D: string; A?: string; B?: string; cross?: string }): Promise<string | undefined> {
  if (!c.A || !c.B || !c.cross) return undefined;
  const name = run.fresh("hcb");
  const X = `(${c.N}) / (${c.D})`;
  const tac = [
    `have ${name} : -1 ≤ ${X} ∧ ${X} ≤ 1 := by`,
    `  refine abs_le.mp ?_`,
    `  rw [abs_div, abs_of_nonneg (by positivity : (0:ℝ) ≤ ${c.D}), ← Real.sqrt_mul (by positivity : (0:ℝ) ≤ ${c.A}) (${c.B})]`,
    `  exact div_le_one_of_le₀ (Real.abs_le_sqrt (by nlinarith [sq_nonneg (${c.cross})])) (Real.sqrt_nonneg _)`,
  ].join("\n");
  // (a multi-line `have` cannot carry `set_option … in`: it breaks the indentation)
  return (await run.apply(tac)) ? name : undefined;
}

/**
 * Given angles become equations the certificate search can use: two equal angles
 * `Real.arccos (N₁ / D₁) = Real.arccos (N₂ / D₂)` give `N₁ * D₂ = N₂ * D₁`, and a given value
 * `Real.arccos (N / D) = c` gives `N = Real.cos c * D` (equal cosines; each argument is in
 * [-1, 1] by Cauchy–Schwarz, and the lengths are not zero). Without this, a problem such as
 * "∠BAD = ∠ACB in a right triangle ⇒ AD ⊥ BC" had no certificate and went on to the model provers.
 * Only for goals that are not angles themselves (those go to the angle mode / cosine comparison).
 */
async function angleHypotheses(run: TacticRunner, done: Set<string>): Promise<void> {
  if (!run.goals().length) return;
  const st = state(run);
  if (st.target.includes("Real.arccos")) return;
  for (const h of st.hyps) {
    const name = h.names[0];
    if (!name || isInaccessible(name) || done.has(name) || h.value !== undefined) continue;
    const t = tryParse(h.type);
    if (!t || t.k !== "bin" || t.op !== "=") continue;
    const xa = isArccos(t.a);
    if (!xa) continue;
    done.add(name);
    const left = cosineParts(h.type, xa);
    if (!left) continue;
    const xb = isArccos(t.b);
    const right = xb ? cosineParts(h.type, xb) : undefined;
    if (xb && !right) continue;
    const mark = run.save();
    try {
      const b1 = await cosineBounds(run, left);
      if (!b1) throw new Fail("no bounds for the first angle");
      const d1 = await proveNonzero(run, h.type, left.Dnode, readFacts(state(run)));
      const fact = run.fresh("hang");
      if (right) {
        const b2 = await cosineBounds(run, right);
        if (!b2) throw new Fail("no bounds for the second angle");
        const d2 = await proveNonzero(run, h.type, right.Dnode, readFacts(state(run)));
        const tac = [
          `have ${fact} : (${left.N}) * (${right.D}) = (${right.N}) * (${left.D}) := by`,
          `  have h' := congrArg Real.cos ${name}`,
          `  rw [Real.cos_arccos ${b1}.1 ${b1}.2, Real.cos_arccos ${b2}.1 ${b2}.2, div_eq_div_iff ${d1} ${d2}] at h'`,
          `  exact h'`,
        ].join("\n");
        if (!(await run.apply(tac))) throw new Fail(`equal angles: ${run.lastError().split("\n")[0]}`);
      } else {
        const c = slice(h.type, t.b);
        const tac = [
          `have ${fact} : ${left.N} = Real.cos (${c}) * (${left.D}) := by`,
          `  have h' := congrArg Real.cos ${name}`,
          `  rw [Real.cos_arccos ${b1}.1 ${b1}.2, div_eq_iff ${d1}] at h'`,
          `  exact h'`,
        ].join("\n");
        if (!(await run.apply(tac))) throw new Fail(`given angle: ${run.lastError().split("\n")[0]}`);
        await run.apply(`simp only [Real.cos_pi_div_two, Real.cos_pi_div_three, Real.cos_pi_div_four, Real.cos_pi_div_six, Real.cos_pi, Real.cos_zero] at ${fact}`);
      }
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      if (process.env.GEOMETRY_DEBUG) console.error(`[geometry] angle hypothesis ${name}: ${e.message}`);
      run.restore(mark);
    }
  }
}

/** Prove the main goal and everything it splits into. */
export async function proveGeometryGoals(run: TacticRunner): Promise<GeometryOutcome> {
  let atomsDone = new Set<string>();
  let trigDone = new Set<string>();
  let goalsBefore = run.goals().length;
  const anglesDone = new Set<string>();
  try {
    await normalize(run);
    await angleHypotheses(run, anglesDone);
    for (let guard = 0; run.goals().length && guard < 40; guard++) {
      const st = state(run);
      const t = tryParse(st.target);
      if (!t) throw new Fail(`cannot read the goal ${st.target.slice(0, 80)}`);
      if (t.k === "bin" && t.op === "∧") {
        if (!(await run.apply("refine ⟨?_, ?_⟩"))) throw new Fail("could not split the conjunction");
        continue;
      }
      if (t.k === "bin" && t.op === "↔") {
        // both directions, each an implication (introduced below)
        if (!(await run.apply("constructor"))) throw new Fail("could not split the equivalence");
        continue;
      }
      if ((t.k === "quant" && t.q === "∀") || (t.k === "bin" && t.op === "→")) {
        // a part of a conjunction that is itself a statement with hypotheses
        const before = st.target;
        await normalize(run);
        if (state(run).target === before) throw new Fail("could not introduce the hypotheses");
        await angleHypotheses(run, anglesDone);
        continue;
      }
      if (t.k === "bin" && t.op === "=" && unwrap(t.a).k === "pair") {
        if (!(await run.apply("simp only [Prod.mk.injEq]"))) throw new Fail("could not split the pair equation");
        continue;
      }
      if (t.k === "bin" && t.op === "=" && isArccos(t.a)) {
        // given angles that are multiples of π / N: the angle mode (angles.ts); else compare cosines
        const mark = run.save();
        const before = run.goals().length;
        try {
          await angleProof(run);
          if (run.goals().length < before) continue;
          throw new Fail("the angle goal stayed open");
        } catch (e) {
          if (!(e instanceof Fail)) throw e;
          if (process.env.GEOMETRY_DEBUG) console.error(`[geometry] angle mode: ${e.message}`);
          run.restore(mark);
        }
        await reduceAngle(run, st, t);
        // the goal is no angle any more: given angles (e.g. a bisector's equal angles) become equations
        await angleHypotheses(run, anglesDone);
        continue;
      }
      if (t.k === "bin" && t.op === "=" && isArccos(t.b) && !isArccos(t.a)) {
        if (!(await run.apply("symm"))) throw new Fail("could not turn the angle goal around");
        continue;
      }
      if (t.k === "bin" && t.op === "=") {
        // facts added for another goal (another branch of a conjunction) are not in this one's context —
        // also when the count is back where it was (branch 1 closed, branch 2 split again)
        const inContext = new Set(st.hyps.flatMap((h) => h.names));
        const stale = [...sqNamesOf(atomsDone).values()].some((n) => !inContext.has(n));
        if (run.goals().length !== goalsBefore || stale) {
          atomsDone = new Set();
          trigDone = new Set();
          goalsBefore = run.goals().length;
        }
        await trigFacts(run, trigDone);
        const open = run.goals().length;
        await numericAbs(run);
        if (run.goals().length < open) continue; // the rewrite closed it
        await clearFractions(run);
        await atomFacts(run, atomsDone);
        await closeEquation(run, atomsDone, trigDone);
        continue;
      }
      if (t.k === "quant" && t.q === "∃") {
        // a witness fixed by linear equations (a circumcentre: the squares cancel), solved by the program
        const w = existsWitness(st.target, readFacts(st).realVars);
        if (!w) throw new Fail(`no witness for ${st.target.replace(/\s+/g, " ").slice(0, 80)}`);
        if (!(await run.apply(w.tactic))) throw new Fail(`the witness ${w.values.join(", ")} was refused: ${run.lastError().split("\n")[0]}`);
        await run.apply("dsimp only"); // (x, y).1 → x
        continue;
      }
      throw new Fail(`goal shape not handled: ${st.target.replace(/\s+/g, " ").slice(0, 100)}`);
    }
    return run.goals().length === 0 ? { ok: true } : { ok: false, reason: "goals left" };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, reason: e.message };
    throw e;
  }
}
