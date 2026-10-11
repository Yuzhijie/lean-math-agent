/**
 * Solution-strategy figures: pictures of HOW a problem is solved, drawn and checked by the program.
 *
 * - bar_model     线段图 / bar model: bars cut into parts (equal units or given values); the program finds
 *                 the value of one unit from what is given, checks every given number against it, and checks
 *                 the asked part (or bar) against the answer.
 * - number_line   数轴 / time line: points, jumps (with their size) and brackets; jump sizes and the answer are checked.
 * - prob_tree     概率树: branches with probabilities; each fork must add up to 1, leaf = product, the asked
 *                 event = sum of its leaves, checked against the answer (exact fractions).
 * - enum_table    列表法: the program enumerates every value of one or two variables, computes the derived
 *                 columns, marks the rows that meet the conditions, and checks the count / the solution.
 * - graph_explore 函数图像 + 滑块: functions of x (and a slider parameter), a point that follows the slider,
 *                 live read-outs; the claimed maximum/minimum and intersections are checked by sampling.
 *
 * Any element may carry `from_step` (it appears from that solution step on, so a step-by-step view builds
 * the picture up), and unknown values `reveal_step` (shown as "?" before that step).
 *
 * Browser-safe: no server imports; messages go through a `tr` parameter.
 */
import { z } from "zod";
import { compileExprVars, ExprError, VAR_NAME, type Scope } from "./expr";

export type Tr = (zh: string, en: string) => string;
const zhOnly: Tr = (a) => a;

export class StrategyError extends Error {}

const id = z.string().min(1).max(16).regex(/^[A-Za-z][A-Za-z0-9_]*$/, "id must be a short identifier like a, part1, bar_A");
const label = z.string().max(24);
const step = z.number().int().min(1).max(30);
const num = z.number().finite();

// ── Bar model ──────────────────────────────────────────────────────────

const barPartSchema = z.object({
  id,
  label: label.optional(),
  /** Number of equal units this part is (e.g. 3 of the 8 eighths). */
  units: z.number().positive().max(100).optional(),
  /** Its value when given in the problem. */
  value: num.optional(),
  /** What the problem asks for (shown as "?" until reveal_step). */
  unknown: z.boolean().optional(),
  shade: z.boolean().optional(),
  from_step: step.optional(),
  reveal_step: step.optional(),
});

const barSchema = z.object({
  id,
  label: label.optional(),
  parts: z.array(barPartSchema).min(1).max(12),
  /** Value of the whole bar when given. */
  total: num.optional(),
  total_label: label.optional(),
  /** The whole bar is this many units (fraction bars: 8 for eighths) — checked against its parts. */
  units: z.number().positive().max(100).optional(),
  from_step: step.optional(),
});

const barRelationSchema = z.object({
  id,
  /** sum: the bars together are `value`; difference: bars[0] is `value` more than bars[1]. */
  type: z.enum(["sum", "difference"]),
  bars: z.array(id).min(2).max(4),
  value: num.optional(),
  label: label.optional(),
  unknown: z.boolean().optional(),
  from_step: step.optional(),
  reveal_step: step.optional(),
});

export const barModelSchema = z.object({
  type: z.literal("bar_model"),
  bars: z.array(barSchema).min(1).max(5),
  relations: z.array(barRelationSchema).max(4).optional(),
  /** Unit of the values, e.g. "颗", "km", "$". */
  unit: z.string().max(8).optional(),
  /** Part, bar or relation the question asks for. */
  ask: id.optional(),
  answer: num.optional(),
});

// ── Number line ───────────────────────────────────────────────────────

export const numberLineSchema = z.object({
  type: z.literal("number_line"),
  min: num,
  max: num,
  tick: z.number().positive().optional(),
  unit: z.string().max(8).optional(),
  points: z.array(z.object({ id, value: num, label: label.optional(), from_step: step.optional(), reveal_step: step.optional(), unknown: z.boolean().optional() })).max(12).default([]),
  /** Arcs above the line from one value to another; `delta` (signed size) is checked against to − from. */
  jumps: z.array(z.object({ id, from: num, to: num, delta: num.optional(), label: label.optional(), from_step: step.optional() })).max(12).default([]),
  /** Brackets below the line. */
  spans: z.array(z.object({ id, from: num, to: num, label: label.optional(), from_step: step.optional() })).max(6).default([]),
  ask: id.optional(),
  answer: num.optional(),
});

// ── Probability tree ──────────────────────────────────────────────────

/** Probability as written: "3/5", "0.4", "1". */
const prob = z.union([z.string().max(16), z.number()]);
type ProbNode = { id: string; label: string; p: string | number; children?: ProbNode[]; from_step?: number };
const probNodeSchema: z.ZodType<ProbNode> = z.lazy(() =>
  z.object({ id, label, p: prob, children: z.array(probNodeSchema).max(6).optional(), from_step: step.optional() }),
);

