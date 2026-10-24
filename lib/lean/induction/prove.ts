/**
 * Induction proofs the program writes itself, in REPL tactic mode, reading Lean's goal after each
 * step (no model, nothing spent):
 *
 *  1. intro the binders and hypotheses, name every hypothesis;
 *  2. pick the scheme from the statement —
 *       a polynomial divisibility `d ∣ P n` (small d): case analysis on `n % d` (interval_cases);
 *       a lower bound `c ≤ n` (`n ≥ c`, `0 < n`): `induction n, h using Nat.le_induction`;
 *       a recurrence `∀ n, a (n + d) = …` with d ≥ 2: strong induction, `rcases n` into d bases and
 *       the step `k + d`;
 *       otherwise ordinary `induction n` (each ℕ variable of the goal, the last one first);
 *  3. close the base cases with a cascade (simp, norm_num, decide, the given values, …);
 *  4. close the step with the tactic its goal calls for —
 *       equations: rewrite the last term of the sum or product (Finset.sum_range_succ, …) or the
 *       recurrence, then the induction hypothesis, then ring / push_cast; ring / field_simp; ring;
 *       inequalities: nlinarith with ih, the bound, `pow_succ b k` for every b ^ (k + 1), products
 *       of the bound with k, squares of the real variables;
 *       divisibility: the quotient computed exactly (witness.ts) — `obtain ⟨m, hm⟩ := ih;
 *       exact ⟨W, by linear_combination c * hm⟩`, or omega in ℕ with subtraction.
 *
 * Every step is a tactic Lean checks; a scheme that does not close every goal is undone and the
 * next one tried. The finished script is verified like any other proof.
 */
import { isInaccessible, parseGoal, type GoalState } from "../geometry/goal";
import type { TacticRunner } from "../tactic-runner";
import { divisibilityWitnesses, splitDvd } from "./witness";

export type InductionScheme = "induction" | "le_induction" | "strong" | "mod_cases";

export interface InductionOutcome {
  ok: boolean;
  scheme?: InductionScheme;
  reason?: string;
}

class Fail extends Error {}

const MAX_INTROS = 30;
const MAX_MODULUS = 60;

function stateAt(run: TacticRunner, i = 0): GoalState {
  const g = run.goals()[i];
  const st = g ? parseGoal(g) : null;
  if (!st) throw new Fail("could not read the goal");
  return st;
}

/** Index of the first top-level occurrence of one of `seps` (outside brackets), with the one found. */
function topLevel(s: string, seps: string[]): [number, string] | undefined {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ("([{⟨".includes(c)) depth++;
    else if (")]}⟩".includes(c)) depth--;
    else if (depth === 0) for (const sep of seps) if (s.startsWith(sep, i)) return [i, sep];
  }
  return undefined;
}

/** The relation of a goal: "=", "≤"/"<"/"≥"/">", "∣", or undefined. */
export function relation(target: string): string | undefined {
  if (/^(∀|∃|¬)/.test(target) || topLevel(target, ["→", "↔", "∧", "∨"])) return undefined;
  return topLevel(target, [" ∣ ", " ≤ ", " < ", " ≥ ", " > ", " ≠ ", " = "])?.[1].trim();
}

const names = (st: GoalState) => st.hyps.flatMap((h) => h.names);
const word = (v: string) => new RegExp(`(^|[^\\w'.✝])${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w'✝])`);

function pick(run: TacticRunner, base: string): string {
  const taken = new Set(run.goals().flatMap((g) => (parseGoal(g) ? names(parseGoal(g)!) : [])));
  return taken.has(base) ? run.fresh(base) : base;
}

/** Replace the names Lean shows as inaccessible by the ones the script gives them. */
function rename(st: GoalState, map: Map<string, string>): GoalState {
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  const sub = (s: string) => keys.reduce((acc, k) => acc.split(k).join(map.get(k)!), s);
  return { hyps: st.hyps.map((h) => ({ ...h, names: h.names.map(sub), type: sub(h.type) })), target: sub(st.target) };
}

