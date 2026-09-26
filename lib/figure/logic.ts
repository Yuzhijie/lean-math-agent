/**
 * Logic-puzzle diagrams for K-12 problems, built the same way as geometry
 * figures: the model only describes the puzzle's structure (who/what, the
 * stated conditions, the claimed answer); the program solves it
 * exhaustively, checks the answer and uniqueness, and the renderer draws it.
 *
 *   grid      — matching puzzles (甲乙丙分别是医生、教师、律师…): logic grid
 *               with ✓ / ✗ derived from ALL solutions of the conditions
 *   venn      — set counting (喜欢语文的有…, 两样都喜欢的有…): 2–3 set
 *               Venn diagram with every region solved from the data
 *   ordering  — line-ups and seating (排成一排, 围坐一圈, 相邻, 左边…)
 *   tree      — enumeration (搭配, 有多少种): tree diagram, leaves counted
 */
import { z } from "zod";

const name = z.string().min(1).max(12);

// ── Schemas ────────────────────────────────────────────────────────────

const gridConstraint = z.discriminatedUnion("type", [
  /** a and b belong together (same row), e.g. 甲 is 医生. */
  z.object({ type: z.literal("is"), a: name, b: name }),
  z.object({ type: z.literal("is_not"), a: name, b: name }),
  /** a belongs together with one of options. */
  z.object({ type: z.literal("one_of"), a: name, options: z.array(name).min(2) }),
]);

export const logicGridSchema = z.object({
  type: z.literal("grid"),
  /** First category = rows (usually the people); every category has the same number of items. */
  categories: z.array(z.object({ name: name, items: z.array(name).min(2).max(6) })).min(2).max(4),
  constraints: z.array(gridConstraint).max(40),
  /** Claimed answer: row item → its items in the other categories, in category order. */
  answer: z.record(z.array(name)).optional(),
  /** Conditions of the problem that could not be expressed with the constraint types. */
  unencoded: z.array(z.string().max(120)).max(10).optional(),
});

export const vennSchema = z.object({
  type: z.literal("venn"),
  sets: z.array(z.object({ id: z.string().regex(/^[A-C]$/), label: z.string().max(16), total: z.number().int().nonnegative().optional() })).min(2).max(3),
  /** Given sizes of intersections, e.g. {sets:["A","B"], count: 5} = |A∩B| (inclusive). */
  intersections: z.array(z.object({ sets: z.array(z.string().regex(/^[A-C]$/)).min(2).max(3), count: z.number().int().nonnegative() })).default([]),
  /** Size of the whole group (universe), of the union, and of those in none of the sets. */
  universe: z.number().int().nonnegative().optional(),
  union: z.number().int().nonnegative().optional(),
  neither: z.number().int().nonnegative().optional(),
  /** What is asked: "A∩B", "A∪B", "A", "only A", "neither", "exactly one", "exactly two". */
  ask: z.string().max(24).optional(),
  answer: z.number().optional(),
  universe_label: z.string().max(16).optional(),
});

const orderingConstraint = z.discriminatedUnion("type", [
  /** 1-based position (row: from the left end; circle: seat number). */
  z.object({ type: z.literal("position"), a: name, pos: z.number().int().min(1) }),
  z.object({ type: z.literal("not_position"), a: name, pos: z.number().int().min(1) }),
  /** a is somewhere left of b (row only). */
  z.object({ type: z.literal("left_of"), a: name, b: name }),
  /** a is directly left of b (row), or directly clockwise-before b (circle). */
  z.object({ type: z.literal("immediately_left_of"), a: name, b: name }),
  z.object({ type: z.literal("adjacent"), a: name, b: name }),
  z.object({ type: z.literal("not_adjacent"), a: name, b: name }),
  /** a stands between b and c (row, not necessarily adjacent). */
  z.object({ type: z.literal("between"), a: name, b: name, c: name }),
  /** a stands at one of the two ends (row). */
  z.object({ type: z.literal("at_end"), a: name }),
  z.object({ type: z.literal("not_at_end"), a: name }),
  /** Circle: a sits directly opposite b (even number of seats). */
  z.object({ type: z.literal("opposite"), a: name, b: name }),
]);

