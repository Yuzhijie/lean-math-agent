/**
 * 3D figures for generated questions: stacks of unit cubes and solids.
 *
 * `cube_stack` — unit cubes stacked on a grid, given as column heights on a
 * map seen from above (first row = back, last row = front, left to right).
 * Drawn in 3D (oblique, as in most textbooks, or isometric), optionally
 * with its front / left / right / top views as square grids — or as empty
 * grids for the student to draw a view in.
 *
 * `solid` — cube, cuboid, triangular prism, square or triangular pyramid
 * (convex polyhedra: visible faces from the face normals, hidden edges
 * dashed), cylinder, cone, sphere, hemisphere; edges can carry labels
 * ("6 cm"). Dimensions are proportions only — labels carry the values.
 *
 * Pure and deterministic (server and browser). Text goes through the
 * caller's pen so the template's font is used.
 */
import { z } from "zod";

const label = z.string().max(40);
const dim = z.number().finite().positive().max(1000);

export const VIEW_NAMES = ["front", "left", "right", "top"] as const;

export const cubeStackSchema = z
  .object({
    kind: z.literal("cube_stack"),
    /** Column heights seen from above: first row = back, last row = front; left to right. */
    heights: z.array(z.array(z.number().int().min(0).max(6)).min(1).max(6)).min(1).max(6),
    projection: z.enum(["oblique", "isometric"]).optional(),
    /** Draw the 3D stack (default true); false = only the views. */
    show_stack: z.boolean().optional(),
    /** Views drawn next to the stack; `blank` = an empty grid to draw the view in. */
    views: z.array(z.object({ view: z.enum(VIEW_NAMES), label: label.optional(), blank: z.boolean().optional() })).max(4).optional(),
    caption: label.optional(),
  });

export const SOLID_SHAPES = ["cube", "cuboid", "triangular_prism", "square_pyramid", "triangular_pyramid", "cylinder", "cone", "sphere", "hemisphere"] as const;

export const solidSchema = z.object({
  kind: z.literal("solid"),
  shape: z.enum(SOLID_SHAPES),
  /** Proportions: length = left–right, width = front–back (depth), height = up; radius for round solids. */
  length: dim.optional(),
  width: dim.optional(),
  height: dim.optional(),
  radius: dim.optional(),
  /** Text written on the edges (the values the question gives). */
  labels: z.object({ length: label.optional(), width: label.optional(), height: label.optional(), radius: label.optional() }).optional(),
  /** Hidden edges dashed (default: oblique yes, isometric no — there the hidden corner falls on the front corner). */
  hidden_edges: z.boolean().optional(),
  projection: z.enum(["oblique", "isometric"]).optional(),
  caption: label.optional(),
});

export type CubeStackSpec = z.infer<typeof cubeStackSchema>;
export type SolidSpec = z.infer<typeof solidSchema>;

export interface Pen {
  ink: string;
  fill: string;
  paper: string;
  sw: number;
  text(x: number, y: number, s: string, size?: number, anchor?: "start" | "middle" | "end"): string;
}

interface Drawn {
  w: number;
  h: number;
  body: string;
}

type V3 = [number, number, number];
type V2 = [number, number];

const r1 = (v: number) => Math.round(v * 10) / 10;
const C30 = Math.cos(Math.PI / 6);
const OB = 0.5 * Math.SQRT1_2;

/** Screen position (y down) of a world point (x right, y away from the viewer, z up). */
function projector(kind: "oblique" | "isometric", scale: number): (p: V3) => V2 {
  return kind === "isometric"
    ? ([x, y, z]) => [scale * C30 * (x + y), scale * (0.5 * (x - y) - z)]
    : ([x, y, z]) => [scale * (x + OB * y), scale * (-z - OB * y)];
}

/** Direction towards the viewer (both projections look from front-right-above). */
function viewDir(kind: "oblique" | "isometric"): V3 {
  return kind === "isometric" ? [1, -1, 1] : [OB, -1, OB];
}

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(k >= 0 ? c + (255 - c) * k : c * (1 + k)));
  return `#${ch.map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0")).join("")}`;
}

