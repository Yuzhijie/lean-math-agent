/**
 * Largest / smallest card of a set expression over a few finite sets with card conditions:
 * `IsGreatest {n | ∃ A B C : Finset α, A.card = 18 ∧ … ∧ (A ∩ B).card = 6 ∧ n = (E).card} M`
 * with `Fintype.card α = N` (α abstract or `Fin N`). Every card is a sum of Venn-region sizes, so
 * the conditions are a small integer program over the regions:
 *  - the witness: region sizes that meet every condition with the value M (solveRegions, a search
 *    with interval pruning), laid out as consecutive blocks of Fin N and moved into α by
 *    Fintype.equivFin; the cards are then decided by the kernel after Finset.map is pulled out;
 *  - the bound: every card written as the sum of its regions (combinatorics/venn.ts) and omega.
 * Region sizes that beat M are reported as a counterexample.
 */
import { cardTerms, vennScript } from "../combinatorics/venn";
import { introAll } from "../combinatorics/finite";
import { isInaccessible, parseGoal } from "../geometry/goal";
import type { TacticRunner } from "../tactic-runner";
import { evalSet, setVars, type SetExpr } from "../combinatorics/sets";
import { topIndex, stripParens } from "../combinatorics/lets";

export interface Linear {
  /** coefficient per card term index */
  coef: Map<number, number>;
  constant: number;
}

export interface VennProblem {
  sets: string[];
  /** card terms (each a set expression over `sets`) */
  terms: { text: string; expr: SetExpr }[];
  /** conditions: `lhs rel 0` */
  conds: { lin: Linear; rel: "=" | "≤" | "<" }[];
  /** the value asked about, as a linear form of card terms */
  objective: Linear;
}

const strip = (s: string) => s.replace(/\((\d+) : ℕ\)/g, "$1").replace(/\s+/g, " ").trim();

/** Top-level conjuncts. */
function conjuncts(s: string): string[] {
  const out: string[] = [];
  let t = stripParens(s.trim());
  for (;;) {
    const i = topIndex(t, "∧");
    if (i < 0) return [...out, stripParens(t.trim())];
    out.push(stripParens(t.slice(0, i).trim()));
    t = t.slice(i + 1).trim();
  }
}

/** `a + 2 * B.card - c` with card terms already replaced by `@i`. */
function linear(src: string): Linear | undefined {
  const lin: Linear = { coef: new Map(), constant: 0 };
  const s = stripParens(src.trim());
  const parts = s.split(/(?=[+-] )/).map((p) => p.trim());
  for (const part of parts) {
    const m = /^([+-])?\s*(?:(\d+)\s*\*\s*)?(@(\d+)|\d+)$/.exec(part.replace(/[()]/g, "").trim());
    if (!m) return undefined;
    const sign = m[1] === "-" ? -1 : 1;
    const k = m[2] ? Number(m[2]) : 1;
    if (m[4] !== undefined) {
      const i = Number(m[4]);
      lin.coef.set(i, (lin.coef.get(i) ?? 0) + sign * k);
    } else lin.constant += sign * k * Number(m[3]);
  }
  return lin;
}

const minus = (a: Linear, b: Linear): Linear => {
  const coef = new Map(a.coef);
  for (const [i, c] of b.coef) coef.set(i, (coef.get(i) ?? 0) - c);
  return { coef, constant: a.constant - b.constant };
};

/**
 * The witness goal as printed after `simp only [Set.mem_setOf_eq, lets]`: `∃ A B C, conds ∧ M = E`.
 * `value` is the bound's variable value (M); the objective is the side that is not M.
 */
