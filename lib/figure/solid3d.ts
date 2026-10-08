/**
 * 3D figures for generated questions: stacks of unit cubes and solids.
 *
 * `cube_stack` — unit cubes stacked on a grid, given as column heights on a
 * map seen from above (first row = back, last row = front, left to right),
 * optionally with a cap on a column (half-cylinder, roof, pyramid, cylinder,
 * cone, dome) and drawn either as unit cubes or as plain blocks (a building).
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

export const VIEW_NAMES = ["front", "left", "right", "side", "top"] as const;
export type ViewName = (typeof VIEW_NAMES)[number];

/** Pieces that can sit on top of a column (or on the ground): one grid cell wide. */
export const CAP_SHAPES = ["half_cylinder", "roof", "pyramid", "cylinder", "cone", "dome"] as const;
export type CapShape = (typeof CAP_SHAPES)[number];
/** Height of each cap in cube units. */
const CAP_H: Record<CapShape, number> = { half_cylinder: 0.5, roof: 0.5, pyramid: 0.6, cylinder: 1, cone: 1, dome: 0.5 };

const capSchema = z.object({
  /** Cell in `heights` (0-based; row 0 = back). */
  row: z.number().int().min(0).max(5),
  col: z.number().int().min(0).max(5),
  shape: z.enum(CAP_SHAPES),
  /** half_cylinder / roof: "x" = the curved or sloping top runs left–right, "y" = front–back. */
  axis: z.enum(["x", "y"]).optional(),
});
export type Cap = z.infer<typeof capSchema>;

export const cubeStackSchema = z.object({
  kind: z.literal("cube_stack"),
  /** Column heights seen from above: first row = back, last row = front; left to right. */
  heights: z.array(z.array(z.number().int().min(0).max(6)).min(1).max(6)).min(1).max(6),
  /** A piece on top of a column (a half-cylinder, a roof, …). */
  caps: z.array(capSchema).max(12).optional(),
  projection: z.enum(["oblique", "isometric"]).optional(),
  /** Lines between the unit cubes (default true); false = plain blocks, like a building. */
  unit_lines: z.boolean().optional(),
  /** Draw the 3D stack (default true); false = only the views. */
  show_stack: z.boolean().optional(),
  /** Views drawn next to the stack; `blank` = an empty grid to draw the view in. "side" = seen from the right. */
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

/** A stack ready to draw: rectangular heights (empty outer rows/columns trimmed) and caps by cell. */
export interface Stack {
  g: number[][];
  caps: Map<string, Cap>;
}

const key = (r: number, c: number) => `${r},${c}`;

export function prepareStack(heights: number[][], caps: Cap[] = []): Stack {
  const cols = Math.max(...heights.map((r) => r.length), ...caps.map((k) => k.col + 1));
  const rows = Math.max(heights.length, ...caps.map((k) => k.row + 1));
  const full = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => Math.max(0, Math.round(heights[r]?.[c] ?? 0))));
  const capAt = new Map(caps.map((k) => [key(k.row, k.col), k]));
  const used = (r: number, c: number) => full[r][c] > 0 || capAt.has(key(r, c));
  let r0 = 0, r1 = rows - 1, c0 = 0, c1 = cols - 1;
  const rowUsed = (r: number) => full[r].some((_, c) => used(r, c));
  const colUsed = (c: number) => full.some((_, r) => used(r, c));
  while (r0 < r1 && !rowUsed(r0)) r0++;
  while (r1 > r0 && !rowUsed(r1)) r1--;
  while (c0 < c1 && !colUsed(c0)) c0++;
  while (c1 > c0 && !colUsed(c1)) c1--;
  const g = full.slice(r0, r1 + 1).map((r) => r.slice(c0, c1 + 1));
  const m = new Map<string, Cap>();
  for (const k of caps) if (k.row >= r0 && k.row <= r1 && k.col >= c0 && k.col <= c1) m.set(key(k.row - r0, k.col - c0), { ...k, row: k.row - r0, col: k.col - c0 });
  return { g, caps: m };
}