export const probTreeSchema = z.object({
  type: z.literal("prob_tree"),
  /** Level names, e.g. ["第一次", "第二次"]. */
  levels: z.array(label).max(3).optional(),
  children: z.array(probNodeSchema).min(1).max(6),
  /** Leaf ids that make up the asked event. */
  ask: z.array(id).max(36).optional(),
  answer: prob.optional(),
});

// ── Enumeration table ─────────────────────────────────────────────────

const varName = z.string().regex(VAR_NAME, "a variable is one letter (not e), optionally with digits");
export const enumTableSchema = z.object({
  type: z.literal("enum_table"),
  /** One or two variables tried systematically (from..to by step). */
  vars: z.array(z.object({ id: varName, label, from: num, to: num, step: z.number().positive().optional() })).min(1).max(2),
  /** Derived columns: expressions in the variables, e.g. {id:"r", label:"兔", expr:"10 - c"}. */
  columns: z.array(z.object({ id: varName, label, expr: z.string().min(1).max(120), from_step: step.optional() })).max(5).default([]),
  /** Conditions in the variables and columns: "2c + 4r = 28", "r >= 0", "m != n". */
  conditions: z.array(z.string().min(3).max(120)).min(1).max(5),
  /** Rows to show: every row tried, or only the rows that meet the conditions (default: all when ≤ 16 rows). */
  show: z.enum(["all", "matching"]).optional(),
  /** How many rows meet the conditions, and/or the values of the one solution. */
  answer_count: z.number().int().nonnegative().optional(),
  answer_row: z.record(num).optional(),
});

// ── Graph with a slider ───────────────────────────────────────────────

export const graphExploreSchema = z.object({
  type: z.literal("graph_explore"),
  x: z.tuple([num, num]),
  y: z.tuple([num, num]),
  /** Functions of x; they may use the slider parameter (e.g. "k x + 1"). */
  functions: z.array(z.object({ id, expr: z.string().min(1).max(200), label: z.string().max(40).optional(), from_step: step.optional() })).min(1).max(4),
  /** Slider: a parameter the student moves. */
  param: z.object({ id: varName, label: z.string().max(24).optional(), min: num, max: num, step: z.number().positive().optional(), start: num.optional() }).optional(),
  /** A point that follows the slider along a function: (param, f(param)). */
  tracer: z.object({ fn: id, label: z.string().max(16).optional() }).optional(),
  /** Live values shown under the graph, expressions in the parameter: [{label:"ab", expr:"a(4-a)"}]. */
  readouts: z.array(z.object({ label: z.string().max(24), expr: z.string().min(1).max(120) })).max(4).default([]),
  /** Claimed extreme value of a function on [x0, x1]: checked by sampling. */
  optimum: z.object({ id: id.optional(), fn: id, kind: z.enum(["max", "min"]), x: num, y: num, from_step: step.optional() }).optional(),
  /** Claimed intersections: f(x) = g(x) at x. */
  intersections: z.array(z.object({ id: id.optional(), fns: z.tuple([id, id]), x: num, from_step: step.optional() })).max(4).default([]),
});

export const strategySchema = z.discriminatedUnion("type", [barModelSchema, numberLineSchema, probTreeSchema, enumTableSchema, graphExploreSchema]);

export type StrategySpec = z.infer<typeof strategySchema>;
export type BarModel = z.infer<typeof barModelSchema>;
export type NumberLine = z.infer<typeof numberLineSchema>;
export type ProbTree = z.infer<typeof probTreeSchema>;
export type EnumTable = z.infer<typeof enumTableSchema>;
export type GraphExplore = z.infer<typeof graphExploreSchema>;

export interface StrategyCheck {
  ok: boolean;
  detail: string;
}

/** Solved strategy figure, JSON-serialisable (stored on the session, rendered in the browser). */
export type StrategySolved =
  | { type: "bar_model"; unit: number | null; parts: Record<string, number | null>; bars: Record<string, number | null>; relations: Record<string, number | null> }
  | { type: "number_line" }
  | { type: "prob_tree"; leaves: Array<{ path: string[]; ids: string[]; p: string }>; event: string | null }
  | { type: "enum_table"; rows: Array<{ values: number[]; ok: boolean }>; header: string[]; tried: number; matching: number; truncated: boolean }
  | { type: "graph_explore" };

const EPS = 1e-6;
const close = (a: number, b: number) => Math.abs(a - b) <= EPS * Math.max(1, Math.abs(a), Math.abs(b));
export const fmtNum = (v: number) => {
  if (Math.abs(v - Math.round(v)) < 1e-9) return String(Math.round(v));
  const r = Math.round(v * 1000) / 1000;
  return String(r);
};

// ── Fractions ──────────────────────────────────────────────────────────