export const orderingSchema = z.object({
  type: z.literal("ordering"),
  layout: z.enum(["row", "circle"]),
  items: z.array(name).min(2).max(8),
  constraints: z.array(orderingConstraint).max(30),
  /** Claimed order: row left→right, circle clockwise from any seat. */
  answer: z.array(name).optional(),
  /** Labels for the two ends of a row, e.g. ["左", "右"] or ["前", "后"]. */
  ends: z.tuple([z.string().max(6), z.string().max(6)]).optional(),
  /** For counting questions (有多少种排法): the claimed number of arrangements. Without it, a unique arrangement is expected. */
  count: z.number().int().nonnegative().optional(),
  unencoded: z.array(z.string().max(120)).max(10).optional(),
});

export const treeSchema = z.object({
  type: z.literal("tree"),
  /** One level per choice, e.g. [{label:"上衣", options:["红","蓝"]}, {label:"裤子", options:["黑","白","灰"]}]. */
  levels: z.array(z.object({ label: z.string().max(12), options: z.array(name).min(1).max(8) })).min(1).max(4),
  /** Choices at later levels may not repeat an earlier choice (arrangements from one pool). */
  distinct: z.boolean().optional(),
  /** Forbidden combinations: a path containing all of these options is dropped. */
  exclude: z.array(z.array(name).min(1)).max(10).optional(),
  answer: z.number().int().nonnegative().optional(),
});

export const logicSchema = z.discriminatedUnion("type", [logicGridSchema, vennSchema, orderingSchema, treeSchema]);

export type LogicSpec = z.infer<typeof logicSchema>;
export type LogicGrid = z.infer<typeof logicGridSchema>;
export type Venn = z.infer<typeof vennSchema>;
export type Ordering = z.infer<typeof orderingSchema>;
export type Tree = z.infer<typeof treeSchema>;

export class LogicError extends Error {}

export interface LogicCheck {
  ok: boolean;
  detail: string;
}

/** Solved logic diagram, JSON-serialisable (stored on the session, rendered in the browser). */
export type LogicSolved =
  | {
      type: "grid";
      /** cells[row][category-1][item]: 1 = ✓ in every solution, -1 = ✗ in every solution, 0 = undetermined. */
      cells: number[][][];
      solutions: number;
    }
  | {
      type: "venn";
      /** Region counts keyed "A", "B", "AB", "ABC", …, and "none"; null = not determined by the data. */
      regions: Record<string, number | null>;
      asked?: number | null;
    }
  | {
      type: "ordering";
      solutions: number;
      /** Arrangements that differ as answers (circle without direction: mirror images counted once). */
      distinct?: number;
      mirror?: boolean;
      /** One valid arrangement (the first found), or undefined when there is none. */
      sample?: string[];
      /** Position index → item when every solution agrees (row), else null. */
      fixed: (string | null)[];
    }
  | {
      type: "tree";
      /** Root-to-leaf paths (truncated for drawing). */
      paths: string[][];
      count: number;
      truncated: boolean;
    };

// ── Grid ───────────────────────────────────────────────────────────────

function permutations(n: number): number[][] {
  const out: number[][] = [];
  const a = [...Array(n).keys()];
  const rec = (k: number) => {
    if (k === n) {
      out.push([...a]);
      return;
    }
    for (let i = k; i < n; i++) {
      [a[k], a[i]] = [a[i], a[k]];
      rec(k + 1);
      [a[k], a[i]] = [a[i], a[k]];
    }
  };
  rec(0);
  return out;
}

