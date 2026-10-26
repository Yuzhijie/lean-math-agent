/**
 * The tactic library of the automation search, chosen from the goal: finishers (close the goal
 * or fail) and splitters (turn it into simpler goals). Ordered cheap and likely first.
 */
import { isInaccessible, type GoalState } from "../geometry/goal";
import { goalShape, nlinarithHints } from "../hammer";
import { relation } from "../induction/prove";
import { topIndex } from "../combinatorics/lets";

export interface Splitter {
  tactic: string;
  /** For the report: what kind of step it is. */
  kind: "intro" | "destruct" | "split" | "cases" | "interval" | "witness" | "contra" | "rewrite" | "abs";
}

const MAX_INTERVAL = 40;
const NUMBERS = /(?<![\w.'])\d+(?![\w.])/g;

const hypNames = (st: GoalState) => st.hyps.flatMap((h) => h.names).filter((n) => !isInaccessible(n));
const isNumType = (t: string) => /^(ℕ|ℤ|ℚ|ℝ)$/.test(t.trim());

/** The goal as text for goalShape (hammer's parser). */
export function goalText(st: GoalState): string {
  return [...st.hyps.map((h) => `${h.names.join(" ")} : ${h.type}`), `⊢ ${st.target}`].join("\n");
}

export function finishers(st: GoalState): string[] {
  const shape = goalShape(goalText(st));
  const hints = nlinarithHints(shape, 10);
  const nl = hints.length ? `nlinarith [${hints.join(", ")}]` : "nlinarith";
  // squares around the statement's small numbers: a * (2 - a) ≤ 1 needs (a - 1) ^ 2 ≥ 0
  const ks = [...new Set((goalText(st).match(NUMBERS) ?? []).map(Number).filter((k) => k >= 1 && k <= 10))].slice(0, 3);
  const realVars = shape.vars.filter((v) => !/^(ℕ|Nat)$/.test(v.type)).map((v) => v.name).slice(0, 4);
  const shifted = realVars.flatMap((v) => ks.flatMap((k) => [`sq_nonneg (${v} - ${k})`, `sq_nonneg (${v} + ${k})`])).slice(0, 12);
  const nl2 = shifted.length ? `nlinarith [${[...shifted, ...hints.slice(0, 4)].join(", ")}]` : undefined;
  // definitions given as hypotheses (∀ x, f x = …)
  const defs = st.hyps.filter((h) => /^∀/.test(h.type.trim()) && / = /.test(h.type)).flatMap((h) => h.names).filter((n) => !isInaccessible(n)).slice(0, 4);
  const D = defs.join(", ");
  const cast = /↑/.test(goalText(st));
  const rel = relation(st.target);
  const t = st.target.trim();
  const eqHyps = st.hyps.filter((h) => relation(h.type) === "=" && !/^∀|^∃/.test(h.type.trim())).flatMap((h) => h.names).filter((n) => !isInaccessible(n)).slice(0, 3);
  const out: string[] = [];
  const add = (...xs: string[]) => {
    for (const x of xs) if (!out.includes(x)) out.push(x);
  };
  if (t === "False") add("simp_all", "omega", "linarith", "norm_num at *", "contradiction", nl, "tauto");
  else if (rel === "=") {
    add("rfl", "norm_num", "simp", "ring", "omega", "linarith", "simp_all", "field_simp", "(field_simp; ring)", "(norm_num; ring)");
    for (const h of eqHyps) add(`linear_combination ${h}`);
    add(nl, "(simp_all; ring)", "(norm_num at *; linarith)");
  } else if (rel && /^[≤<≥>]$/.test(rel)) add("norm_num", "linarith", "positivity", "omega", "simp_all", nl, "(norm_num at *; linarith)", "(field_simp; nlinarith)", "nlinarith");
  else if (rel === "∣") add("decide", "norm_num", "omega", "simp_all", "(norm_num [Nat.dvd_iff_mod_eq_zero])", "decide +kernel");
  else if (rel === "≠") add("norm_num", "simp", "omega", "decide", "positivity", "simp_all", "(intro h; simp_all)", "(intro h; nlinarith)");
  else add("simp", "norm_num", "decide", "simp_all", "tauto", "omega");
  if (nl2 && rel && rel !== "∣") add(nl2);
  if (defs.length) add(`norm_num [${D}]`, `simp [${D}]`, `(simp only [${D}] at *; linarith)`, `(simp only [${D}] at *; nlinarith [${hints.slice(0, 6).join(", ")}])`, `(simp only [${D}] at *; ring_nf at *; linarith)`);
  if (cast) {
    add("(push_cast at *; linarith)", "(norm_num at *; omega)", "(norm_num at *; linarith)");
    // an integer unknown fixed by a real equation: compute it over ℝ, then cast back
    const m = /^(\S+) = (-?\d+)$/.exec(t);
    if (m) add(`exact_mod_cast (show ((${m[1]} : ℝ)) = ${m[2]} by norm_num at *; linarith)`, `exact_mod_cast (show ((${m[1]} : ℝ)) = ${m[2]} by field_simp at *; linarith)`);
  }
  const all = goalText(st);
  // definitions applied to numbers (f 2, f (-3)): the instances of the definition as facts
  const inst = defInstances(st);
  if (inst.length) {
    const haves = inst.map((e) => `have := ${e}`).join("; ");
    add(`(${haves}; norm_num at *; linarith)`, `(${haves}; norm_num at *; nlinarith [${hints.slice(0, 4).join(", ")}])`, `(${haves}; simp_all)`, `(${haves}; norm_num at *; omega)`);
  }
  // sums over small ranges written out
  if (/∑|∏/.test(all)) add("(norm_num [Finset.sum_range_succ, Finset.prod_range_succ] at *; linarith)", "(norm_num [Finset.sum_range_succ, Finset.prod_range_succ] at *; omega)", "(simp [Finset.sum_range_succ, Finset.prod_range_succ] at *; omega)", "decide +kernel");
  if (/ofDigits|digits/.test(all)) add("(norm_num [Nat.ofDigits] at *; omega)", "(norm_num [Nat.ofDigits, Nat.digits] at *)", "decide +kernel");
  if (/Complex\.I/.test(all)) add("(simp [div_pow, Complex.ext_iff]; norm_num)", "(rw [div_pow, Complex.I_sq]; norm_num)", "(ring_nf; simp [Complex.I_sq]; ring_nf)", "(simp [Complex.ext_iff, pow_two]; norm_num)");
  // fractions: clear them in every hypothesis
  if (/\/|⁻¹/.test(all)) add("(field_simp at *; linarith)", "(norm_num at *; field_simp at *; linarith)", `(field_simp at *; nlinarith [${hints.slice(0, 4).join(", ")}])`);
  // square roots: √E ^ 2 = E for the E the statement takes roots of
  const roots = sqrtArgs(all).slice(0, 2);
  if (roots.length) {
    const facts = roots.flatMap((e) => [`Real.sq_sqrt (show (0:ℝ) ≤ ${e} by first | positivity | linarith | nlinarith)`, `Real.sqrt_nonneg (${e})`]);
    add(`nlinarith [${[...facts, ...hints.slice(0, 4)].join(", ")}]`);
  }
  // gcd · lcm = product
  const gl = gcdLcm(st);
  if (gl) add(`(have h := Nat.gcd_mul_lcm ${gl.a} ${gl.b}; rw [${gl.hg}, ${gl.hl}] at h; omega)`, `(have h := Nat.gcd_mul_lcm ${gl.a} ${gl.b}; rw [${gl.hg}, ${gl.hl}] at h; nlinarith)`);
  // two bounded unknowns at once
  const bounded = boundedVars(st);
  if (bounded.length >= 2) {
    const [a, b] = bounded;
    for (const fin of ["omega", "simp_all", "norm_num at *"]) add(`(interval_cases ${a} <;> interval_cases ${b} <;> ${fin})`);
  }
  // anything closed and finite: the kernel computes it
  if (!st.hyps.some((h) => isNumType(h.type))) add("decide +kernel");
  add("aesop");
  return out;
}

/** The text of the first `|…|` in s (balanced), or undefined. */
function firstAbs(s: string): string | undefined {
  const i = s.indexOf("|");
  if (i < 0) return undefined;
  let depth = 0;
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "|" && depth === 0) return s.slice(i + 1, j).trim();
  }
  return undefined;
}

