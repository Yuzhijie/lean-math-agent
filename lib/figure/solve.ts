/**
 * Compute coordinates for a FigureSpec, construction by construction.
 *
 * Shapes (triangle, rectangle, square, parallelogram, regular polygon) are
 * built in local coordinates and then placed: when two of their vertices
 * already exist, the shape is moved (rotated + translated, scaled only if
 * it must be) onto them; with one existing vertex it is translated; with
 * none it starts at the origin. Everything else (midpoints, feet,
 * intersections, circles …) is computed from points that already exist.
 *
 * Under-determined triangles get textbook-looking defaults (a scalene
 * triangle with base 5), recorded as warnings — a figure is an
 * illustration, and the claims checked afterwards decide whether it is
 * faithful.
 */
import { compileExpr, ExprError } from "./expr";
import type { Construction, FigureSpec, Point2, SolvedCircle } from "./spec";

export class FigureError extends Error {}

const DEG = Math.PI / 180;
const EPS = 1e-9;

export interface SolveResult {
  points: Record<string, Point2>;
  circles: Record<string, SolvedCircle>;
  functions: Record<string, (x: number) => number>;
  warnings: string[];
}

// ── Vector helpers ─────────────────────────────────────────────────────
const sub = (p: Point2, q: Point2): Point2 => ({ x: p.x - q.x, y: p.y - q.y });
const add = (p: Point2, q: Point2): Point2 => ({ x: p.x + q.x, y: p.y + q.y });
const mul = (p: Point2, k: number): Point2 => ({ x: p.x * k, y: p.y * k });
const dot = (p: Point2, q: Point2) => p.x * q.x + p.y * q.y;
const cross = (p: Point2, q: Point2) => p.x * q.y - p.y * q.x;
export const dist = (p: Point2, q: Point2) => Math.hypot(p.x - q.x, p.y - q.y);
const rot = (p: Point2, a: number): Point2 => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) });

function lineIntersection(p1: Point2, p2: Point2, q1: Point2, q2: Point2): Point2 | undefined {
  const r = sub(p2, p1);
  const s = sub(q2, q1);
  const d = cross(r, s);
  if (Math.abs(d) < EPS) return undefined;
  const t = cross(sub(q1, p1), s) / d;
  return add(p1, mul(r, t));
}

function foot(p: Point2, a: Point2, b: Point2): Point2 {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  if (len2 < EPS) throw new FigureError("直线的两个端点重合");
  return add(a, mul(ab, dot(sub(p, a), ab) / len2));
}

// ── Triangle from partial data ─────────────────────────────────────────

interface Tri {
  A?: number; // angles in radians at ids[0], ids[1], ids[2]
  B?: number;
  C?: number;
  a?: number; // sides opposite ids[0], ids[1], ids[2]
  b?: number;
  c?: number;
}

/**
 * Solve a triangle from any mix of given sides/angles (SSS, SAS, ASA, AAS,
 * SSA → acute solution), filling missing data with defaults.
 */