export function solveGrid(g: LogicGrid): { solved: Extract<LogicSolved, { type: "grid" }>; checks: LogicCheck[]; solutions: number[][][] } {
  const n = g.categories[0].items.length;
  const where = new Map<string, [number, number]>(); // item → [category, index]
  g.categories.forEach((c, ci) => {
    if (c.items.length !== n) throw new LogicError(`「${c.name}」有 ${c.items.length} 项，应与「${g.categories[0].name}」一样是 ${n} 项`);
    c.items.forEach((it, ii) => {
      if (where.has(it)) throw new LogicError(`名称「${it}」重复出现，请给每一项不同的名字`);
      where.set(it, [ci, ii]);
    });
  });
  const locate = (x: string) => {
    const w = where.get(x);
    if (!w) throw new LogicError(`条件中的「${x}」不在任何类别中`);
    return w;
  };
  // An assignment maps each category to a permutation: perm[c][rowIndex] = item index in category c (category 0 is identity).
  const rowOf = (perm: number[][], [c, i]: [number, number]) => (c === 0 ? i : perm[c].indexOf(i));
  const checks = g.constraints.map((k) => {
    switch (k.type) {
      case "is": {
        const a = locate(k.a);
        const b = locate(k.b);
        if (a[0] === b[0]) throw new LogicError(`「${k.a}」和「${k.b}」属于同一类别，不能「是」对方`);
        return { cats: [a[0], b[0]], test: (p: number[][]) => rowOf(p, a) === rowOf(p, b) };
      }
      case "is_not": {
        const a = locate(k.a);
        const b = locate(k.b);
        if (a[0] === b[0]) return { cats: [], test: () => true };
        return { cats: [a[0], b[0]], test: (p: number[][]) => rowOf(p, a) !== rowOf(p, b) };
      }
      case "one_of": {
        const a = locate(k.a);
        const opts = k.options.map(locate);
        return { cats: [a[0], ...opts.map((o) => o[0])], test: (p: number[][]) => opts.some((o) => rowOf(p, a) === rowOf(p, o)) };
      }
    }
  });
  const perms = permutations(n);
  const K = g.categories.length;
  const solutions: number[][][] = [];
  const perm: number[][] = [[...Array(n).keys()]];
  const rec = (c: number) => {
    if (solutions.length > 5000) return;
    if (c === K) {
      solutions.push(perm.map((p) => [...p]));
      return;
    }
    for (const p of perms) {
      perm[c] = p;
      // Check constraints whose categories are all assigned now (and involve c).
      const ok = checks.every((ch) => !ch.cats.includes(c) || ch.cats.some((x) => x > c) || ch.test(perm));
      if (ok) rec(c + 1);
    }
    perm.length = c;
  };
  rec(1);

  const cells: number[][][] = g.categories[0].items.map(() => g.categories.slice(1).map((cat) => cat.items.map(() => 0)));
  for (let r = 0; r < n; r++) {
    for (let c = 1; c < K; c++) {
      for (let i = 0; i < n; i++) {
        if (solutions.length === 0) continue;
        const inAll = solutions.every((s) => s[c][r] === i);
        const inNone = solutions.every((s) => s[c][r] !== i);
        cells[r][c - 1][i] = inAll ? 1 : inNone ? -1 : 0;
      }
    }
  }
  const out: LogicCheck[] = [];
  out.push(
    solutions.length === 0
      ? { ok: false, detail: "按给出的条件无解（条件有矛盾或编码有误）" }
      : solutions.length === 1
        ? { ok: true, detail: "条件确定唯一解" }
        : { ok: false, detail: `条件有 ${solutions.length > 5000 ? "5000+" : solutions.length} 种解，尚不能唯一确定` },
  );
  if (g.answer && solutions.length === 1) {
    const s = solutions[0];
    const wrong: string[] = [];
    for (const [row, vals] of Object.entries(g.answer)) {
      const r = g.categories[0].items.indexOf(row);
      if (r < 0) {
        wrong.push(`答案中的「${row}」不是「${g.categories[0].name}」`);
        continue;
      }
      vals.forEach((v, j) => {
        const cat = g.categories[j + 1];
        if (!cat) return;
        const expected = cat.items[s[j + 1][r]];
        if (expected !== v) wrong.push(`${row}：推出是「${expected}」，答案写的是「${v}」`);
      });
    }
    out.push(wrong.length ? { ok: false, detail: `答案与推理不符：${wrong.join("；")}` } : { ok: true, detail: "答案与推理结果一致" });
  }
  if (g.unencoded?.length) out.push({ ok: false, detail: `以下条件未能自动校验：${g.unencoded.join("；")}` });
  return { solved: { type: "grid", cells, solutions: solutions.length }, checks: out, solutions };
}