/** Step 1: intro every binder (keeping its name) and hypothesis (named h1, h2, …). */
async function introAll(run: TacticRunner): Promise<void> {
  for (let i = 0; i < MAX_INTROS && run.goals().length; i++) {
    const t = stateAt(run).target;
    if (/^∀/.test(t)) {
      // `∀ (a b : ℕ), …`, `∀ n ≥ 1, …`, `∀ n, …`
      const m = /^∀ \(([^:()]+) : /.exec(t) ?? /^∀ ([^\s,:()]+)/.exec(t);
      const binders = m ? m[1].trim().split(/\s+/).filter((x) => /^[A-Za-z_][\w']*$/.test(x)) : [];
      const named = binders.length ? `intro ${binders.map((b) => pick(run, b)).join(" ")}` : "intro";
      if (!(await run.apply(named)) && !(await run.apply("intro"))) break;
    } else if (topLevel(t, ["→"])) {
      if (!(await run.apply(`intro ${run.fresh("h")}`))) break;
    } else break;
  }
  if (!run.goals().length) return;
  const hidden = names(stateAt(run)).filter(isInaccessible);
  if (hidden.length) await run.apply(`rename_i ${hidden.map(() => run.fresh("h")).join(" ")}`);
}

interface Recurrence {
  name: string;
  fn: string;
  depth: number;
}

interface Facts {
  nats: string[];
  bounds: { v: string; h: string }[];
  recurrences: Recurrence[];
  /** given values such as `a 0 = 1` (not ∀) */
  equations: string[];
  inequalities: string[];
  reals: string[];
}

function facts(st: GoalState): Facts {
  const f: Facts = { nats: [], bounds: [], recurrences: [], equations: [], inequalities: [], reals: [] };
  for (const h of st.hyps) {
    const t = h.type.replace(/\s+/g, " ").trim();
    for (const n of h.names) {
      if (isInaccessible(n)) continue;
      if (t === "ℕ") f.nats.push(n);
      if (t === "ℝ" || t === "ℚ") f.reals.push(n);
      const b =
        /^\d+ ≤ (\S+)$/.exec(t) ?? /^(\S+) ≥ \d+$/.exec(t) ?? /^\d+ < (\S+)$/.exec(t) ?? /^(\S+) > \d+$/.exec(t);
      if (b) f.bounds.push({ v: b[1], h: n });
      const r = /^∀ \((\S+) : ℕ\), (\S+) \(\1 \+ (\d+)\) = /.exec(t);
      if (r) f.recurrences.push({ name: n, fn: r[2], depth: Number(r[3]) });
      else if (!/^∀/.test(t) && relation(t) === "=") f.equations.push(n);
      else if (!/^∀/.test(t) && /^[≤<≥>]$/.test(relation(t) ?? "")) f.inequalities.push(n);
    }
  }
  f.bounds = f.bounds.filter((b) => f.nats.includes(b.v));
  return f;
}

/** Try tactics in order; true at the first Lean accepts. */
async function first(run: TacticRunner, cands: string[], wrap: (c: string) => string): Promise<boolean> {
  const seen = new Set<string>();
  for (const c of cands) {
    if (seen.has(c)) continue;
    seen.add(c);
    if (await run.apply(wrap(c))) return true;
  }
  return false;
}

function baseCandidates(f: Facts): string[] {
  const eq = f.equations.join(", ");
  return [
    "simp",
    "norm_num",
    "rfl",
    "omega",
    ...(eq ? [`simp [${eq}]`, `norm_num [${eq}]`] : []),
    "norm_num [Finset.sum_range_succ, Finset.prod_range_succ]",
    "simp [Finset.sum_range_succ, Finset.prod_range_succ]",
    "simp_all",
    "decide",
    "positivity",
    "linarith",
    "nlinarith",
  ];
}

/** `pow_succ b k` for every `b ^ (k + 1)` in the goal. */
function powSucc(t: string, k: string): string[] {
  const re = new RegExp(`(\\d+|[A-Za-z_][\\w'.]*|\\([^()]*\\)) \\^ \\(${k} \\+ 1\\)`, "g");
  return [...new Set([...t.matchAll(re)].map((m) => `pow_succ ${m[1]} ${k}`))];
}

/** Lemmas that split off the last term of a sum or product up to k + 1, or unfold a recursive definition. */
function bigOpLemmas(t: string, k: string): string[] {
  const out: string[] = [];
  // the recursive definitions the step meets: (k + 1)! = (k + 1) * k!, fib (k + 2) = fib k + fib (k + 1)
  if (/!|factorial/.test(t)) out.push("Nat.factorial_succ");
  if (/\bfib\b/.test(t)) out.push("Nat.fib_add_two");
  const kind = /∏/.test(t) ? "prod" : /∑/.test(t) ? "sum" : undefined;
  if (!kind) return out;
  if (t.includes(`Finset.range (${k} + 1`)) out.push(`Finset.${kind}_range_succ`);
  if (new RegExp(`Finset\\.Icc \\S+ \\(${k} \\+ 1\\)`).test(t)) out.push(`Finset.${kind}_Icc_succ_top (by omega)`);
  return out;
}

interface StepCtx {
  st: GoalState;
  k: string;
  ih: string;
  hk?: string;
  /** strong induction: ih is ∀ m < k + d, P m */
  strongDepth?: number;
  f: Facts;
}

function stepCandidates(run: TacticRunner, c: StepCtx): string[] {
  const { st, k, ih, hk, f } = c;
  const t = st.target;
  const rel = relation(t);
  const ihType = st.hyps.find((h) => h.names.includes(ih))?.type.replace(/\s+/g, " ") ?? "";
  const ihs = c.strongDepth ? Array.from({ length: c.strongDepth }, (_, i) => `${ih} ${i ? `(${k} + ${i})` : k} (by omega)`).reverse() : [ih];
  const big = bigOpLemmas(t, k);
  const recs = f.recurrences.map((r) => r.name);
  const pows = powSucc(t, k);
  const out: string[] = [];
  if (rel === "=") {
    const rw = [...big, ...recs, ...ihs].join(", ");
    for (const fin of ["ring", "push_cast; ring", "field_simp; ring", "push_cast; field_simp; ring", "field_simp", "push_cast; field_simp", "simp; ring", "norm_num; ring", "omega", "linarith", "rfl"]) out.push(`rw [${rw}]; ${fin}`);
    out.push(`simp only [${rw}]; ring`, `simp [${[...big, ...recs, ...ihs, "pow_succ"].join(", ")}]; ring`);
    if (!c.strongDepth && (big.length || recs.length)) {
      const rw0 = [...big, ...recs].join(", ");
      // ih does not occur as written once the last term is split off (∑ + 1 vs ∑ + f k + 1)
      out.push(`rw [${rw0}]; linear_combination ${ih}`, `rw [${rw0}]; push_cast; linear_combination ${ih}`, `rw [${rw0}]; omega`);
    }
    if (!c.strongDepth && !big.length && !recs.length) out.push(`linear_combination ${ih}`);
  } else if (rel && /^[≤<≥>]$/.test(rel)) {
    const realType = /ℚ/.test(st.hyps.map((h) => h.type).join(" ")) && !f.reals.some((x) => st.hyps.find((h) => h.names.includes(x))?.type.trim() === "ℝ") ? "ℚ" : "ℝ";
    const hints = [
      ...ihs,
      ...(hk ? [hk, `Nat.mul_le_mul ${hk} (le_refl ${k})`] : []),
      ...(/!|factorial/.test(t) ? [`Nat.factorial_pos ${k}`] : []),
      ...pows,
      // 1 ≤ b ^ k for the numeric bases (3 ^ k ≥ 2 ^ k + k needs 2 ^ k ≥ 1)
      ...(f.reals.length ? [] : pows.map((p) => p.split(" ")[1]).filter((b) => /^\d+$/.test(b) && Number(b) > 1).map((b) => `Nat.one_le_pow ${k} ${b} (by norm_num)`)),
      ...f.inequalities.filter((h) => h !== ih && h !== hk),
      ...f.reals.map((x) => `sq_nonneg ${x}`),
      ...(f.reals.length ? [`(Nat.cast_nonneg ${k} : (0 : ${realType}) ≤ ${k})`] : []),
    ].join(", ");
    const pre = ["", ...(big.length ? [`rw [${big.join(", ")}]; `] : []), "push_cast; ", ...(big.length ? [`rw [${big.join(", ")}]; push_cast; `] : [])];
    for (const p of pre) out.push(`${p}nlinarith [${hints}]`);
    if (big.length && rel === "≤" && !c.strongDepth) {
      // ∑_{<k+1} = ∑_{<k} + f k ≤ B k + f k, then B k + f k ≤ B (k + 1) has no sum left
      const close = [`field_simp; nlinarith [${hints}]`, `rw [← sub_nonneg]; field_simp; ring_nf; positivity`, `nlinarith [${hints}]`];
      for (const cl of close) out.push(`rw [${big.join(", ")}]; refine le_trans (add_le_add ${ih} le_rfl) ?_; push_cast; ${cl}`);
    }
    if (pows.length) out.push(`rw [${pows.join(", ")}]; omega`);
    for (const p of pre) out.push(`${p}linarith [${hints}]`);
  } else if (rel === "∣" && !c.strongDepth && splitDvd(ihType)) {
    const m = pick(run, "m");
    const hm = pick(run, "hm");
    const nat = !/[ℤℚℝ↑]/.test(t);
    for (const w of divisibilityWitnesses(t, ihType, k, m)) {
      const grab = `obtain ⟨${m}, ${hm}⟩ := ${ih}`;
      out.push(`${grab}; exact ⟨${w.quotient}, by linear_combination ${w.multiplier} * ${hm}⟩`);
      if (nat && w.flat) {
        const ones = w.bases.filter((b) => b > 1n).map((b, i) => `have ${pick(run, `hp${i}`)} : 1 ≤ ${b} ^ ${k} := Nat.one_le_pow _ _ (by norm_num); `).join("");
        // 3 ^ (2 * (k + 1)) → 9 * 9 ^ k in the goal and in hm, so omega sees the same atoms
        const norm = w.scaled ? `simp only [mul_add, pow_add, pow_mul, mul_one] at ${hm} ⊢; norm_num at ${hm} ⊢; ` : "";
        if (!w.scaled) out.push(`${grab}; ${ones}exact ⟨${w.flat}, by ${pows.length ? `rw [${pows.join(", ")}]; ` : ""}omega⟩`);
        out.push(`${grab}; ${norm}${ones}exact ⟨${w.flat}, by omega⟩`);
        out.push(`${grab}; ${ones}exact ⟨${w.flat}, by ring_nf; ring_nf at ${hm}; omega⟩`);
      }
    }
  }
  const rw = [...big, ...recs].join(", ");
  out.push("omega", "simp_all", "linarith", `nlinarith [${ihs.join(", ")}]`, ...(rw ? [`simp [${rw}, ${ihs.join(", ")}]`, `norm_num [${rw}, ${ihs.join(", ")}]`] : []), "positivity");
  return out;
}

/** Ordinary induction on v. */
async function plain(run: TacticRunner, v: string, f: Facts): Promise<void> {
  if (!(await run.apply(`induction ${v}`))) throw new Fail(`induction ${v} was refused`);
  const gs = run.goals();
  if (gs.length !== 2 || !/^case zero/.test(gs[0]) || !/^case succ/.test(gs[1])) throw new Fail("unexpected goals after induction");
  const succ = stateAt(run, 1);
  const hidden = names(succ).filter(isInaccessible);
  if (hidden.length !== 2) throw new Fail("unexpected names in the step");
  if (!(await first(run, baseCandidates(f), (c) => `case zero => ${c}`))) throw new Fail("the base case did not close");
  const k = pick(run, "k");
  const ih = pick(run, "ih");
  const st = rename(succ, new Map([[hidden[0], k], [hidden[1], ih]]));
  if (!(await first(run, stepCandidates(run, { st, k, ih, f: facts(st) }), (c) => `case succ ${k} ${ih} => ${c}`))) throw new Fail("the induction step did not close");
}

/** Induction from a lower bound h : c ≤ v. */
async function fromBound(run: TacticRunner, v: string, h: string, f: Facts): Promise<void> {
  if (!(await run.apply(`induction ${v}, ${h} using Nat.le_induction`))) throw new Fail("Nat.le_induction was refused");
  const gs = run.goals();
  if (gs.length !== 2 || !/^case base/.test(gs[0]) || !/^case succ/.test(gs[1])) throw new Fail("unexpected goals after Nat.le_induction");
  const succ = stateAt(run, 1);
  const hidden = names(succ).filter(isInaccessible);
  if (hidden.length !== 3) throw new Fail("unexpected names in the step");
  if (!(await first(run, baseCandidates(f), (c) => `case base => ${c}`))) throw new Fail("the base case did not close");
  const k = pick(run, "k");
  const hk = pick(run, "hk");
  const ih = pick(run, "ih");
  const st = rename(succ, new Map([[hidden[0], k], [hidden[1], hk], [hidden[2], ih]]));
  if (!(await first(run, stepCandidates(run, { st, k, ih, hk, f: facts(st) }), (c) => `case succ ${k} ${hk} ${ih} => ${c}`))) throw new Fail("the induction step did not close");
}

/** Strong induction for a recurrence of depth d: d base cases, then the step k + d. */
async function strong(run: TacticRunner, v: string, depth: number, f: Facts): Promise<void> {
  if (!(await run.apply(`induction ${v} using Nat.strong_induction_on`))) throw new Fail("strong induction was refused");
  const hidden = names(stateAt(run)).filter(isInaccessible);
  if (hidden.length !== 2) throw new Fail("unexpected names after strong induction");
  const ih = pick(run, "ih");
  if (!(await run.apply(`rename_i ${v} ${ih}`))) throw new Fail("could not name the hypotheses");
  const k = pick(run, "k");
  if (!(await run.apply(`rcases ${v} with ${"_ | ".repeat(depth)}${k}`))) throw new Fail("could not split the cases");
  if (run.goals().length !== depth + 1) throw new Fail("unexpected goals after the case split");
  for (let i = 0; i < depth; i++) if (!(await first(run, baseCandidates(f), (c) => `· ${c}`))) throw new Fail(`base case ${i} did not close`);
  const st = stateAt(run);
  if (!(await first(run, stepCandidates(run, { st, k, ih, strongDepth: depth, f: facts(st) }), (c) => `· ${c}`))) throw new Fail("the induction step did not close");
}

/** `d ∣ P v` for a polynomial P and a small d: every residue of v mod d. */
async function modCases(run: TacticRunner, v: string, d: number): Promise<void> {
  const hr = pick(run, "hr");
  const h = pick(run, "hv");
  // the REPL takes one tactic at a time at the top level (`t1; t2` only inside a block)
  if (!(await run.apply(`have ${hr} := Nat.mod_lt ${v} (show ${d} > 0 by norm_num)`))) throw new Fail("could not bound the residue");
  for (const fin of ["simp [Nat.dvd_iff_mod_eq_zero, Nat.add_mod, Nat.mul_mod, Nat.pow_mod, H]", "omega", "simp [Nat.dvd_iff_mod_eq_zero, Nat.add_mod, Nat.mul_mod, Nat.pow_mod, H] <;> omega"]) {
    if (await run.apply(`interval_cases ${h} : ${v} % ${d} <;> ${fin.replace("H", h)}`)) return;
  }
  throw new Fail("the residues did not all check");
}

/** The schemes worth trying for this goal, best first. */
function schemes(st: GoalState, f: Facts): { scheme: InductionScheme; run: (r: TacticRunner) => Promise<void> }[] {
  const t = st.target;
  const inGoal = f.nats.filter((v) => word(v).test(t)).reverse();
  const out: { scheme: InductionScheme; run: (r: TacticRunner) => Promise<void> }[] = [];
  const dvd = relation(t) === "∣" ? splitDvd(t) : undefined;
  const d = dvd && /^\d+$/.test(dvd[0]) ? Number(dvd[0]) : undefined;
  if (dvd && d && d <= MAX_MODULUS && !/[ℤℚℝ↑-]/.test(dvd[1])) {
    for (const v of inGoal) if (!new RegExp(`\\^ (\\([^()]*\\b${v}\\b[^()]*\\)|${v}\\b)`).test(dvd[1])) out.push({ scheme: "mod_cases", run: (r) => modCases(r, v, d) });
  }
  for (const b of f.bounds) if (inGoal.includes(b.v)) out.push({ scheme: "le_induction", run: (r) => fromBound(r, b.v, b.h, f) });
  for (const rec of f.recurrences) {
    if (rec.depth < 2) continue;
    for (const v of inGoal) if (t.includes(`${rec.fn} ${v}`)) out.push({ scheme: "strong", run: (r) => strong(r, v, rec.depth, f) });
  }
  for (const v of inGoal) out.push({ scheme: "induction", run: (r) => plain(r, v, f) });
  return out;
}

export async function proveByInduction(run: TacticRunner): Promise<InductionOutcome> {
  try {
    await introAll(run);
    if (!run.goals().length) return { ok: true };
    const st = stateAt(run);
    const f = facts(st);
    const tries = schemes(st, f);
    if (!tries.length) return { ok: false, reason: "no natural-number variable to induct on" };
    const reasons: string[] = [];
    for (const s of tries) {
      const mark = run.save();
      try {
        await s.run(run);
        if (!run.goals().length) return { ok: true, scheme: s.scheme };
        reasons.push(`${s.scheme}: goals left`);
      } catch (e) {
        if (!(e instanceof Fail)) throw e;
        reasons.push(`${s.scheme}: ${e.message}`);
      }
      run.restore(mark);
    }
    return { ok: false, reason: reasons.join("; ") };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, reason: e.message };
    throw e;
  }
}
