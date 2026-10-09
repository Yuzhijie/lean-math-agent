/**
 * Reflection in two lines — "The shape is reflected in line l and then in line m. Move two shapes
 * into the correct positions on the diagram."
 *
 * A shape of grid squares sits in one corner of a diagram cut by two perpendicular dashed lines;
 * empty target boxes fill the other corners; underneath, numbered cards each show the shape after a
 * transformation (reflected left–right, top–bottom, half turn, quarter turns, unchanged). The program
 * knows which card belongs in which box (`reflectionAnswer`), so the answer can be checked.
 *
 * Pure and deterministic (server and browser).
 */
import { z } from "zod";

export const TRANSFORMS = ["original", "flip_h", "flip_v", "rotate_180", "rotate_90", "rotate_270"] as const;
export type Transform = (typeof TRANSFORMS)[number];

export const reflectionSchema = z.object({
  kind: z.literal("reflection"),
  /** The shape's grid is n × n. */
  grid: z.number().int().min(2).max(6),
  /** Squares of the shape, [row, col] from the top left (0-based). */
  cells: z.array(z.tuple([z.number().int().min(0), z.number().int().min(0)])).min(2).max(30),
  /** Direction of the first line (l): "vertical" (default) or "horizontal"; the second line (m) is the other. */
  first_line: z.enum(["vertical", "horizontal"]).optional(),
  labels: z.object({ first: z.string().max(4).optional(), second: z.string().max(4).optional() }).optional(),
  /** Empty target boxes in the other three corners (default true). */
  targets: z.boolean().optional(),
  /** Cards under the diagram, each the shape after a transformation; numbered 1, 2, … */
  cards: z.array(z.enum(TRANSFORMS)).min(2).max(6),
  /** Light grid lines inside the shapes. */
  show_grid: z.boolean().optional(),
  caption: z.string().max(60).optional(),
});

export type ReflectionSpec = z.infer<typeof reflectionSchema>;

export interface ReflectionPen {
  ink: string;
  accent: string;
  fill: string;
  paper: string;
  sw: number;
  text(x: number, y: number, s: string, size?: number, anchor?: "start" | "middle" | "end"): string;
}

type Cell = [number, number];

export function transformCells(cells: Cell[], n: number, t: Transform): Cell[] {
  return cells.map(([r, c]) => {
    switch (t) {
      case "flip_h":
        return [r, n - 1 - c];
      case "flip_v":
        return [n - 1 - r, c];
      case "rotate_180":
        return [n - 1 - r, n - 1 - c];
      case "rotate_90":
        return [c, n - 1 - r];
      case "rotate_270":
        return [n - 1 - c, r];
      default:
        return [r, c];
    }
  });
}

/** Shape of a set of squares, independent of where it sits. */
export function shapeKey(cells: Cell[]): string {
  const r0 = Math.min(...cells.map((x) => x[0])), c0 = Math.min(...cells.map((x) => x[1]));
  return cells.map(([r, c]) => `${r - r0},${c - c0}`).sort().join(" ");
}

export interface ReflectionAnswer {
  /** Where the shape lands after the first reflection, and after both. */
  afterFirst: "top-right" | "bottom-left";
  afterBoth: "bottom-right";
  /** Cards (1-based) showing those shapes. */
  firstCards: number[];
  bothCards: number[];
  /** The shape looks the same after one of the reflections, so the cards cannot be told apart. */
  symmetric: boolean;
  /** Cards (1-based) that look the same as an earlier card. */
  duplicateCards: number[];
}

export function reflectionAnswer(s: ReflectionSpec): ReflectionAnswer {
  const n = s.grid;
  const cells = s.cells.filter(([r, c]) => r < n && c < n) as Cell[];
  const vertical = (s.first_line ?? "vertical") === "vertical";
  const first = shapeKey(transformCells(cells, n, vertical ? "flip_h" : "flip_v"));
  const both = shapeKey(transformCells(cells, n, "rotate_180"));
  const keys = s.cards.map((t) => shapeKey(transformCells(cells, n, t)));
  const orig = shapeKey(cells);
  const symmetric = first === orig || both === orig || first === both || shapeKey(transformCells(cells, n, vertical ? "flip_v" : "flip_h")) === orig;
  return {
    afterFirst: vertical ? "top-right" : "bottom-left",
    afterBoth: "bottom-right",
    firstCards: keys.flatMap((k, i) => (k === first ? [i + 1] : [])),
    bothCards: keys.flatMap((k, i) => (k === both ? [i + 1] : [])),
    symmetric,
    duplicateCards: keys.flatMap((k, i) => (keys.indexOf(k) < i ? [i + 1] : [])),
  };
}

const r1 = (v: number) => Math.round(v * 10) / 10;

