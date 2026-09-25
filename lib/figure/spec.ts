/**
 * Figure specification: what the model says to draw. It names points and
 * how each one is constructed (a triangle with given sides/angles, a
 * midpoint, a perpendicular foot, an intersection, a circle …), what to
 * draw, which conditions of the problem must hold in the picture, and
 * which elements each solution step refers to. Coordinates are never
 * taken from the model: `solveFigure` computes them and `checkFigure`
 * verifies the claimed conditions numerically.
 */
import { z } from "zod";

const id = z.string().min(1).max(16).regex(/^[A-Za-z][A-Za-z0-9_'′₀-₉]*$/, "id must be a short identifier like A, B1, O, l1");
const pair = z.tuple([id, id]);
const num = z.number().finite();

export const constructionSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("point"), id, x: num, y: num }),
  z.object({
    op: z.literal("triangle"),
    ids: z.tuple([id, id, id]),
    /** Side lengths by segment name, e.g. { "AB": 5, "BC": 6 }. */
    sides: z.record(num.positive()).optional(),
    /** Interior angles in degrees by vertex, e.g. { "A": 90 }. */
    angles: z.record(num.positive()).optional(),
    /** Vertex where the two equal sides meet (isosceles). */
    isosceles_at: id.optional(),
    equilateral: z.boolean().optional(),
  }),
  z.object({ op: z.literal("rectangle"), ids: z.tuple([id, id, id, id]), width: num.positive(), height: num.positive() }),
  z.object({ op: z.literal("square"), ids: z.tuple([id, id, id, id]), side: num.positive() }),
  z.object({
    op: z.literal("parallelogram"),
    ids: z.tuple([id, id, id, id]),
    /** |AB| and |AD| for ids [A, B, C, D], angle at A in degrees. */
    ab: num.positive(),
    ad: num.positive(),
    angle: num.positive(),
  }),
  z.object({ op: z.literal("regular_polygon"), ids: z.array(id).min(3).max(12), side: num.positive() }),
  z.object({ op: z.literal("midpoint"), id, of: pair }),
  /** Point on segment PQ with PX : PQ = ratio (0..1), or beyond with ratio > 1. */
  z.object({ op: z.literal("point_on_segment"), id, of: pair, ratio: num }),
  /** Foot of the perpendicular from `from` to line `line`. */
  z.object({ op: z.literal("foot"), id, from: id, line: pair }),
  z.object({ op: z.literal("intersection"), id, line1: pair, line2: pair }),
  /** Where the bisector of angle (from, vertex, to) meets segment from–to. */
  z.object({ op: z.literal("angle_bisector_point"), id, vertex: id, from: id, to: id }),
  z.object({ op: z.literal("reflect"), id, of: id, over: pair }),
  z.object({ op: z.literal("rotate"), id, of: id, center: id, angle: num }),
  z.object({ op: z.literal("circle"), id, center: id, radius: num.positive().optional(), through: id.optional() }),
  z.object({ op: z.literal("circumcircle"), id, of: z.tuple([id, id, id]), center_id: id.optional() }),
  z.object({ op: z.literal("incircle"), id, of: z.tuple([id, id, id]), center_id: id.optional() }),
  /** Point on a circle at a polar angle (degrees, counter-clockwise from +x). */
  z.object({ op: z.literal("point_on_circle"), id, circle: id, angle: num }),
  /** Intersection of line PQ with a circle; which = 0 or 1 picks one of the two. */
  z.object({ op: z.literal("line_circle_intersection"), id, line: pair, circle: id, which: z.union([z.literal(0), z.literal(1)]).default(0) }),
  /** Point on a plotted function: (x, f(x)). */
  z.object({ op: z.literal("function_point"), id, fn: id, x: num }),
]);