/** Rectangular height grid with empty outer rows/columns removed. */
export function normaliseHeights(heights: number[][]): number[][] {
  return prepareStack(heights).g;
}

/** The cells along each line of sight of a view, from the viewer's left to right; each list runs nearest first. */
function sightLines(st: Stack, view: Exclude<ViewName, "top">): Array<Array<[number, number]>> {
  const R = st.g.length, C = st.g[0].length;
  const range = (n: number) => Array.from({ length: n }, (_, i) => i);
  if (view === "front") return range(C).map((c) => range(R).map((i) => [R - 1 - i, c] as [number, number]));
  if (view === "left") return range(R).map((r) => range(C).map((c) => [r, c] as [number, number]));
  return range(R).map((i) => range(C).map((j) => [R - 1 - i, C - 1 - j] as [number, number])); // right / side
}

export interface SideView {
  /** For each position left to right, for each unit height: depth index of the face seen there (-1 = nothing). */
  faces: number[][];
  heights: number[];
  /** Caps seen in this view: position, base height and the outline shape. */
  caps: Array<{ pos: number; base: number; outline: "rect" | "semicircle" | "triangle"; h: number }>;
}

function capOutline(k: Cap, lookingAlong: "x" | "y"): { outline: "rect" | "semicircle" | "triangle"; h: number } {
  const h = CAP_H[k.shape];
  const axis = k.axis ?? "x";
  switch (k.shape) {
    case "half_cylinder":
      return { outline: axis === lookingAlong ? "semicircle" : "rect", h };
    case "roof":
      return { outline: axis === lookingAlong ? "triangle" : "rect", h };
    case "pyramid":
    case "cone":
      return { outline: "triangle", h };
    case "cylinder":
      return { outline: "rect", h };
    default:
      return { outline: "semicircle", h };
  }
}

/** A side view (front, left, right/side) of the stack. */
export function sideView(st: Stack, view: Exclude<ViewName, "top">): SideView {
  const lines = sightLines(st, view);
  const heights = lines.map((l) => Math.max(0, ...l.map(([r, c]) => st.g[r][c])));
  const H = Math.max(...heights);
  const faces = lines.map((l) =>
    Array.from({ length: H }, (_, z) => {
      const i = l.findIndex(([r, c]) => st.g[r][c] > z);
      return i;
    }),
  );
  const caps: SideView["caps"] = [];
  const along = view === "front" ? "y" : "x";
  lines.forEach((l, pos) => {
    let nearer = 0;
    for (const [r, c] of l) {
      const h = st.g[r][c];
      const k = st.caps.get(key(r, c));
      if (k && h >= nearer) caps.push({ pos, base: h, ...capOutline(k, along) });
      nearer = Math.max(nearer, h);
    }
  });
  return { faces, heights, caps };
}

