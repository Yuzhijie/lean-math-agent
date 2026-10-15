/**
 * Things standing in a row along a street — "Pete, Sita, Lin and Ben live in these four houses … What is
 * the order of the houses from left to right?", "Which shop is next to the school?".
 *
 * Simple generic drawings (house, tree, shop, school, block of flats, bush, lamp post, car, flower pot)
 * side by side on a strip of grass and a road, each with an optional colour and a short label under it.
 * Nothing is labelled unless the question gives it, so an ordering question keeps its answer hidden.
 *
 * Pure and deterministic (server and browser).
 */
import { z } from "zod";

export const STREET_THINGS = ["house", "tree", "shop", "school", "flats", "bush", "lamp", "car", "pot"] as const;
export type StreetThing = (typeof STREET_THINGS)[number];

/** Named colours (walls, car body, pot). */
export const STREET_COLOURS: Record<string, string> = {
  blue: "#cfe6f5",
  yellow: "#f5c842",
  pink: "#f4c6d4",
  purple: "#d8d3ec",
  green: "#bfe3b4",
  orange: "#f6b77a",
  white: "#f4f4f4",
  red: "#e8504f",
  grey: "#c9c9c9",
  brown: "#b98a5a",
  black: "#3a3a3a",
};
const COLOUR_NAMES = Object.keys(STREET_COLOURS) as [string, ...string[]];
/** Wall colours used in turn when none is given. */
const WALLS = ["blue", "yellow", "pink", "purple", "green", "orange"];

export const streetSchema = z.object({
  kind: z.literal("street"),
  /** From left to right. */
  items: z
    .array(
      z.object({
        thing: z.enum(STREET_THINGS),
        colour: z.enum(COLOUR_NAMES).optional(),
        /** Short text under it (a letter, a number, a name the question gives). */
        label: z.string().max(14).optional(),
      }),
    )
    .min(1)
    .max(10),
  /** Grass and road along the bottom (default true). */
  ground: z.boolean().optional(),
  caption: z.string().max(60).optional(),
});

export type StreetSpec = z.infer<typeof streetSchema>;