/** Label text with a paper-coloured halo so it stays readable over lines. */
function halo(pen: Pen, x: number, y: number, t: string, size = 14, anchor: "start" | "middle" | "end" = "middle"): string {
  return `<g paint-order="stroke" stroke="${pen.paper}" stroke-width="4" stroke-linejoin="round">${pen.text(x, y, t, size, anchor)}</g>`;
}

const pts = (ps: V2[]) => ps.map(([x, y]) => `${r1(x)},${r1(y)}`).join(" ");

/** Shift a drawing so its content starts at (pad, pad). */
function fit(parts: string[], xs: number[], ys: number[], pad = 4, extraBottom = 0): Drawn {
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const w = Math.max(...xs) - minX, h = Math.max(...ys) - minY;
  return { w: w + 2 * pad, h: h + 2 * pad + extraBottom, body: `<g transform="translate(${r1(pad - minX)},${r1(pad - minY)})">${parts.join("")}</g>` };
}

// ── Cube stacks ─────────────────────────────────────────────────────

/** Rectangular height grid with empty outer rows/columns removed. */
export function normaliseHeights(heights: number[][]): number[][] {
  const cols = Math.max(...heights.map((r) => r.length));
  let g = heights.map((r) => Array.from({ length: cols }, (_, c) => Math.max(0, Math.round(r[c] ?? 0))));
  while (g.length > 1 && g[0].every((h) => h === 0)) g = g.slice(1);
  while (g.length > 1 && g[g.length - 1].every((h) => h === 0)) g = g.slice(0, -1);
  const used = (c: number) => g.some((r) => r[c] > 0);
  let c0 = 0, c1 = cols - 1;
  while (c0 < c1 && !used(c0)) c0++;
  while (c1 > c0 && !used(c1)) c1--;
  return g.map((r) => r.slice(c0, c1 + 1));
}

/** A view as columns of squares (heights left to right as the viewer sees them), or the top view as a 0/1 grid. */
export function stackView(heights: number[][], view: (typeof VIEW_NAMES)[number]): number[] | number[][] {
  const g = normaliseHeights(heights);
  const cols = g[0].length;
  if (view === "top") return g.map((r) => r.map((h) => (h > 0 ? 1 : 0)));
  if (view === "front") return Array.from({ length: cols }, (_, c) => Math.max(...g.map((r) => r[c])));
  const byRow = g.map((r) => Math.max(...r)); // back → front
  return view === "left" ? byRow : byRow.reverse();
}

export function cubeCount(heights: number[][]): number {
  return heights.flat().reduce((a, h) => a + Math.max(0, Math.round(h)), 0);
}

/** Cubes on top of a column that cannot be seen in the drawing (covered in front, on the right and above-front). */
export function hiddenTops(heights: number[][], projection: "oblique" | "isometric" = "oblique"): number {
  const g = normaliseHeights(heights);
  const R = g.length, C = g[0].length;
  const h = (r: number, c: number) => (r >= 0 && r < R && c >= 0 && c < C ? g[r][c] : 0);
  let n = 0;
  for (let r = 0; r < R; r++)
    for (let c = 0; c < C; c++) {
      const top = g[r][c];
      if (!top) continue;
      // The top face of the column is covered by taller columns in front of it (towards the viewer: front, front-right, right).
      const covered =
        projection === "isometric"
          ? h(r + 1, c + 1) > top || (h(r, c + 1) > top && h(r + 1, c) > top)
          : h(r + 1, c) > top && h(r + 1, c + 1) > top;
      if (covered) n++;
    }
  return n;
}

