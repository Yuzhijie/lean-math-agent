/**
 * Tiles placed side by side in a row — "Peter had some triangular tiles with sides 3 cm long. He
 * placed them side by side to make a trapezium. The perimeter was 27 cm. How many tiles?"
 *
 * Equilateral triangles alternate up and down (n tiles: n + 2 sides around the outside; an odd
 * number ≥ 3 makes a trapezium, an even number a parallelogram); squares in a row: 2n + 2 sides;
 * hexagons sharing sides: 4n + 2. The figure can show only the first tiles (shaded, then dashed)
 * with dashed lines for the rest of the row, so the count stays the student's to find.
 *
 * Pure and deterministic (server and browser).
 */
import { z } from "zod";

export const TILE_SHAPES = ["triangle", "square", "hexagon"] as const;
export type TileShape = (typeof TILE_SHAPES)[number];

export const tileRowSchema = z.object({
  kind: z.literal("tile_row"),
  tile: z.enum(TILE_SHAPES),
  /** Tiles drawn (1–12). */
  tiles: z.number().int().min(1).max(12),
  /** The first `shaded` tiles are filled (default: all drawn tiles). */
  shaded: z.number().int().min(0).max(12).optional(),
  /** Tiles from this one on (1-based) are drawn as dashed outlines. */
  dashed_from: z.number().int().min(1).max(12).optional(),
  /** Dashed lines along the top and bottom: the row goes on (its length is not shown). */
  continues: z.boolean().optional(),
  /** Text on one side of the first tile, e.g. "3 cm". */
  side_label: z.string().max(20).optional(),
  caption: z.string().max(60).optional(),
});

export type TileRowSpec = z.infer<typeof tileRowSchema>;

export interface TilePen {
  ink: string;
  accent: string;
  fill: string;
  paper: string;
  sw: number;
  text(x: number, y: number, s: string, size?: number, anchor?: "start" | "middle" | "end"): string;
}

/** Number of tile sides around the outside of a row of n tiles. */
export function outsideSides(tile: TileShape, n: number): number {
  return tile === "triangle" ? n + 2 : tile === "square" ? 2 * n + 2 : 4 * n + 2;
}

/** Shape a row of n tiles makes. */
export function rowShape(tile: TileShape, n: number): string {
  if (tile === "triangle") return n === 1 ? "triangle" : n % 2 === 1 ? "trapezium" : "parallelogram";
  if (tile === "square") return n === 1 ? "square" : "rectangle";
  return n === 1 ? "hexagon" : "row of hexagons";
}

const r1 = (v: number) => Math.round(v * 10) / 10;
type P = [number, number];

function tilePoints(tile: TileShape, i: number, s: number): P[] {
  if (tile === "square") return [[i * s, 0], [(i + 1) * s, 0], [(i + 1) * s, s], [i * s, s]];
  if (tile === "triangle") {
    const h = (s * Math.sqrt(3)) / 2;
    const k = Math.floor(i / 2);
    return i % 2 === 0
      ? [[k * s, h], [(k + 1) * s, h], [(k + 0.5) * s, 0]] // pointing up
      : [[(k + 0.5) * s, 0], [(k + 1.5) * s, 0], [(k + 1) * s, h]]; // pointing down
  }
  // pointy-top hexagons sharing their vertical sides
  const w = Math.sqrt(3) * s, cx = w / 2 + i * w, cy = s;
  return [0, 1, 2, 3, 4, 5].map((j) => {
    const a = ((60 * j - 90) * Math.PI) / 180;
    return [cx + s * Math.cos(a), cy + s * Math.sin(a)] as P;
  });
}