export interface Frac {
  n: number;
  d: number;
}
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : Math.abs(a));
const frac = (n: number, d: number): Frac => {
  if (d < 0) [n, d] = [-n, -d];
  const g = gcd(Math.round(n), Math.round(d)) || 1;
  return { n: Math.round(n) / g, d: Math.round(d) / g };
};
const fAdd = (a: Frac, b: Frac) => frac(a.n * b.d + b.n * a.d, a.d * b.d);
const fMul = (a: Frac, b: Frac) => frac(a.n * b.n, a.d * b.d);
export const fStr = (f: Frac) => (f.d === 1 ? String(f.n) : `${f.n}/${f.d}`);

/** "3/5", "0.4", "1", 0.25 → exact fraction (decimals up to 6 places). */
export function parseProb(p: string | number): Frac | null {
  const s = String(p).trim().replace(/\s+/g, "").replace(/^\$|\$$/g, "");
  let m = s.match(/^\\?d?frac\{(\d+)\}\{(\d+)\}$/);
  if (m) return frac(Number(m[1]), Number(m[2]));
  m = s.match(/^(\d+)\/(\d+)$/);
  if (m) return Number(m[2]) ? frac(Number(m[1]), Number(m[2])) : null;
  m = s.match(/^(\d+(?:\.\d+)?)%$/);
  if (m) return parseProb(Number(m[1]) / 100);
  if (/^\d*\.?\d+$/.test(s)) {
    const v = Number(s);
    const dec = (s.split(".")[1] ?? "").length;
    if (dec > 6) return null;
    return frac(Math.round(v * 10 ** dec), 10 ** dec);
  }
  return null;
}

// ── Solvers ────────────────────────────────────────────────────────────

