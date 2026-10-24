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
import { NotPolynomial, Poly, toPoly, VarTable, hasNonConstDivision, isNumeric } from "./poly";
import { findCertificate } from "./certificate";

export interface TacticRunner {
  /** Open goals (pretty-printed, with their contexts). */
  goals(): string[];
  /** Apply a tactic to the main goal; false (state unchanged) when Lean rejects it. */
  apply(tactic: string): Promise<boolean>;
  lastError(): string;
  /** A fresh hypothesis name `base<n>` (unique within this proof). */
  fresh(base: string): string;
}

export interface GeometryOutcome {
  ok: boolean;
  reason?: string;
}

const PAIR_SIMP = "simp only [Prod.mk.injEq, ne_eq, Prod.mk_sub_mk, Prod.mk_add_mk, Prod.smul_mk, smul_eq_mul, Prod.neg_mk] at *";
const MAX_INTROS = 60;

class Fail extends Error {}

/**
 * A tactic that may compute a lot (ring normal forms of big certificates, nlinarith): in tactic
 * mode each tactic gets its own budget, but the whole proof is checked as one declaration, so the
 * heavy steps carry a larger heartbeat limit of their own (never 0).
 */
function heavy(tactic: string): string {
  const n = Number(process.env.GEOMETRY_MAX_HEARTBEATS ?? 1_000_000);
  return `set_option maxHeartbeats ${Number.isFinite(n) && n > 0 ? Math.floor(n) : 1_000_000} in ${tactic}`;
}

function tryParse(text: string): Node | undefined {
  try {
    return parseTerm(text);
  } catch (e) {
    if (e instanceof ParseError) return undefined;
    throw e;
  }
}

function state(run: TacticRunner): GoalState {
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
async function normalize(run: TacticRunner): Promise<void> {
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
  {
    const st = state(run);
    const taken = allNames(st);
    for (const h of st.hyps) {
      if (!isPoint(h.type) || h.value !== undefined) continue;
      for (const p of h.names) {
        if (isInaccessible(p)) continue;
        const x = fresh(`${p}x`, taken);
        const y = fresh(`${p}y`, taken);
        await run.apply(`obtain ⟨${x}, ${y}⟩ := ${p}`);
      }
    }
  }
  await run.apply(PAIR_SIMP);
  if (!run.goals().length) return;
  await splitAndName(run);
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
interface Facts {
  st: GoalState;
  realVars: Set<string>;
  eqs: { name: string; node: Node & { k: "bin" }; text: string }[];
  nes: { name: string; a: Node; b: Node; text: string }[];
  pointNes: { name: string; a: Node; b: Node; c: Node; d: Node; text: string }[];
  lts: { name: string; lo: Node; hi: Node; text: string }[];
}

function readFacts(st: GoalState): Facts {
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
function positivityProofs(E: string, f: Facts, strict: boolean): string[] {
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
async function haveFirst(run: TacticRunner, name: string, stmt: string, proofs: string[]): Promise<boolean> {
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
const OWN = /^(hden|hfac|hm|hmul|hkey|hsq|habs|htrig|hpos|hnn)\d+$/;

/** Prove `D ≠ 0` for a denominator; returns the hypothesis name. */
async function proveNonzero(run: TacticRunner, src: string, D: Node, f: Facts): Promise<string> {
  const text = slice(src, D);
  const name = run.fresh("hden");
  const direct = [`(show (${text}) ≠ 0 by positivity)`, `(show (${text}) ≠ 0 by norm_num)`];
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
  const found: { text: string; arg: string; nonneg: boolean }[] = [];
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
      } else walk(src, u.a);
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
    const lemma = a.nonneg ? `abs_of_nonneg (show (0:ℝ) ≤ ${a.arg} by norm_num)` : `abs_of_neg (show ${a.arg} < (0:ℝ) by norm_num)`;
    await run.apply(`simp only [${lemma}] at *`);
  }
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
  const trig = new Set<string>();
  for (const a of vars.atoms) {
    if (done.has(a.text) || !a.arg) continue;
    done.add(a.text);
    if (a.kind === "sqrt") {
      await haveFirst(
        run,
        run.fresh("hsq"),
        `(${a.text}) ^ 2 = ${a.arg}`,
        positivityProofs(a.arg, f, false).map((p) => `Real.sq_sqrt ${p}`),
      );
    } else if (a.kind === "abs") {
      await run.apply(`have ${run.fresh("habs")} : (${a.text}) ^ 2 = (${a.arg}) ^ 2 := sq_abs _`);
    } else if ((a.kind === "sin" || a.kind === "cos") && !trig.has(a.arg)) {
      trig.add(a.arg);
      await run.apply(`have ${run.fresh("htrig")} : Real.sin ${a.arg} ^ 2 + Real.cos ${a.arg} ^ 2 = 1 := Real.sin_sq_add_cos_sq _`);
    }
  }
}

/**
 * Steps 4–5; when no certificate exists and both sides are nonnegative (`√X = √Y / 2`), square
 * both sides (`pow_left_inj₀`) and try once more — over the reals that is what the algebra misses.
 */
async function closeEquation(run: TacticRunner, atomsDone: Set<string>): Promise<void> {
  try {
    await closeEquationOnce(run);
  } catch (e) {
    if (!(e instanceof NoCertificate)) throw e;
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
    await closeEquationOnce(run);
  }
}

class NoCertificate extends Fail {}

async function closeEquationOnce(run: TacticRunner): Promise<void> {
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
  const cert = await findCertificate({ vars: vars.names.map((_, i) => `v${i}`), hyps, goal, multipliers: mults });
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

/** Prove the main goal and everything it splits into. */
export async function proveGeometryGoals(run: TacticRunner): Promise<GeometryOutcome> {
  let atomsDone = new Set<string>();
  let trigDone = new Set<string>();
  let goalsBefore = run.goals().length;
  try {
    await normalize(run);
    for (let guard = 0; run.goals().length && guard < 40; guard++) {
      const st = state(run);
      const t = tryParse(st.target);
      if (!t) throw new Fail(`cannot read the goal ${st.target.slice(0, 80)}`);
      if (t.k === "bin" && t.op === "∧") {
        if (!(await run.apply("refine ⟨?_, ?_⟩"))) throw new Fail("could not split the conjunction");
        continue;
      }
      if ((t.k === "quant" && t.q === "∀") || (t.k === "bin" && t.op === "→")) {
        // a part of a conjunction that is itself a statement with hypotheses
        const before = st.target;
        await normalize(run);
        if (state(run).target === before) throw new Fail("could not introduce the hypotheses");
        continue;
      }
      if (t.k === "bin" && t.op === "=" && unwrap(t.a).k === "pair") {
        if (!(await run.apply("simp only [Prod.mk.injEq]"))) throw new Fail("could not split the pair equation");
        continue;
      }
      if (t.k === "bin" && t.op === "=" && isArccos(t.a)) {
        await reduceAngle(run, st, t);
        continue;
      }
      if (t.k === "bin" && t.op === "=" && isArccos(t.b) && !isArccos(t.a)) {
        if (!(await run.apply("symm"))) throw new Fail("could not turn the angle goal around");
        continue;
      }
      if (t.k === "bin" && t.op === "=") {
        // facts added for another goal (another branch of a conjunction) are not in this one's context
        if (run.goals().length !== goalsBefore) {
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
        await closeEquation(run, atomsDone);
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
