/**
 * Reflection figures, two kinds (`mode`):
 *
 * - "two_lines" (default) — "The shape is reflected in line l and then in line m. Move two shapes into
 *   the correct positions on the diagram." A shape of grid squares sits in one corner of a diagram cut
 *   by two perpendicular dashed lines; empty target boxes fill the other corners; underneath, numbered
 *   cards each show the shape after a transformation. `reflectionAnswer` knows which card goes where.
 * - "one_line" — "Jack flipped this shape across the dashed line. What did his new shape look like?"
 *   The shape with one dashed mirror line beside it, and the cards are the answer choices A, B, C, D
 *   (2 by 2 for four). `mirrorChoiceAnswer` knows which choice is the flipped shape.
 *
 * Squares may be split by a diagonal with one half shaded (`[row, col, "tl"]` = the top-left half), so a
 * reflection has to flip the shading as well as move the squares; "…_squares" cards move the squares but
 * keep each square's shading, the usual mistake.
 *
 * Pure and deterministic (server and browser).
 */
import { z } from "zod";

export const TRANSFORMS = ["original", "flip_h", "flip_v", "rotate_180", "rotate_90", "rotate_270", "flip_h_squares", "flip_v_squares"] as const;
export type Transform = (typeof TRANSFORMS)[number];

/** How a square is filled: all, none, or the half on one side of a diagonal (named by its corner). */
export const PATTERNS = ["full", "empty", "tl", "tr", "bl", "br"] as const;
export type Pattern = (typeof PATTERNS)[number];

const cellSchema = z.union([
  z.tuple([z.number().int().min(0), z.number().int().min(0)]),
  z.tuple([z.number().int().min(0), z.number().int().min(0), z.enum(PATTERNS)]),
]);

