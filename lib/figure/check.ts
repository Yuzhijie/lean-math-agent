/**
 * Numerically verify that a solved figure satisfies the conditions of the
 * problem: the claims the model listed, plus the measurements given in the
 * constructions themselves (an over-determined triangle whose data do not
 * fit together is caught here). A figure with a failing claim is still
 * shown, but labelled as a sketch ("示意图") rather than an accurate figure.
 */
import { lt } from "../llm/output-locale";
import { LogicError, solveLogic } from "./logic";
import { dist, FigureError, solveFigure, type SolveResult } from "./solve";
import type { Claim, ClaimResult, FigureSpec, Point2, SolvedFigure } from "./spec";

const DEG = 180 / Math.PI;
const LEN_TOL = 1e-3; // relative
const ANG_TOL = 0.2; // degrees

function angleAt(a: Point2, v: Point2, b: Point2): number {
  const u = { x: a.x - v.x, y: a.y - v.y };
  const w = { x: b.x - v.x, y: b.y - v.y };
  const c = (u.x * w.x + u.y * w.y) / (Math.hypot(u.x, u.y) * Math.hypot(w.x, w.y));
  return Math.acos(Math.max(-1, Math.min(1, c))) * DEG;
}

/** Angle between two lines in degrees, in [0, 90]. */
function lineAngle(p1: Point2, p2: Point2, q1: Point2, q2: Point2): number {
  const a = Math.atan2(p2.y - p1.y, p2.x - p1.x);
  const b = Math.atan2(q2.y - q1.y, q2.x - q1.x);
  let d = Math.abs(a - b) * DEG % 180;
  if (d > 90) d = 180 - d;
  return d;
}

const fmt = (v: number) => (Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : v.toFixed(3).replace(/0+$/, "").replace(/\.$/, ""));
const relClose = (a: number, b: number) => Math.abs(a - b) <= LEN_TOL * Math.max(1, Math.abs(a), Math.abs(b));