/** A view as columns of squares (heights left to right as the viewer sees them), or the top view as a 0/1 grid. */
export function stackView(heights: number[][], view: ViewName): number[] | number[][] {
  const st = prepareStack(heights);
  if (view === "top") return st.g.map((r) => r.map((h) => (h > 0 ? 1 : 0)));
  return sideView(st, view).heights;
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

// Convex meshes for caps (unit cell, base at z = 0). Smooth faces are parts of a curved surface: no lines between them.
interface Mesh {
  v: V3[];
  f: number[][];
  smooth: boolean[];
}

function extrudeX(profile: Array<[number, number]>, smoothSides: boolean): Mesh {
  // profile: (y, z) points along the top, from y = 1 to y = 0.
  const n = profile.length;
  const v: V3[] = [...profile.map(([y, z]) => [0, y, z] as V3), ...profile.map(([y, z]) => [1, y, z] as V3)];
  const f: number[][] = [profile.map((_, i) => i), profile.map((_, i) => n + i), [0, n - 1, 2 * n - 1, n]];
  const smooth = [false, false, false];
  for (let i = 0; i < n - 1; i++) {
    f.push([i, i + 1, n + i + 1, n + i]);
    smooth.push(smoothSides);
  }
  return { v, f, smooth };
}

function capMesh(k: Cap): Mesh {
  const N = 16;
  let m: Mesh;
  switch (k.shape) {
    case "half_cylinder":
      m = extrudeX(Array.from({ length: N + 1 }, (_, i) => [0.5 + 0.5 * Math.cos((Math.PI * i) / N), 0.5 * Math.sin((Math.PI * i) / N)] as [number, number]), true);
      break;
    case "roof":
      m = extrudeX([[1, 0], [0.5, 0.5], [0, 0]], false);
      break;
    case "pyramid":
      return { v: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0.5, 0.5, CAP_H.pyramid]], f: [[0, 1, 2, 3], [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]], smooth: [false, false, false, false, false] };
    case "cylinder":
    case "cone": {
      const ring = Array.from({ length: N * 2 }, (_, i) => [0.5 + 0.5 * Math.cos((Math.PI * i) / N), 0.5 + 0.5 * Math.sin((Math.PI * i) / N)]);
      const M = ring.length;
      if (k.shape === "cone") {
        const v: V3[] = [...ring.map(([x, y]) => [x, y, 0] as V3), [0.5, 0.5, 1]];
        const f = [ring.map((_, i) => i), ...ring.map((_, i) => [i, (i + 1) % M, M])];
        return { v, f, smooth: f.map((_, i) => i > 0) };
      }
      const v: V3[] = [...ring.map(([x, y]) => [x, y, 0] as V3), ...ring.map(([x, y]) => [x, y, 1] as V3)];
      const f = [ring.map((_, i) => i), ring.map((_, i) => M + i), ...ring.map((_, i) => [i, (i + 1) % M, M + ((i + 1) % M), M + i])];
      return { v, f, smooth: f.map((_, i) => i > 1) };
    }
    default: {
      // dome: rings of latitude and a top point
      const L = 4, M = N * 2;
      const v: V3[] = [];
      for (let j = 0; j < L; j++) {
        const phi = (j / L) * (Math.PI / 2);
        for (let i = 0; i < M; i++) v.push([0.5 + 0.5 * Math.cos(phi) * Math.cos((2 * Math.PI * i) / M), 0.5 + 0.5 * Math.cos(phi) * Math.sin((2 * Math.PI * i) / M), 0.5 * Math.sin(phi)]);
      }
      v.push([0.5, 0.5, 0.5]);
      const f: number[][] = [Array.from({ length: M }, (_, i) => i)];
      for (let j = 0; j < L - 1; j++) for (let i = 0; i < M; i++) f.push([j * M + i, j * M + ((i + 1) % M), (j + 1) * M + ((i + 1) % M), (j + 1) * M + i]);
      for (let i = 0; i < M; i++) f.push([(L - 1) * M + i, (L - 1) * M + ((i + 1) % M), L * M]);
      return { v, f, smooth: f.map((_, i) => i > 0) };
    }
  }
  if ((k.axis ?? "x") === "y") m = { ...m, v: m.v.map(([x, y, z]) => [y, x, z] as V3) };
  return m;
}

const LIGHT: V3 = [0.3, -0.5, 0.8];

function faceShade(fill: string, n: V3): string {
  const k = dot(n, LIGHT) / ((Math.hypot(...n) || 1) * Math.hypot(...LIGHT));
  return shade(fill, Math.max(-0.25, Math.min(0.55, -0.25 + 0.95 * k)));
}

