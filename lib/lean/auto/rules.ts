/**
 * The automation search's tactic library as a table of rules. A rule looks at the goal (the facts
 * read once per goal: relation, hypotheses, nlinarith hints, …) and offers tactics:
 *  - finisher rules: tactics that must close the goal (`· tac`), tried in table order;
 *  - splitter rules: steps that turn the goal into simpler ones (intro, cases, interval_cases, …).
 * A new tactic is one entry in RULES (or registerRule / a rule file, below); the search records
 * for every rule how often its tactics were tried and how often they closed a goal or led to a
 * proof (stats.ts), and AUTO_RULE_ORDER=learned tries the finisher rules with the best record
 * first.
 *
 * Rule file (AUTO_RULES_PATH, default .data/auto-rules.json): `{ "rules": [{ "id", "kind":
 * "finisher" | "splitter", "relation": ["=", "≤", …], "matches": "<regex on the goal text>",
 * "tactics": ["nlinarith [sq_nonneg (a - b)]", …], "before": "<rule id>" }] }` — literal tactics;
 * every proof is still checked by Lean as a whole, and the sanitizer's forbidden commands apply.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isInaccessible, type GoalState } from "../geometry/goal";
import { goalShape, nlinarithHints } from "../hammer";
import { relation } from "../induction/prove";
import { topIndex } from "../combinatorics/lets";
import { divisibilityFinishers } from "./divbound";
import { boundedVars, defInstances, denominators, firstAbs, gcdLcm, goalText, hypNames, isNumType, MAX_INTERVAL, NUMBERS, sqrtArgs } from "./helpers";
import { learnedScore } from "./stats";

export type SplitKind = "intro" | "destruct" | "split" | "cases" | "interval" | "witness" | "contra" | "rewrite" | "abs";

export interface Splitter {
  tactic: string;
  /** For the report: what kind of step it is. */
  kind: SplitKind;
  /** The rule that offered it. */
  rule?: string;
}

/** What the rules read from a goal, computed once. */
export interface GoalFacts {
  st: GoalState;
  text: string;
  target: string;
  rel: string | undefined;
  hints: string[];
  /** nlinarith with the hammer's hints */
  nl: string;
  /** nlinarith with squares around the statement's small numbers */
  nl2?: string;
  defs: string[];
  eqHyps: string[];
  cast: boolean;
  /** ℕ / ℤ variables */
  intVars: string[];
}

export interface FinisherRule {
  id: string;
  kind: "finisher";
  doc: string;
  tactics(g: GoalFacts): string[];
}

export interface SplitterRule {
  id: string;
  kind: "splitter";
  doc: string;
  steps(g: GoalFacts, fresh: (base: string) => string): Omit<Splitter, "rule">[];
}

export type Rule = FinisherRule | SplitterRule;

export function goalFacts(st: GoalState): GoalFacts {
  const text = goalText(st);
  const shape = goalShape(text);
  const hints = nlinarithHints(shape, 10);
  const nl = hints.length ? `nlinarith [${hints.join(", ")}]` : "nlinarith";
  // squares around the statement's small numbers: a * (2 - a) ≤ 1 needs (a - 1) ^ 2 ≥ 0
  const ks = [...new Set((text.match(NUMBERS) ?? []).map(Number).filter((k) => k >= 1 && k <= 10))].slice(0, 3);
  const realVars = shape.vars.filter((v) => !/^(ℕ|Nat)$/.test(v.type)).map((v) => v.name).slice(0, 4);
  const shifted = realVars.flatMap((v) => ks.flatMap((k) => [`sq_nonneg (${v} - ${k})`, `sq_nonneg (${v} + ${k})`])).slice(0, 12);
  return {
    st,
    text,
    target: st.target.trim(),
    rel: relation(st.target),
    hints,
    nl,
    nl2: shifted.length ? `nlinarith [${[...shifted, ...hints.slice(0, 4)].join(", ")}]` : undefined,
    defs: st.hyps.filter((h) => /^∀/.test(h.type.trim()) && / = /.test(h.type)).flatMap((h) => h.names).filter((n) => !isInaccessible(n)).slice(0, 4),
    eqHyps: st.hyps.filter((h) => relation(h.type) === "=" && !/^∀|^∃/.test(h.type.trim())).flatMap((h) => h.names).filter((n) => !isInaccessible(n)).slice(0, 3),
    cast: /↑/.test(text),
    intVars: st.hyps.filter((h) => /^(ℕ|ℤ)$/.test(h.type.trim())).flatMap((h) => h.names).filter((v) => !isInaccessible(v)),
  };
}