function stack3d(g: number[][], projection: "oblique" | "isometric", pen: Pen): Drawn {
  const R = g.length, C = g[0].length;
  const maxH = Math.max(...g.flat());
  const size = Math.max(R, C, maxH);
  const scale = size <= 3 ? 30 : size <= 4 ? 26 : 22;
  const P = projector(projection, scale);
  const cubes: V3[] = [];
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) for (let z = 0; z < g[r][c]; z++) cubes.push([c, R - 1 - r, z]);
  // Far first: larger y, then lower z, then smaller x (valid painter order for both projections).
  cubes.sort((a, b) => b[1] - a[1] || a[2] - b[2] || a[0] - b[0]);
  const top = shade(pen.fill, 0.55), front = pen.fill, side = shade(pen.fill, -0.18);
  const st = `stroke="${pen.ink}" stroke-width="${Math.max(1.2, pen.sw * 0.75)}" stroke-linejoin="round"`;
  const parts: string[] = [];
  const xs: number[] = [], ys: number[] = [];
  const face = (corners: V3[], fill: string) => {
    const p = corners.map(P);
    p.forEach(([x, y]) => (xs.push(x), ys.push(y)));
    parts.push(`<polygon points="${pts(p)}" fill="${fill}" ${st}/>`);
  };
  for (const [x, y, z] of cubes) {
    face([[x, y, z], [x + 1, y, z], [x + 1, y, z + 1], [x, y, z + 1]], front);
    face([[x + 1, y, z], [x + 1, y + 1, z], [x + 1, y + 1, z + 1], [x + 1, y, z + 1]], side);
    face([[x, y, z + 1], [x + 1, y, z + 1], [x + 1, y + 1, z + 1], [x, y + 1, z + 1]], top);
  }
  return fit(parts, xs, ys);
}

const VIEW_CELL = 18;

function viewGrid(g: number[][], v: NonNullable<CubeStackSpec["views"]>[number], pen: Pen): Drawn {
  const parts: string[] = [];
  const s = VIEW_CELL;
  const sq = (x: number, y: number) => `<rect x="${x}" y="${y}" width="${s}" height="${s}" fill="${pen.fill}" stroke="${pen.ink}" stroke-width="${Math.max(1.2, pen.sw * 0.75)}"/>`;
  let w: number, h: number;
  if (v.blank) {
    // Empty dotted grid big enough for any view of this stack.
    const n = Math.max(g.length, g[0].length, Math.max(...g.flat())) + 1;
    w = h = n * s;
    for (let i = 0; i <= n; i++) {
      parts.push(`<line x1="${i * s}" y1="0" x2="${i * s}" y2="${h}" stroke="#9e9e9e" stroke-width="0.8" stroke-dasharray="2 3"/>`);
      parts.push(`<line x1="0" y1="${i * s}" x2="${w}" y2="${i * s}" stroke="#9e9e9e" stroke-width="0.8" stroke-dasharray="2 3"/>`);
    }
  } else if (v.view === "top") {
    const t = stackView(g, "top") as number[][];
    w = t[0].length * s;
    h = t.length * s;
    t.forEach((row, r) => row.forEach((on, c) => on && parts.push(sq(c * s, r * s))));
  } else {
    const cols = stackView(g, v.view) as number[];
    const maxH = Math.max(...cols);
    w = cols.length * s;
    h = maxH * s;
    cols.forEach((n, c) => {
      for (let k = 0; k < n; k++) parts.push(sq(c * s, h - (k + 1) * s));
    });
  }
  const name = v.label ?? v.view;
  parts.push(pen.text(w / 2, h + 20, name, 13));
  return { w: Math.max(w, name.length * 7), h: h + 28, body: `<g transform="translate(${r1(Math.max(0, (name.length * 7 - w) / 2))},0)">${parts.join("")}</g>` };
}