export function solveTriangle(given: Tri, isoscelesAt?: 0 | 1 | 2, warnings: string[] = [], label = "三角形"): Required<Tri> {
  const t: Tri = { ...given };
  const angleKeys = ["A", "B", "C"] as const;
  const sideKeys = ["a", "b", "c"] as const;
  const knownAngles = () => angleKeys.filter((k) => t[k] !== undefined);
  const knownSides = () => sideKeys.filter((k) => t[k] !== undefined);

  const step = (): boolean => {
    let changed = false;
    const set = (k: keyof Tri, v: number) => {
      if (t[k] === undefined && Number.isFinite(v) && v > 0) {
        t[k] = v;
        changed = true;
      }
    };
    // Isosceles: the two sides at the apex are equal, as are the base angles.
    if (isoscelesAt !== undefined) {
      const apex = isoscelesAt;
      const [s1, s2] = sideKeys.filter((_, i) => i !== apex);
      const [a1, a2] = angleKeys.filter((_, i) => i !== apex);
      if (t[s1] !== undefined) set(s2, t[s1]!);
      if (t[s2] !== undefined) set(s1, t[s2]!);
      if (t[a1] !== undefined) set(a2, t[a1]!);
      if (t[a2] !== undefined) set(a1, t[a2]!);
      const apexAngle = t[angleKeys[apex]];
      if (apexAngle !== undefined) {
        set(a1, (Math.PI - apexAngle) / 2);
        set(a2, (Math.PI - apexAngle) / 2);
      }
    }
    // Angle sum.
    const ka = knownAngles();
    if (ka.length === 2) {
      const missing = angleKeys.find((k) => t[k] === undefined)!;
      set(missing, Math.PI - t[ka[0]]! - t[ka[1]]!);
    }
    // SSS → angles (law of cosines).
    if (knownSides().length === 3) {
      const { a, b, c } = t as Required<Tri>;
      set("A", Math.acos(clampCos((b * b + c * c - a * a) / (2 * b * c))));
      set("B", Math.acos(clampCos((a * a + c * c - b * b) / (2 * a * c))));
      set("C", Math.acos(clampCos((a * a + b * b - c * c) / (2 * a * b))));
    }
    // SAS → third side.
    for (let i = 0; i < 3; i++) {
      const ang = angleKeys[i];
      const opp = sideKeys[i];
      const [s1, s2] = sideKeys.filter((_, j) => j !== i);
      if (t[ang] !== undefined && t[s1] !== undefined && t[s2] !== undefined) {
        set(opp, Math.sqrt(Math.max(0, t[s1]! ** 2 + t[s2]! ** 2 - 2 * t[s1]! * t[s2]! * Math.cos(t[ang]!))));
      }
    }
    // Law of sines, from any known angle/opposite-side pair.
    const pair = [0, 1, 2].find((i) => t[angleKeys[i]] !== undefined && t[sideKeys[i]] !== undefined);
    if (pair !== undefined) {
      const k = t[sideKeys[pair]]! / Math.sin(t[angleKeys[pair]]!);
      for (let i = 0; i < 3; i++) {
        if (i === pair) continue;
        if (t[angleKeys[i]] !== undefined) set(sideKeys[i], k * Math.sin(t[angleKeys[i]]!));
        else if (t[sideKeys[i]] !== undefined) {
          const s = t[sideKeys[i]]! / k;
          if (s > 1 + 1e-9) throw new FigureError(`${label}：给定的边和角无法构成三角形`);
          let ang = Math.asin(Math.min(1, s));
          if (t[angleKeys[pair]]! + ang >= Math.PI) ang = Math.PI - ang;
          set(angleKeys[i], ang);
        }
      }
    }
    return changed;
  };

  for (let guard = 0; guard < 30; guard++) {
    while (step()) {
      /* propagate */
    }
    if (knownSides().length === 3) break;
    // Stuck: inject one default and propagate again.
    const ks = knownSides();
    const ka = knownAngles();
    if (ks.length >= 2) {
      const i = [0, 1, 2].find((j) => !ks.includes(sideKeys[j]))!;
      if (t[angleKeys[i]] === undefined) {
        t[angleKeys[i]] = 60 * DEG;
        warnings.push(`${label}：未给出夹角，按 60° 作示意`);
        continue;
      }
    }
    if (ka.length < 2) {
      const i = [0, 1, 2].find((j) => t[angleKeys[j]] === undefined)!;
      const sum = ka.reduce((s, k) => s + t[k]!, 0);
      const v = ka.length === 0 ? 58 * DEG : (Math.PI - sum) * 0.42;
      t[angleKeys[i]] = v;
      warnings.push(`${label}：角未完全给出，∠${"ABC"[i]} 按 ${(v / DEG).toFixed(0)}° 作示意`);
      continue;
    }
    if (ks.length === 0) {
      t.a = 5;
      warnings.push(`${label}：未给出边长，按比例作图`);
      continue;
    }
    throw new FigureError(`${label}：条件不足以确定三角形`);
  }
  const { A, B, C, a, b, c } = t;
  if ([A, B, C, a, b, c].some((v) => v === undefined || !Number.isFinite(v) || v <= 0)) {
    throw new FigureError(`${label}：条件矛盾或不足`);
  }
  if (a! >= b! + c! - 1e-9 || b! >= a! + c! - 1e-9 || c! >= a! + b! - 1e-9) {
    throw new FigureError(`${label}：边长不满足三角形不等式`);
  }
  return t as Required<Tri>;
}