const fin = (id: string, doc: string, tactics: (g: GoalFacts) => string[]): FinisherRule => ({ id, kind: "finisher", doc, tactics });
const split = (id: string, doc: string, steps: SplitterRule["steps"]): SplitterRule => ({ id, kind: "splitter", doc, steps });
const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\']/g, "\\$&");

/** The built-in rules, in the order their tactics are tried. */
export const BUILTIN_RULES: Rule[] = [
  // ── finishers, by the goal's relation ──
  fin("false", "⊢ False: contradiction in the hypotheses", (g) => (g.target === "False" ? ["simp_all", "omega", "linarith", "norm_num at *", "contradiction", g.nl, "tauto"] : [])),
  fin("equation", "⊢ a = b: computation, rings, linear arithmetic, an equation hypothesis", (g) =>
    g.target !== "False" && g.rel === "="
      ? ["rfl", "norm_num", "simp", "ring", "omega", "linarith", "simp_all", "field_simp", "(field_simp; ring)", "(norm_num; ring)", ...g.eqHyps.map((h) => `linear_combination ${h}`), g.nl, "(simp_all; ring)", "(norm_num at *; linarith)"]
      : [],
  ),
  fin("inequality", "⊢ a ≤ b, a < b: linear and nonlinear arithmetic, positivity", (g) =>
    g.target !== "False" && g.rel && /^[≤<≥>]$/.test(g.rel) ? ["norm_num", "linarith", "positivity", "omega", "simp_all", g.nl, "(norm_num at *; linarith)", "(field_simp; nlinarith)", "nlinarith"] : [],
  ),
  fin("divides", "⊢ a ∣ b", (g) => (g.target !== "False" && g.rel === "∣" ? ["decide", "norm_num", "omega", "simp_all", "(norm_num [Nat.dvd_iff_mod_eq_zero])", "decide +kernel"] : [])),
  fin("not-equal", "⊢ a ≠ b", (g) => (g.target !== "False" && g.rel === "≠" ? ["norm_num", "simp", "omega", "decide", "positivity", "simp_all", "(intro h; simp_all)", "(intro h; nlinarith)"] : [])),
  fin("other", "any other goal: simplification, propositional logic", (g) => (g.target !== "False" && !["=", "≤", "<", "≥", ">", "∣", "≠"].includes(g.rel ?? "") ? ["simp", "norm_num", "decide", "simp_all", "tauto", "omega"] : [])),
  fin("shifted-squares", "nlinarith with (x − k)² ≥ 0 for the statement's small numbers", (g) => (g.nl2 && g.rel && g.rel !== "∣" ? [g.nl2] : [])),
  fin("definitions", "definitions given as hypotheses ∀ x, f x = …: unfolded", (g) => {
    if (!g.defs.length) return [];
    const D = g.defs.join(", ");
    return [`norm_num [${D}]`, `simp [${D}]`, `(simp only [${D}] at *; linarith)`, `(simp only [${D}] at *; nlinarith [${g.hints.slice(0, 6).join(", ")}])`, `(simp only [${D}] at *; ring_nf at *; linarith)`];
  }),
  fin("casts", "casts ↑: pushed, an integer unknown computed over ℝ and cast back", (g) => {
    if (!g.cast) return [];
    const out = ["(push_cast at *; linarith)", "(norm_num at *; omega)", "(norm_num at *; linarith)"];
    const m = /^(\S+) = (-?\d+)$/.exec(g.target);
    if (m) out.push(`exact_mod_cast (show ((${m[1]} : ℝ)) = ${m[2]} by norm_num at *; linarith)`, `exact_mod_cast (show ((${m[1]} : ℝ)) = ${m[2]} by field_simp at *; linarith)`);
    return out;
  }),
  fin("definition-instances", "a definition applied to numbers (f 2): its instances as facts", (g) => {
    const inst = defInstances(g.st);
    if (!inst.length) return [];
    const haves = inst.map((e) => `have := ${e}`).join("; ");
    return [`(${haves}; norm_num at *; linarith)`, `(${haves}; norm_num at *; nlinarith [${g.hints.slice(0, 4).join(", ")}])`, `(${haves}; simp_all)`, `(${haves}; norm_num at *; omega)`];
  }),
  fin("big-operators", "∑ / ∏ over small ranges written out", (g) =>
    /∑|∏/.test(g.text) ? ["(norm_num [Finset.sum_range_succ, Finset.prod_range_succ] at *; linarith)", "(norm_num [Finset.sum_range_succ, Finset.prod_range_succ] at *; omega)", "(simp [Finset.sum_range_succ, Finset.prod_range_succ] at *; omega)", "decide +kernel"] : [],
  ),
  fin("digits", "digits / ofDigits", (g) => (/ofDigits|digits/.test(g.text) ? ["(norm_num [Nat.ofDigits] at *; omega)", "(norm_num [Nat.ofDigits, Nat.digits] at *)", "decide +kernel"] : [])),
  fin("complex", "Complex.I", (g) =>
    /Complex\.I/.test(g.text) ? ["(simp [div_pow, Complex.ext_iff]; norm_num)", "(rw [div_pow, Complex.I_sq]; norm_num)", "(ring_nf; simp [Complex.I_sq]; ring_nf)", "(simp [Complex.ext_iff, pow_two]; norm_num)"] : [],
  ),
  fin("fractions", "fractions cleared in every hypothesis", (g) => (/\/|⁻¹/.test(g.text) ? ["(field_simp at *; linarith)", "(norm_num at *; field_simp at *; linarith)", `(field_simp at *; nlinarith [${g.hints.slice(0, 4).join(", ")}])`] : [])),
  fin("square-roots", "√E² = E and √E ≥ 0 for the roots of the statement", (g) => {
    const roots = sqrtArgs(g.text).slice(0, 2);
    if (!roots.length) return [];
    const facts = roots.flatMap((e) => [`Real.sq_sqrt (show (0:ℝ) ≤ ${e} by first | positivity | linarith | nlinarith)`, `Real.sqrt_nonneg (${e})`]);
    return [`nlinarith [${[...facts, ...g.hints.slice(0, 4)].join(", ")}]`];
  }),
  fin("gcd-lcm", "gcd · lcm = the product", (g) => {
    const gl = gcdLcm(g.st);
    return gl ? [`(have h := Nat.gcd_mul_lcm ${gl.a} ${gl.b}; rw [${gl.hg}, ${gl.hl}] at h; omega)`, `(have h := Nat.gcd_mul_lcm ${gl.a} ${gl.b}; rw [${gl.hg}, ${gl.hl}] at h; nlinarith)`] : [];
  }),
  fin("two-bounded", "two bounded unknowns: every pair of values", (g) => {
    const b = boundedVars(g.st);
    if (b.length < 2) return [];
    return ["omega", "simp_all", "norm_num at *"].map((f) => `(interval_cases ${b[0]} <;> interval_cases ${b[1]} <;> ${f})`);
  }),
  fin("divisibility-bound", "a·n + b ∣ P(n): n bounded through the remainder, then every value (divbound.ts)", (g) => (g.st.hyps.some((h) => / ∣ /.test(h.type)) ? divisibilityFinishers(g.st) : [])),
  fin("kernel", "closed and finite: the kernel computes it", (g) => (!g.st.hyps.some((h) => isNumType(h.type)) ? ["decide +kernel"] : [])),
  fin("aesop", "aesop, last", () => ["aesop"]),

  // ── splitters ──
  split("intro", "binders and hypotheses of the target", (g, fresh) => {
    const out: Omit<Splitter, "rule">[] = [];
    const t = g.target;
    if (/^∀/.test(t) || topIndex(t, "→") >= 0 || /^¬/.test(t)) out.push({ tactic: `intro ${fresh("h")}`, kind: "intro" });
    const m = /^∀ \(?([A-Za-z_][\w'₀-₉]*)/.exec(t);
    if (m && !hypNames(g.st).includes(m[1])) out.unshift({ tactic: `intro ${m[1]}`, kind: "intro" });
    return out;
  }),
  split("destruct", "∃ / ∧ (every conjunct at once) / ↔ hypotheses taken apart", (g, fresh) => {
    const out: Omit<Splitter, "rule">[] = [];
    for (const h of g.st.hyps) {
      const n = h.names[0];
      if (h.names.length !== 1 || isInaccessible(n)) continue;
      const ty = h.type.trim();
      if (/^∃/.test(ty)) out.push({ tactic: `obtain ⟨${fresh("x")}, ${fresh("h")}⟩ := ${n}`, kind: "destruct" });
      else if (topIndex(ty, " ∧ ") >= 0 && !/^∀/.test(ty)) {
        let k = 1;
        for (let rest = ty; topIndex(rest, " ∧ ") >= 0; k++) rest = rest.slice(topIndex(rest, " ∧ ") + 3);
        out.push({ tactic: `obtain ⟨${Array.from({ length: Math.min(k, 8) }, () => fresh("h")).join(", ")}⟩ := ${n}`, kind: "destruct" });
      } else if (topIndex(ty, " ↔ ") >= 0 && !/^∀/.test(ty)) out.push({ tactic: `obtain ⟨${fresh("h")}, ${fresh("h")}⟩ := ${n}`, kind: "destruct" });
    }
    return out;
  }),
  split("constructor", "⊢ P ∧ Q, ⊢ P ↔ Q", (g) => (!/^∀|^∃/.test(g.target) && (topIndex(g.target, " ∧ ") >= 0 || topIndex(g.target, " ↔ ") >= 0) ? [{ tactic: "constructor", kind: "split" }] : [])),
  split("or-cases", "a hypothesis P ∨ Q: both cases", (g, fresh) =>
    g.st.hyps
      .filter((h) => h.names.length === 1 && !isInaccessible(h.names[0]) && topIndex(h.type, " ∨ ") >= 0 && !/^∀|^∃/.test(h.type.trim()))
      .map((h) => ({ tactic: `rcases ${h.names[0]} with ${fresh("h")} | ${fresh("h")}`, kind: "cases" as const })),
  ),
  split("interval", `a bounded ℕ / ℤ variable (≤ ${MAX_INTERVAL}): every value`, (g) =>
    g.intVars
      .filter((v) => {
        const e = esc(v);
        const types = g.st.hyps.map((h) => h.type.trim());
        const upper = types.some((t) => new RegExp(`^${e} (<|≤) (\\d+)$`).test(t) && Number(/(\d+)$/.exec(t)![1]) <= MAX_INTERVAL);
        const upper2 = types.some((t) => new RegExp(`^(\\d+) (>|≥) ${e}$`).test(t) && Number(/^(\d+)/.exec(t)![1]) <= MAX_INTERVAL);
        const isNat = g.st.hyps.some((h) => h.names.includes(v) && h.type.trim() === "ℕ");
        const lower = isNat || types.some((t) => new RegExp(`^(-?\\d+) (<|≤) ${e}$|^${e} (>|≥) (-?\\d+)$`).test(t));
        return (upper || upper2) && lower;
      })
      .map((v) => ({ tactic: `interval_cases ${v}`, kind: "interval" as const })),
  ),
  split("or-goal", "⊢ P ∨ Q: either side", (g) => (!/^∀|^∃/.test(g.target) && topIndex(g.target, " ∨ ") >= 0 ? [{ tactic: "left", kind: "split" }, { tactic: "right", kind: "split" }] : [])),
  split("witness", "⊢ ∃ x, …: the statement's numbers, 0, 1, 2, and n, n + 1, 2n", (g) => {
    if (!/^∃/.test(g.target)) return [];
    const nums = [...new Set([...(g.text.match(NUMBERS) ?? []), "0", "1", "2"])].slice(0, 8);
    return [
      ...nums.map((c) => ({ tactic: `use ${c}`, kind: "witness" as const })),
      ...g.intVars.slice(0, 2).flatMap((v) => [`use ${v} + 1`, `use ${v}`, `use 2 * ${v}`].map((tactic) => ({ tactic, kind: "witness" as const }))),
    ];
  }),
  split("abs", "the first |…|: both signs", (g, fresh) => {
    const abs = firstAbs(g.target) ?? g.st.hyps.map((h) => firstAbs(h.type)).find(Boolean);
    return abs ? [{ tactic: `rcases abs_cases (${abs}) with ⟨${fresh("h")}, ${fresh("h")}⟩ | ⟨${fresh("h")}, ${fresh("h")}⟩`, kind: "abs" }] : [];
  }),
  split("denominators", "variable denominators shown ≠ 0, then field_simp (the certificate finisher closes the rest)", (g, fresh) => {
    const dens = denominators(g.target);
    if (!dens.length || dens.length > 4) return [];
    const haves = dens.map((d) => `have ${fresh("hden")} : ${d} ≠ 0 := (by first | positivity | exact ne_of_gt (by nlinarith) | exact ne_of_lt (by nlinarith))`);
    return [{ tactic: `(${haves.join("; ")}; field_simp)`, kind: "rewrite" }];
  }),
  split("rewrite", "definitions unfolded, subst_vars, norm_num / push_cast everywhere", (g) => [
    ...(g.defs.length ? [{ tactic: `simp only [${g.defs.join(", ")}] at *`, kind: "rewrite" as const }] : []),
    { tactic: "subst_vars", kind: "rewrite" },
    { tactic: "norm_num at *", kind: "rewrite" },
    { tactic: "push_cast at *", kind: "rewrite" },
  ]),
  split("contra", "by_contra + push_neg", (g, fresh) => (g.target !== "False" && !/^¬|^∀|^∃/.test(g.target) ? [{ tactic: `(by_contra ${fresh("h")}; push_neg at *)`, kind: "contra" }] : [])),
];

// ── the table in use: built-in rules, rules registered by code, rules from the rule file ──

const registered: { rule: Rule; before?: string }[] = [];

/** Add a rule (before the rule with id `before`, else at the end of its kind). */
export function registerRule(rule: Rule, opts: { before?: string } = {}): void {
  const i = registered.findIndex((r) => r.rule.id === rule.id);
  if (i >= 0) registered.splice(i, 1);
  registered.push({ rule, before: opts.before });
}

export function _resetRegisteredRulesForTests(): void {
  registered.length = 0;
  fileCache = undefined;
}

interface FileRule {
  id: string;
  kind: "finisher" | "splitter";
  relation?: string[];
  matches?: string;
  tactics: string[];
  before?: string;
  doc?: string;
}

/** A rule from the rule file: literal tactics, offered when the relation / pattern fits. */
export function fileRule(r: FileRule): { rule: Rule; before?: string } | undefined {
  if (!r || typeof r.id !== "string" || !/^[\w.-]{1,60}$/.test(r.id) || !Array.isArray(r.tactics) || !r.tactics.length) return undefined;
  const tactics = r.tactics.filter((t) => typeof t === "string" && t.length < 2000 && !/#eval|\bunsafe\b|\baxiom\b|\belab\b|\bsorry\b|\badmit\b/.test(t));
  if (!tactics.length) return undefined;
  let re: RegExp | undefined;
  try {
    re = r.matches ? new RegExp(r.matches) : undefined;
  } catch {
    return undefined;
  }
  const fits = (g: GoalFacts) => (!r.relation?.length || r.relation.includes(g.rel ?? "")) && (!re || re.test(g.text));
  const doc = r.doc ?? `rule file: ${r.id}`;
  const rule: Rule =
    r.kind === "splitter"
      ? split(r.id, doc, (g) => (fits(g) ? tactics.map((tactic) => ({ tactic, kind: "rewrite" as const })) : []))
      : fin(r.id, doc, (g) => (fits(g) ? tactics : []));
  return { rule, before: r.before };
}

let fileCache: { path: string; mtime: number; rules: { rule: Rule; before?: string }[] } | undefined;

function fileRules(): { rule: Rule; before?: string }[] {
  const p = process.env.AUTO_RULES_PATH ?? path.join(process.cwd(), ".data", "auto-rules.json");
  try {
    if (!existsSync(p)) return [];
    const mtime = statSync(p).mtimeMs;
    if (fileCache && fileCache.path === p && fileCache.mtime === mtime) return fileCache.rules;
    const raw = JSON.parse(readFileSync(p, "utf8")) as { rules?: FileRule[] };
    const rules = (raw.rules ?? []).map(fileRule).filter((x): x is { rule: Rule; before?: string } => !!x);
    fileCache = { path: p, mtime, rules };
    return rules;
  } catch {
    return [];
  }
}

/** Every rule, in order. */
export function allRules(): Rule[] {
  const out = [...BUILTIN_RULES];
  for (const { rule, before } of [...registered, ...fileRules()]) {
    const existing = out.findIndex((r) => r.id === rule.id);
    if (existing >= 0) out.splice(existing, 1);
    const at = before ? out.findIndex((r) => r.id === before) : -1;
    if (at >= 0) out.splice(at, 0, rule);
    else {
      // at the end of its kind (finishers before splitters; aesop stays the last finisher)
      const lastOfKind = rule.kind === "finisher" ? out.findIndex((r) => r.id === "aesop") : out.length;
      out.splice(lastOfKind >= 0 ? lastOfKind : out.length, 0, rule);
    }
  }
  return out;
}

export interface FinisherEntry {
  tactic: string;
  rule: string;
}

/** The finishers for a goal, each with its rule; the first rule offering a tactic keeps it. */
export function finisherEntries(st: GoalState): FinisherEntry[] {
  const g = goalFacts(st);
  let rules = allRules().filter((r): r is FinisherRule => r.kind === "finisher");
  if (process.env.AUTO_RULE_ORDER === "learned") {
    // the rules with the best record first (ties keep the table order; aesop stays last)
    const order = new Map(rules.map((r, i) => [r.id, i]));
    rules = [...rules].sort((a, b) => (a.id === "aesop" ? 1 : b.id === "aesop" ? -1 : learnedScore(b.id) - learnedScore(a.id) || order.get(a.id)! - order.get(b.id)!));
  }
  const out: FinisherEntry[] = [];
  const seen = new Set<string>();
  for (const r of rules) {
    let ts: string[];
    try {
      ts = r.tactics(g);
    } catch {
      continue; // a broken rule (a rule file's) must not stop the search
    }
    for (const t of ts) {
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push({ tactic: t, rule: r.id });
    }
  }
  return out;
}

export function splitterEntries(st: GoalState, fresh: (base: string) => string): Splitter[] {
  const g = goalFacts(st);
  const out: Splitter[] = [];
  for (const r of allRules()) {
    if (r.kind !== "splitter") continue;
    try {
      for (const s of r.steps(g, fresh)) out.push({ ...s, rule: r.id });
    } catch {
      continue;
    }
  }
  return out;
}