function solveBarModel(b: BarModel, tr: Tr): { solved: Extract<StrategySolved, { type: "bar_model" }>; checks: StrategyCheck[] } {
  const checks: StrategyCheck[] = [];
  const u = (v: number) => (b.unit ? `${fmtNum(v)} ${b.unit}` : fmtNum(v));
  const ids = new Set<string>();
  for (const bar of b.bars) {
    if (ids.has(bar.id)) throw new StrategyError(tr(`编号 ${bar.id} 重复`, `Duplicate id ${bar.id}`));
    ids.add(bar.id);
    for (const p of bar.parts) {
      if (ids.has(p.id)) throw new StrategyError(tr(`编号 ${p.id} 重复`, `Duplicate id ${p.id}`));
      ids.add(p.id);
    }
  }
  // Per bar: total = U·unit + V (+ one part known from neither, solved from the total).
  const info = b.bars.map((bar) => {
    const unitParts = bar.parts.filter((p) => p.units !== undefined);
    const valueParts = bar.parts.filter((p) => p.units === undefined && p.value !== undefined);
    const free = bar.parts.filter((p) => p.units === undefined && p.value === undefined);
    if (free.length > 1) throw new StrategyError(tr(`线段 ${bar.label ?? bar.id} 有 ${free.length} 段既没有份数也没有数值，最多只能有一段`, `Bar ${bar.label ?? bar.id} has ${free.length} parts with neither units nor a value; at most one is allowed`));
    return { bar, U: unitParts.reduce((s, p) => s + p.units!, 0), V: valueParts.reduce((s, p) => s + p.value!, 0), free: free[0] };
  });
  // Candidate values of one unit.
  const cands: Array<{ v: number; from: string }> = [];
  for (const { bar } of info) for (const p of bar.parts) if (p.units !== undefined && p.value !== undefined) cands.push({ v: p.value / p.units, from: tr(`${p.label ?? p.id} = ${u(p.value)}（${fmtNum(p.units)} 份）`, `${p.label ?? p.id} = ${u(p.value)} (${fmtNum(p.units)} units)`) });
  for (const x of info) {
    if (x.bar.total !== undefined && !x.free && x.U > 0) cands.push({ v: (x.bar.total - x.V) / x.U, from: tr(`${x.bar.label ?? x.bar.id} 共 ${u(x.bar.total)}`, `${x.bar.label ?? x.bar.id} totals ${u(x.bar.total)}`) });
    // The whole bar is `units` equal units (fraction bars), whatever its parts are.
    if (x.bar.total !== undefined && x.bar.units !== undefined) cands.push({ v: x.bar.total / x.bar.units, from: tr(`${x.bar.label ?? x.bar.id} 共 ${u(x.bar.total)}，平均分成 ${fmtNum(x.bar.units)} 份`, `${x.bar.label ?? x.bar.id} totals ${u(x.bar.total)} split into ${fmtNum(x.bar.units)} equal units`) });
  }
  const byId = new Map(info.map((x) => [x.bar.id, x]));
  for (const r of b.relations ?? []) {
    if (r.value === undefined) continue;
    const xs = r.bars.map((bid) => {
      const x = byId.get(bid);
      if (!x) throw new StrategyError(tr(`关系 ${r.id} 引用了不存在的线段 ${bid}`, `Relation ${r.id} names an unknown bar ${bid}`));
      return x;
    });
    if (xs.some((x) => x.free)) continue;
    const U = r.type === "sum" ? xs.reduce((s, x) => s + x.U, 0) : xs[0].U - xs[1].U;
    const V = r.type === "sum" ? xs.reduce((s, x) => s + x.V, 0) : xs[0].V - xs[1].V;
    if (Math.abs(U) > EPS) cands.push({ v: (r.value - V) / U, from: tr(`${r.label ?? r.id}：${r.type === "sum" ? "合计" : "相差"} ${u(r.value)}`, `${r.label ?? r.id}: ${r.type === "sum" ? "together" : "difference"} ${u(r.value)}`) });
  }
  const hasUnits = info.some((x) => x.U > 0);
  let unit: number | null = null;
  if (cands.length) {
    unit = cands[0].v;
    const bad = cands.filter((c) => !close(c.v, unit!));
    if (bad.length) checks.push({ ok: false, detail: tr(`每份的值不一致：由「${cands[0].from}」得 ${fmtNum(unit)}，由「${bad[0].from}」得 ${fmtNum(bad[0].v)}`, `The value of one unit does not agree: “${cands[0].from}” gives ${fmtNum(unit)}, “${bad[0].from}” gives ${fmtNum(bad[0].v)}`) });
    else if (hasUnits) checks.push({ ok: true, detail: tr(`每份 = ${u(unit)}（${cands[0].from}）`, `One unit = ${u(unit)} (${cands[0].from})`) });
  } else if (hasUnits) {
    checks.push({ ok: false, detail: tr("图中的数据求不出每份是多少", "The figure's data do not determine the value of one unit") });
  }
  // Values.
  const parts: Record<string, number | null> = {};
  const bars: Record<string, number | null> = {};
  for (const x of info) {
    let known = 0;
    let complete = true;
    for (const p of x.bar.parts) {
      const v = p.units !== undefined ? (unit === null ? null : p.units * unit) : p.value ?? null;
      parts[p.id] = v;
      if (v === null) complete = false;
      else known += v;
    }
    if (x.free) {
      if (x.bar.total !== undefined && (x.U === 0 || unit !== null)) {
        const rest = x.bar.total - known;
        parts[x.free.id] = rest;
        if (rest < -EPS) checks.push({ ok: false, detail: tr(`${x.bar.label ?? x.bar.id} 的其余部分已超过总数 ${u(x.bar.total)}`, `The other parts of ${x.bar.label ?? x.bar.id} already exceed its total ${u(x.bar.total)}`) });
        bars[x.bar.id] = x.bar.total;
      } else bars[x.bar.id] = null;
    } else {
      bars[x.bar.id] = complete ? known : null;
      if (complete && x.bar.total !== undefined && !close(known, x.bar.total)) checks.push({ ok: false, detail: tr(`${x.bar.label ?? x.bar.id} 各段之和是 ${u(known)}，不是 ${u(x.bar.total)}`, `The parts of ${x.bar.label ?? x.bar.id} add up to ${u(known)}, not ${u(x.bar.total)}`) });
    }
    for (const p of x.bar.parts) {
      if (p.units !== undefined && p.value !== undefined && unit !== null && !close(p.units * unit, p.value)) checks.push({ ok: false, detail: tr(`${p.label ?? p.id}：${fmtNum(p.units)} 份应为 ${u(p.units * unit)}，图上写的是 ${u(p.value)}`, `${p.label ?? p.id}: ${fmtNum(p.units)} units should be ${u(p.units * unit)}, the figure says ${u(p.value)}`) });
    }
    if (x.bar.units !== undefined && !x.free && x.V === 0 && !close(x.U, x.bar.units)) checks.push({ ok: false, detail: tr(`${x.bar.label ?? x.bar.id} 应分成 ${fmtNum(x.bar.units)} 份，各段份数之和是 ${fmtNum(x.U)}`, `${x.bar.label ?? x.bar.id} should have ${fmtNum(x.bar.units)} units; its parts have ${fmtNum(x.U)}`) });
  }
  const relations: Record<string, number | null> = {};
  for (const r of b.relations ?? []) {
    const vals = r.bars.map((bid) => bars[bid] ?? null);
    const v = vals.some((x) => x === null) ? null : r.type === "sum" ? (vals as number[]).reduce((s, x) => s + x, 0) : (vals[0] as number) - (vals[1] as number);
    relations[r.id] = v;
    if (v !== null && r.value !== undefined && !close(v, r.value)) checks.push({ ok: false, detail: tr(`${r.label ?? r.id}：按图算是 ${u(v)}，题目给的是 ${u(r.value)}`, `${r.label ?? r.id}: the figure gives ${u(v)}, the problem says ${u(r.value)}`) });
  }
  if (b.ask) {
    const v = b.ask in parts ? parts[b.ask] : b.ask in bars ? bars[b.ask] : b.ask in relations ? relations[b.ask] : undefined;
    if (v === undefined) throw new StrategyError(tr(`ask 指向不存在的编号 ${b.ask}`, `ask names an unknown id ${b.ask}`));
    if (v === null) checks.push({ ok: false, detail: tr("图中的数据求不出所问的量", "The figure's data do not determine what is asked") });
    else if (b.answer !== undefined) checks.push(close(v, b.answer) ? { ok: true, detail: tr(`所求 = ${u(v)}，与答案一致`, `What is asked = ${u(v)}, matching the answer`) } : { ok: false, detail: tr(`按图算出所求是 ${u(v)}，答案写的是 ${u(b.answer)}`, `The figure gives ${u(v)} for what is asked, but the answer says ${u(b.answer)}`) });
    else checks.push({ ok: true, detail: tr(`所求 = ${u(v)}`, `What is asked = ${u(v)}`) });
  }
  return { solved: { type: "bar_model", unit, parts, bars, relations }, checks };
}

