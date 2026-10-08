/**
 * Star shapes cut into identical pieces — "this star has 6 lines of symmetry; it can be cut into 6
 * identical quadrilaterals like this one; the smallest angle is 38°; find the largest angle".
 *
 * The program computes the star from the number of points and the tip angle, so the star, its
 * division, the separate piece and every angle agree. `starAngles` gives the exact angles, which
 * generation uses to check the numbers in the question (lib/bank/generate.ts).
 *
 * Division "tips": lines from the centre to every tip → n concave quadrilaterals (centre, tip,
 * inner corner, tip): angles 360/n, α, α and the reflex 360 − 360/n − 2α, where 2α is the tip angle.
 * Division "inner": lines from the centre to every inner corner → n kites (centre, inner, tip, inner):
 * angles 360/n, 2α and two equal angles (360 − 360/n − 2α)/2.
 *
 * Pure and deterministic (server and browser).
 */
import { z } from "zod";

const label = z.string().max(20);

export const starSchema = z.object({
  kind: z.literal("star"),
  /** Number of tips (3–12). */
  points: z.number().int().min(3).max(12),
  /** Angle at each tip, in degrees (must be less than 180 − 360/points for a star). */
  tip_angle: z.number().positive().max(179),
  /** Lines cutting the star into identical pieces: from the centre to the tips, or to the inner corners. */
  divide: z.enum(["none", "tips", "inner"]).optional(),
  /** Draw the dividing lines on the star (default true when divided). */
  show_division: z.boolean().optional(),
  /** Dashed lines of symmetry. */
  symmetry_lines: z.boolean().optional(),
  /** Draw one piece separately beside the star. */
  show_piece: z.boolean().optional(),
  /** Text at the piece's angles (e.g. "38°", "?"). */
  piece_labels: z.object({ centre: label.optional(), tip: label.optional(), inner: label.optional() }).optional(),
  /** Text at one tip angle of the star. */
  tip_label: label.optional(),
  caption: z.string().max(60).optional(),
});

export type StarSpec = z.infer<typeof starSchema>;