// ── Venn ───────────────────────────────────────────────────────────────

const REGIONS: Record<2 | 3, string[]> = {
  2: ["A", "B", "AB", "none"],
  3: ["A", "B", "C", "AB", "AC", "BC", "ABC", "none"],
};

/** Solve a small linear system A x = b (least squares via normal equations + Gauss); returns determined components. */
function solveLinear(A: number[][], b: number[], nVars: number): { x: (number | null)[]; consistent: boolean } {
  // Row-reduce the augmented matrix; a variable is determined when its pivot row has no free variables.
  const M = A.map((row, i) => [...row, b[i]]);
  const pivots: number[] = [];
  let r = 0;
  for (let c = 0; c < nVars && r < M.length; c++) {
    let p = r;
    while (p < M.length && Math.abs(M[p][c]) < 1e-9) p++;
    if (p === M.length) continue;
    [M[r], M[p]] = [M[p], M[r]];
    const pv = M[r][c];
    for (let j = c; j <= nVars; j++) M[r][j] /= pv;
    for (let i = 0; i < M.length; i++) {
      if (i === r || Math.abs(M[i][c]) < 1e-12) continue;
      const f = M[i][c];
      for (let j = c; j <= nVars; j++) M[i][j] -= f * M[r][j];
    }
    pivots[r] = c;
    r++;
  }
  const consistent = M.slice(r).every((row) => Math.abs(row[nVars]) < 1e-6);
  const x: (number | null)[] = Array(nVars).fill(null);
  for (let i = 0; i < r; i++) {
    const c = pivots[i];
    const free = M[i].slice(0, nVars).some((v, j) => j !== c && Math.abs(v) > 1e-9);
    if (!free) x[c] = M[i][nVars];
  }
  return { x, consistent };
}

function regionHas(region: string, set: string): boolean {
  return region !== "none" && region.includes(set);
}

/** Value of an asked expression from region counts, or null when not determined. */
/** The asked quantity in words, e.g. "neither" → "都不…的" / "in none of the sets". */
export function vennAskLabel(ask: string, sets: { id: string; label: string }[], en = false): string {
  const name = (id: string) => sets.find((s) => s.id === id)?.label ?? id;
  const q = ask.replace(/\s+/g, "").replace(/只|仅/g, "only").replace(/都不|none|neither/gi, "none").replace(/∩/g, "&").replace(/∪/g, "|");
  if (q === "none") return en ? "in none" : "都不…的";
  if (/^exactly(one|1)$|^恰好一/.test(q)) return en ? "in exactly one" : "恰好一项的";
  if (/^exactly(two|2)$|^恰好两/.test(q)) return en ? "in exactly two" : "恰好两项的";
  if (/^only[A-C]$/.test(q)) return en ? `only ${name(q.slice(4))}` : `只${name(q.slice(4))}的`;
  if (/^[A-C](&[A-C])+$/.test(q)) return en ? `${q.split("&").map(name).join(" and ")}` : `${q.split("&").map(name).join("、")}都…的`;
  if (/^[A-C]\|[A-C](\|[A-C])*$/.test(q)) return en ? "in at least one" : "至少一项的";
  if (/^[A-C]$/.test(q)) return en ? name(q) : `${name(q)}的`;
  return ask;
}