export function drawCubeStack(spec: CubeStackSpec, pen: Pen): Drawn {
  if (!spec.heights.some((r) => r.some((h) => h > 0))) throw new Error("cube_stack: the stack has no cubes");
  if (spec.show_stack === false && !spec.views?.length) throw new Error("cube_stack: nothing to draw (show_stack is false and there are no views)");
  const g = normaliseHeights(spec.heights);
  const blocks: Drawn[] = [];
  if (spec.show_stack !== false) blocks.push(stack3d(g, spec.projection ?? "oblique", pen));
  for (const v of spec.views ?? []) blocks.push(viewGrid(g, v, pen));
  const gap = 28;
  const H = Math.max(...blocks.map((b) => b.h));
  let x = 0;
  const parts: string[] = [];
  for (const b of blocks) {
    // Bottom-align the blocks (views sit on the same base line as the stack).
    parts.push(`<g transform="translate(${r1(x)},${r1(H - b.h)})">${b.body}</g>`);
    x += b.w + gap;
  }
  let h = H;
  if (spec.caption) {
    parts.push(pen.text(0, h + 22, spec.caption, 13, "start"));
    h += 30;
  }
  return { w: x - gap, h, body: parts.join("") };
}

export function describeCubeStack(s: CubeStackSpec): string {
  const g = normaliseHeights(s.heights);
  const n = cubeCount(g);
  const proj = s.projection ?? "oblique";
  const parts: string[] = [];
  if (s.show_stack !== false)
    parts.push(
      `${n} unit cubes stacked and drawn in 3D (${proj} view from the front right, above)${hiddenTops(g, proj) ? " — some cubes cannot be seen from this side" : ""}; seen from above, the number of cubes in each column, back row first, left to right: ${g.map((r) => `[${r.join(", ")}]`).join(" ")} (${n} cubes in all, including any hidden behind or under others)`,
    );
  else parts.push(`views of a stack of unit cubes (the stack itself is not drawn)`);
  for (const v of s.views ?? []) {
    const name = v.label ? `"${v.label}" (${v.view} view)` : `the ${v.view} view`;
    if (v.blank) parts.push(`an empty grid labelled ${name} for drawing that view`);
    else if (v.view === "top") parts.push(`${name}: squares seen from above, back row first: ${(stackView(g, "top") as number[][]).map((r) => r.map((on) => (on ? "■" : "□")).join("")).join(" / ")}`);
    else parts.push(`${name}: columns of squares, left to right, of heights ${(stackView(g, v.view) as number[]).join(", ")}`);
  }
  if (s.caption) parts.push(`caption "${s.caption}"`);
  return parts.join("; ");
}

// ── Solids ──────────────────────────────────────────────────────────

interface Poly {
  v: V3[];
  f: number[][];
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function polyOf(shape: SolidSpec["shape"], L: number, W: number, H: number): Poly {
  switch (shape) {
    case "cube":
    case "cuboid":
      return {
        v: [[0, 0, 0], [L, 0, 0], [L, W, 0], [0, W, 0], [0, 0, H], [L, 0, H], [L, W, H], [0, W, H]],
        f: [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]],
      };
    case "triangular_prism":
      return {
        v: [[0, 0, 0], [L, 0, 0], [L / 2, 0, H], [0, W, 0], [L, W, 0], [L / 2, W, H]],
        f: [[0, 1, 2], [3, 4, 5], [0, 1, 4, 3], [1, 2, 5, 4], [2, 0, 3, 5]],
      };
    case "square_pyramid":
      return { v: [[0, 0, 0], [L, 0, 0], [L, W, 0], [0, W, 0], [L / 2, W / 2, H]], f: [[0, 1, 2, 3], [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]] };
    default: // triangular_pyramid
      return { v: [[0, 0, 0], [L, 0, 0], [L * 0.4, W, 0], [L * 0.47, W / 3, H]], f: [[0, 1, 2], [0, 1, 3], [1, 2, 3], [2, 0, 3]] };
  }
}

function dims(s: SolidSpec): { L: number; W: number; H: number } {
  const cube = s.shape === "cube";
  const a = s.length ?? s.width ?? s.height ?? 1;
  let L = cube ? a : s.length ?? 6, W = cube ? a : s.width ?? (s.shape === "triangular_prism" ? 7 : 4), H = cube ? a : s.height ?? (s.shape === "cuboid" ? 4 : 5);
  const m = Math.max(L, W, H);
  // Keep every edge visible: no side below a quarter of the longest.
  [L, W, H] = [L, W, H].map((d) => Math.max(d / m, 0.25));
  return { L, W, H };
}