export interface StarPen {
  ink: string;
  accent: string;
  fill: string;
  paper: string;
  sw: number;
  text(x: number, y: number, s: string, size?: number, anchor?: "start" | "middle" | "end"): string;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const deg = Math.PI / 180;
const round = (v: number) => Math.round(v * 100) / 100;

/** Largest tip angle that still gives a star (beyond it the inner corners are no longer pointing in). */
export function maxTipAngle(points: number): number {
  return 180 - 360 / points;
}

export interface StarAngles {
  tip: number;
  centre: number;
  /** Angles of one piece, in order around it, with where they are. */
  piece: Array<{ at: "centre" | "tip" | "inner"; angle: number }>;
  /** Interior angle of the star at an inner corner (reflex). */
  starInner: number;
}

export function starAngles(s: Pick<StarSpec, "points" | "tip_angle" | "divide">): StarAngles {
  const n = s.points, tip = s.tip_angle;
  const centre = 360 / n;
  const rest = 360 - centre - tip;
  const starInner = rest; // interior (reflex) angle of the star at an inner corner
  const piece: StarAngles["piece"] =
    s.divide === "inner"
      ? [{ at: "centre", angle: centre }, { at: "inner", angle: rest / 2 }, { at: "tip", angle: tip }, { at: "inner", angle: rest / 2 }]
      : s.divide === "tips"
        ? [{ at: "centre", angle: centre }, { at: "tip", angle: tip / 2 }, { at: "inner", angle: rest }, { at: "tip", angle: tip / 2 }]
        : [];
  return { tip: round(tip), centre: round(centre), piece: piece.map((p) => ({ ...p, angle: round(p.angle) })), starInner: round(starInner) };
}

/** Outer tips and inner corners (math coordinates, y up; top tip at (0, R)). */
function geometry(n: number, tip: number, R: number) {
  const beta = 180 / n; // angle at the centre between a tip and the next inner corner
  const alpha = tip / 2;
  const r = (R * Math.sin(alpha * deg)) / Math.sin((alpha + beta) * deg);
  const tips: Array<[number, number]> = [], inner: Array<[number, number]> = [];
  for (let k = 0; k < n; k++) {
    const a = 90 + (k * 360) / n;
    tips.push([R * Math.cos(a * deg), R * Math.sin(a * deg)]);
    const b = a + beta;
    inner.push([r * Math.cos(b * deg), r * Math.sin(b * deg)]);
  }
  return { tips, inner, r };
}

const P = (p: [number, number]) => `${r1(p[0])},${r1(-p[1])}`;

/** Text placed inside the angle at vertex v (between the directions to a and b). */
function angleLabel(pen: StarPen, v: [number, number], a: [number, number], b: [number, number], text: string, reflex = false): string {
  const u = (p: [number, number]) => {
    const d = [p[0] - v[0], p[1] - v[1]];
    const l = Math.hypot(d[0], d[1]) || 1;
    return [d[0] / l, d[1] / l];
  };
  const ua = u(a), ub = u(b);
  let bx = ua[0] + ub[0], by = ua[1] + ub[1];
  const l = Math.hypot(bx, by) || 1;
  bx /= l;
  by /= l;
  if (reflex) (bx = -bx), (by = -by);
  const dist = 20;
  const x = v[0] + bx * dist, y = v[1] + by * dist;
  return `<g paint-order="stroke" stroke="${pen.paper}" stroke-width="3.5" stroke-linejoin="round">${pen.text(x, -y + 5, text, 14)}</g>`;
}

export function drawStar(s: StarSpec, pen: StarPen): { w: number; h: number; body: string } {
  if (s.tip_angle >= maxTipAngle(s.points)) throw new Error(`star: a ${s.points}-point star needs a tip angle under ${round(maxTipAngle(s.points))}°`);
  if (s.show_piece && !s.divide) throw new Error('star: show_piece needs "divide" ("tips" or "inner")');
  const R = 90;
  const { tips, inner } = geometry(s.points, s.tip_angle, R);
  const n = s.points;
  const outline: Array<[number, number]> = [];
  for (let k = 0; k < n; k++) outline.push(tips[k], inner[k]);
  const st = `stroke="${pen.accent}" stroke-width="${pen.sw}" stroke-linejoin="round"`;
  const parts: string[] = [];
  const cx = R + 12, cy = R + 12;
  const star: string[] = [`<polygon points="${outline.map(P).join(" ")}" fill="${pen.fill}" ${st}/>`];
  if (s.symmetry_lines)
    for (let k = 0; k < n; k++) {
      const a = (90 + (k * 180) / n) * deg;
      const e = R * 1.15;
      star.push(`<line x1="${r1(e * Math.cos(a))}" y1="${r1(-e * Math.sin(a))}" x2="${r1(-e * Math.cos(a))}" y2="${r1(e * Math.sin(a))}" stroke="${pen.ink}" stroke-width="1" stroke-dasharray="5 4"/>`);
    }
  if (s.divide && s.divide !== "none" && s.show_division !== false) {
    const ends = s.divide === "tips" ? tips : inner;
    for (const p of ends) star.push(`<line x1="0" y1="0" x2="${r1(p[0])}" y2="${r1(-p[1])}" stroke="${pen.accent}" stroke-width="${Math.max(1, pen.sw * 0.8)}"/>`);
  }
  if (s.tip_label) star.push(angleLabel(pen, tips[0], inner[n - 1], inner[0], s.tip_label));
  parts.push(`<g transform="translate(${cx},${cy})">${star.join("")}</g>`);
  let w = 2 * R + 24;
  const h = 2 * R + 24;
  if (s.show_piece && s.divide && s.divide !== "none") {
    // One piece, turned so that it stands upright (its line of symmetry vertical).
    let piece: Array<[number, number]>;
    let roles: Array<"centre" | "tip" | "inner">;
    let turn: number;
    if (s.divide === "inner") {
      piece = [[0, 0], inner[n - 1], tips[0], inner[0]];
      roles = ["centre", "inner", "tip", "inner"];
      turn = 0; // tip up already
    } else {
      piece = [[0, 0], tips[0], inner[0], tips[1]];
      roles = ["centre", "tip", "inner", "tip"];
      turn = -(180 / n); // inner corner up
    }
    const c = Math.cos(turn * deg), sn = Math.sin(turn * deg);
    const rot = piece.map(([x, y]) => [x * c - y * sn, x * sn + y * c] as [number, number]);
    const xs = rot.map((p) => p[0]), ys = rot.map((p) => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const ox = w + 30 - minX + 10, oy = cy + (maxY + minY) / 2; // vertically centred with the star
    const pp: string[] = [`<polygon points="${rot.map(P).join(" ")}" fill="${pen.fill}" ${st}/>`];
    const lb = s.piece_labels ?? {};
    rot.forEach((v, i) => {
      const t = lb[roles[i]];
      if (!t) return;
      const reflex = s.divide === "tips" && roles[i] === "inner";
      pp.push(angleLabel(pen, v, rot[(i + 3) % 4], rot[(i + 1) % 4], t, reflex));
    });
    parts.push(`<g transform="translate(${r1(ox)},${r1(oy)})">${pp.join("")}</g>`);
    w = ox + maxX + 20;
  }
  let hh = h;
  if (s.caption) {
    parts.push(pen.text(w / 2, h + 18, s.caption, 14));
    hh += 26;
  }
  return { w, h: hh, body: parts.join("") };
}

export function describeStar(s: StarSpec): string {
  const a = starAngles(s);
  const parts = [`a ${s.points}-point star drawn to scale (all ${s.points} tips the same; each tip angle ${a.tip}°)`];
  if (s.symmetry_lines) parts.push(`its ${s.points} lines of symmetry dashed`);
  if (s.divide && s.divide !== "none") {
    const what = s.divide === "tips" ? `${s.points} identical concave quadrilaterals` : `${s.points} identical kites`;
    parts.push(`${s.show_division === false ? "(not drawn) " : ""}lines from the centre to every ${s.divide === "tips" ? "tip" : "inner corner"} cut it into ${what}`);
    if (s.show_piece) {
      const names = { centre: "at the centre", tip: "at a tip", inner: s.divide === "tips" ? "at the inner corner (reflex)" : "at an inner corner" };
      const lb = s.piece_labels ?? {};
      parts.push(
        `one piece is drawn separately beside the star, with angles ${a.piece.map((p) => `${p.angle}° ${names[p.at]}`).join(", ")}${Object.entries(lb).filter(([, t]) => t).length ? `; labels on the piece: ${Object.entries(lb).filter(([, t]) => t).map(([k, t]) => `"${t}" ${names[k as "centre"]}`).join(", ")}` : "; no labels"}`,
      );
    }
  }
  if (s.tip_label) parts.push(`"${s.tip_label}" written at one tip angle`);
  if (s.caption) parts.push(`caption "${s.caption}"`);
  return parts.join("; ");
}

/** Every angle the figure has (tip, centre, piece angles, the star's inner angle), for checking numbers in the question. */
export function allStarAngles(s: StarSpec): number[] {
  const a = starAngles(s);
  return [...new Set([a.tip, a.tip / 2, a.centre, a.starInner, 360 - a.starInner, ...a.piece.map((p) => p.angle)].map(round))];
}