export function vennAsk(ask: string, ids: string[], regions: Record<string, number | null>): number | null {
  const q = ask.replace(/\s+/g, "").replace(/只|仅/g, "only").replace(/都不|none|neither/gi, "none").replace(/∩/g, "&").replace(/∪/g, "|");
  let keys: string[];
  const all = REGIONS[ids.length as 2 | 3];
  if (q === "none") keys = ["none"];
  else if (/^exactly(one|1)$|^恰好一/.test(q)) keys = all.filter((k) => k !== "none" && k.length === 1);
  else if (/^exactly(two|2)$|^恰好两/.test(q)) keys = all.filter((k) => k !== "none" && k.length === 2);
  else if (/^only[A-C]$/.test(q)) keys = [q.slice(4)];
  else if (/^[A-C](&[A-C])+$/.test(q)) {
    const sets = q.split("&");
    keys = all.filter((k) => sets.every((s) => regionHas(k, s)));
  } else if (/^[A-C](\|[A-C])*$/.test(q)) {
    const sets = q.split("|");
    keys = all.filter((k) => sets.some((s) => regionHas(k, s)));
  } else return null;
  let sum = 0;
  for (const k of keys) {
    const v = regions[k];
    if (v === null || v === undefined) return null;
    sum += v;
  }
  return sum;
}

export function solveVenn(v: Venn): { solved: Extract<LogicSolved, { type: "venn" }>; checks: LogicCheck[] } {
  const ids = v.sets.map((s) => s.id);
  if (new Set(ids).size !== ids.length || ids.some((id, i) => id !== "ABC"[i])) throw new LogicError("维恩图的集合 id 依次为 A、B（、C）");
  const regs = REGIONS[ids.length as 2 | 3];
  const rows: number[][] = [];
  const rhs: number[] = [];
  const eq = (pred: (r: string) => boolean, value: number) => {
    rows.push(regs.map((r) => (pred(r) ? 1 : 0)));
    rhs.push(value);
  };
  for (const s of v.sets) if (s.total !== undefined) eq((r) => regionHas(r, s.id), s.total);
  for (const it of v.intersections) {
    if (it.sets.some((s) => !ids.includes(s))) throw new LogicError(`交集引用了不存在的集合 ${it.sets.join("∩")}`);
    eq((r) => it.sets.every((s) => regionHas(r, s)), it.count);
  }
  if (v.universe !== undefined) eq(() => true, v.universe);
  if (v.union !== undefined) eq((r) => r !== "none", v.union);
  if (v.neither !== undefined) eq((r) => r === "none", v.neither);
  // With no information about "none" and no universe, the outside region is simply not shown.
  const { x, consistent } = rows.length ? solveLinear(rows, rhs, regs.length) : { x: regs.map(() => null), consistent: true };
  const regions: Record<string, number | null> = {};
  regs.forEach((r, i) => (regions[r] = x[i] === null ? null : Math.round(x[i]! * 1e6) / 1e6));
  const checks: LogicCheck[] = [];
  if (!consistent) checks.push({ ok: false, detail: "给出的人数互相矛盾" });
  const bad = Object.entries(regions).filter(([, n]) => n !== null && (n < -1e-9 || Math.abs(n - Math.round(n)) > 1e-6));
  if (bad.length) checks.push({ ok: false, detail: `有区域人数不是非负整数：${bad.map(([k, n]) => `${k}=${n}`).join("，")}` });
  const undetermined = regs.filter((r) => regions[r] === null && !(r === "none" && v.universe === undefined && v.neither === undefined));
  if (consistent && !bad.length) checks.push(undetermined.length ? { ok: false, detail: `数据不足以确定每个区域（${undetermined.length} 个区域未定）` } : { ok: true, detail: "每个区域的人数都由条件唯一确定，且为非负整数" });
  let asked: number | null | undefined;
  if (v.ask) {
    asked = vennAsk(v.ask, ids, regions);
    if (v.answer !== undefined) {
      checks.push(
        asked === null
          ? { ok: false, detail: `无法从条件算出「${v.ask}」` }
          : Math.abs(asked - v.answer) < 1e-6
            ? { ok: true, detail: `「${v.ask}」= ${asked}，与答案一致` }
            : { ok: false, detail: `「${v.ask}」应为 ${asked}，答案写的是 ${v.answer}` },
      );
    }
  }
  return { solved: { type: "venn", regions, asked }, checks };
}