const showHidden = (s: SolidSpec) => s.hidden_edges ?? (s.projection ?? "oblique") !== "isometric";

function polyhedron(s: SolidSpec, pen: Pen): Drawn {
  const proj = s.projection ?? "oblique";
  const { L, W, H } = dims(s);
  const scale = proj === "isometric" ? 100 : 135;
  const P = projector(proj, scale);
  const poly = polyOf(s.shape, L, W, H);
  const centre: V3 = [0, 1, 2].map((k) => poly.v.reduce((a, p) => a + p[k], 0) / poly.v.length) as V3;
  const d = viewDir(proj);
  const visible = poly.f.map((f) => {
    let n = cross(sub(poly.v[f[1]], poly.v[f[0]]), sub(poly.v[f[2]], poly.v[f[0]]));
    const fc: V3 = [0, 1, 2].map((k) => f.reduce((a, i) => a + poly.v[i][k], 0) / f.length) as V3;
    if (dot(n, sub(fc, centre)) < 0) n = [-n[0], -n[1], -n[2]];
    const len = Math.hypot(...n) || 1;
    return { vis: dot(n, d) > 1e-6, light: (0.25 * n[0] - 0.35 * n[1] + 0.9 * n[2]) / len };
  });
  const edges = new Map<string, { a: number; b: number; vis: boolean }>();
  poly.f.forEach((f, i) =>
    f.forEach((a, k) => {
      const b = f[(k + 1) % f.length];
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      const e = edges.get(key) ?? { a, b, vis: false };
      e.vis ||= visible[i].vis;
      edges.set(key, e);
    }),
  );
  const parts: string[] = [];
  const pv = poly.v.map(P);
  const xs = pv.map((p) => p[0]), ys = pv.map((p) => p[1]);
  poly.f.forEach((f, i) => {
    if (!visible[i].vis) return;
    const k = visible[i].light;
    parts.push(`<polygon points="${pts(f.map((j) => pv[j]))}" fill="${shade(pen.fill, k > 0.6 ? 0.55 : k > 0 ? 0 : -0.15)}" stroke="none"/>`);
  });
  const sw = pen.sw;
  const line = (a: V2, b: V2, dashed: boolean) => `<line x1="${r1(a[0])}" y1="${r1(a[1])}" x2="${r1(b[0])}" y2="${r1(b[1])}" stroke="${pen.ink}" stroke-width="${dashed ? Math.max(1, sw * 0.6) : sw}" stroke-linecap="round"${dashed ? ' stroke-dasharray="5 4"' : ""}/>`;
  for (const e of edges.values()) if (!e.vis && showHidden(s)) parts.push(line(pv[e.a], pv[e.b], true));
  for (const e of edges.values()) if (e.vis) parts.push(line(pv[e.a], pv[e.b], false));
  // Labels on edges, pushed away from the middle of the drawing.
  const mid2: V2 = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  const edgeLabel = (a: V3, b: V3, t: string | undefined) => {
    if (!t) return;
    const [pa, pb] = [P(a), P(b)];
    const m: V2 = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
    let ox = m[0] - mid2[0], oy = m[1] - mid2[1];
    const n = Math.hypot(ox, oy) || 1;
    ox /= n;
    oy /= n;
    const x = m[0] + ox * 14, y = m[1] + oy * 14 + 5;
    parts.push(halo(pen, x, y, t, 14, Math.abs(ox) < 0.35 ? "middle" : ox > 0 ? "start" : "end"));
    xs.push(x + (ox > 0 ? t.length * 8 : ox < -0.35 ? -t.length * 8 : 0));
    ys.push(y + 4, y - 14);
  };
  const lb = s.labels ?? {};
  const pyramid = s.shape === "square_pyramid" || s.shape === "triangular_pyramid";
  edgeLabel([0, 0, 0], [L, 0, 0], lb.length);
  if (s.shape === "triangular_pyramid") edgeLabel([L, 0, 0], [L * 0.4, W, 0], lb.width);
  else edgeLabel([L, 0, 0], [L, W, 0], lb.width);
  if (pyramid || s.shape === "triangular_prism") {
    if (lb.height) {
      // Height drawn as a dashed altitude.
      const apex = poly.v[s.shape === "triangular_prism" ? 2 : poly.v.length - 1];
      const foot: V3 = [apex[0], apex[1], 0];
      parts.push(line(P(foot), P(apex), true));
      const [fx, fy] = P(foot), [ax, ay] = P(apex);
      parts.push(halo(pen, (fx + ax) / 2 + 6, (fy + ay) / 2 + 5, lb.height, 14, "start"));
    }
  } else edgeLabel([0, 0, 0], [0, 0, H], lb.height);
  return fit(parts, xs, ys, 6);
}