export function checkClaim(claim: Claim, s: SolveResult): ClaimResult {
  const P = (n: string) => {
    const p = s.points[n];
    if (!p) throw new Error(lt(`点 ${n} 未定义`, `Point ${n} is not defined`));
    return p;
  };
  try {
    switch (claim.type) {
      case "perpendicular": {
        const [[a, b], [c, d]] = claim.lines;
        const ang = lineAngle(P(a), P(b), P(c), P(d));
        return { claim, ok: Math.abs(ang - 90) <= ANG_TOL, detail: lt(`${a}${b} 与 ${c}${d} 夹角 ${fmt(ang)}°（应为 90°）`, `Angle between ${a}${b} and ${c}${d}: ${fmt(ang)}° (should be 90°)`) };
      }
      case "parallel": {
        const [[a, b], [c, d]] = claim.lines;
        const ang = lineAngle(P(a), P(b), P(c), P(d));
        return { claim, ok: ang <= ANG_TOL, detail: lt(`${a}${b} 与 ${c}${d} 夹角 ${fmt(ang)}°（应平行）`, `Angle between ${a}${b} and ${c}${d}: ${fmt(ang)}° (should be parallel)`) };
      }
      case "equal_length": {
        const [[a, b], [c, d]] = claim.segments;
        const l1 = dist(P(a), P(b));
        const l2 = dist(P(c), P(d));
        return { claim, ok: relClose(l1, l2), detail: lt(`${a}${b} = ${fmt(l1)}，${c}${d} = ${fmt(l2)}`, `${a}${b} = ${fmt(l1)}, ${c}${d} = ${fmt(l2)}`) };
      }
      case "length": {
        const [a, b] = claim.segment;
        const l = dist(P(a), P(b));
        return { claim, ok: relClose(l, claim.value), detail: lt(`${a}${b} = ${fmt(l)}（应为 ${fmt(claim.value)}）`, `${a}${b} = ${fmt(l)} (should be ${fmt(claim.value)})`) };
      }
      case "angle": {
        const [a, v, b] = claim.points;
        const ang = angleAt(P(a), P(v), P(b));
        return { claim, ok: Math.abs(ang - claim.value) <= ANG_TOL, detail: lt(`∠${a}${v}${b} = ${fmt(ang)}°（应为 ${fmt(claim.value)}°）`, `∠${a}${v}${b} = ${fmt(ang)}° (should be ${fmt(claim.value)}°)`) };
      }
      case "collinear": {
        const pts = claim.points.map(P);
        const [p0, p1] = pts;
        const len = dist(p0, p1) || 1;
        const worst = Math.max(...pts.slice(2).map((q) => Math.abs((p1.x - p0.x) * (q.y - p0.y) - (p1.y - p0.y) * (q.x - p0.x)) / len));
        return { claim, ok: worst <= LEN_TOL * Math.max(1, len), detail: lt(`${claim.points.join("、")} ${worst <= LEN_TOL * Math.max(1, len) ? "共线" : `偏离 ${fmt(worst)}`}`, `${claim.points.join(", ")} ${worst <= LEN_TOL * Math.max(1, len) ? "collinear" : `off by ${fmt(worst)}`}`) };
      }
      case "on_circle": {
        const c = s.circles[claim.circle];
        if (!c) throw new Error(lt(`圆 ${claim.circle} 未定义`, `Circle ${claim.circle} is not defined`));
        const d = dist(P(claim.point), c.center);
        return { claim, ok: relClose(d, c.r), detail: lt(`${claim.point} 到圆心距离 ${fmt(d)}，半径 ${fmt(c.r)}`, `Distance from ${claim.point} to center: ${fmt(d)}, radius ${fmt(c.r)}`) };
      }
      case "concyclic": {
        const [a, b, c, d] = claim.points.map(P);
        // Four points are concyclic iff the angles subtending one chord agree (or are supplementary).
        const x = angleAt(a, c, b);
        const y = angleAt(a, d, b);
        const ok = Math.abs(x - y) <= ANG_TOL || Math.abs(x + y - 180) <= ANG_TOL;
        return { claim, ok, detail: lt(`${claim.points.join("")} ${ok ? "四点共圆" : "不共圆"}`, `${claim.points.join("")} ${ok ? "concyclic" : "not concyclic"}`) };
      }
      case "function_passes": {
        const f = s.functions[claim.fn];
        if (!f) throw new Error(lt(`函数 ${claim.fn} 未定义`, `Function ${claim.fn} is not defined`));
        const y = f(claim.x);
        return { claim, ok: Number.isFinite(y) && relClose(y, claim.y), detail: lt(`${claim.fn}(${fmt(claim.x)}) = ${Number.isFinite(y) ? fmt(y) : "无定义"}（应为 ${fmt(claim.y)}）`, `${claim.fn}(${fmt(claim.x)}) = ${Number.isFinite(y) ? fmt(y) : "undefined"} (should be ${fmt(claim.y)})`) };
      }
    }
  } catch (e) {
    return { claim, ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Measurements stated inside triangle constructions, as claims. */
export function implicitClaims(spec: FigureSpec): Claim[] {
  const out: Claim[] = [];
  for (const c of spec.constructions) {
    if (c.op !== "triangle") continue;
    const [n0, n1, n2] = c.ids;
    for (const [key, value] of Object.entries(c.sides ?? {})) {
      const pair = [[n0, n1], [n1, n0], [n0, n2], [n2, n0], [n1, n2], [n2, n1]].find(([u, v]) => u + v === key);
      if (pair) out.push({ type: "length", segment: [pair[0], pair[1]], value });
    }
    for (const [v, value] of Object.entries(c.angles ?? {})) {
      const others = [n0, n1, n2].filter((n) => n !== v);
      if (others.length === 2) out.push({ type: "angle", points: [others[0], v, others[1]], value });
    }
  }
  return out;
}

/** Solve + check. Throws FigureError when the figure cannot be constructed. */
export function buildFigure(spec: FigureSpec): SolvedFigure {
  const solved = solveFigure(spec);
  const claims: ClaimResult[] = [...implicitClaims(spec), ...spec.claims].map((c) => checkClaim(c, solved));
  let logic: SolvedFigure["logic"];
  if (spec.logic) {
    try {
      const r = solveLogic(spec.logic, lt);
      logic = r.solved;
      claims.push(...r.checks);
    } catch (e) {
      // Same contract as geometry: a description that cannot be built is a FigureError (→ repair round).
      throw new FigureError(e instanceof LogicError ? e.message : String(e));
    }
  }
  return {
    spec,
    points: solved.points,
    circles: solved.circles,
    claims,
    verified: claims.every((c) => c.ok),
    warnings: solved.warnings,
    logic,
  };
}