// ── Ordering ───────────────────────────────────────────────────────────

export function solveOrdering(o: Ordering): { solved: Extract<LogicSolved, { type: "ordering" }>; checks: LogicCheck[] } {
  const n = o.items.length;
  if (new Set(o.items).size !== n) throw new LogicError("排序的对象名称有重复");
  const idx = (x: string) => {
    const i = o.items.indexOf(x);
    if (i < 0) throw new LogicError(`条件中的「${x}」不在排序对象中`);
    return i;
  };
  const circle = o.layout === "circle";
  // pos[item] = seat index
  const tests = o.constraints.map((k): ((pos: number[]) => boolean) => {
    const d = (a: number, b: number) => {
      const t = Math.abs(a - b);
      return circle ? Math.min(t, n - t) : t;
    };
    switch (k.type) {
      case "position": {
        if (k.pos > n) throw new LogicError(`位置 ${k.pos} 超出了 ${n} 个位置`);
        const a = idx(k.a);
        return (p) => p[a] === k.pos - 1;
      }
      case "not_position": {
        const a = idx(k.a);
        return (p) => p[a] !== k.pos - 1;
      }
      case "left_of": {
        if (circle) throw new LogicError("围成一圈时没有「左边」的先后，请改用 adjacent / immediately_left_of");
        const a = idx(k.a);
        const b = idx(k.b);
        return (p) => p[a] < p[b];
      }
      case "immediately_left_of": {
        const a = idx(k.a);
        const b = idx(k.b);
        return (p) => (circle ? (p[a] + 1) % n === p[b] : p[a] + 1 === p[b]);
      }
      case "adjacent": {
        const a = idx(k.a);
        const b = idx(k.b);
        return (p) => d(p[a], p[b]) === 1;
      }
      case "not_adjacent": {
        const a = idx(k.a);
        const b = idx(k.b);
        return (p) => d(p[a], p[b]) !== 1;
      }
      case "between": {
        const a = idx(k.a);
        const b = idx(k.b);
        const c = idx(k.c);
        return (p) => (p[b] < p[a] && p[a] < p[c]) || (p[c] < p[a] && p[a] < p[b]);
      }
      case "at_end": {
        const a = idx(k.a);
        return (p) => p[a] === 0 || p[a] === n - 1;
      }
      case "not_at_end": {
        const a = idx(k.a);
        return (p) => p[a] !== 0 && p[a] !== n - 1;
      }
      case "opposite": {
        if (!circle || n % 2) throw new LogicError("「正对面」只适用于偶数个座位的圆桌");
        const a = idx(k.a);
        const b = idx(k.b);
        return (p) => d(p[a], p[b]) === n / 2;
      }
    }
  });
  const sols: number[][] = []; // seat → item
  for (const perm of permutations(n)) {
    // perm[seat] = item; circle: fix item 0 at seat 0 unless positions are given (seats are numbered then).
    if (circle && !o.constraints.some((k) => k.type === "position" || k.type === "not_position") && perm[0] !== 0) continue;
    const pos = Array(n);
    perm.forEach((item, seat) => (pos[item] = seat));
    if (tests.every((t) => t(pos))) sols.push(perm);
  }
  const fixed = [...Array(n).keys()].map((seat) => (sols.length && sols.every((s) => s[seat] === sols[0][seat]) ? o.items[sols[0][seat]] : null));
  const directed = o.constraints.some((k) => k.type === "immediately_left_of");
  // A seating puzzle without a direction is solved up to mirror image as well.
  const mirrorFree = circle && !directed && !o.constraints.some((k) => k.type === "position" || k.type === "not_position");
  const distinct = mirrorFree
    ? new Set(sols.map((s) => Math.min(Number(s.join("")), Number(s.map((_, k) => s[(n - k) % n]).join(""))))).size
    : sols.length;
  const checks: LogicCheck[] = [];
  if (o.count !== undefined) {
    checks.push(
      o.count === sols.length
        ? { ok: true, detail: `共 ${sols.length} 种排法，与答案一致` }
        : { ok: false, detail: `按条件共有 ${sols.length} 种排法，答案写的是 ${o.count} 种` },
    );
  } else {
    checks.push(
      sols.length === 0
        ? { ok: false, detail: "按给出的条件无法排列（条件有矛盾或编码有误）" }
        : distinct === 1
          ? { ok: true, detail: circle ? `条件确定唯一的座次（旋转${mirrorFree ? "、翻转" : ""}视为相同）` : "条件确定唯一的排列" }
          : { ok: false, detail: `条件允许 ${distinct} 种排列` },
    );
  }
  if (o.answer && sols.length) {
    const ans = o.answer.map(idx);
    const match = sols.some((s) => {
      if (!circle) return s.every((v, i) => v === ans[i]);
      // Circle: compare up to rotation (and reflection when no direction constraints are used).
      const rotations = (arr: number[]) => arr.map((_, r) => [...arr.slice(r), ...arr.slice(0, r)]);
      const cands = [...rotations(ans), ...(directed ? [] : rotations([...ans].reverse()))];
      return cands.some((c) => c.every((v, i) => v === s[i]));
    });
    checks.push(match ? { ok: true, detail: "答案满足全部条件" } : { ok: false, detail: "答案的排列不满足条件" });
  }
  if (o.unencoded?.length) checks.push({ ok: false, detail: `以下条件未能自动校验：${o.unencoded.join("；")}` });
  return { solved: { type: "ordering", solutions: sols.length, distinct, mirror: mirrorFree, sample: sols[0]?.map((i) => o.items[i]), fixed }, checks };
}