function round(s: SolidSpec, pen: Pen): Drawn {
  const { radius, labels: lb = {} } = s;
  const r = 70;
  const ry = r * 0.3;
  const hRaw = s.height && radius ? s.height / radius : s.shape === "cone" ? 2.2 : 1.8;
  const H = s.shape === "sphere" || s.shape === "hemisphere" ? 0 : Math.max(0.6, Math.min(4, hRaw)) * r;
  const sw = pen.sw;
  const st = `stroke="${pen.ink}" stroke-width="${sw}" stroke-linecap="round"`;
  const dash = `stroke="${pen.ink}" stroke-width="${Math.max(1, sw * 0.6)}" stroke-dasharray="5 4"`;
  const hidden = s.hidden_edges !== false;
  const light = shade(pen.fill, 0.55);
  const parts: string[] = [];
  const labels: string[] = [];
  const cx = 0;
  // Ellipse halves: front = lower arc, back = upper arc.
  const front = (y: number) => `M${-r},${r1(y)} A${r},${r1(ry)} 0 0 0 ${r},${r1(y)}`;
  const back = (y: number) => `M${-r},${r1(y)} A${r},${r1(ry)} 0 0 1 ${r},${r1(y)}`;
  const radiusLine = (y: number, dashed = false) => {
    if (!lb.radius && !radius) return;
    parts.push(`<line x1="${cx}" y1="${r1(y)}" x2="${r}" y2="${r1(y)}" ${dashed ? dash : st}/>`, `<circle cx="${cx}" cy="${r1(y)}" r="2.5" fill="${pen.ink}"/>`);
    if (lb.radius) labels.push(halo(pen, r / 2, y - 7, lb.radius, 14));
  };
  let top = 0, bottom = 0;
  if (s.shape === "cylinder") {
    top = 0;
    bottom = H;
    parts.push(`<path d="M${-r},0 L${-r},${r1(H)} A${r},${r1(ry)} 0 0 0 ${r},${r1(H)} L${r},0 Z" fill="${pen.fill}" stroke="none"/>`);
    parts.push(`<ellipse cx="0" cy="0" rx="${r}" ry="${r1(ry)}" fill="${light}" ${st}/>`);
    parts.push(`<line x1="${-r}" y1="0" x2="${-r}" y2="${r1(H)}" ${st}/>`, `<line x1="${r}" y1="0" x2="${r}" y2="${r1(H)}" ${st}/>`);
    parts.push(`<path d="${front(H)}" fill="none" ${st}/>`);
    if (hidden) parts.push(`<path d="${back(H)}" fill="none" ${dash}/>`);
    radiusLine(0);
    if (lb.height) labels.push(halo(pen, r + 8, H / 2 + 5, lb.height, 14, "start"));
    top = -ry;
    bottom = H + ry;
  } else if (s.shape === "cone") {
    parts.push(`<path d="M0,${r1(-H)} L${-r},0 A${r},${r1(ry)} 0 0 0 ${r},0 Z" fill="${pen.fill}" stroke="none"/>`);
    parts.push(`<line x1="0" y1="${r1(-H)}" x2="${-r}" y2="0" ${st}/>`, `<line x1="0" y1="${r1(-H)}" x2="${r}" y2="0" ${st}/>`);
    parts.push(`<path d="${front(0)}" fill="none" ${st}/>`);
    if (hidden) parts.push(`<path d="${back(0)}" fill="none" ${dash}/>`);
    if (lb.height) parts.push(`<line x1="0" y1="${r1(-H)}" x2="0" y2="0" ${dash}/>`, halo(pen, -6, -H / 2 + 5, lb.height, 14, "end"));
    radiusLine(0, false);
    top = -H;
    bottom = ry;
  } else if (s.shape === "sphere") {
    parts.push(`<circle cx="0" cy="0" r="${r}" fill="${pen.fill}" ${st}/>`);
    parts.push(`<path d="${front(0)}" fill="none" stroke="${pen.ink}" stroke-width="${Math.max(1, sw * 0.7)}"/>`);
    if (hidden) parts.push(`<path d="${back(0)}" fill="none" ${dash}/>`);
    radiusLine(0);
    top = -r;
    bottom = r;
  } else {
    // Hemisphere, dome up.
    parts.push(`<path d="M${-r},0 A${r},${r} 0 0 1 ${r},0 A${r},${r1(ry)} 0 0 1 ${-r},0 Z" fill="${pen.fill}" stroke="none"/>`);
    parts.push(`<path d="M${-r},0 A${r},${r} 0 0 1 ${r},0" fill="none" ${st}/>`);
    parts.push(`<path d="${front(0)}" fill="none" ${st}/>`);
    if (hidden) parts.push(`<path d="${back(0)}" fill="none" ${dash}/>`);
    radiusLine(0);
    top = -r;
    bottom = ry;
  }
  parts.push(...labels);
  const labelW = Math.max(lb.height?.length ?? 0, lb.radius?.length ?? 0) * 8 + 14;
  return fit(parts, [-r - (s.shape === "cone" && lb.height ? labelW : 0), r + (s.shape === "cylinder" && lb.height ? labelW : 0)], [top - (lb.radius ? 4 : 0), bottom], 6);
}