export function drawTileRow(spec: TileRowSpec, pen: TilePen): { w: number; h: number; body: string } {
  const s = spec.tile === "hexagon" ? 34 : 60;
  const n = spec.tiles;
  const shaded = Math.min(spec.shaded ?? n, n);
  const dashedFrom = spec.dashed_from ?? Infinity;
  const parts: string[] = [];
  const all: P[] = [];
  for (let i = 0; i < n; i++) {
    const p = tilePoints(spec.tile, i, s);
    all.push(...p);
    const dashed = i + 1 >= dashedFrom;
    const fill = i < shaded && !dashed ? pen.fill : "none";
    parts.push(
      `<polygon points="${p.map(([x, y]) => `${r1(x)},${r1(y)}`).join(" ")}" fill="${fill}" stroke="${dashed ? pen.ink : pen.accent}" stroke-width="${dashed ? 1.4 : pen.sw}" stroke-linejoin="round"${dashed ? ' stroke-dasharray="6 4"' : ""}/>`,
    );
  }
  const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  let maxX = Math.max(...xs);
  if (spec.continues) {
    const ext = s * 1.6;
    const topY = spec.tile === "hexagon" ? minY + s / 2 : minY;
    const botY = spec.tile === "hexagon" ? maxY - s / 2 : maxY;
    // Each line starts where the row ends along that edge.
    const endAt = (y: number) => (spec.tile === "hexagon" ? maxX : Math.max(...all.filter((p) => Math.abs(p[1] - y) < 0.5).map((p) => p[0])));
    parts.push(
      `<line x1="${r1(endAt(topY))}" y1="${r1(topY)}" x2="${r1(maxX + ext)}" y2="${r1(topY)}" stroke="${pen.ink}" stroke-width="1.4" stroke-dasharray="6 4"/>`,
      `<line x1="${r1(endAt(botY))}" y1="${r1(botY)}" x2="${r1(maxX + ext)}" y2="${r1(botY)}" stroke="${pen.ink}" stroke-width="1.4" stroke-dasharray="6 4"/>`,
    );
    maxX += ext;
  }
  let pad = 0;
  if (spec.side_label) {
    // On the left side of the first tile.
    const p = tilePoints(spec.tile, 0, s);
    const [a, b] = spec.tile === "square" ? [p[3], p[0]] : spec.tile === "triangle" ? [p[0], p[2]] : [p[4], p[5]];
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    pad = spec.side_label.length * 8 + 10;
    parts.push(`<g paint-order="stroke" stroke="${pen.paper}" stroke-width="3.5">${pen.text(mx - 8, my + 5, spec.side_label, 14, "end")}</g>`);
  }
  const body = `<g transform="translate(${r1(pad + 4)},${r1(4 - minY)})">${parts.join("")}</g>`;
  let h = maxY - minY + 8;
  let extra = "";
  if (spec.caption) {
    extra = pen.text(0, h + 20, spec.caption, 14, "start");
    h += 28;
  }
  return { w: pad + maxX + 8, h, body: body + extra };
}

const TILE_NAMES: Record<TileShape, string> = {
  triangle: "equilateral triangle tiles placed side by side, alternately pointing up and down",
  square: "square tiles placed side by side",
  hexagon: "regular hexagon tiles placed side by side, each sharing a side with the next",
};

export function describeTileRow(s: TileRowSpec): string {
  const shaded = Math.min(s.shaded ?? s.tiles, s.tiles);
  const dashed = s.dashed_from && s.dashed_from <= s.tiles ? s.tiles - s.dashed_from + 1 : 0;
  const parts = [`a row of ${TILE_NAMES[s.tile]}: ${s.tiles} tile${s.tiles === 1 ? "" : "s"} drawn`];
  if (shaded && shaded < s.tiles) parts.push(`the first ${shaded} shaded`);
  if (dashed) parts.push(`${dashed} drawn as dashed outline${dashed === 1 ? "" : "s"}`);
  if (s.continues) parts.push("dashed lines along the top and bottom show that the row continues (the total number of tiles is not shown)");
  if (s.side_label) parts.push(`one side labelled "${s.side_label}"`);
  if (s.caption) parts.push(`caption "${s.caption}"`);
  return parts.join("; ");
}
