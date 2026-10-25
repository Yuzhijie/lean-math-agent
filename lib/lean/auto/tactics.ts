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
  }
  const abs = firstAbs(t) ?? st.hyps.map((h) => firstAbs(h.type)).find(Boolean);
  if (abs) out.push({ tactic: `rcases abs_cases (${abs}) with ⟨${fresh("h")}, ${fresh("h")}⟩ | ⟨${fresh("h")}, ${fresh("h")}⟩`, kind: "abs" });
  // rewriting steps (each must change the goal)
  out.push({ tactic: "subst_vars", kind: "rewrite" }, { tactic: "norm_num at *", kind: "rewrite" }, { tactic: "push_cast at *", kind: "rewrite" });
  if (t !== "False" && !/^¬|^∀|^∃/.test(t)) out.push({ tactic: `(by_contra ${fresh("h")}; push_neg at *)`, kind: "contra" });
  return out;
}