function solveNumberLine(n: NumberLine, tr: Tr): StrategyCheck[] {
  const checks: StrategyCheck[] = [];
  if (!(n.max > n.min)) throw new StrategyError(tr("数轴的 max 必须大于 min", "The number line's max must be greater than its min"));
  const out = [...n.points.map((p) => p.value), ...n.jumps.flatMap((j) => [j.from, j.to]), ...n.spans.flatMap((s) => [s.from, s.to])].filter((v) => v < n.min - EPS || v > n.max + EPS);
  if (out.length) checks.push({ ok: false, detail: tr(`${fmtNum(out[0])} 不在数轴范围 ${fmtNum(n.min)}–${fmtNum(n.max)} 内`, `${fmtNum(out[0])} is outside the line's range ${fmtNum(n.min)}–${fmtNum(n.max)}`) });
  for (const j of n.jumps) {
    if (j.delta !== undefined && !close(j.to - j.from, j.delta)) checks.push({ ok: false, detail: tr(`跳跃 ${j.label ?? j.id}：从 ${fmtNum(j.from)} 到 ${fmtNum(j.to)} 是 ${fmtNum(j.to - j.from)}，不是 ${fmtNum(j.delta)}`, `Jump ${j.label ?? j.id}: from ${fmtNum(j.from)} to ${fmtNum(j.to)} is ${fmtNum(j.to - j.from)}, not ${fmtNum(j.delta)}`) });
  }
  if (n.jumps.length && n.jumps.every((j) => j.delta === undefined || close(j.to - j.from, j.delta))) checks.push({ ok: true, detail: tr(`${n.jumps.length} 次跳跃的长度都正确`, `All ${n.jumps.length} jumps have the right size`) });
  if (n.ask) {
    const p = n.points.find((q) => q.id === n.ask);
    if (!p) throw new StrategyError(tr(`ask 指向不存在的点 ${n.ask}`, `ask names an unknown point ${n.ask}`));
    if (n.answer !== undefined) checks.push(close(p.value, n.answer) ? { ok: true, detail: tr(`所求点在 ${fmtNum(p.value)}，与答案一致`, `The asked point is at ${fmtNum(p.value)}, matching the answer`) } : { ok: false, detail: tr(`所求点在 ${fmtNum(p.value)}，答案写的是 ${fmtNum(n.answer)}`, `The asked point is at ${fmtNum(p.value)}, but the answer says ${fmtNum(n.answer)}`) });
  }
  return checks;
}