export function splitters(st: GoalState, fresh: (base: string) => string): Splitter[] {
  const t = st.target.trim();
  const out: Splitter[] = [];
  // binders and hypotheses of the target
  if (/^∀/.test(t) || topIndex(t, "→") >= 0 || /^¬/.test(t)) out.push({ tactic: `intro ${fresh("h")}`, kind: "intro" });
  if (/^∀ \(?([A-Za-z_][\w'₀-₉]*)/.test(t)) {
    const v = /^∀ \(?([A-Za-z_][\w'₀-₉]*)/.exec(t)![1];
    if (!hypNames(st).includes(v)) out.unshift({ tactic: `intro ${v}`, kind: "intro" });
  }
  // structure in the hypotheses
  for (const h of st.hyps) {
    const n = h.names[0];
    if (h.names.length !== 1 || isInaccessible(n)) continue;
    const ty = h.type.trim();
    if (/^∃/.test(ty) || (topIndex(ty, " ∧ ") >= 0 && !/^∀/.test(ty))) out.push({ tactic: `obtain ⟨${fresh("x")}, ${fresh("h")}⟩ := ${n}`, kind: "destruct" });
    else if (topIndex(ty, " ↔ ") >= 0 && !/^∀/.test(ty)) out.push({ tactic: `obtain ⟨${fresh("h")}, ${fresh("h")}⟩ := ${n}`, kind: "destruct" });
  }
  // the target's structure
  if (!/^∀|^∃/.test(t) && (topIndex(t, " ∧ ") >= 0 || topIndex(t, " ↔ ") >= 0)) out.push({ tactic: "constructor", kind: "split" });
  for (const h of st.hyps) {
    const n = h.names[0];
    if (h.names.length !== 1 || isInaccessible(n)) continue;
    if (topIndex(h.type, " ∨ ") >= 0 && !/^∀|^∃/.test(h.type.trim())) out.push({ tactic: `rcases ${n} with ${fresh("h")} | ${fresh("h")}`, kind: "cases" });
  }
  // a bounded integer variable: every value
  const vars = st.hyps.filter((h) => /^(ℕ|ℤ)$/.test(h.type.trim())).flatMap((h) => h.names).filter((v) => !isInaccessible(v));
  for (const v of vars) {
    const esc = v.replace(/[.*+?^${}()|[\]\\']/g, "\\$&");
    const upper = st.hyps.some((h) => new RegExp(`^${esc} (<|≤) (\\d+)$`).test(h.type.trim()) && Number(/(\d+)$/.exec(h.type.trim())![1]) <= MAX_INTERVAL);
    const upper2 = st.hyps.some((h) => new RegExp(`^(\\d+) (>|≥) ${esc}$`).test(h.type.trim()) && Number(/^(\d+)/.exec(h.type.trim())![1]) <= MAX_INTERVAL);
    const isNat = st.hyps.some((h) => h.names.includes(v) && h.type.trim() === "ℕ");
    const lower = isNat || st.hyps.some((h) => new RegExp(`^(-?\\d+) (<|≤) ${esc}$|^${esc} (>|≥) (-?\\d+)$`).test(h.type.trim()));
    if ((upper || upper2) && lower) out.push({ tactic: `interval_cases ${v}`, kind: "interval" });
  }
  if (!/^∀|^∃/.test(t) && topIndex(t, " ∨ ") >= 0) out.push({ tactic: "left", kind: "split" }, { tactic: "right", kind: "split" });
  // ∃: a witness among the numbers of the statement and 0, 1, 2
  if (/^∃/.test(t)) {
    const nums = [...new Set([...(goalText(st).match(NUMBERS) ?? []), "0", "1", "2"])].slice(0, 8);
    for (const c of nums) out.push({ tactic: `use ${c}`, kind: "witness" });
    for (const v of vars.slice(0, 2)) out.push({ tactic: `use ${v} + 1`, kind: "witness" }, { tactic: `use ${v}`, kind: "witness" }, { tactic: `use 2 * ${v}`, kind: "witness" });
  }
  const abs = firstAbs(t) ?? st.hyps.map((h) => firstAbs(h.type)).find(Boolean);
  if (abs) out.push({ tactic: `rcases abs_cases (${abs}) with ⟨${fresh("h")}, ${fresh("h")}⟩ | ⟨${fresh("h")}, ${fresh("h")}⟩`, kind: "abs" });
  // rewriting steps (each must change the goal)
  const defs = st.hyps.filter((h) => /^∀/.test(h.type.trim()) && / = /.test(h.type)).flatMap((h) => h.names).filter((n) => !isInaccessible(n)).slice(0, 4);
  if (defs.length) out.push({ tactic: `simp only [${defs.join(", ")}] at *`, kind: "rewrite" });
  out.push({ tactic: "subst_vars", kind: "rewrite" }, { tactic: "norm_num at *", kind: "rewrite" }, { tactic: "push_cast at *", kind: "rewrite" });
  if (t !== "False" && !/^¬|^∀|^∃/.test(t)) out.push({ tactic: `(by_contra ${fresh("h")}; push_neg at *)`, kind: "contra" });
  return out;
}

/** `h c` for each definition `h : ∀ x, f x = …` and each `f c` (c a number) in the goal or the hypotheses. */
export function defInstances(st: GoalState): string[] {
  const out: string[] = [];
  const all = goalText(st);
  for (const h of st.hyps) {
    const n = h.names[0];
    if (h.names.length !== 1 || isInaccessible(n)) continue;
    const m = /^∀ \(?([A-Za-z_][\w'₀-₉]*)[^,]*,\s*(.*)$/.exec(h.type.replace(/\s+/g, " ").trim());
    if (!m) continue;
    const body = m[2];
    const cond = /^(.*?) → (.*)$/.exec(body);
    const eq = (cond ? cond[2] : body).trim();
    const f = new RegExp(`^([A-Za-z_][\\w'₀-₉]*) ${m[1]} = `).exec(eq)?.[1];
    if (!f) continue;
    const re = new RegExp(`(?<![\\w'.])${f} (\\(-?[\\d./ ]+\\)|\\d+)`, "g");
    for (const a of new Set([...all.matchAll(re)].map((x) => x[1]))) out.push(cond ? `${n} ${a} (by decide)` : `${n} ${a}`);
  }
  return out.slice(0, 4);
}

/** The arguments of `Real.sqrt (…)` / `√(…)` / `√x`, as written. */
export function sqrtArgs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/Real\.sqrt |√/g)) {
    let i = m.index! + m[0].length;
    if (text[i] === "(") {
      let depth = 0;
      for (let j = i; j < text.length; j++) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")" && --depth === 0) {
          out.push(text.slice(i, j + 1));
          break;
        }
      }
    } else {
      const id = /^[A-Za-z_\d][\w'₀-₉]*/.exec(text.slice(i));
      if (id) out.push(id[0]);
    }
  }
  return [...new Set(out)];
}

function gcdLcm(st: GoalState): { a: string; b: string; hg: string; hl: string } | undefined {
  let g: { a: string; b: string; h: string } | undefined;
  let l: { a: string; b: string; h: string } | undefined;
  const ARG = "(\\S+|\\([^()]*\\))";
  for (const h of st.hyps) {
    const t = h.type.trim();
    const n = h.names[0];
    const mg = new RegExp(`^(?:Nat\\.gcd ${ARG} ${ARG}|${ARG}\\.gcd ${ARG}) = \\d+$`).exec(t);
    if (mg) g = { a: mg[1] ?? mg[3], b: mg[2] ?? mg[4], h: n };
    const ml = new RegExp(`^(?:Nat\\.lcm ${ARG} ${ARG}|${ARG}\\.lcm ${ARG}) = \\d+$`).exec(t);
    if (ml) l = { a: ml[1] ?? ml[3], b: ml[2] ?? ml[4], h: n };
  }
  return g && l && g.a === l.a && g.b === l.b ? { a: g.a, b: g.b, hg: g.h, hl: l.h } : undefined;
}

/** ℕ / ℤ variables with a numeric upper bound (≤ MAX_INTERVAL) in some hypothesis, also inside ∧. */
export function boundedVars(st: GoalState): string[] {
  const vars = st.hyps.filter((h) => /^(ℕ|ℤ)$/.test(h.type.trim())).flatMap((h) => h.names).filter((v) => !isInaccessible(v));
  const facts = st.hyps.flatMap((h) => h.type.split(" ∧ ").map((x) => x.trim()));
  return vars.filter((v) => {
    const esc = v.replace(/[.*+?^${}()|[\]\\']/g, "\\$&");
    return facts.some((f) => {
      const a = new RegExp(`^${esc} (<|≤) (\\d+)$`).exec(f);
      const b = new RegExp(`^(\\d+) (>|≥) ${esc}$`).exec(f);
      const k = a ? Number(a[2]) : b ? Number(b[1]) : NaN;
      return k <= MAX_INTERVAL;
    });
  });
}