/** Draw a convex mesh: visible faces filled, creases and outlines stroked. */
function drawMesh(m: Mesh, off: V3, P: (p: V3) => V2, d: V3, pen: Pen, sw: number, parts: string[], xs: number[], ys: number[]) {
  const v = m.v.map(([x, y, z]) => [x + off[0], y + off[1], z + off[2]] as V3);
  const centre: V3 = [0, 1, 2].map((k) => v.reduce((a, p) => a + p[k], 0) / v.length) as V3;
  const info = m.f.map((f) => {
    let n = cross(sub(v[f[1]], v[f[0]]), sub(v[f[2]], v[f[0]]));
    if (Math.hypot(...n) < 1e-12 && f.length > 3) n = cross(sub(v[f[2]], v[f[0]]), sub(v[f[3]], v[f[0]]));
    const fc: V3 = [0, 1, 2].map((k) => f.reduce((a, i) => a + v[i][k], 0) / f.length) as V3;
    if (dot(n, sub(fc, centre)) < 0) n = [-n[0], -n[1], -n[2]];
    return { n, vis: dot(n, d) > 1e-9 };
  });
  const pv = v.map(P);
  m.f.forEach((f, i) => {
    if (!info[i].vis) return;
    const c = faceShade(pen.fill, info[i].n);
    parts.push(`<polygon points="${pts(f.map((j) => pv[j]))}" fill="${c}" stroke="${c}" stroke-width="0.6" stroke-linejoin="round"/>`);
    f.forEach((j) => (xs.push(pv[j][0]), ys.push(pv[j][1])));
  });
  const edges = new Map<string, number[]>();
  m.f.forEach((f, i) =>
    f.forEach((a, k) => {
      const b = f[(k + 1) % f.length];
      const id = a < b ? `${a}-${b}` : `${b}-${a}`;
      edges.set(id, [...(edges.get(id) ?? []), i]);
    }),
  );
  for (const [id, fs] of edges) {
    const vis = fs.filter((i) => info[i].vis);
    if (!vis.length) continue;
    if (vis.length === fs.length && fs.every((i) => m.smooth[i])) continue; // inside a curved surface
    const [a, b] = id.split("-").map(Number);
    parts.push(`<line x1="${r1(pv[a][0])}" y1="${r1(pv[a][1])}" x2="${r1(pv[b][0])}" y2="${r1(pv[b][1])}" stroke="${pen.ink}" stroke-width="${sw}" stroke-linecap="round"/>`);
  }
}

function stack3d(st: Stack, projection: "oblique" | "isometric", unitLines: boolean, pen: Pen): Drawn {
  const { g, caps } = st;
  const R = g.length, C = g[0].length;
  const maxH = Math.max(...g.flat(), ...[...caps.values()].map((k) => g[k.row][k.col] + CAP_H[k.shape]));
  const size = Math.max(R, C, maxH);
  const scale = size <= 3 ? 30 : size <= 4 ? 26 : 22;
  const P = projector(projection, scale);
  const d = viewDir(projection);
  const occ = new Set<string>();
  type Piece = { at: V3; cap?: Cap };
  const pieces: Piece[] = [];
  for (let r = 0; r < R; r++)
    for (let c = 0; c < C; c++) {
      for (let z = 0; z < g[r][c]; z++) {
        pieces.push({ at: [c, R - 1 - r, z] });
        occ.add(`${c},${R - 1 - r},${z}`);
      }
      const k = caps.get(key(r, c));
      if (k) pieces.push({ at: [c, R - 1 - r, g[r][c]], cap: k });
    }
  // Far first: larger y, then lower z, then smaller x (valid painter order for both projections).
  pieces.sort((a, b) => b.at[1] - a.at[1] || a.at[2] - b.at[2] || a.at[0] - b.at[0]);
  const sw = Math.max(1.2, pen.sw * 0.75);
  const st2 = `stroke="${pen.ink}" stroke-width="${sw}" stroke-linejoin="round"`;
  const fills = { front: faceShade(pen.fill, [0, -1, 0]), side: faceShade(pen.fill, [1, 0, 0]), top: faceShade(pen.fill, [0, 0, 1]) };
  const has = (x: number, y: number, z: number) => occ.has(`${x},${y},${z}`);
  const parts: string[] = [];
  const xs: number[] = [], ys: number[] = [];
  const line = (a: V3, b: V3) => {
    const [pa, pb] = [P(a), P(b)];
    parts.push(`<line x1="${r1(pa[0])}" y1="${r1(pa[1])}" x2="${r1(pb[0])}" y2="${r1(pb[1])}" stroke="${pen.ink}" stroke-width="${sw}" stroke-linecap="round"/>`);
  };
  // Faces: [corners, fill, exposed(x,y,z), in-plane neighbours per edge]
  for (const { at, cap } of pieces) {
    const [x, y, z] = at;
    if (cap) {
      drawMesh(capMesh(cap), at, P, d, pen, sw, parts, xs, ys);
      continue;
    }
    const faces: Array<{ c: V3[]; fill: string; exposed: (x: number, y: number, z: number) => boolean; nb: V3[] }> = [
      { c: [[x, y, z], [x + 1, y, z], [x + 1, y, z + 1], [x, y, z + 1]], fill: fills.front, exposed: (a, b, cc) => has(a, b, cc) && !has(a, b - 1, cc), nb: [[x, y, z - 1], [x + 1, y, z], [x, y, z + 1], [x - 1, y, z]] },
      { c: [[x + 1, y, z], [x + 1, y + 1, z], [x + 1, y + 1, z + 1], [x + 1, y, z + 1]], fill: fills.side, exposed: (a, b, cc) => has(a, b, cc) && !has(a + 1, b, cc), nb: [[x, y, z - 1], [x, y + 1, z], [x, y, z + 1], [x, y - 1, z]] },
      { c: [[x, y, z + 1], [x + 1, y, z + 1], [x + 1, y + 1, z + 1], [x, y + 1, z + 1]], fill: fills.top, exposed: (a, b, cc) => has(a, b, cc) && !has(a, b, cc + 1), nb: [[x, y - 1, z], [x + 1, y, z], [x, y + 1, z], [x - 1, y, z]] },
    ];
    for (const f of faces) {
      const p = f.c.map(P);
      p.forEach(([px, py]) => (xs.push(px), ys.push(py)));
      if (unitLines) {
        parts.push(`<polygon points="${pts(p)}" fill="${f.fill}" ${st2}/>`);
        continue;
      }
      parts.push(`<polygon points="${pts(p)}" fill="${f.fill}" stroke="${f.fill}" stroke-width="0.6" stroke-linejoin="round"/>`);
      if (!f.exposed(x, y, z)) continue;
      // An edge is drawn unless the same face continues into the neighbouring cube.
      f.c.forEach((a, i) => {
        const [nx, ny, nz] = f.nb[i];
        if (!f.exposed(nx, ny, nz)) line(a, f.c[(i + 1) % 4]);
      });
    }
  }
  return fit(parts, xs, ys);
}