function solveProbTree(t: ProbTree, tr: Tr): { solved: Extract<StrategySolved, { type: "prob_tree" }>; checks: StrategyCheck[] } {
  const checks: StrategyCheck[] = [];
  const leaves: Array<{ path: string[]; ids: string[]; p: string; f: Frac }> = [];
  const seen = new Set<string>();
  const bad: string[] = [];
  const walk = (nodes: ProbNode[], path: string[], ids: string[], acc: Frac, depth: number) => {
    if (depth > 3) throw new StrategyError(tr("概率树最多 3 层", "A probability tree has at most 3 levels"));
    let sum: Frac = { n: 0, d: 1 };
    for (const nd of nodes) {
      if (seen.has(nd.id)) throw new StrategyError(tr(`编号 ${nd.id} 重复`, `Duplicate id ${nd.id}`));
      seen.add(nd.id);
      const p = parseProb(nd.p);
      if (!p || p.n < 0 || p.n > p.d) throw new StrategyError(tr(`${nd.label} 的概率 “${nd.p}” 不是 0 到 1 之间的数`, `The probability “${nd.p}” of ${nd.label} is not a number from 0 to 1`));
      sum = fAdd(sum, p);
      const here = fMul(acc, p);
      if (nd.children?.length) walk(nd.children, [...path, nd.label], [...ids, nd.id], here, depth + 1);
      else leaves.push({ path: [...path, nd.label], ids: [...ids, nd.id], p: fStr(here), f: here });
    }
    if (sum.n !== sum.d) bad.push(`${path.length ? path.join(" → ") + " → " : ""}{${nodes.map((x) => x.label).join(", ")}} = ${fStr(sum)}`);
  };
  walk(t.children, [], [], { n: 1, d: 1 }, 1);
  checks.push(bad.length ? { ok: false, detail: tr(`每个分叉的概率之和应为 1：${bad.join("；")}`, `The branches of each fork must add up to 1: ${bad.join("; ")}`) } : { ok: true, detail: tr("每个分叉的概率之和都是 1", "The branches of every fork add up to 1") });
  let event: Frac | null = null;
  if (t.ask?.length) {
    const leafIds = new Set(leaves.map((l) => l.ids[l.ids.length - 1]));
    const unknown = t.ask.filter((a) => !leafIds.has(a));
    if (unknown.length) throw new StrategyError(tr(`ask 里的 ${unknown.join("、")} 不是叶子`, `${unknown.join(", ")} in ask ${unknown.length === 1 ? "is not a leaf" : "are not leaves"}`));
    event = leaves.filter((l) => t.ask!.includes(l.ids[l.ids.length - 1])).reduce((s, l) => fAdd(s, l.f), { n: 0, d: 1 } as Frac);
    if (t.answer !== undefined) {
      const a = parseProb(t.answer);
      if (!a) checks.push({ ok: false, detail: tr(`答案 “${t.answer}” 不是概率`, `The answer “${t.answer}” is not a probability`) });
      else checks.push(a.n === event.n && a.d === event.d ? { ok: true, detail: tr(`所求概率 = ${fStr(event)}，与答案一致`, `The probability asked = ${fStr(event)}, matching the answer`) } : { ok: false, detail: tr(`按树算出概率是 ${fStr(event)}，答案写的是 ${fStr(a)}`, `The tree gives ${fStr(event)}, but the answer says ${fStr(a)}`) });
    } else checks.push({ ok: true, detail: tr(`所求概率 = ${fStr(event)}`, `The probability asked = ${fStr(event)}`) });
  }
  return { solved: { type: "prob_tree", leaves: leaves.map(({ path, ids, p }) => ({ path, ids, p })), event: event ? fStr(event) : null }, checks };
}

const CMP = /(<=|>=|!=|≠|≤|≥|==|=|<|>)/;
/** "2c + 4r = 28" → a test on a scope (exact up to 1e-9 for =). */
export function compileCondition(src: string, vars: string[]): (s: Scope) => boolean {
  const parts = src.split(CMP);
  if (parts.length !== 3) throw new ExprError(`条件需要恰好一个比较符号: ${src}`);
  const [l, op, r] = parts;
  const L = compileExprVars(l, vars);
  const R = compileExprVars(r, vars);
  return (s) => {
    const a = L(s);
    const b = R(s);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    switch (op) {
      case "=":
      case "==":
        return Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
      case "!=":
      case "≠":
        return Math.abs(a - b) >= 1e-9;
      case "<":
        return a < b - 1e-12;
      case ">":
        return a > b + 1e-12;
      case "<=":
      case "≤":
        return a <= b + 1e-12;
      default:
        return a >= b - 1e-12;
    }
  };
}