function clampCos(v: number): number {
  if (v > 1 + 1e-9 || v < -1 - 1e-9) throw new FigureError("边长不满足三角形不等式");
  return Math.max(-1, Math.min(1, v));
}

// ── Main solver ────────────────────────────────────────────────────────

export function solveFigure(spec: FigureSpec): SolveResult {
  const points: Record<string, Point2> = {};
  const circles: Record<string, SolvedCircle> = {};
  const functions: Record<string, (x: number) => number> = {};
  const warnings: string[] = [];

  for (const f of spec.functions) {
    try {
      functions[f.id] = compileExpr(f.expr);
    } catch (e) {
      throw new FigureError(`函数 ${f.id} = ${f.expr}：${e instanceof ExprError ? e.message : String(e)}`);
    }
  }

  const P = (name: string, ctx: string): Point2 => {
    const p = points[name];
    if (!p) throw new FigureError(`${ctx}：点 ${name} 尚未定义（构造顺序需先定义它）`);
    return p;
  };
  const Circ = (name: string, ctx: string): SolvedCircle => {
    const c = circles[name];
    if (!c) throw new FigureError(`${ctx}：圆 ${name} 尚未定义`);
    return c;
  };
  const define = (name: string, p: Point2, ctx: string) => {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new FigureError(`${ctx}：点 ${name} 无法计算`);
    points[name] = p;
  };

  /** Place a shape given in local coordinates onto already-defined vertices. */
  const place = (ids: string[], local: Point2[], ctx: string) => {
    const existing = ids.map((n, i) => (points[n] ? i : -1)).filter((i) => i >= 0);
    let map: (p: Point2) => Point2 = (p) => p;
    if (existing.length >= 2) {
      const [i, j] = existing;
      const L = sub(local[j], local[i]);
      const W = sub(points[ids[j]], points[ids[i]]);
      const scale = Math.hypot(W.x, W.y) / Math.hypot(L.x, L.y);
      if (Math.abs(scale - 1) > 1e-6) warnings.push(`${ctx}：与已有点的距离不一致，按比例缩放`);
      const angle = Math.atan2(W.y, W.x) - Math.atan2(L.y, L.x);
      const origin = local[i];
      const target = points[ids[i]];
      map = (p) => add(target, mul(rot(sub(p, origin), angle), scale));
    } else if (existing.length === 1) {
      const i = existing[0];
      const d = sub(points[ids[i]], local[i]);
      map = (p) => add(p, d);
    }
    ids.forEach((n, k) => {
      if (!points[n]) define(n, map(local[k]), ctx);
    });
  };

  for (const c of spec.constructions) {
    const ctx = describe(c);
    switch (c.op) {
      case "point":
        define(c.id, { x: c.x, y: c.y }, ctx);
        break;
      case "triangle": {
        const [n0, n1, n2] = c.ids;
        const sideOf = (u: string, v: string) => c.sides?.[u + v] ?? c.sides?.[v + u];
        const given: Tri = {
          a: sideOf(n1, n2),
          b: sideOf(n0, n2),
          c: sideOf(n0, n1),
          A: c.angles?.[n0] !== undefined ? c.angles[n0] * DEG : undefined,
          B: c.angles?.[n1] !== undefined ? c.angles[n1] * DEG : undefined,
          C: c.angles?.[n2] !== undefined ? c.angles[n2] * DEG : undefined,
        };
        const names = [n0 + n1, n1 + n0, n0 + n2, n2 + n0, n1 + n2, n2 + n1];
        const unknownSides = Object.keys(c.sides ?? {}).filter((k) => !names.includes(k));
        const unknownAngles = Object.keys(c.angles ?? {}).filter((k) => ![n0, n1, n2].includes(k));
        if (unknownSides.length || unknownAngles.length) {
          throw new FigureError(`${ctx}：无法识别的边/角 ${[...unknownSides, ...unknownAngles].join(", ")}（边用两个顶点名如 ${n0}${n1}，角用顶点名如 ${n0}）`);
        }
        if (c.equilateral) {
          given.A = given.B = given.C = 60 * DEG;
        }
        const apexIdx = c.isosceles_at !== undefined ? [n0, n1, n2].indexOf(c.isosceles_at) : undefined;
        if (apexIdx === -1) throw new FigureError(`${ctx}：顶点 ${c.isosceles_at} 不在三角形中`);
        const apex = apexIdx as 0 | 1 | 2 | undefined;
        // Existing base vertices fix the scale when no side is given.
        if (given.a === undefined && given.b === undefined && given.c === undefined) {
          if (points[n1] && points[n2]) given.a = dist(points[n1], points[n2]);
          else if (points[n0] && points[n2]) given.b = dist(points[n0], points[n2]);
          else if (points[n0] && points[n1]) given.c = dist(points[n0], points[n1]);
        }
        const t = solveTriangle(given, apex, warnings, ctx);
        // n1 at the origin, n2 on the +x axis, n0 above.
        const local = [
          { x: t.c * Math.cos(t.B), y: t.c * Math.sin(t.B) },
          { x: 0, y: 0 },
          { x: t.a, y: 0 },
        ];
        place([n0, n1, n2], local, ctx);
        break;
      }
      case "rectangle":
      case "square": {
        const w = c.op === "square" ? c.side : c.width;
        const h = c.op === "square" ? c.side : c.height;
        place([...c.ids], [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], ctx);
        break;
      }
      case "parallelogram": {
        const d = { x: c.ad * Math.cos(c.angle * DEG), y: c.ad * Math.sin(c.angle * DEG) };
        place([...c.ids], [{ x: 0, y: 0 }, { x: c.ab, y: 0 }, { x: c.ab + d.x, y: d.y }, d], ctx);
        break;
      }
      case "regular_polygon": {
        const n = c.ids.length;
        const R = c.side / (2 * Math.sin(Math.PI / n));
        const start = -Math.PI / 2 - Math.PI / n;
        const local = c.ids.map((_, k) => ({ x: R * Math.cos(start + (2 * Math.PI * k) / n), y: R * Math.sin(start + (2 * Math.PI * k) / n) }));
        place([...c.ids], local, ctx);
        break;
      }
      case "midpoint": {
        const [p, q] = c.of.map((n) => P(n, ctx));
        define(c.id, mul(add(p, q), 0.5), ctx);
        break;
      }
      case "point_on_segment": {
        const [p, q] = c.of.map((n) => P(n, ctx));
        define(c.id, add(p, mul(sub(q, p), c.ratio)), ctx);
        break;
      }
      case "foot":
        define(c.id, foot(P(c.from, ctx), P(c.line[0], ctx), P(c.line[1], ctx)), ctx);
        break;
      case "intersection": {
        const x = lineIntersection(P(c.line1[0], ctx), P(c.line1[1], ctx), P(c.line2[0], ctx), P(c.line2[1], ctx));
        if (!x) throw new FigureError(`${ctx}：两直线平行，没有交点`);
        define(c.id, x, ctx);
        break;
      }
      case "angle_bisector_point": {
        const v = P(c.vertex, ctx);
        const a = P(c.from, ctx);
        const b = P(c.to, ctx);
        const da = dist(v, a);
        const db = dist(v, b);
        // Angle bisector theorem: the point divides ab in ratio da : db.
        define(c.id, add(a, mul(sub(b, a), da / (da + db))), ctx);
        break;
      }
      case "reflect": {
        const p = P(c.of, ctx);
        const f = foot(p, P(c.over[0], ctx), P(c.over[1], ctx));
        define(c.id, sub(mul(f, 2), p), ctx);
        break;
      }
      case "rotate": {
        const p = P(c.of, ctx);
        const o = P(c.center, ctx);
        define(c.id, add(o, rot(sub(p, o), c.angle * DEG)), ctx);
        break;
      }
      case "circle": {
        const center = P(c.center, ctx);
        const r = c.radius ?? (c.through ? dist(center, P(c.through, ctx)) : undefined);
        if (r === undefined || r <= 0) throw new FigureError(`${ctx}：需要 radius 或 through`);
        circles[c.id] = { center, r };
        break;
      }
      case "circumcircle": {
        const [a, b, cc] = c.of.map((n) => P(n, ctx));
        const d = 2 * (a.x * (b.y - cc.y) + b.x * (cc.y - a.y) + cc.x * (a.y - b.y));
        if (Math.abs(d) < EPS) throw new FigureError(`${ctx}：三点共线，没有外接圆`);
        const a2 = dot(a, a);
        const b2 = dot(b, b);
        const c2 = dot(cc, cc);
        const center = {
          x: (a2 * (b.y - cc.y) + b2 * (cc.y - a.y) + c2 * (a.y - b.y)) / d,
          y: (a2 * (cc.x - b.x) + b2 * (a.x - cc.x) + c2 * (b.x - a.x)) / d,
        };
        circles[c.id] = { center, r: dist(center, a) };
        if (c.center_id) define(c.center_id, center, ctx);
        break;
      }
      case "incircle": {
        const [A, B, C] = c.of.map((n) => P(n, ctx));
        const a = dist(B, C);
        const b = dist(A, C);
        const cl = dist(A, B);
        const per = a + b + cl;
        if (per < EPS) throw new FigureError(`${ctx}：三角形退化`);
        const center = { x: (a * A.x + b * B.x + cl * C.x) / per, y: (a * A.y + b * B.y + cl * C.y) / per };
        const area = Math.abs(cross(sub(B, A), sub(C, A))) / 2;
        if (area < EPS) throw new FigureError(`${ctx}：三点共线，没有内切圆`);
        circles[c.id] = { center, r: area / (per / 2) };
        if (c.center_id) define(c.center_id, center, ctx);
        break;
      }
      case "point_on_circle": {
        const circ = Circ(c.circle, ctx);
        define(c.id, { x: circ.center.x + circ.r * Math.cos(c.angle * DEG), y: circ.center.y + circ.r * Math.sin(c.angle * DEG) }, ctx);
        break;
      }
      case "line_circle_intersection": {
        const p = P(c.line[0], ctx);
        const q = P(c.line[1], ctx);
        const circ = Circ(c.circle, ctx);
        const d = sub(q, p);
        const f = sub(p, circ.center);
        const A = dot(d, d);
        const B = 2 * dot(f, d);
        const C = dot(f, f) - circ.r * circ.r;
        const disc = B * B - 4 * A * C;
        if (A < EPS || disc < -1e-9) throw new FigureError(`${ctx}：直线与圆没有交点`);
        const s = Math.sqrt(Math.max(0, disc));
        const ts = [(-B - s) / (2 * A), (-B + s) / (2 * A)].sort((u, v) => u - v);
        // Prefer an intersection other than an already-named endpoint.
        const cands = ts.map((t) => add(p, mul(d, t)));
        const fresh = cands.filter((pt) => dist(pt, p) > 1e-6 && dist(pt, q) > 1e-6);
        const pick = fresh.length === 1 ? fresh[0] : cands[c.which];
        define(c.id, pick, ctx);
        break;
      }
      case "function_point": {
        const fn = functions[c.fn];
        if (!fn) throw new FigureError(`${ctx}：函数 ${c.fn} 未定义`);
        define(c.id, { x: c.x, y: fn(c.x) }, ctx);
        break;
      }
    }
  }
  return { points, circles, functions, warnings };
}

export function describe(c: Construction): string {
  switch (c.op) {
    case "triangle":
    case "rectangle":
    case "square":
    case "parallelogram":
    case "regular_polygon":
      return `${c.op} ${c.ids.join("")}`;
    default:
      return `${c.op} ${c.id}`;
  }
}