export const drawSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("segment"), a: id, b: id, id: id.optional(), dashed: z.boolean().optional(), label: z.string().max(24).optional() }),
  z.object({ type: z.literal("line"), a: id, b: id, id: id.optional(), dashed: z.boolean().optional() }),
  z.object({ type: z.literal("ray"), a: id, b: id, id: id.optional(), dashed: z.boolean().optional() }),
  z.object({ type: z.literal("polygon"), ids: z.array(id).min(3), id: id.optional(), fill: z.boolean().optional() }),
  z.object({ type: z.literal("circle"), circle: id, dashed: z.boolean().optional() }),
  z.object({ type: z.literal("angle"), vertex: id, from: id, to: id, id: id.optional(), label: z.string().max(12).optional(), right: z.boolean().optional() }),
  /** Tick marks on segments of equal length (count = 1..3 ticks). */
  z.object({ type: z.literal("equal_marks"), segments: z.array(pair).min(2), count: z.number().int().min(1).max(3).optional() }),
  z.object({ type: z.literal("text"), at: id, text: z.string().max(24) }),
]);

export const claimSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("perpendicular"), lines: z.tuple([pair, pair]) }),
  z.object({ type: z.literal("parallel"), lines: z.tuple([pair, pair]) }),
  z.object({ type: z.literal("equal_length"), segments: z.tuple([pair, pair]) }),
  z.object({ type: z.literal("length"), segment: pair, value: num }),
  z.object({ type: z.literal("angle"), points: z.tuple([id, id, id]), value: num }),
  z.object({ type: z.literal("collinear"), points: z.array(id).min(3) }),
  z.object({ type: z.literal("on_circle"), point: id, circle: id }),
  z.object({ type: z.literal("concyclic"), points: z.tuple([id, id, id, id]) }),
  z.object({ type: z.literal("function_passes"), fn: id, x: num, y: num }),
]);

export const functionSchema = z.object({
  id,
  /** Expression in x, e.g. "x^2 - 2x - 3", "sin(x)", "1/x". */
  expr: z.string().min(1).max(200),
  label: z.string().max(32).optional(),
  domain: z.tuple([num, num]).optional(),
});

export const figureSpecSchema = z.object({
  /** false when the problem does not benefit from a figure (pure algebra, number theory). */
  needed: z.boolean(),
  title: z.string().max(60).optional(),
  constructions: z.array(constructionSchema).max(40).default([]),
  draw: z.array(drawSchema).max(60).default([]),
  claims: z.array(claimSchema).max(30).default([]),
  axes: z
    .object({ x: z.tuple([num, num]), y: z.tuple([num, num]), grid: z.boolean().optional() })
    .optional(),
  functions: z.array(functionSchema).max(6).default([]),
  /** Points that are constructed but not drawn / labelled. */
  hidden_points: z.array(id).default([]),
  /** Element ids (points, segment/angle ids, circle ids, fn ids) each solution step refers to; step is 1-based. */
  step_highlights: z.array(z.object({ step: z.number().int().min(1), ids: z.array(id) })).default([]),
});

export type Construction = z.infer<typeof constructionSchema>;
export type DrawItem = z.infer<typeof drawSchema>;
export type Claim = z.infer<typeof claimSchema>;
export type FigureFunction = z.infer<typeof functionSchema>;
export type FigureSpec = z.infer<typeof figureSpecSchema>;

export interface Point2 {
  x: number;
  y: number;
}

export interface SolvedCircle {
  center: Point2;
  r: number;
}

export interface ClaimResult {
  claim: Claim;
  ok: boolean;
  /** Human-readable measurement, e.g. "∠ABC = 89.9°（应为 90°）". */
  detail: string;
}

/** A figure with computed coordinates, ready to render (and to store in a session). */
export interface SolvedFigure {
  spec: FigureSpec;
  points: Record<string, Point2>;
  circles: Record<string, SolvedCircle>;
  claims: ClaimResult[];
  /** All claims hold numerically. */
  verified: boolean;
  /** Construction problems that were worked around (defaults used, etc.). */
  warnings: string[];
}