function solveEnumTable(e: EnumTable, tr: Tr): { solved: Extract<StrategySolved, { type: "enum_table" }>; checks: StrategyCheck[] } {
  const names = [...e.vars.map((v) => v.id), ...e.columns.map((c) => c.id)];
  if (new Set(names).size !== names.length) throw new StrategyError(tr("变量和列的名字不能重复", "Variable and column names must be different"));
  const ranges = e.vars.map((v) => {
    const st = v.step ?? 1;
    if (v.to < v.from) throw new StrategyError(tr(`${v.label} 的范围 from > to`, `The range of ${v.label} has from > to`));
    const n = Math.floor((v.to - v.from) / st + 1e-9) + 1;
    if (n > 200) throw new StrategyError(tr(`${v.label} 要试的值太多（${n} 个）`, `Too many values to try for ${v.label} (${n})`));
    return Array.from({ length: n }, (_, i) => Math.round((v.from + i * st) * 1e9) / 1e9);
  });
  let cols: Array<(s: Scope) => number>;
  let conds: Array<(s: Scope) => boolean>;
  try {
    cols = e.columns.map((c) => compileExprVars(c.expr, names));
    conds = e.conditions.map((c) => compileCondition(c, names));
  } catch (err) {
    throw new StrategyError(tr(`表达式有误：${(err as Error).message}`, `Bad expression: ${(err as Error).message}`));
  }
  const rows: Array<{ values: number[]; ok: boolean }> = [];
  const combos = e.vars.length === 1 ? ranges[0].map((a) => [a]) : ranges[0].flatMap((a) => ranges[1].map((b) => [a, b]));
  for (const combo of combos) {
    const s: Scope = {};
    e.vars.forEach((v, i) => (s[v.id] = combo[i]));
    const derived = e.columns.map((c, i) => {
      const val = cols[i](s);
      s[c.id] = val;
      return val;
    });
    rows.push({ values: [...combo, ...derived], ok: conds.every((f) => f(s)) });
  }
  const matching = rows.filter((r) => r.ok);
  const show = e.show ?? (rows.length <= 16 ? "all" : "matching");
  const shown = (show === "all" ? rows : matching).slice(0, 40);
  const checks: StrategyCheck[] = [{ ok: true, detail: tr(`试了 ${rows.length} 种情况，符合条件的有 ${matching.length} 种`, `Tried ${rows.length} cases; ${matching.length} meet the conditions`) }];
  if (e.answer_count !== undefined) checks.push(e.answer_count === matching.length ? { ok: true, detail: tr("个数与答案一致", "The count matches the answer") } : { ok: false, detail: tr(`列表找到 ${matching.length} 种，答案写的是 ${e.answer_count} 种`, `The table finds ${matching.length}, but the answer says ${e.answer_count}`) });
  if (e.answer_row) {
    const want = e.answer_row;
    const idx = (k: string) => names.indexOf(k);
    const bad = Object.keys(want).filter((k) => idx(k) < 0);
    if (bad.length) throw new StrategyError(tr(`answer_row 里的 ${bad.join("、")} 不是变量或列`, `${bad.join(", ")} in answer_row ${bad.length === 1 ? "is not a variable or column" : "are not variables or columns"}`));
    const hit = matching.filter((r) => Object.entries(want).every(([k, v]) => close(r.values[idx(k)], v)));
    checks.push(
      matching.length === 1 && hit.length === 1
        ? { ok: true, detail: tr("唯一符合条件的一行就是答案", "The only row that meets the conditions is the answer") }
        : hit.length
          ? { ok: false, detail: tr(`答案那一行符合条件，但共有 ${matching.length} 行符合，答案不唯一`, `The answer's row meets the conditions, but ${matching.length} rows do, so it is not the only answer`) }
          : { ok: false, detail: tr(`答案（${Object.entries(want).map(([k, v]) => `${k} = ${fmtNum(v)}`).join("，")}）不符合条件`, `The answer (${Object.entries(want).map(([k, v]) => `${k} = ${fmtNum(v)}`).join(", ")}) does not meet the conditions`) },
    );
  }
  return {
    solved: { type: "enum_table", rows: shown, header: [...e.vars.map((v) => v.label), ...e.columns.map((c) => c.label)], tried: rows.length, matching: matching.length, truncated: shown.length < (show === "all" ? rows : matching).length },
    checks,
  };
}