export function drawSolid(spec: SolidSpec, pen: Pen): Drawn {
  const d = ["cylinder", "cone", "sphere", "hemisphere"].includes(spec.shape) ? round(spec, pen) : polyhedron(spec, pen);
  if (!spec.caption) return d;
  return { w: Math.max(d.w, spec.caption.length * 8), h: d.h + 28, body: d.body + pen.text(d.w / 2, d.h + 20, spec.caption, 14) };
}

const SHAPE_NAMES: Record<SolidSpec["shape"], string> = {
  cube: "a cube",
  cuboid: "a cuboid (rectangular prism)",
  triangular_prism: "a triangular prism lying on a rectangular face",
  square_pyramid: "a square-based pyramid",
  triangular_pyramid: "a triangular pyramid (tetrahedron)",
  cylinder: "an upright cylinder",
  cone: "an upright cone",
  sphere: "a sphere",
  hemisphere: "a hemisphere, flat face down",
};

export function describeSolid(s: SolidSpec): string {
  const lb = s.labels ?? {};
  const labels = (["length", "width", "height", "radius"] as const).filter((k) => lb[k]).map((k) => `${k} labelled "${lb[k]}"`);
  const round = ["cylinder", "cone", "sphere", "hemisphere"].includes(s.shape);
  const prop = !round && s.shape !== "cube" && (s.length || s.width || s.height) ? ` drawn in proportion length : width : height ≈ ${[s.length ?? "?", s.width ?? "?", s.height ?? "?"].join(" : ")}` : "";
  return `${SHAPE_NAMES[s.shape]} drawn in 3D${round ? "" : ` (${s.projection ?? "oblique"} view)`}${prop}${labels.length ? `; ${labels.join(", ")}` : "; no measurements written on it"}${round || showHidden(s) ? (s.hidden_edges === false ? "; hidden edges not drawn" : "; hidden edges dashed") : "; hidden edges not drawn"}${s.caption ? `; caption "${s.caption}"` : ""}`;
}