export const reflectionSchema = z.object({
  kind: z.literal("reflection"),
  /** "two_lines" (default): lines l and m, target boxes, numbered cards. "one_line": one mirror line, the cards are answer choices A, B, …. */
  mode: z.enum(["two_lines", "one_line"]).optional(),
  /** The shape's grid is n × n. */
  grid: z.number().int().min(2).max(6),
  /** Squares of the shape, [row, col] from the top left (0-based), optionally with how the square is shaded. */
  cells: z.array(cellSchema).min(2).max(30),
  /** Direction of the first line (l) — in one_line mode the mirror line: "vertical" (default, right of the shape) or "horizontal" (below it). */
  first_line: z.enum(["vertical", "horizontal"]).optional(),
  labels: z.object({ first: z.string().max(4).optional(), second: z.string().max(4).optional() }).optional(),
  /** Empty target boxes in the other three corners (two_lines; default true). */
  targets: z.boolean().optional(),
  /** Cards, each the shape after a transformation: numbered 1, 2, … (two_lines) or the choices A, B, … (one_line). */
  cards: z.array(z.enum(TRANSFORMS)).min(2).max(6),
  /** one_line: letters over the choices (default true). */
  choice_labels: z.boolean().optional(),
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

type Cell = [number, number] | [number, number, Pattern];

const FLIP_H: Record<Pattern, Pattern> = { full: "full", empty: "empty", tl: "tr", tr: "tl", bl: "br", br: "bl" };
const FLIP_V: Record<Pattern, Pattern> = { full: "full", empty: "empty", tl: "bl", bl: "tl", tr: "br", br: "tr" };
const TURN: Record<Pattern, Pattern> = { full: "full", empty: "empty", tl: "tr", tr: "br", br: "bl", bl: "tl" }; // quarter turn clockwise

function turnPattern(p: Pattern, t: Transform): Pattern {
  switch (t) {
    case "flip_h":
      return FLIP_H[p];
    case "flip_v":
      return FLIP_V[p];
    case "rotate_180":
      return TURN[TURN[p]];
    case "rotate_90":
      return TURN[p];
    case "rotate_270":
      return TURN[TURN[TURN[p]]];
    default:
      return p; // original, and the "_squares" mistakes keep each square's shading
  }
}

export function transformCells<C extends Cell>(cells: C[], n: number, t: Transform): C[] {
  return cells.map((cell) => {
    const [r, c] = cell;
    let at: [number, number];
    switch (t) {
      case "flip_h":
      case "flip_h_squares":
        at = [r, n - 1 - c];
        break;
      case "flip_v":
      case "flip_v_squares":
        at = [n - 1 - r, c];
        break;
      case "rotate_180":
        at = [n - 1 - r, n - 1 - c];
        break;
      case "rotate_90":
        at = [c, n - 1 - r];
        break;
      case "rotate_270":
        at = [n - 1 - c, r];
        break;
      default:
        at = [r, c];
    }
    return (cell.length > 2 ? [...at, turnPattern(cell[2] as Pattern, t)] : at) as C;
  });
}

/** Shape of a set of squares (with their shading), independent of where it sits. */
export function shapeKey(cells: Cell[]): string {
  const r0 = Math.min(...cells.map((x) => x[0])), c0 = Math.min(...cells.map((x) => x[1]));
  return cells.map(([r, c, p]) => `${r - r0},${c - c0}${p && p !== "full" ? `:${p}` : ""}`).sort().join(" ");
}

const inGrid = (s: ReflectionSpec): Cell[] => (s.cells as Cell[]).filter(([r, c]) => r < s.grid && c < s.grid);
export const isOneLine = (s: Pick<ReflectionSpec, "mode">) => s.mode === "one_line";

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
  const cells = inGrid(s);
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

export interface MirrorChoiceAnswer {
  /** The change that is the flip across the line: flip_h for a vertical line, flip_v for a horizontal one. */
  flip: "flip_h" | "flip_v";
  /** Choices (1-based) that show the flipped shape — exactly one for a good question. */
  rightCards: number[];
  /** The flipped shape looks the same as the shape, so the question gives nothing to find. */
  symmetric: boolean;
  duplicateCards: number[];
}

/** one_line: which answer choice is the shape flipped across the mirror line. */
export function mirrorChoiceAnswer(s: ReflectionSpec): MirrorChoiceAnswer {
  const n = s.grid;
  const cells = inGrid(s);
  const flip = (s.first_line ?? "vertical") === "vertical" ? "flip_h" : "flip_v";
  const right = shapeKey(transformCells(cells, n, flip));
  const keys = s.cards.map((t) => shapeKey(transformCells(cells, n, t)));
  return {
    flip,
    rightCards: keys.flatMap((k, i) => (k === right ? [i + 1] : [])),
    symmetric: right === shapeKey(cells),
    duplicateCards: keys.flatMap((k, i) => (keys.indexOf(k) < i ? [i + 1] : [])),
  };
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** A half-shaded square: the shaded triangle (corner `p`) and its diagonal. */
function halfSquare(p: "tl" | "tr" | "bl" | "br", X: number, Y: number, s: number): { tri: string; diag: [number, number, number, number] } {
  const A = [X, Y], B = [X + s, Y], C = [X + s, Y + s], D = [X, Y + s];
  const pts = { tl: [A, B, D], tr: [A, B, C], br: [B, C, D], bl: [A, C, D] }[p];
  const diag = (p === "tl" || p === "br" ? [B, D] : [A, C]).flat() as [number, number, number, number];
  return { tri: pts.map(([x, y]) => `${r1(x)},${r1(y)}`).join(" "), diag };
}

function shapeSvg(cells: Cell[], n: number, x: number, y: number, s: number, pen: ReflectionPen, grid: boolean): string {
  const on = new Set(cells.map(([r, c]) => `${r},${c}`));
  const out: string[] = [];
  if (grid) for (let i = 0; i <= n; i++) out.push(`<line x1="${x}" y1="${r1(y + i * s)}" x2="${r1(x + n * s)}" y2="${r1(y + i * s)}" stroke="#d6d6d6" stroke-width="0.7"/>`, `<line x1="${r1(x + i * s)}" y1="${y}" x2="${r1(x + i * s)}" y2="${r1(y + n * s)}" stroke="#d6d6d6" stroke-width="0.7"/>`);
  // Squares with their own shading are drawn one by one, each outlined (as on the printed papers).
  if (cells.some((c) => c[2] && c[2] !== "full")) {
    const st = `stroke="${pen.ink}" stroke-width="${pen.sw}" stroke-linejoin="round"`;
    for (const [r, c, p = "full"] of cells) {
      const X = x + c * s, Y = y + r * s;
      out.push(`<rect x="${r1(X)}" y="${r1(Y)}" width="${s}" height="${s}" fill="${p === "full" ? pen.fill : pen.paper}"/>`);
      if (p !== "full" && p !== "empty") {
        const h = halfSquare(p, X, Y, s);
        out.push(`<polygon points="${h.tri}" fill="${pen.fill}"/>`, `<line x1="${r1(h.diag[0])}" y1="${r1(h.diag[1])}" x2="${r1(h.diag[2])}" y2="${r1(h.diag[3])}" ${st}/>`);
      }
      out.push(`<rect x="${r1(X)}" y="${r1(Y)}" width="${s}" height="${s}" fill="none" ${st}/>`);
    }
    return out.join("");
  }
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

/** The squares moved to the top left of their own box, with that box's size in squares. */
function tight(cells: Cell[]): { cells: Cell[]; rows: number; cols: number } {
  const r0 = Math.min(...cells.map((x) => x[0])), c0 = Math.min(...cells.map((x) => x[1]));
  const moved = cells.map((cell) => [cell[0] - r0, cell[1] - c0, ...cell.slice(2)] as Cell);
  return { cells: moved, rows: Math.max(...moved.map((x) => x[0])) + 1, cols: Math.max(...moved.map((x) => x[1])) + 1 };
}

export const LETTERS = "ABCDEF";

function drawOneLine(spec: ReflectionSpec, cells: Cell[], pen: ReflectionPen): { w: number; h: number; body: string } {
  const n = spec.grid;
  const vertical = (spec.first_line ?? "vertical") === "vertical";
  const s = n <= 3 ? 30 : n <= 4 ? 26 : 22;
  const src = tight(cells);
  const parts: string[] = [];
  const dash = `stroke="${pen.ink}" stroke-width="1.6" stroke-dasharray="6 5"`;
  // The shape, and the mirror line beside it (right of it, or under it).
  parts.push(shapeSvg(src.cells, n, 0, 0, s, pen, false));
  const sw = src.cols * s, sh = src.rows * s;
  let top: number;
  if (vertical) {
    const lx = sw + 24;
    parts.push(`<line x1="${lx}" y1="-18" x2="${lx}" y2="${sh + 18}" ${dash}/>`);
    top = sh + 52;
  } else {
    const ly = sh + 24;
    parts.push(`<line x1="-18" y1="${ly}" x2="${sw + 18}" y2="${ly}" ${dash}/>`);
    top = ly + 46;
  }
  // The choices: 2 by 2 for four (else one row of up to three per row).
  const shapes = spec.cards.map((t) => tight(transformCells(cells, n, t)));
  const cw = Math.max(...shapes.map((x) => x.cols)) * s, chh = Math.max(...shapes.map((x) => x.rows)) * s;
  const cols = spec.cards.length === 4 ? 2 : Math.min(3, spec.cards.length);
  const labels = spec.choice_labels !== false;
  const lab = labels ? 26 : 0, gapX = 64, gapY = 34;
  shapes.forEach((sh2, i) => {
    const x = (i % cols) * (lab + cw + gapX), y = top + Math.floor(i / cols) * (chh + gapY);
    if (labels) parts.push(pen.text(x, y + 16, LETTERS[i], 16, "start"));
    parts.push(shapeSvg(sh2.cells, n, x + lab, y, s, pen, !!spec.show_grid));
  });
  const rows = Math.ceil(spec.cards.length / cols);
  let h = top + rows * (chh + gapY) - gapY;
  const w = Math.max(sw + 48, cols * (lab + cw + gapX) - gapX);
  if (spec.caption) {
    parts.push(pen.text(0, h + 26, spec.caption, 14, "start"));
    h += 34;
  }
  return { w: w + 28, h: h + 46, body: `<g transform="translate(14,26)">${parts.join("")}</g>` };
}

export function drawReflection(spec: ReflectionSpec, pen: ReflectionPen): { w: number; h: number; body: string } {
  const n = spec.grid;
  const cells = inGrid(spec);
  if (cells.length < 2) throw new Error("reflection: the shape needs at least 2 squares inside the grid");
  if (isOneLine(spec)) return drawOneLine(spec, cells, pen);
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
  flip_h_squares: "the squares placed as in a left–right reflection but each square's shading not flipped",
  flip_v_squares: "the squares placed as in a top–bottom reflection but each square's shading not flipped",
};

const P_NAMES: Record<Pattern, string> = {
  full: "shaded",
  empty: "unshaded",
  tl: "top-left half shaded",
  tr: "top-right half shaded",
  bl: "bottom-left half shaded",
  br: "bottom-right half shaded",
};

const cellList = (cells: Cell[]) => cells.map(([r, c, p]) => `row ${r + 1} col ${c + 1}${p ? ` (${P_NAMES[p]})` : ""}`).join(", ");

export function describeReflection(s: ReflectionSpec): string {
  const vertical = (s.first_line ?? "vertical") === "vertical";
  if (isOneLine(s)) {
    const cells = inGrid(s);
    const a = mirrorChoiceAnswer(s);
    return [
      `a shape of ${cells.length} squares (${cellList(tight(cells).cells)}${cells.some((c) => c[2] && c[2] !== "full") ? "; a half-shaded square is split by a diagonal" : ""}) with a ${vertical ? "vertical dashed mirror line to its right" : "horizontal dashed mirror line below it"}`,
      `${s.cards.length} answer pictures${s.cards.length === 4 ? " in a 2 by 2 grid" : ""}: ${s.cards.map((t, i) => `${LETTERS[i]} = ${T_NAMES[t]}`).join(", ")}`,
      a.symmetric ? "note: the shape looks the same after the flip" : "",
      s.caption ? `caption "${s.caption}"` : "",
    ]
      .filter(Boolean)
      .join("; ");
  }
  const l = s.labels?.first ?? "l", m = s.labels?.second ?? "m";
  const a = reflectionAnswer(s);
  return [
    `a reflection diagram: a ${vertical ? "vertical" : "horizontal"} dashed line labelled "${l}" and a ${vertical ? "horizontal" : "vertical"} dashed line labelled "${m}" cross`,
    `a shape of ${s.cells.length} grid squares (on a ${s.grid} by ${s.grid} grid: ${cellList(s.cells as Cell[])}) in the top-left corner`,
    s.targets === false ? "" : "empty target boxes in the top-right, bottom-left and bottom-right corners",
    `below, ${s.cards.length} numbered cards: ${s.cards.map((t, i) => `card ${i + 1} = ${T_NAMES[t]}`).join(", ")}`,
    a.symmetric ? "note: the shape is symmetric, so some of these look the same" : "",
    s.caption ? `caption "${s.caption}"` : "",
  ]
    .filter(Boolean)
    .join("; ");
}