function solveGraph(g: GraphExplore, tr: Tr): StrategyCheck[] {
  const checks: StrategyCheck[] = [];
  if (!(g.x[1] > g.x[0]) || !(g.y[1] > g.y[0])) throw new StrategyError(tr("坐标范围必须是从小到大", "Axis ranges must go from low to high"));
  const vars = g.param ? [g.param.id] : [];
  const p0 = g.param ? (g.param.start ?? g.param.min) : 0;
  const fns = new Map<string, (x: number) => number>();
  try {
    for (const f of g.functions) {
      const c = compileExprVars(f.expr, vars);
      fns.set(f.id, (x) => c({ x, ...(g.param ? { [g.param.id]: p0 } : {}) }));
    }
    for (const r of g.readouts) compileExprVars(r.expr, vars);
  } catch (e) {
    throw new StrategyError(tr(`表达式有误：${(e as Error).message}`, `Bad expression: ${(e as Error).message}`));
  }
  if (g.param && !(g.param.max > g.param.min)) throw new StrategyError(tr("滑块的 max 必须大于 min", "The slider's max must be greater than its min"));
  if (g.tracer && !fns.has(g.tracer.fn)) throw new StrategyError(tr(`tracer 指向不存在的函数 ${g.tracer.fn}`, `tracer names an unknown function ${g.tracer.fn}`));
  if (g.optimum) {
    const f = fns.get(g.optimum.fn);
    if (!f) throw new StrategyError(tr(`optimum 指向不存在的函数 ${g.optimum.fn}`, `optimum names an unknown function ${g.optimum.fn}`));
    const [a, b] = g.param && g.tracer?.fn === g.optimum.fn ? [g.param.min, g.param.max] : g.x;
    let best = { x: a, y: f(a) };
    const N = 4000;
    for (let i = 0; i <= N; i++) {
      const x = a + ((b - a) * i) / N;
      const y = f(x);
      if (!Number.isFinite(y)) continue;
      if (!Number.isFinite(best.y) || (g.optimum.kind === "max" ? y > best.y : y < best.y)) best = { x, y };
    }
    const tol = Math.max(1e-3, 1e-3 * Math.abs(best.y));
    const yClaim = f(g.optimum.x);
    const word = g.optimum.kind === "max" ? tr("最大值", "maximum") : tr("最小值", "minimum");
    if (!close(yClaim, g.optimum.y) && Math.abs(yClaim - g.optimum.y) > tol) checks.push({ ok: false, detail: tr(`x = ${fmtNum(g.optimum.x)} 时函数值是 ${fmtNum(yClaim)}，不是 ${fmtNum(g.optimum.y)}`, `At x = ${fmtNum(g.optimum.x)} the function is ${fmtNum(yClaim)}, not ${fmtNum(g.optimum.y)}`) });
    else if (Math.abs(best.y - g.optimum.y) > tol) checks.push({ ok: false, detail: tr(`在 ${fmtNum(a)} 到 ${fmtNum(b)} 上${word}约为 ${fmtNum(best.y)}（x ≈ ${fmtNum(best.x)}），不是 ${fmtNum(g.optimum.y)}`, `On ${fmtNum(a)} to ${fmtNum(b)} the ${word} is about ${fmtNum(best.y)} (x ≈ ${fmtNum(best.x)}), not ${fmtNum(g.optimum.y)}`) });
    else checks.push({ ok: true, detail: tr(`${word} ${fmtNum(g.optimum.y)}（x = ${fmtNum(g.optimum.x)}）已核对`, `The ${word} ${fmtNum(g.optimum.y)} (x = ${fmtNum(g.optimum.x)}) is checked`) });
  }
  for (const it of g.intersections) {
    const [f, h] = it.fns.map((n) => fns.get(n));
    if (!f || !h) throw new StrategyError(tr(`交点引用了不存在的函数 ${it.fns.join("、")}`, `An intersection names an unknown function ${it.fns.join(", ")}`));
    const a = f(it.x);
    const b = h(it.x);
    checks.push(Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(a)) ? { ok: true, detail: tr(`x = ${fmtNum(it.x)} 处两图像相交（y = ${fmtNum(a)}）`, `The graphs meet at x = ${fmtNum(it.x)} (y = ${fmtNum(a)})`) } : { ok: false, detail: tr(`x = ${fmtNum(it.x)} 处两函数值是 ${fmtNum(a)} 和 ${fmtNum(b)}，不相交`, `At x = ${fmtNum(it.x)} the functions are ${fmtNum(a)} and ${fmtNum(b)}; they do not meet`) });
  }
  return checks;
}

export function solveStrategy(spec: StrategySpec, tr: Tr = zhOnly): { solved: StrategySolved; checks: StrategyCheck[] } {
  switch (spec.type) {
    case "bar_model":
      return solveBarModel(spec, tr);
    case "number_line":
      return { solved: { type: "number_line" }, checks: solveNumberLine(spec, tr) };
    case "prob_tree":
      return solveProbTree(spec, tr);
    case "enum_table":
      return solveEnumTable(spec, tr);
    case "graph_explore":
      return { solved: { type: "graph_explore" }, checks: solveGraph(spec, tr) };
  }
}

/** Solution steps that change the picture (elements appear / values are revealed) — for the step buttons. */
export function strategySteps(spec: StrategySpec): number[] {
  const s = new Set<number>();
  const add = (v?: number) => v && s.add(v);
  switch (spec.type) {
    case "bar_model":
      spec.bars.forEach((b) => {
        add(b.from_step);
        b.parts.forEach((p) => (add(p.from_step), add(p.reveal_step)));
      });
      spec.relations?.forEach((r) => (add(r.from_step), add(r.reveal_step)));
      break;
    case "number_line":
      spec.points.forEach((p) => (add(p.from_step), add(p.reveal_step)));
      spec.jumps.forEach((j) => add(j.from_step));
      spec.spans.forEach((j) => add(j.from_step));
      break;
    case "prob_tree": {
      const walk = (ns: ProbNode[]) => ns.forEach((n) => (add(n.from_step), n.children && walk(n.children)));
      walk(spec.children);
      break;
    }
    case "enum_table":
      spec.columns.forEach((c) => add(c.from_step));
      break;
    case "graph_explore":
      spec.functions.forEach((f) => add(f.from_step));
      add(spec.optimum?.from_step);
      spec.intersections.forEach((i) => add(i.from_step));
      break;
  }
  return [...s].sort((a, b) => a - b);
}