export interface StreetPen {
  ink: string;
  paper: string;
  sw: number;
  text(x: number, y: number, s: string, size?: number, anchor?: "start" | "middle" | "end"): string;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const ROOF = "#e0384f", WINDOW = "#2b3a8f", DOOR = "#7a4a1f", TRUNK = "#6b3f1d", LEAF = "#8cc152", GRASS = "#d6e04a", ROAD = "#8e8e8e";

const WIDTH: Record<StreetThing, number> = { house: 120, tree: 150, shop: 130, school: 160, flats: 100, bush: 70, lamp: 40, car: 100, pot: 50 };

const rect = (x: number, y: number, w: number, h: number, fill: string, ink: string, sw: number, extra = "") =>
  `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" fill="${fill}" stroke="${ink}" stroke-width="${sw}"${extra}/>`;
const poly = (pts: Array<[number, number]>, fill: string, ink: string, sw: number) =>
  `<polygon points="${pts.map(([x, y]) => `${r1(x)},${r1(y)}`).join(" ")}" fill="${fill}" stroke="${ink}" stroke-width="${sw}" stroke-linejoin="round"/>`;

/** A four-pane window with its top-left corner at (x, y). */
function window4(x: number, y: number, s: number, paper: string): string {
  const h = s / 2;
  return `<rect x="${r1(x)}" y="${r1(y)}" width="${s}" height="${s}" fill="${WINDOW}"/><line x1="${r1(x + h)}" y1="${r1(y)}" x2="${r1(x + h)}" y2="${r1(y + s)}" stroke="${paper}" stroke-width="2"/><line x1="${r1(x)}" y1="${r1(y + h)}" x2="${r1(x + s)}" y2="${r1(y + h)}" stroke="${paper}" stroke-width="2"/>`;
}

/** One thing standing on the ground line `g`, centred at `cx`. */
function thing(t: StreetThing, cx: number, g: number, wall: string, pen: StreetPen): string {
  const { ink, paper } = pen;
  const sw = Math.max(1, pen.sw * 0.8);
  switch (t) {
    case "house": {
      const w = 96, h = 66, x = cx - w / 2, y = g - h;
      return [
        rect(cx + 20, y - 40, 10, 22, ROOF, ink, sw), // chimney
        rect(x, y, w, h, wall, ink, sw),
        poly([[x - 12, y + 2], [cx, y - 44], [x + w + 12, y + 2]], ROOF, ink, sw),
        window4(x + 14, y + 16, 24, paper),
        rect(x + w - 36, y + 20, 22, h - 20, DOOR, paper, 2),
      ].join("");
    }
    case "shop": {
      const w = 110, h = 74, x = cx - w / 2, y = g - h;
      const stripes = Array.from({ length: 6 }, (_, i) => `<rect x="${r1(x + (i * w) / 6)}" y="${r1(y + 16)}" width="${r1(w / 6)}" height="14" fill="${i % 2 ? paper : ROOF}"/>`).join("");
      return [rect(x, y, w, h, wall, ink, sw), rect(x, y, w, 16, "#555555", ink, sw), stripes, rect(x, y + 16, w, 14, "none", ink, sw), window4(x + 12, y + 38, 30, paper), rect(x + w - 40, y + 36, 26, h - 36, DOOR, paper, 2)].join("");
    }
    case "school": {
      const w = 140, h = 80, x = cx - w / 2, y = g - h;
      const wins = [0, 1, 2, 3].map((i) => (i === 1 || i === 2 ? "" : window4(x + 12 + i * 32, y + 18, 22, paper))).join("");
      return [
        `<line x1="${r1(cx)}" y1="${r1(y - 34)}" x2="${r1(cx)}" y2="${r1(y - 78)}" stroke="${ink}" stroke-width="2"/>`,
        poly([[cx, y - 78], [cx + 26, y - 70], [cx, y - 62]], ROOF, ink, sw),
        rect(x, y, w, h, wall, ink, sw),
        poly([[x - 8, y + 2], [cx, y - 34], [x + w + 8, y + 2]], ROOF, ink, sw),
        wins,
        rect(cx - 16, y + 34, 32, h - 34, DOOR, paper, 2),
        `<circle cx="${r1(cx)}" cy="${r1(y - 10)}" r="9" fill="${paper}" stroke="${ink}" stroke-width="${sw}"/>`,
      ].join("");
    }
    case "flats": {
      const w = 84, h = 150, x = cx - w / 2, y = g - h;
      const wins: string[] = [];
      for (let r = 0; r < 5; r++) for (let c = 0; c < 2; c++) wins.push(window4(x + 12 + c * 38, y + 10 + r * 26, 20, paper));
      return rect(x, y, w, h, wall, ink, sw) + wins.join("");
    }
    case "tree": {
      const top = g - 170;
      const blobs: Array<[number, number, number]> = [[0, 60, 46], [-40, 74, 34], [40, 74, 34], [-28, 40, 32], [28, 40, 32], [0, 30, 34]];
      return [
        poly([[cx - 9, g], [cx - 5, top + 80], [cx + 5, top + 80], [cx + 11, g]], TRUNK, ink, sw),
        ...blobs.map(([dx, dy, r]) => `<circle cx="${r1(cx + dx)}" cy="${r1(top + dy)}" r="${r}" fill="${LEAF}" stroke="${ink}" stroke-width="${sw}"/>`),
        ...blobs.map(([dx, dy, r]) => `<circle cx="${r1(cx + dx)}" cy="${r1(top + dy)}" r="${r - sw}" fill="${LEAF}"/>`),
        `<path d="M${r1(cx)},${r1(top + 110)} L${r1(cx - 16)},${r1(top + 66)} M${r1(cx + 2)},${r1(top + 96)} L${r1(cx + 22)},${r1(top + 58)}" stroke="${TRUNK}" stroke-width="5" stroke-linecap="round"/>`,
      ].join("");
    }
    case "bush":
      return [[-18, 18], [18, 18], [0, 24]].map(([dx, r]) => `<circle cx="${r1(cx + dx)}" cy="${r1(g - r)}" r="${r}" fill="${LEAF}" stroke="${ink}" stroke-width="${sw}"/>`).join("");
    case "lamp":
      return [`<line x1="${r1(cx)}" y1="${r1(g)}" x2="${r1(cx)}" y2="${r1(g - 110)}" stroke="#444" stroke-width="5"/>`, rect(cx - 10, g - 124, 20, 16, "#ffe680", ink, sw)].join("");
    case "car": {
      const w = 90, x = cx - w / 2, y = g - 40;
      return [
        poly([[x + 18, y], [x + 30, y - 22], [x + 62, y - 22], [x + 74, y]], wall, ink, sw),
        rect(x, y, w, 26, wall, ink, sw, ' rx="6"'),
        rect(x + 33, y - 18, 12, 14, "#cfe6f5", ink, 1),
        rect(x + 49, y - 18, 12, 14, "#cfe6f5", ink, 1),
        ...[x + 20, x + w - 20].map((wx) => `<circle cx="${r1(wx)}" cy="${r1(g - 12)}" r="11" fill="#333" stroke="${ink}" stroke-width="${sw}"/><circle cx="${r1(wx)}" cy="${r1(g - 12)}" r="4" fill="#ccc"/>`),
      ].join("");
    }
    case "pot":
      return [
        `<line x1="${r1(cx)}" y1="${r1(g - 34)}" x2="${r1(cx)}" y2="${r1(g - 62)}" stroke="#4c8b2b" stroke-width="3"/>`,
        `<circle cx="${r1(cx)}" cy="${r1(g - 66)}" r="8" fill="#f2c230" stroke="${ink}" stroke-width="1"/>`,
        poly([[cx - 18, g - 36], [cx + 18, g - 36], [cx + 14, g], [cx - 14, g]], wall, ink, sw),
      ].join("");
  }
}

export function drawStreet(spec: StreetSpec, pen: StreetPen): { w: number; h: number; body: string } {
  const gap = 18;
  const tallest = Math.max(...spec.items.map((i) => ({ tree: 170, flats: 150, school: 158, house: 110, shop: 74, lamp: 124, car: 62, pot: 74, bush: 48 })[i.thing]));
  const g = tallest + 10;
  const labelled = spec.items.some((i) => i.label);
  let x = 10;
  let wall = 0;
  const parts: string[] = [];
  const centres: number[] = [];
  for (const it of spec.items) {
    const w = WIDTH[it.thing];
    const cx = x + w / 2;
    centres.push(cx);
    const colour = STREET_COLOURS[it.colour ?? (it.thing === "car" ? "red" : it.thing === "pot" ? "brown" : WALLS[wall % WALLS.length])];
    if (!it.colour && ["house", "shop", "school", "flats"].includes(it.thing)) wall++;
    parts.push(thing(it.thing, cx, g, colour, pen));
    x += w + gap;
  }
  const W = x - gap + 10;
  const ground = spec.ground !== false ? `<rect x="0" y="${g}" width="${r1(W)}" height="8" fill="${GRASS}"/><rect x="0" y="${g + 8}" width="${r1(W)}" height="8" fill="${ROAD}"/>` : `<line x1="0" y1="${g}" x2="${r1(W)}" y2="${g}" stroke="${pen.ink}" stroke-width="${pen.sw}"/>`;
  let h = g + 16;
  const labels = labelled ? spec.items.map((it, i) => (it.label ? pen.text(centres[i], g + 40, it.label, 18) : "")).join("") : "";
  if (labelled) h += 32;
  const caption = spec.caption ? pen.text(0, h + 24, spec.caption, 14, "start") : "";
  if (caption) h += 32;
  return { w: W, h: h + 8, body: `<g transform="translate(0,4)">${ground}${parts.join("")}${labels}${caption}</g>` };
}

const NAMES: Record<StreetThing, string> = { house: "house", tree: "tree", shop: "shop", school: "school", flats: "block of flats", bush: "bush", lamp: "lamp post", car: "car", pot: "flower pot" };

export function describeStreet(s: StreetSpec): string {
  let wall = 0;
  const things = s.items.map((it, i) => {
    let colour = it.colour;
    if (!colour && ["house", "shop", "school", "flats"].includes(it.thing)) colour = WALLS[wall++ % WALLS.length];
    if (!colour && it.thing === "car") colour = "red";
    const what = `${["tree", "bush", "lamp"].includes(it.thing) || !colour ? "a" : `a ${colour}`} ${NAMES[it.thing]}`;
    return `${i + 1}) ${what}${it.label ? ` labelled "${it.label}"` : ""}`;
  });
  const unlabelled = s.items.every((i) => !i.label);
  return [
    `a row of ${s.items.length} things along a street, from left to right: ${things.join(", ")}`,
    unlabelled ? "nothing is labelled" : "",
    s.ground === false ? "" : "grass and a road along the bottom",
    s.caption ? `caption "${s.caption}"` : "",
  ]
    .filter(Boolean)
    .join("; ");
}