// ── Tree ───────────────────────────────────────────────────────────────

export function solveTree(t: Tree): { solved: Extract<LogicSolved, { type: "tree" }>; checks: LogicCheck[] } {
  const paths: string[][] = [];
  let count = 0;
  const rec = (level: number, path: string[]) => {
    if (level === t.levels.length) {
      if (t.exclude?.some((ex) => ex.every((v) => path.includes(v)))) return;
      count++;
      if (paths.length < 48) paths.push([...path]);
      return;
    }
    for (const opt of t.levels[level].options) {
      if (t.distinct && path.includes(opt)) continue;
      path.push(opt);
      rec(level + 1, path);
      path.pop();
    }
  };
  rec(0, []);
  const checks: LogicCheck[] = [{ ok: true, detail: `共 ${count} 种` }];
  if (t.answer !== undefined) checks.push(t.answer === count ? { ok: true, detail: "与答案一致" } : { ok: false, detail: `树状图数出 ${count} 种，答案写的是 ${t.answer} 种` });
  return { solved: { type: "tree", paths, count, truncated: count > paths.length }, checks };
}

export function solveLogic(spec: LogicSpec): { solved: LogicSolved; checks: LogicCheck[] } {
  switch (spec.type) {
    case "grid": {
      const r = solveGrid(spec);
      return { solved: r.solved, checks: r.checks };
    }
    case "venn":
      return solveVenn(spec);
    case "ordering":
      return solveOrdering(spec);
    case "tree":
      return solveTree(spec);
  }
}