export function readVennGoal(target: string, M: number): { binders: string[]; problem: VennProblem } | undefined {
  const t = strip(target);
  const ex = /^∃ ((?:[A-Za-z_][\w'₀-₉]* ?)+)(?:: [^,]+)?, ([\s\S]+)$/.exec(t);
  if (!ex) return undefined;
  const binders = ex[1].trim().split(/\s+/);
  const sets = new Set(binders);
  const items = conjuncts(ex[2]);
  const terms: { text: string; expr: SetExpr }[] = [];
  const conds: VennProblem["conds"] = [];
  let objective: Linear | undefined;
  for (const [n, item] of items.entries()) {
    const found = cardTerms(item, sets);
    if (!found) return undefined;
    let text = item;
    for (const c of [...found].sort((a, b) => b.text.length - a.text.length)) {
      let i = terms.findIndex((x) => x.text === c.text);
      if (i < 0) i = terms.push(c) - 1;
      text = text.split(c.text).join(`@${i}`);
    }
    const rel = ["≤", "≥", "<", ">", "="].map((r) => ({ r, at: topIndex(text, r) })).find((x) => x.at >= 0);
    if (!rel) return undefined;
    const lhs = linear(text.slice(0, rel.at));
    const rhs = linear(text.slice(rel.at + rel.r.length));
    if (!lhs || !rhs) return undefined;
    if (n === items.length - 1) {
      // the value: `M = E` or `E = M`
      if (rel.r !== "=") return undefined;
      const isM = (l: Linear) => l.coef.size === 0 && l.constant === M;
      if (isM(lhs)) objective = rhs;
      else if (isM(rhs)) objective = lhs;
      else return undefined;
      continue;
    }
    if (rel.r === "=") conds.push({ lin: minus(lhs, rhs), rel: "=" });
    else if (rel.r === "≤") conds.push({ lin: minus(lhs, rhs), rel: "≤" });
    else if (rel.r === "<") conds.push({ lin: minus(lhs, rhs), rel: "<" });
    else if (rel.r === "≥") conds.push({ lin: minus(rhs, lhs), rel: "≤" });
    else conds.push({ lin: minus(rhs, lhs), rel: "<" });
  }
  if (!objective || !terms.length) return undefined;
  if (terms.some((x) => [...setVars(x.expr)].some((v) => !sets.has(v)))) return undefined;
  return { binders, problem: { sets: binders, terms, conds, objective } };
}

/**
 * Region sizes (index = membership bit pattern over `sets`; 0 = in none) with total N meeting every
 * condition and the objective in [lo, hi]; undefined when there are none (or time ran out).
 */
export function solveRegions(p: VennProblem, N: number, lo: number, hi: number, deadline = Date.now() + 10_000): number[] | undefined {
  const m = p.sets.length;
  const R = 1 << m;
  const inside = (e: SetExpr, r: number) => evalSet(e, (name) => ((r >> p.sets.indexOf(name)) & 1) === 1);
  // each linear form as coefficients per region
  const perRegion = (l: Linear) => {
    const c = new Array<number>(R).fill(0);
    for (const [i, k] of l.coef) {
      const e = p.terms[i].expr;
      for (let r = 0; r < R; r++) if (e.k === "univ" || inside(e, r)) c[r] += k;
    }
    return { c, k: l.constant };
  };
  const rows = p.conds.map((cd) => ({ ...perRegion(cd.lin), rel: cd.rel }));
  const obj = perRegion(p.objective);
  // the objective as two conditions: lo ≤ obj ≤ hi
  rows.push({ c: obj.c.map((x) => -x), k: lo - obj.k, rel: "≤" });
  rows.push({ c: obj.c, k: obj.k - hi, rel: "≤" });
  const sizes = new Array<number>(R).fill(0);
  // order: regions in many terms first
  const order = [...Array(R).keys()].sort((a, b) => rows.filter((w) => w.c[b] !== 0).length - rows.filter((w) => w.c[a] !== 0).length);
  const fits = (pos: number, left: number): boolean => {
    for (const w of rows) {
      let base = w.k;
      for (let j = 0; j < pos; j++) base += w.c[order[j]] * sizes[order[j]];
      // the rest share `left` elements: min / max of Σ c·x over x ≥ 0, Σ x = left (pos < R) — or exactly 0 left
      const rest = order.slice(pos).map((r) => w.c[r]);
      const lo2 = rest.length ? base + Math.min(...rest) * left : base;
      const hi2 = rest.length ? base + Math.max(...rest) * left : base;
      if (!rest.length && left !== 0) return false;
      if (w.rel === "=" && (lo2 > 0 || hi2 < 0)) return false;
      if (w.rel === "≤" && lo2 > 0) return false;
      if (w.rel === "<" && lo2 >= 0) return false;
    }
    return true;
  };
  const go = (pos: number, left: number): boolean => {
    if (Date.now() > deadline) return false;
    if (!fits(pos, left)) return false;
    if (pos === R) return left === 0;
    if (pos === R - 1) {
      sizes[order[pos]] = left;
      return go(pos + 1, 0);
    }
    for (let x = 0; x <= left; x++) {
      sizes[order[pos]] = x;
      if (go(pos + 1, left - x)) return true;
    }
    sizes[order[pos]] = 0;
    return false;
  };
  return go(0, N) ? [...sizes] : undefined;
}

/** The objective's value at given region sizes. */
export function objectiveAt(p: VennProblem, sizes: number[]): number {
  const inside = (e: SetExpr, r: number) => e.k === "univ" || evalSet(e, (name) => ((r >> p.sets.indexOf(name)) & 1) === 1);
  let v = p.objective.constant;
  for (const [i, k] of p.objective.coef) for (let r = 0; r < sizes.length; r++) if (inside(p.terms[i].expr, r)) v += k * sizes[r];
  return v;
}

/** Each set as a predicate on `i.val`: the blocks of the regions it contains (regions laid out in order). */
export function blockPredicates(sets: string[], sizes: number[]): string[] {
  const starts: number[] = [];
  let at = 0;
  for (const s of sizes) {
    starts.push(at);
    at += s;
  }
  return sets.map((_, j) => {
    // merge adjacent blocks
    const ranges: [number, number][] = [];
    sizes.forEach((s, r) => {
      if (!s || !((r >> j) & 1)) return;
      const last = ranges[ranges.length - 1];
      if (last && last[1] === starts[r]) last[1] = starts[r] + s;
      else ranges.push([starts[r], starts[r] + s]);
    });
    if (!ranges.length) return "False";
    return ranges.map(([a, b]) => (a === 0 ? `i.val < ${b}` : b === at ? `${a} ≤ i.val` : `(${a} ≤ i.val ∧ i.val < ${b})`)).join(" ∨ ");
  });
}

/** Region sizes in words, for a counterexample: `A∩B∩C: 4, A only: 10, …`. */
export function describeRegions(sets: string[], sizes: number[]): string {
  return sizes
    .map((s, r) => {
      if (!s) return "";
      const ins = sets.filter((_, j) => (r >> j) & 1);
      return `${ins.length ? ins.join("∩") + (ins.length < sets.length ? " only" : "") : "outside"}: ${s}`;
    })
    .filter(Boolean)
    .join(", ");
}

const MAP_SIMPS = "← Finset.map_inter, ← Finset.map_union, ← Finset.map_sdiff, Finset.card_map";

/**
 * On an opened statement: the intros, then witness and bound as above. `ok` when every goal is
 * closed (the runner's script is then the proof); a counterexample when region sizes beat M.
 */
export async function vennOptimize(run: TacticRunner, theoremType: string): Promise<{ ok: boolean; reason: string; counterexample?: string }> {
  const ty = /∃ (?:[^\s(),:]+ )+: Finset (\(Fin \d+\)|[^\s(),:]+)/.exec(theoremType);
  if (!ty || /Finset \(Finset/.test(theoremType)) return { ok: false, reason: "not sets with card conditions" };
  let T = stripParens(ty[1]);
  const lets = await introAll(run);
  const g0 = run.goals()[0] ? parseGoal(run.goals()[0]) : null;
  if (!g0) return { ok: false, reason: "no goal" };
  const head = /^(IsGreatest|IsLeast) \{\s*([^\s:|]+)[^|]*\|[\s\S]*\}\s*(\d+)$/.exec(strip(g0.target));
  if (!head) return { ok: false, reason: "not IsGreatest / IsLeast" };
  const [, kind, bv, Mtext] = head;
  const M = Number(Mtext);
  // the size of the type: Fin N, or a hypothesis Fintype.card T = N (T as named in the context)
  let N: number | undefined;
  let hU: string | undefined;
  const fin = /^Fin (\d+)$/.exec(T);
  if (fin) N = Number(fin[1]);
  else {
    for (const h of g0.hyps) {
      const m = /^Fintype\.card (\S+) = (\d+)$/.exec(strip(h.type));
      if (m && !isInaccessible(h.names[0])) {
        T = m[1];
        N = Number(m[2]);
        hU = h.names[0];
      }
    }
  }
  if (N === undefined || N > 400) return { ok: false, reason: `the size of ${T} is not known` };
  const L = lets.length ? `, ${lets.join(", ")}` : "";
  if (!(await run.apply("refine ⟨?_, ?_⟩"))) return { ok: false, reason: "refine failed" };
  if (!(await run.apply(`simp only [Set.mem_setOf_eq${L}]`)) && !(await run.apply(`simp only [Set.mem_def${L}]`))) return { ok: false, reason: "membership did not unfold" };
  const g1 = run.goals()[0] ? parseGoal(run.goals()[0]) : null;
  const read = g1 && readVennGoal(g1.target, M);
  if (!read) return { ok: false, reason: "the conditions are not card conditions on the sets" };
  const { binders, problem } = read;
  if (binders.length > 4) return { ok: false, reason: "more than 4 sets" };
  const big = N * 4 * Math.max(1, ...[...problem.objective.coef.values()].map(Math.abs)) + Math.abs(problem.objective.constant) + 1;
  const better = kind === "IsGreatest" ? solveRegions(problem, N, M + 1, big) : M > 0 ? solveRegions(problem, N, -big, M - 1) : undefined;
  if (better) {
    const v = objectiveAt(problem, better);
    const text = describeRegions(binders, better);
    return { ok: false, reason: `regions ${text} give ${v}`, counterexample: `${v} ${kind === "IsGreatest" ? ">" : "<"} ${M}: ${text}` };
  }
  const sizes = solveRegions(problem, N, M, M);
  if (!sizes) return { ok: false, reason: `no sets meet the conditions with the value ${M}` };
  const preds = blockPredicates(binders, sizes).map((p) => `((Finset.univ : Finset (Fin ${N})).filter (fun i => ${p}))`);
  if (fin) {
    if (!(await run.apply(`refine ⟨${preds.join(", ")}, ?_⟩`))) return { ok: false, reason: "witness not accepted" };
    if (!(await run.apply("decide +kernel")) && !(await run.apply("decide"))) return { ok: false, reason: "the witness's cards were not decided" };
  } else {
    if (!hU) return { ok: false, reason: "no hypothesis on the size of the type" };
    if (!(await run.apply(`let e : Fin ${N} ↪ ${T} := ((Fintype.equivFin ${T}).trans (finCongr ${hU})).symm.toEmbedding`))) return { ok: false, reason: "no embedding of Fin N" };
    if (!(await run.apply(`refine ⟨${preds.map((p) => `${p}.map e`).join(", ")}, ?_⟩`))) return { ok: false, reason: "witness not accepted" };
    if (!(await run.apply(`simp only [${MAP_SIMPS}]`))) return { ok: false, reason: "Finset.map did not come out" };
    if (!(await run.apply("decide +kernel")) && !(await run.apply("decide"))) return { ok: false, reason: "the witness's cards were not decided" };
  }
  // the bound
  const conds = problem.conds.length;
  const names = Array.from({ length: conds }, () => run.fresh("hv"));
  if (!(await run.apply(`rintro ${bv} ⟨${[...binders, ...names, "rfl"].join(", ")}⟩`))) return { ok: false, reason: "the bound's hypotheses did not come apart" };
  if (lets.length) await run.apply(`simp only [${lets.join(", ")}]`);
  const g2 = run.goals()[0] ? parseGoal(run.goals()[0]) : null;
  const lines = g2 && vennScript(g2);
  if (!lines) return { ok: false, reason: "the bound is not a card fact" };
  for (const line of lines) if (!(await run.apply(line))) return { ok: false, reason: `the region step failed: ${line.slice(0, 80)}` };
  return run.goals().length ? { ok: false, reason: "goals left" } : { ok: true, reason: "" };
}