const VIEW_CELL = 22;

function viewGrid(st: Stack, v: NonNullable<CubeStackSpec["views"]>[number], unitLines: boolean, pen: Pen): Drawn {
  const parts: string[] = [];
  const s = VIEW_CELL;
  const sw = Math.max(1.2, pen.sw * 0.75);
  const ink = `stroke="${pen.ink}" stroke-width="${sw}"`;
  const seg = (x1: number, y1: number, x2: number, y2: number) => parts.push(`<line x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}" ${ink} stroke-linecap="round"/>`);
  const cell = (x: number, y: number) => parts.push(unitLines ? `<rect x="${x}" y="${y}" width="${s}" height="${s}" fill="${pen.fill}" ${ink}/>` : `<rect x="${x}" y="${y}" width="${s}" height="${s}" fill="${pen.fill}" stroke="${pen.fill}" stroke-width="0.6"/>`);
  const g = st.g;
  let w: number, h: number;
  if (v.blank) {
    // Empty dotted grid big enough for any view of this stack.
    const n = Math.max(g.length, g[0].length, Math.max(...g.flat()) + (st.caps.size ? 1 : 0)) + 1;
    w = h = n * s;
    for (let i = 0; i <= n; i++) {
      parts.push(`<line x1="${i * s}" y1="0" x2="${i * s}" y2="${h}" stroke="#9e9e9e" stroke-width="0.8" stroke-dasharray="2 3"/>`);
      parts.push(`<line x1="0" y1="${i * s}" x2="${w}" y2="${i * s}" stroke="#9e9e9e" stroke-width="0.8" stroke-dasharray="2 3"/>`);
    }
  } else if (v.view === "top") {
    const R = g.length, C = g[0].length;
    w = C * s;
    h = R * s;
    const on = (r: number, c: number) => r >= 0 && r < R && c >= 0 && c < C && (g[r][c] > 0 || st.caps.has(key(r, c)));
    const top = (r: number, c: number) => (on(r, c) ? g[r][c] : -1);
    for (let r = 0; r < R; r++)
      for (let c = 0; c < C; c++) {
        if (!on(r, c)) continue;
        cell(c * s, r * s);
        if (!unitLines) {
          // Edges where the height changes (or the outline).
          if (top(r - 1, c) !== top(r, c)) seg(c * s, r * s, (c + 1) * s, r * s);
          if (top(r + 1, c) !== top(r, c)) seg(c * s, (r + 1) * s, (c + 1) * s, (r + 1) * s);
          if (top(r, c - 1) !== top(r, c)) seg(c * s, r * s, c * s, (r + 1) * s);
          if (top(r, c + 1) !== top(r, c)) seg((c + 1) * s, r * s, (c + 1) * s, (r + 1) * s);
        }
        const k = st.caps.get(key(r, c));
        if (!k) continue;
        const cx = c * s + s / 2, cy = r * s + s / 2;
        if (k.shape === "cylinder" || k.shape === "dome" || k.shape === "cone") parts.push(`<circle cx="${cx}" cy="${cy}" r="${s / 2 - 1}" fill="none" ${ink}/>`);
        if (k.shape === "cone") parts.push(`<circle cx="${cx}" cy="${cy}" r="1.6" fill="${pen.ink}"/>`);
        if (k.shape === "pyramid") (seg(c * s, r * s, (c + 1) * s, (r + 1) * s), seg((c + 1) * s, r * s, c * s, (r + 1) * s));
        if (k.shape === "roof") (k.axis ?? "x") === "x" ? seg(c * s, cy, (c + 1) * s, cy) : seg(cx, r * s, cx, (r + 1) * s);
      }
  } else {
    const sv = sideView(st, v.view);
    const H = Math.max(...sv.heights, ...sv.caps.map((k) => k.base + k.h));
    w = sv.heights.length * s;
    h = H * s;
    const base = h; // ground line
    const face = (p: number, z: number) => (p >= 0 && p < sv.faces.length ? (sv.faces[p][z] ?? -1) : -1);
    sv.faces.forEach((col, p) =>
      col.forEach((depth, z) => {
        if (depth < 0) return;
        cell(p * s, base - (z + 1) * s);
        if (unitLines) return;
        // Edges where the face seen changes (a step in depth, the outline).
        if (face(p, z - 1) !== depth) seg(p * s, base - z * s, (p + 1) * s, base - z * s);
        if (face(p, z + 1) !== depth) seg(p * s, base - (z + 1) * s, (p + 1) * s, base - (z + 1) * s);
        if (face(p - 1, z) !== depth) seg(p * s, base - z * s, p * s, base - (z + 1) * s);
        if (face(p + 1, z) !== depth) seg((p + 1) * s, base - z * s, (p + 1) * s, base - (z + 1) * s);
      }),
    );
    for (const k of sv.caps) {
      const x0 = k.pos * s, y0 = base - k.base * s, hh = k.h * s;
      const style = `fill="${pen.fill}" ${ink} stroke-linejoin="round"`;
      if (k.outline === "rect") parts.push(`<rect x="${x0}" y="${r1(y0 - hh)}" width="${s}" height="${r1(hh)}" ${style}/>`);
      else if (k.outline === "triangle") parts.push(`<polygon points="${pts([[x0, y0], [x0 + s, y0], [x0 + s / 2, y0 - hh]])}" ${style}/>`);
      else parts.push(`<path d="M${x0},${r1(y0)} A${s / 2},${r1(hh)} 0 0 1 ${x0 + s},${r1(y0)} Z" ${style}/>`);
    }
  }
  const name = v.label ?? (v.view === "side" ? "side view" : v.view);
  parts.push(pen.text(w / 2, h + 20, name, 13));
  return { w: Math.max(w, name.length * 7), h: h + 28, body: `<g transform="translate(${r1(Math.max(0, (name.length * 7 - w) / 2))},0)">${parts.join("")}</g>` };
}