function shapeSvg(cells: Cell[], n: number, x: number, y: number, s: number, pen: ReflectionPen, grid: boolean): string {
  const on = new Set(cells.map(([r, c]) => `${r},${c}`));
  const out: string[] = [];
  if (grid) for (let i = 0; i <= n; i++) out.push(`<line x1="${x}" y1="${r1(y + i * s)}" x2="${r1(x + n * s)}" y2="${r1(y + i * s)}" stroke="#d6d6d6" stroke-width="0.7"/>`, `<line x1="${r1(x + i * s)}" y1="${y}" x2="${r1(x + i * s)}" y2="${r1(y + n * s)}" stroke="#d6d6d6" stroke-width="0.7"/>`);
  for (const [r, c] of cells) out.push(`<rect x="${r1(x + c * s)}" y="${r1(y + r * s)}" width="${s}" height="${s}" fill="${pen.fill}"/>`);
  const st = `stroke="${pen.accent}" stroke-width="${pen.sw}" stroke-linecap="round"`;
  for (const [r, c] of cells) {
    const X = x + c * s, Y = y + r * s;
    if (!on.has(`${r - 1},${c}`)) out.push(`<line x1="${r1(X)}" y1="${r1(Y)}" x2="${r1(X + s)}" y2="${r1(Y)}" ${st}/>`);
    if (!on.has(`${r + 1},${c}`)) out.push(`<line x1="${r1(X)}" y1="${r1(Y + s)}" x2="${r1(X + s)}" y2="${r1(Y + s)}" ${st}/>`);
    if (!on.has(`${r},${c - 1}`)) out.push(`<line x1="${r1(X)}" y1="${r1(Y)}" x2="${r1(X)}" y2="${r1(Y + s)}" ${st}/>`);
    if (!on.has(`${r},${c + 1}`)) out.push(`<line x1="${r1(X + s)}" y1="${r1(Y)}" x2="${r1(X + s)}" y2="${r1(Y + s)}" ${st}/>`);
  }
  return out.join("");
}

export function drawReflection(spec: ReflectionSpec, pen: ReflectionPen): { w: number; h: number; body: string } {
  const n = spec.grid;
  const cells = spec.cells.filter(([r, c]) => r < n && c < n) as Cell[];
  if (cells.length < 2) throw new Error("reflection: the shape needs at least 2 squares inside the grid");
  const s = n <= 3 ? 20 : n <= 4 ? 17 : 14;
  const box = n * s + 16, gap = 30;
  const parts: string[] = [];
  const vertical = (spec.first_line ?? "vertical") === "vertical";
  const lab = { first: spec.labels?.first ?? "l", second: spec.labels?.second ?? "m" };
  const X = [0, box + gap], Y = [0, box + gap];
  const W = 2 * box + gap, H = 2 * box + gap;
  // The two lines, through the middle of the gaps.
  const midX = box + gap / 2, midY = box + gap / 2;
  const dash = `stroke="${pen.ink}" stroke-width="1.6" stroke-dasharray="8 5"`;
  parts.push(`<line x1="${midX}" y1="-12" x2="${midX}" y2="${H + 12}" ${dash}/>`, `<line x1="-12" y1="${midY}" x2="${W + 12}" y2="${midY}" ${dash}/>`);
  parts.push(pen.text(midX + 6, -14, vertical ? lab.first : lab.second, 16, "start"), pen.text(W + 16, midY + 5, vertical ? lab.second : lab.first, 16, "start"));
  // Original shape top-left; empty targets in the other corners.
  parts.push(shapeSvg(cells, n, X[0] + 8, Y[0] + 8, s, pen, !!spec.show_grid));
  if (spec.targets !== false)
    for (const [i, j] of [[1, 0], [0, 1], [1, 1]] as const) parts.push(`<rect x="${X[i] + 4}" y="${Y[j] + 4}" width="${box - 8}" height="${box - 8}" rx="3" fill="${pen.paper}" stroke="${pen.ink}" stroke-width="1.4"/>`);
  // Cards underneath.
  const cy = H + 40, cw = box + 6;
  spec.cards.forEach((t, i) => {
    const cx = i * (cw + 14);
    parts.push(`<rect x="${cx}" y="${cy}" width="${cw}" height="${cw + 24}" rx="6" fill="${pen.paper}" stroke="${pen.accent}" stroke-width="1.4"/>`);
    parts.push(pen.text(cx + cw / 2, cy + 18, String(i + 1), 15));
    parts.push(shapeSvg(transformCells(cells, n, t), n, cx + (cw - n * s) / 2, cy + 26, s, pen, !!spec.show_grid));
  });
  const cardsW = spec.cards.length * (cw + 14) - 14;
  let h = cy + cw + 24;
  const caption = spec.caption ? pen.text(0, h + 22, spec.caption, 14, "start") : "";
  if (caption) h += 30;
  const w = Math.max(W + 34, cardsW);
  return { w, h: h + 18, body: `<g transform="translate(14,22)">${parts.join("")}${caption}</g>` };
}

const T_NAMES: Record<Transform, string> = {
  original: "the shape unchanged",
  flip_h: "the shape reflected left–right",
  flip_v: "the shape reflected top–bottom",
  rotate_180: "the shape turned half a turn",
  rotate_90: "the shape turned a quarter turn clockwise",
  rotate_270: "the shape turned a quarter turn anticlockwise",
};

export function describeReflection(s: ReflectionSpec): string {
  const vertical = (s.first_line ?? "vertical") === "vertical";
  const l = s.labels?.first ?? "l", m = s.labels?.second ?? "m";
  const a = reflectionAnswer(s);
  return [
    `a reflection diagram: a ${vertical ? "vertical" : "horizontal"} dashed line labelled "${l}" and a ${vertical ? "horizontal" : "vertical"} dashed line labelled "${m}" cross`,
    `a shape of ${s.cells.length} grid squares (on a ${s.grid} by ${s.grid} grid: ${s.cells.map(([r, c]) => `row ${r + 1} col ${c + 1}`).join(", ")}) in the top-left corner`,
    s.targets === false ? "" : "empty target boxes in the top-right, bottom-left and bottom-right corners",
    `below, ${s.cards.length} numbered cards: ${s.cards.map((t, i) => `card ${i + 1} = ${T_NAMES[t]}`).join(", ")}`,
    a.symmetric ? "note: the shape is symmetric, so some of these look the same" : "",
    s.caption ? `caption "${s.caption}"` : "",
  ]
    .filter(Boolean)
    .join("; ");
}