export function drawCubeStack(spec: CubeStackSpec, pen: Pen): Drawn {
  if (!spec.heights.some((r) => r.some((h) => h > 0)) && !spec.caps?.length) throw new Error("cube_stack: the stack has no cubes");
  if (spec.show_stack === false && !spec.views?.length) throw new Error("cube_stack: nothing to draw (show_stack is false and there are no views)");
  for (const k of spec.caps ?? []) if (k.row >= spec.heights.length || k.col >= Math.max(...spec.heights.map((r) => r.length))) throw new Error(`cube_stack: cap at row ${k.row}, col ${k.col} is outside the heights grid`);
  const st = prepareStack(spec.heights, spec.caps);
  const unit = spec.unit_lines !== false;
  const blocks: Drawn[] = [];
  if (spec.show_stack !== false) blocks.push(stack3d(st, spec.projection ?? "oblique", unit, pen));
  for (const v of spec.views ?? []) blocks.push(viewGrid(st, v, unit, pen));
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

const CAP_NAMES: Record<CapShape, (axis: "x" | "y") => string> = {
  half_cylinder: (a) => `a half-cylinder (curved top running ${a === "x" ? "left–right" : "front–back"})`,
  roof: (a) => `a triangular-prism roof (ridge running ${a === "x" ? "left–right" : "front–back"})`,
  pyramid: () => "a square pyramid",
  cylinder: () => "an upright cylinder",
  cone: () => "a cone",
  dome: () => "a dome (hemisphere)",
};

const OUTLINE_NAMES = { rect: "a rectangle", semicircle: "a semicircle", triangle: "a triangle" };

export function describeCubeStack(s: CubeStackSpec): string {
  const st = prepareStack(s.heights, s.caps);
  const { g } = st;
  const n = cubeCount(g);
  const proj = s.projection ?? "oblique";
  const R = g.length;
  const capText = [...st.caps.values()].map((k) => `${CAP_NAMES[k.shape](k.axis ?? "x")} on ${g[k.row][k.col] ? "top of" : "the ground at"} the column in row ${k.row + 1} of ${R} from the back, column ${k.col + 1} from the left`);
  const parts: string[] = [];
  const what = s.unit_lines === false ? `a solid made of ${n} unit cubes, drawn as plain blocks (no lines between the cubes)` : `${n} unit cubes stacked`;
  if (s.show_stack !== false)
    parts.push(
      `${what} and drawn in 3D (${proj} view from the front right, above)${hiddenTops(g, proj) ? " — some cubes cannot be seen from this side" : ""}; seen from above, the number of cubes in each column, back row first, left to right: ${g.map((r) => `[${r.join(", ")}]`).join(" ")} (${n} cubes in all, including any hidden behind or under others)${capText.length ? `; ${capText.join("; ")}` : ""}`,
    );
  else parts.push(`views of a solid made of unit cubes (the solid itself is not drawn): seen from above, cubes in each column, back row first, left to right: ${g.map((r) => `[${r.join(", ")}]`).join(" ")}${capText.length ? `; ${capText.join("; ")}` : ""}`);
  for (const v of s.views ?? []) {
    const name = v.label ? `"${v.label}" (${v.view === "side" ? "side (from the right)" : v.view} view)` : `the ${v.view === "side" ? "side (from the right)" : v.view} view`;
    if (v.blank) parts.push(`an empty grid labelled ${name} for drawing that view`);
    else if (v.view === "top")
      parts.push(
        `${name}: squares seen from above, back row first: ${g.map((r, ri) => r.map((h, c) => (h > 0 || st.caps.has(key(ri, c)) ? "■" : "□")).join("")).join(" / ")}${[...st.caps.values()].map((k) => ` (${k.shape === "pyramid" ? "diagonals" : k.shape === "roof" ? "a ridge line" : k.shape === "half_cylinder" ? "no extra line" : "a circle"} in row ${k.row + 1}, column ${k.col + 1})`).join("")}`,
      );
    else {
      const sv = sideView(st, v.view);
      parts.push(`${name}: columns of squares, left to right, of heights ${sv.heights.join(", ")}${sv.caps.map((k) => `; ${OUTLINE_NAMES[k.outline]} on top of column ${k.pos + 1}`).join("")}`);
    }
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
