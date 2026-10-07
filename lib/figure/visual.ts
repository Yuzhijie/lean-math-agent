/**
 * Figures for generated questions, in the style of the template.
 *
 * The model writes a VisualSpec — data, not drawing: a clock showing 2:15,
 * a bar chart with these values, a number line from 0 to 20 with a point
 * at 13, a pictograph, a table, shaded squares on a grid, a fraction
 * shape, groups of objects, a geometry construction (lib/figure/spec.ts),
 * or a layout of cards each holding one of these (like cut-out sequence
 * cards on a worksheet). The program draws it, so the figure always shows
 * exactly the data in the spec, and `describeVisual` turns the same spec
 * into an exact text description for the independent re-solve.
 *
 * Only when no kind fits does the model draw an SVG itself ("svg"); such
 * a figure is marked as not program-drawn and is checked separately.
 *
 * The style (colour or black-and-white, accent colour, font feel, line
 * weight, card frames) comes from the template's figures as read by the
 * vision model (lib/bank/template-visual.ts). Pure and deterministic: runs
 * on the server (stored with the candidate) and in the browser. Model-
 * facing descriptions are English; labels come from the spec as written.
 */
import { z } from "zod";
import { buildFigure } from "./check";
import { renderFigureSvg } from "./render";
import { figureSpecSchema } from "./spec";

// ── Style ───────────────────────────────────────────────────────────

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const figureStyleSchema = z.object({
  colour: z.enum(["colour", "mono"]).catch("colour"),
  /** Main colour for outlines of frames, bars and highlights. */
  accent: hex.catch("#4b3f9e"),
  /** Light fill colour (bars, shaded parts, card backgrounds). */
  fill: hex.catch("#c9c2f2"),
  font: z.enum(["rounded", "sans", "serif", "handwriting"]).catch("sans"),
  stroke: z.enum(["thin", "normal", "bold"]).catch("normal"),
  /** Frames around cards / figures. */
  frame: z.enum(["none", "box", "rounded", "dashed"]).catch("box"),
});
export type FigureStyle = z.infer<typeof figureStyleSchema>;

export const DEFAULT_STYLE: FigureStyle = { colour: "mono", accent: "#222222", fill: "#d9d9d9", font: "sans", stroke: "normal", frame: "box" };

interface Theme {
  ink: string;
  accent: string;
  fill: string;
  paper: string;
  font: string;
  sw: number;
  frame: FigureStyle["frame"];
}

function themeOf(s: FigureStyle): Theme {
  const mono = s.colour === "mono";
  return {
    ink: "#1f1f1f",
    accent: mono ? "#1f1f1f" : s.accent,
    fill: mono ? "#d4d4d4" : s.fill,
    paper: "#ffffff",
    font:
      s.font === "rounded"
        ? "'Comic Neue', 'Nunito', 'Varela Round', 'Arial Rounded MT Bold', 'Trebuchet MS', sans-serif"
        : s.font === "serif"
          ? "'Times New Roman', 'Songti SC', serif"
          : s.font === "handwriting"
            ? "'Comic Sans MS', 'Comic Neue', 'Kaiti SC', cursive"
            : "'Helvetica Neue', Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif",
    sw: s.stroke === "thin" ? 1.2 : s.stroke === "bold" ? 3 : 2,
    frame: s.frame,
  };
}

// ── Spec ────────────────────────────────────────────────────────────

const label = z.string().max(40);
const num = z.number().finite();
const symbol = z.enum(["circle", "star", "square", "triangle", "heart", "apple", "flower"]).catch("circle");

const clockSchema = z.object({
  kind: z.literal("clock"),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  label: label.optional(),
  /** Analogue face (default) or a digital display. */
  digital: z.boolean().optional(),
});
const numberLineSchema = z.object({
  kind: z.literal("number_line"),
  min: num,
  max: num,
  step: num.positive(),
  /** Label every n-th tick (default 1). */
  label_every: z.number().int().min(1).max(10).optional(),
  points: z.array(z.object({ value: num, label: label.optional() })).max(8).default([]),
  /** Jumps drawn as arcs, e.g. counting on in steps. */
  hops: z.array(z.object({ from: num, to: num, label: label.optional() })).max(12).default([]),
  /** Tick values whose number is replaced by "?" or a letter (the thing asked). */
  unknown: z.array(z.object({ value: num, text: z.string().max(4).default("?") })).max(4).default([]),
});
const barChartSchema = z.object({
  kind: z.literal("bar_chart"),
  title: label.optional(),
  categories: z.array(label).min(1).max(12),
  values: z.array(num.min(0)).min(1).max(12),
  value_label: label.optional(),
  /** Top of the value axis and its step (default: computed). */
  axis_max: num.positive().optional(),
  axis_step: num.positive().optional(),
  horizontal: z.boolean().optional(),
  /** Write each value on its bar. */
  show_values: z.boolean().optional(),
});
const pictographSchema = z.object({
  kind: z.literal("pictograph"),
  title: label.optional(),
  symbol,
  /** Each symbol stands for this many. */
  key: num.positive(),
  /** Number of symbols per row (halves allowed). */
  rows: z.array(z.object({ label, symbols: z.number().min(0).max(12) })).min(1).max(8),
});
const cell = z.union([z.string().max(60), z.number(), z.null()]).transform((v) => (v === null ? "" : String(v)));
const tableSchema = z.object({
  kind: z.literal("table"),
  title: label.optional(),
  headers: z.array(cell).min(1).max(10),
  rows: z.array(z.array(cell).max(10)).min(1).max(15),
  /** The first column holds row labels (drawn like headers). */
  row_headers: z.boolean().optional(),
  /** Text under the table (e.g. a key or a note). */
  caption: z.string().max(80).optional(),
});
const gridShapeSchema = z.object({
  kind: z.literal("grid_shape"),
  cols: z.number().int().min(2).max(20),
  rows: z.number().int().min(2).max(16),
  /** Shaded squares as [row, column], 0-based from the top left. */
  shaded: z.array(z.tuple([z.number().int().min(0), z.number().int().min(0)])).max(200),
  /** e.g. "1 square = 1 cm²" */
  unit_label: label.optional(),
});
const fractionSchema = z.object({
  kind: z.literal("fraction"),
  shape: z.enum(["bar", "circle", "rectangle"]),
  parts: z.number().int().min(2).max(24),
  shaded: z.number().int().min(0),
  label: label.optional(),
});
const groupsSchema = z.object({
  kind: z.literal("groups"),
  /** Each group is drawn in its own ring (or as a row when `array` is set). */
  groups: z.array(z.object({ count: z.number().int().min(0).max(30), symbol, label: label.optional() })).min(1).max(8),
  array: z.boolean().optional(),
  caption: label.optional(),
});
const geometrySchema = z.object({ kind: z.literal("geometry"), spec: figureSpecSchema });

const leafSchemas = [clockSchema, numberLineSchema, barChartSchema, pictographSchema, tableSchema, gridShapeSchema, fractionSchema, groupsSchema, geometrySchema] as const;
export const visualLeafSchema = z.discriminatedUnion("kind", [...leafSchemas]);
export type VisualLeaf = z.infer<typeof visualLeafSchema>;

const cardsSchema = z.object({
  kind: z.literal("cards"),
  columns: z.number().int().min(1).max(4),
  cards: z
    .array(
      z.object({
        /** Text above the picture (e.g. a time or a word). */
        label: label.optional(),
        figure: visualLeafSchema.optional(),
        /** Short text instead of / under the figure (e.g. "eat breakfast"). */
        caption: label.optional(),
        /** An empty answer box under the card (write the order, the time …). */
        answer_box: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(12),
});
/** Drawn by the model when no kind fits: not program-drawn. */
const svgSchema = z.object({ kind: z.literal("svg"), svg: z.string().min(20).max(60_000), description: z.string().min(1).max(2000) });

export const visualSpecSchema = z.discriminatedUnion("kind", [...leafSchemas, cardsSchema, svgSchema]);
export type VisualSpec = z.infer<typeof visualSpecSchema>;

export const VISUAL_KINDS = ["clock", "number_line", "bar_chart", "pictograph", "table", "grid_shape", "fraction", "groups", "geometry", "cards", "svg"] as const;

// ── Drawing helpers ─────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const r1 = (v: number) => Math.round(v * 10) / 10;
const fmt = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000));

interface Box {
  w: number;
  h: number;
  body: string;
}

function text(t: Theme, x: number, y: number, s: string, size = 15, anchor: "start" | "middle" | "end" = "middle", weight = "normal", fill = t.ink): string {
  return `<text x="${r1(x)}" y="${r1(y)}" font-family="${esc(t.font)}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;
}

function symbolPath(kind: z.infer<typeof symbol>, cx: number, cy: number, r: number, t: Theme, half = false): string {
  const fill = t.accent;
  const clip = half ? ` clip-path="inset(0 50% 0 0)"` : "";
  let shape: string;
  switch (kind) {
    case "square":
      shape = `<rect x="${r1(cx - r)}" y="${r1(cy - r)}" width="${r1(2 * r)}" height="${r1(2 * r)}" rx="2" fill="${fill}"/>`;
      break;
    case "triangle":
      shape = `<polygon points="${r1(cx)},${r1(cy - r)} ${r1(cx + r)},${r1(cy + r * 0.85)} ${r1(cx - r)},${r1(cy + r * 0.85)}" fill="${fill}"/>`;
      break;
    case "star": {
      const pts: string[] = [];
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rr = i % 2 ? r * 0.45 : r;
        pts.push(`${r1(cx + rr * Math.cos(a))},${r1(cy + rr * Math.sin(a))}`);
      }
      shape = `<polygon points="${pts.join(" ")}" fill="${fill}"/>`;
      break;
    }
    case "heart":
      shape = `<path d="M${r1(cx)},${r1(cy + r * 0.9)} C${r1(cx - r * 1.6)},${r1(cy - r * 0.2)} ${r1(cx - r * 0.6)},${r1(cy - r * 1.3)} ${r1(cx)},${r1(cy - r * 0.35)} C${r1(cx + r * 0.6)},${r1(cy - r * 1.3)} ${r1(cx + r * 1.6)},${r1(cy - r * 0.2)} ${r1(cx)},${r1(cy + r * 0.9)}Z" fill="${fill}"/>`;
      break;
    case "apple":
      shape = `<circle cx="${r1(cx)}" cy="${r1(cy + r * 0.1)}" r="${r1(r * 0.85)}" fill="${fill}"/><path d="M${r1(cx)},${r1(cy - r * 0.6)} q${r1(r * 0.1)},${r1(-r * 0.4)} ${r1(r * 0.35)},${r1(-r * 0.5)}" stroke="${t.ink}" stroke-width="1.5" fill="none"/>`;
      break;
    case "flower":
      shape =
        [0, 72, 144, 216, 288].map((d) => `<circle cx="${r1(cx + r * 0.55 * Math.cos((d * Math.PI) / 180))}" cy="${r1(cy + r * 0.55 * Math.sin((d * Math.PI) / 180))}" r="${r1(r * 0.42)}" fill="${fill}"/>`).join("") +
        `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(r * 0.3)}" fill="${t.paper}" stroke="${fill}"/>`;
      break;
    default:
      shape = `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(r)}" fill="${fill}"/>`;
  }
  if (!half) return shape;
  // Half symbol: draw it, then cover the right half with paper (works in every SVG renderer).
  void clip;
  return `${shape}<rect x="${r1(cx)}" y="${r1(cy - r - 2)}" width="${r1(r + 2)}" height="${r1(2 * r + 4)}" fill="${t.paper}"/>`;
}

function niceAxis(maxValue: number): { max: number; step: number } {
  const target = maxValue <= 0 ? 1 : maxValue;
  const raw = target / 5;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  const step = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
  return { max: Math.ceil(target / step) * step, step };
}

// ── Kinds ───────────────────────────────────────────────────────────

function clock(spec: z.infer<typeof clockSchema>, t: Theme): Box {
  const size = 150;
  const labelH = spec.label ? 24 : 0;
  const cx = size / 2, cy = labelH + size / 2, R = size / 2 - 6;
  const parts: string[] = [];
  if (spec.label) parts.push(text(t, cx, 17, spec.label, 16, "middle", "bold"));
  if (spec.digital) {
    const h12 = spec.hour % 12 === 0 ? 12 : spec.hour % 12;
    parts.push(`<rect x="10" y="${r1(cy - 34)}" width="${size - 20}" height="68" rx="10" fill="${t.paper}" stroke="${t.accent}" stroke-width="${t.sw + 1}"/>`);
    parts.push(text(t, cx, cy + 14, `${h12}:${String(spec.minute).padStart(2, "0")}`, 38, "middle", "bold"));
    return { w: size, h: labelH + size, body: parts.join("") };
  }
  parts.push(`<circle cx="${cx}" cy="${r1(cy)}" r="${R}" fill="${t.paper}" stroke="${t.accent}" stroke-width="${t.sw + 2}"/>`);
  for (let i = 0; i < 60; i++) {
    const a = (i * Math.PI) / 30;
    const long = i % 5 === 0;
    const r0 = R - (long ? 9 : 4);
    parts.push(`<line x1="${r1(cx + r0 * Math.sin(a))}" y1="${r1(cy - r0 * Math.cos(a))}" x2="${r1(cx + (R - 1) * Math.sin(a))}" y2="${r1(cy - (R - 1) * Math.cos(a))}" stroke="${t.ink}" stroke-width="${long ? 1.6 : 0.7}"/>`);
  }
  for (let n = 1; n <= 12; n++) {
    const a = (n * Math.PI) / 6;
    parts.push(text(t, cx + (R - 21) * Math.sin(a), cy - (R - 21) * Math.cos(a) + 5, String(n), 14));
  }
  const ha = (((spec.hour % 12) + spec.minute / 60) * Math.PI) / 6;
  const ma = (spec.minute * Math.PI) / 30;
  parts.push(`<line x1="${cx}" y1="${r1(cy)}" x2="${r1(cx + R * 0.5 * Math.sin(ha))}" y2="${r1(cy - R * 0.5 * Math.cos(ha))}" stroke="${t.ink}" stroke-width="5" stroke-linecap="round"/>`);
  parts.push(`<line x1="${cx}" y1="${r1(cy)}" x2="${r1(cx + R * 0.78 * Math.sin(ma))}" y2="${r1(cy - R * 0.78 * Math.cos(ma))}" stroke="${t.ink}" stroke-width="3" stroke-linecap="round"/>`);
  parts.push(`<circle cx="${cx}" cy="${r1(cy)}" r="4" fill="${t.accent}"/>`);
  return { w: size, h: labelH + size, body: parts.join("") };
}

function numberLine(spec: z.infer<typeof numberLineSchema>, t: Theme): Box {
  const [lo, hi] = spec.min < spec.max ? [spec.min, spec.max] : [spec.max, spec.min];
  const n = Math.min(60, Math.round((hi - lo) / spec.step));
  const W = Math.max(320, Math.min(640, n * 34 + 60));
  const x0 = 30, x1 = W - 30;
  const X = (v: number) => x0 + ((v - lo) / (hi - lo || 1)) * (x1 - x0);
  const hopH = spec.hops.length ? 46 : 0;
  const y = 30 + hopH;
  const parts: string[] = [];
  parts.push(`<line x1="${x0 - 14}" y1="${y}" x2="${x1 + 14}" y2="${y}" stroke="${t.ink}" stroke-width="${t.sw}"/>`);
  parts.push(`<path d="M${x0 - 6},${y - 6} L${x0 - 16},${y} L${x0 - 6},${y + 6} M${x1 + 6},${y - 6} L${x1 + 16},${y} L${x1 + 6},${y + 6}" stroke="${t.ink}" stroke-width="${t.sw}" fill="none"/>`);
  const every = spec.label_every ?? 1;
  const unknown = new Map(spec.unknown.map((u) => [fmt(u.value), u.text]));
  for (let i = 0; i <= n; i++) {
    const v = lo + i * spec.step;
    const big = i % every === 0;
    parts.push(`<line x1="${r1(X(v))}" y1="${y - (big ? 9 : 5)}" x2="${r1(X(v))}" y2="${y + (big ? 9 : 5)}" stroke="${t.ink}" stroke-width="${t.sw}"/>`);
    const u = unknown.get(fmt(v));
    if (u !== undefined) parts.push(text(t, X(v), y + 30, u, 16, "middle", "bold", t.accent));
    else if (big) parts.push(text(t, X(v), y + 28, fmt(v), 14));
  }
  for (const p of spec.points) {
    parts.push(`<circle cx="${r1(X(p.value))}" cy="${y}" r="6" fill="${t.accent}"/>`);
    if (p.label) parts.push(text(t, X(p.value), y - 14, p.label, 15, "middle", "bold", t.accent));
  }
  for (const h of spec.hops) {
    const a = X(h.from), b = X(h.to), mid = (a + b) / 2;
    const top = y - 10 - Math.min(36, Math.abs(b - a) / 2.2);
    parts.push(`<path d="M${r1(a)},${y - 8} Q${r1(mid)},${r1(top - 8)} ${r1(b)},${y - 8}" stroke="${t.accent}" stroke-width="${t.sw}" fill="none"/>`);
    parts.push(`<path d="M${r1(b - 7)},${y - 16} L${r1(b)},${y - 8} L${r1(b - 9)},${y - 5}" stroke="${t.accent}" stroke-width="${t.sw}" fill="none"/>`);
    if (h.label) parts.push(text(t, mid, top - 2, h.label, 13, "middle", "normal", t.accent));
  }
  return { w: W, h: y + 44, body: parts.join("") };
}

function barChart(spec: z.infer<typeof barChartSchema>, t: Theme): Box {
  const k = Math.min(spec.categories.length, spec.values.length);
  const cats = spec.categories.slice(0, k), vals = spec.values.slice(0, k);
  const auto = niceAxis(Math.max(...vals));
  const max = spec.axis_max && spec.axis_max >= Math.max(...vals) ? spec.axis_max : auto.max;
  const step = spec.axis_step && max / spec.axis_step <= 20 ? spec.axis_step : niceAxis(max).step;
  const parts: string[] = [];
  const titleH = spec.title ? 30 : 6;
  if (spec.title) parts.push(text(t, 0, 20, spec.title, 16, "start", "bold"));
  if (!spec.horizontal) {
    const left = 54, plotW = Math.max(240, k * 62), plotH = 210, top = titleH + 8;
    const W = left + plotW + 16, base = top + plotH;
    const Y = (v: number) => base - (v / max) * plotH;
    for (let v = 0; v <= max + 1e-9; v += step) {
      parts.push(`<line x1="${left}" y1="${r1(Y(v))}" x2="${left + plotW}" y2="${r1(Y(v))}" stroke="#bdbdbd" stroke-width="0.8"/>`);
      parts.push(text(t, left - 8, Y(v) + 5, fmt(v), 13, "end"));
    }
    const bw = (plotW / k) * 0.6;
    cats.forEach((c, i) => {
      const cx = left + (plotW / k) * (i + 0.5);
      parts.push(`<rect x="${r1(cx - bw / 2)}" y="${r1(Y(vals[i]))}" width="${r1(bw)}" height="${r1(base - Y(vals[i]))}" fill="${t.fill}" stroke="${t.accent}" stroke-width="${t.sw}"/>`);
      if (spec.show_values) parts.push(text(t, cx, Y(vals[i]) - 6, fmt(vals[i]), 13));
      parts.push(text(t, cx, base + 20, c, 13));
    });
    parts.push(`<line x1="${left}" y1="${top}" x2="${left}" y2="${base}" stroke="${t.ink}" stroke-width="${t.sw}"/><line x1="${left}" y1="${base}" x2="${left + plotW}" y2="${base}" stroke="${t.ink}" stroke-width="${t.sw}"/>`);
    if (spec.value_label) parts.push(`<text x="14" y="${r1(top + plotH / 2)}" font-family="${esc(t.font)}" font-size="13" fill="${t.ink}" text-anchor="middle" transform="rotate(-90 14 ${r1(top + plotH / 2)})">${esc(spec.value_label)}</text>`);
    return { w: W, h: base + 34, body: parts.join("") };
  }
  const left = 110, plotW = 300, rowH = 34, top = titleH + 8;
  const plotH = k * rowH, base = top + plotH;
  const X = (v: number) => left + (v / max) * plotW;
  for (let v = 0; v <= max + 1e-9; v += step) {
    parts.push(`<line x1="${r1(X(v))}" y1="${top}" x2="${r1(X(v))}" y2="${base}" stroke="#bdbdbd" stroke-width="0.8"/>`);
    parts.push(text(t, X(v), base + 18, fmt(v), 13));
  }
  cats.forEach((c, i) => {
    const cy = top + rowH * (i + 0.5);
    parts.push(`<rect x="${left}" y="${r1(cy - rowH * 0.3)}" width="${r1(X(vals[i]) - left)}" height="${r1(rowH * 0.6)}" fill="${t.fill}" stroke="${t.accent}" stroke-width="${t.sw}"/>`);
    parts.push(text(t, left - 8, cy + 5, c, 13, "end"));
    if (spec.show_values) parts.push(text(t, X(vals[i]) + 6, cy + 5, fmt(vals[i]), 13, "start"));
  });
  parts.push(`<line x1="${left}" y1="${top}" x2="${left}" y2="${base}" stroke="${t.ink}" stroke-width="${t.sw}"/><line x1="${left}" y1="${base}" x2="${left + plotW}" y2="${base}" stroke="${t.ink}" stroke-width="${t.sw}"/>`);
  if (spec.value_label) parts.push(text(t, left + plotW / 2, base + 38, spec.value_label, 13));
  return { w: left + plotW + 20, h: base + (spec.value_label ? 46 : 28), body: parts.join("") };
}

function pictograph(spec: z.infer<typeof pictographSchema>, t: Theme): Box {
  const left = 120, cell = 34, rowH = 40;
  const maxSym = Math.max(1, ...spec.rows.map((r) => Math.ceil(r.symbols)));
  const titleH = spec.title ? 30 : 4;
  const W = left + maxSym * cell + 20;
  const parts: string[] = [];
  if (spec.title) parts.push(text(t, 0, 20, spec.title, 16, "start", "bold"));
  spec.rows.forEach((row, i) => {
    const cy = titleH + rowH * (i + 0.5);
    parts.push(`<line x1="0" y1="${r1(titleH + rowH * (i + 1))}" x2="${W}" y2="${r1(titleH + rowH * (i + 1))}" stroke="#bdbdbd" stroke-width="0.8"/>`);
    parts.push(text(t, left - 12, cy + 5, row.label, 14, "end"));
    const whole = Math.floor(row.symbols);
    for (let j = 0; j < whole; j++) parts.push(symbolPath(spec.symbol, left + cell * (j + 0.5), cy, 12, t));
    if (row.symbols - whole >= 0.5) parts.push(symbolPath(spec.symbol, left + cell * (whole + 0.5), cy, 12, t, true));
  });
  parts.push(`<line x1="${left - 4}" y1="${titleH}" x2="${left - 4}" y2="${titleH + rowH * spec.rows.length}" stroke="${t.ink}" stroke-width="${t.sw}"/>`);
  const keyY = titleH + rowH * spec.rows.length + 28;
  parts.push(symbolPath(spec.symbol, 14, keyY - 5, 10, t));
  parts.push(text(t, 32, keyY, `= ${fmt(spec.key)}`, 14, "start"));
  return { w: W, h: keyY + 12, body: parts.join("") };
}

/** Approximate text width in px: CJK characters are about twice as wide as Latin ones. */
function textWidth(s: string, size: number): number {
  let w = 0;
  for (const ch of s) w += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch) ? 1 : 0.58;
  return w * size;
}

/** Simple LaTeX in a cell as plain text for SVG ($\frac{1}{2}$ → 1/2, \times → ×). */
export function plainMath(s: string): string {
  return s
    .replace(/\$/g, "")
    .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "$1/$2")
    .replace(/\\times/g, "×")
    .replace(/\\div/g, "÷")
    .replace(/\\cdot/g, "·")
    .replace(/\\(?:le|leq)\b/g, "≤")
    .replace(/\\(?:ge|geq)\b/g, "≥")
    .replace(/\\(?:text|mathrm)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\^\{?2\}?/g, "²")
    .replace(/\^\{?3\}?/g, "³")
    .replace(/\\[,;! ]/g, " ")
    .replace(/[{}]/g, "")
    .trim();
}

/** A cell to be filled in: empty, "?", or underscores. */
const isBlank = (v: string) => /^\s*(?:\?+|？+|_+|\\_+|\[\s*\]|□)?\s*$/.test(v);

function table(spec: z.infer<typeof tableSchema>, t: Theme): Box {
  const cols = Math.max(spec.headers.length, ...spec.rows.map((r) => r.length));
  const all = [spec.headers, ...spec.rows].map((r) => Array.from({ length: cols }, (_, c) => plainMath(r[c] ?? "")));
  const widths = Array.from({ length: cols }, (_, c) => Math.max(64, Math.min(260, 26 + Math.max(...all.map((r) => textWidth(r[c], 15))))));
  const rowH = 36, titleH = spec.title ? 30 : 0;
  const W = widths.reduce((a, b) => a + b, 0);
  const parts: string[] = [];
  if (spec.title) parts.push(text(t, W / 2, 20, plainMath(spec.title), 16, "middle", "bold"));
  all.forEach((row, ri) => {
    let x = 0;
    const y = titleH + ri * rowH;
    for (let c = 0; c < cols; c++) {
      const head = ri === 0 || (spec.row_headers && c === 0);
      parts.push(`<rect x="${x}" y="${y}" width="${widths[c]}" height="${rowH}" fill="${head ? t.fill : t.paper}" stroke="${t.ink}" stroke-width="${t.sw * 0.7}"/>`);
      const v = row[c];
      if (!head && isBlank(v)) {
        // A space to fill in: an empty box, with "?" when the template asks for it.
        parts.push(`<rect x="${r1(x + widths[c] / 2 - 18)}" y="${y + 6}" width="36" height="${rowH - 12}" rx="3" fill="${t.paper}" stroke="${t.accent}" stroke-width="1.4" stroke-dasharray="4 3"/>`);
        if (/\?|？/.test(v)) parts.push(text(t, x + widths[c] / 2, y + 24, "?", 15, "middle", "bold", t.accent));
      } else {
        parts.push(text(t, x + widths[c] / 2, y + 23, v, 15, "middle", head ? "bold" : "normal"));
      }
      x += widths[c];
    }
  });
  let h = titleH + all.length * rowH;
  if (spec.caption) {
    parts.push(text(t, 0, h + 22, plainMath(spec.caption), 13, "start"));
    h += 30;
  }
  return { w: W + 2, h: h + 2, body: parts.join("") };
}

function gridShape(spec: z.infer<typeof gridShapeSchema>, t: Theme): Box {
  const cell = Math.min(30, Math.floor(420 / spec.cols));
  const parts: string[] = [];
  for (const [r, c] of spec.shaded) if (r < spec.rows && c < spec.cols) parts.push(`<rect x="${c * cell}" y="${r * cell}" width="${cell}" height="${cell}" fill="${t.fill}"/>`);
  for (let r = 0; r <= spec.rows; r++) parts.push(`<line x1="0" y1="${r * cell}" x2="${spec.cols * cell}" y2="${r * cell}" stroke="#9e9e9e" stroke-width="0.8"/>`);
  for (let c = 0; c <= spec.cols; c++) parts.push(`<line x1="${c * cell}" y1="0" x2="${c * cell}" y2="${spec.rows * cell}" stroke="#9e9e9e" stroke-width="0.8"/>`);
  // Outline of the shaded shape.
  const on = new Set(spec.shaded.map(([r, c]) => `${r},${c}`));
  for (const [r, c] of spec.shaded) {
    const edge = (rr: number, cc: number) => !on.has(`${rr},${cc}`);
    const x = c * cell, y = r * cell;
    const st = `stroke="${t.accent}" stroke-width="${t.sw + 1}" stroke-linecap="round"`;
    if (edge(r - 1, c)) parts.push(`<line x1="${x}" y1="${y}" x2="${x + cell}" y2="${y}" ${st}/>`);
    if (edge(r + 1, c)) parts.push(`<line x1="${x}" y1="${y + cell}" x2="${x + cell}" y2="${y + cell}" ${st}/>`);
    if (edge(r, c - 1)) parts.push(`<line x1="${x}" y1="${y}" x2="${x}" y2="${y + cell}" ${st}/>`);
    if (edge(r, c + 1)) parts.push(`<line x1="${x + cell}" y1="${y}" x2="${x + cell}" y2="${y + cell}" ${st}/>`);
  }
  const h = spec.rows * cell;
  if (spec.unit_label) parts.push(text(t, 0, h + 22, spec.unit_label, 13, "start"));
  return { w: spec.cols * cell + 2, h: h + (spec.unit_label ? 30 : 2), body: parts.join("") };
}

function fraction(spec: z.infer<typeof fractionSchema>, t: Theme): Box {
  const shaded = Math.min(spec.shaded, spec.parts);
  const parts: string[] = [];
  const st = `stroke="${t.ink}" stroke-width="${t.sw}"`;
  let w: number, h: number;
  if (spec.shape === "circle") {
    const R = 70, cx = 75, cy = 75;
    for (let i = 0; i < spec.parts; i++) {
      const a0 = -Math.PI / 2 + (i * 2 * Math.PI) / spec.parts, a1 = a0 + (2 * Math.PI) / spec.parts;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      parts.push(`<path d="M${cx},${cy} L${r1(cx + R * Math.cos(a0))},${r1(cy + R * Math.sin(a0))} A${R},${R} 0 ${large} 1 ${r1(cx + R * Math.cos(a1))},${r1(cy + R * Math.sin(a1))}Z" fill="${i < shaded ? t.fill : t.paper}" ${st}/>`);
    }
    w = 150;
    h = 150;
  } else if (spec.shape === "bar") {
    const pw = Math.min(56, 420 / spec.parts);
    for (let i = 0; i < spec.parts; i++) parts.push(`<rect x="${r1(i * pw)}" y="0" width="${r1(pw)}" height="44" fill="${i < shaded ? t.fill : t.paper}" ${st}/>`);
    w = spec.parts * pw;
    h = 44;
  } else {
    const cols = Math.ceil(Math.sqrt(spec.parts)) + (spec.parts % 2 === 0 && Math.sqrt(spec.parts) % 1 !== 0 ? 0 : 0);
    const c = spec.parts % cols === 0 ? cols : spec.parts % 2 === 0 ? 2 : spec.parts;
    const rows = spec.parts / c;
    const cell = Math.min(46, 260 / Math.max(c, rows));
    for (let i = 0; i < spec.parts; i++) {
      const rr = Math.floor(i / c), cc = i % c;
      parts.push(`<rect x="${r1(cc * cell)}" y="${r1(rr * cell)}" width="${r1(cell)}" height="${r1(cell)}" fill="${i < shaded ? t.fill : t.paper}" ${st}/>`);
    }
    w = c * cell;
    h = rows * cell;
  }
  if (spec.label) {
    parts.push(text(t, w / 2, h + 24, spec.label, 15));
    h += 32;
  }
  return { w: w + 4, h: h + 4, body: `<g transform="translate(2,2)">${parts.join("")}</g>` };
}

function groups(spec: z.infer<typeof groupsSchema>, t: Theme): Box {
  const parts: string[] = [];
  const r = 9, gap = 24;
  if (spec.array) {
    const cols = Math.max(...spec.groups.map((g) => g.count), 1);
    spec.groups.forEach((g, i) => {
      for (let j = 0; j < g.count; j++) parts.push(symbolPath(g.symbol, 16 + j * gap, 16 + i * gap, r, t));
    });
    const h = spec.groups.length * gap + 8;
    if (spec.caption) parts.push(text(t, 0, h + 18, spec.caption, 14, "start"));
    return { w: cols * gap + 12, h: h + (spec.caption ? 26 : 0), body: parts.join("") };
  }
  let x = 0;
  let maxH = 0;
  for (const g of spec.groups) {
    const per = Math.max(1, Math.ceil(Math.sqrt(g.count)));
    const rows = Math.max(1, Math.ceil(g.count / per));
    const gw = per * gap + 20, gh = rows * gap + 20;
    parts.push(`<rect x="${x}" y="0" width="${gw}" height="${gh}" rx="${Math.min(gw, gh) / 2.4}" fill="none" stroke="${t.ink}" stroke-width="${t.sw * 0.8}"/>`);
    for (let j = 0; j < g.count; j++) parts.push(symbolPath(g.symbol, x + 10 + gap * ((j % per) + 0.5), 10 + gap * (Math.floor(j / per) + 0.5), r, t));
    if (g.label) parts.push(text(t, x + gw / 2, gh + 20, g.label, 13));
    x += gw + 16;
    maxH = Math.max(maxH, gh + (g.label ? 28 : 4));
  }
  if (spec.caption) parts.push(text(t, 0, maxH + 20, spec.caption, 14, "start"));
  return { w: Math.max(x - 16, 10), h: maxH + (spec.caption ? 28 : 0), body: parts.join("") };
}

/** Palette for the geometry renderer on paper (it defaults to the app's dark theme). */
function paperPalette(t: Theme) {
  return { stroke: t.ink, aux: "#333333", hi: t.accent, point: t.ink, label: t.ink, grid: "#d0d0d0", axis: "#555555", fill: t.fill, fns: [t.accent, "#c2185b", "#2e7d32", "#ef6c00", "#6a1b9a", "#00838f"] };
}

function geometry(spec: z.infer<typeof geometrySchema>, t: Theme): Box & { verified: boolean; issues: string[] } {
  const fig = buildFigure(spec.spec);
  const raw = renderFigureSvg(fig, { width: 380, maxHeight: 300, palette: paperPalette(t) });
  const m = /viewBox="([-\d.\s]+)"/.exec(raw);
  const [vx, vy, vw, vh] = m ? m[1].trim().split(/\s+/).map(Number) : [0, 0, 380, 300];
  const inner = raw.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const issues = fig.claims.filter((c) => !c.ok).map((c) => c.detail);
  return { w: vw, h: vh, body: `<g transform="translate(${-vx},${-vy})">${inner}</g>`, verified: fig.verified, issues };
}

function leaf(spec: VisualLeaf, t: Theme): Box & { verified?: boolean; issues?: string[] } {
  switch (spec.kind) {
    case "clock":
      return clock(spec, t);
    case "number_line":
      return numberLine(spec, t);
    case "bar_chart":
      return barChart(spec, t);
    case "pictograph":
      return pictograph(spec, t);
    case "table":
      return table(spec, t);
    case "grid_shape":
      return gridShape(spec, t);
    case "fraction":
      return fraction(spec, t);
    case "groups":
      return groups(spec, t);
    case "geometry":
      return geometry(spec, t);
  }
}

function frameRect(t: Theme, x: number, y: number, w: number, h: number): string {
  if (t.frame === "none") return "";
  const rx = t.frame === "rounded" ? 14 : t.frame === "dashed" ? 0 : 4;
  const dash = t.frame === "dashed" ? ' stroke-dasharray="7 5"' : "";
  return `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" rx="${rx}" fill="${t.paper}" stroke="${t.frame === "dashed" ? t.ink : t.accent}" stroke-width="${t.frame === "dashed" ? 1.3 : t.sw}"${dash}/>`;
}

function cards(spec: z.infer<typeof cardsSchema>, t: Theme): Box & { verified: boolean; issues: string[] } {
  const inner = spec.cards.map((c) => (c.figure ? leaf(c.figure, t) : undefined));
  const pad = 14;
  const cw = Math.max(150, ...inner.map((b) => (b ? b.w : 0))) + 2 * pad;
  const ch =
    Math.max(
      60,
      ...spec.cards.map((c, i) => (c.label ? 30 : 0) + (inner[i] ? inner[i]!.h + 8 : 0) + (c.caption ? 26 : 0) + (c.answer_box ? 50 : 0)),
    ) +
    2 * pad;
  const cols = Math.min(spec.columns, spec.cards.length);
  const gap = t.frame === "dashed" ? 0 : 14;
  const parts: string[] = [];
  spec.cards.forEach((c, i) => {
    const x = (i % cols) * (cw + gap), y = Math.floor(i / cols) * (ch + gap);
    parts.push(frameRect(t, x + 1, y + 1, cw, ch));
    let yy = y + pad;
    if (c.label) {
      parts.push(text(t, x + cw / 2, yy + 20, c.label, 18, "middle", "bold"));
      yy += 30;
    }
    const b = inner[i];
    if (b) {
      parts.push(`<g transform="translate(${r1(x + (cw - b.w) / 2)},${r1(yy)})">${b.body}</g>`);
      yy += b.h + 8;
    }
    if (c.caption) {
      parts.push(text(t, x + cw / 2, yy + 18, c.caption, 14));
      yy += 26;
    }
    if (c.answer_box) parts.push(`<rect x="${r1(x + cw / 2 - 26)}" y="${r1(yy + 4)}" width="52" height="40" rx="4" fill="${t.paper}" stroke="${t.ink}" stroke-width="1.5"/>`);
  });
  const rows = Math.ceil(spec.cards.length / cols);
  const issues = inner.flatMap((b) => b?.issues ?? []);
  return { w: cols * cw + (cols - 1) * gap + 2, h: rows * ch + (rows - 1) * gap + 2, body: parts.join(""), verified: inner.every((b) => !b || b.verified !== false), issues };
}

// ── Model-drawn SVG ─────────────────────────────────────────────────

/** Strip anything active or external from a model-drawn SVG (it is also sanitised again in the browser). */
export function sanitizeSvg(svg: string): string | null {
  const s = svg.trim();
  const m = /<svg\b[\s\S]*<\/svg>/i.exec(s);
  if (!m) return null;
  return m[0]
    .replace(/<(script|foreignObject|style|iframe|object|embed|image|use)\b[\s\S]*?(<\/\1>|\/>)/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(?:xlink:)?href\s*=\s*("[^"]*"|'[^']*')/gi, "")
    .replace(/url\(\s*['"]?(?!#)[^)]*\)/gi, "none");
}

// ── Public API ──────────────────────────────────────────────────────

export interface BuiltVisual {
  svg: string;
  /** Exact description of what is drawn (for the independent re-solve and the reviewer). */
  description: string;
  /** "program": drawn from the data; "model": the model's own SVG. */
  source: "program" | "model";
  /** Program-drawn and every geometric condition holds. Model-drawn figures are never verified here. */
  verified: boolean;
  issues: string[];
}

/** Draw a spec in a style. Throws on an unusable spec (e.g. a geometry construction that cannot be built). */
export function buildVisual(spec: VisualSpec, style: FigureStyle = DEFAULT_STYLE): BuiltVisual {
  const t = themeOf(style);
  if (spec.kind === "svg") {
    const clean = sanitizeSvg(spec.svg);
    if (!clean) throw new Error("the model's SVG is not a valid <svg> element");
    return { svg: clean, description: spec.description.trim(), source: "model", verified: false, issues: [] };
  }
  const box = spec.kind === "cards" ? cards(spec, t) : leaf(spec, t);
  const pad = spec.kind === "cards" ? 6 : 16;
  const framed = spec.kind !== "cards" && spec.kind !== "table" && (t.frame === "box" || t.frame === "rounded");
  const fpad = framed ? 10 : 0;
  const W = Math.ceil(box.w + 2 * (pad + fpad)), H = Math.ceil(box.h + 2 * (pad + fpad));
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">` +
    `<rect x="0" y="0" width="${W}" height="${H}" fill="${t.paper}"/>` +
    (framed ? frameRect(t, pad / 2, pad / 2, W - pad, H - pad) : "") +
    `<g transform="translate(${pad + fpad},${pad + fpad})">${box.body}</g></svg>`;
  return { svg, description: describeVisual(spec), source: "program", verified: (box as { verified?: boolean }).verified !== false, issues: (box as { issues?: string[] }).issues ?? [] };
}

const time12 = (h: number, m: number) => `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")}`;

function describeLeaf(s: VisualLeaf): string {
  switch (s.kind) {
    case "clock":
      return `${s.digital ? "a digital clock" : "an analogue clock"} showing ${time12(s.hour, s.minute)}${s.label ? ` (labelled "${s.label}")` : ""}`;
    case "number_line": {
      const pts = s.points.map((p) => `${p.label ? `${p.label} at ` : "a point at "}${fmt(p.value)}`);
      const hops = s.hops.map((h) => `a jump from ${fmt(h.from)} to ${fmt(h.to)}${h.label ? ` labelled "${h.label}"` : ""}`);
      const unk = s.unknown.map((u) => `"${u.text}" written under ${fmt(u.value)} instead of the number`);
      return `a number line from ${fmt(s.min)} to ${fmt(s.max)} with ticks every ${fmt(s.step)}${(s.label_every ?? 1) > 1 ? ` (numbers on every ${s.label_every}th tick)` : ""}${[...pts, ...hops, ...unk].length ? "; " + [...pts, ...hops, ...unk].join("; ") : ""}`;
    }
    case "bar_chart":
      return `a ${s.horizontal ? "horizontal " : ""}bar chart${s.title ? ` titled "${s.title}"` : ""}${s.value_label ? ` (${s.value_label})` : ""}: ${s.categories.map((c, i) => `${c} = ${fmt(s.values[i] ?? 0)}`).join(", ")}${s.show_values ? " (values written on the bars)" : " (values read from the scale)"}`;
    case "pictograph":
      return `a pictograph${s.title ? ` titled "${s.title}"` : ""} where each ${s.symbol} stands for ${fmt(s.key)}: ${s.rows.map((r) => `${r.label} has ${fmt(r.symbols)} symbol${r.symbols === 1 ? "" : "s"} (= ${fmt(r.symbols * s.key)})`).join(", ")}`;
    case "table": {
      const show = (v: string) => (isBlank(v) ? (/\?|？/.test(v) ? "? (to find)" : "(blank)") : v);
      return `a table${s.title ? ` titled "${s.title}"` : ""} with ${s.rows.length} row${s.rows.length === 1 ? "" : "s"} under the header row ${s.headers.map((h) => `"${h}"`).join(" | ")}${s.row_headers ? " (first column = row labels)" : ""}; rows: ${s.rows.map((r) => s.headers.map((_, c) => show(r[c] ?? "")).join(" | ")).join("; ")}${s.caption ? `; note under the table: "${s.caption}"` : ""}`;
    }
    case "grid_shape": {
      const on = new Set(s.shaded.map(([r, c]) => `${r},${c}`));
      let perimeter = 0;
      for (const [r, c] of s.shaded) for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (!on.has(`${r + dr},${c + dc}`)) perimeter++;
      return `a ${s.cols} by ${s.rows} square grid with a shaded shape made of ${on.size} squares (its outline is ${perimeter} square sides long)${s.unit_label ? `; ${s.unit_label}` : ""}`;
    }
    case "fraction":
      return `a ${s.shape} divided into ${s.parts} equal parts with ${Math.min(s.shaded, s.parts)} parts shaded${s.label ? ` (labelled "${s.label}")` : ""}`;
    case "groups":
      return s.array
        ? `an array of ${s.groups.length} rows: ${s.groups.map((g) => `${g.count} ${g.symbol}s`).join(", ")}${s.caption ? `; caption "${s.caption}"` : ""}`
        : `${s.groups.length} group${s.groups.length === 1 ? "" : "s"} of objects: ${s.groups.map((g) => `${g.count} ${g.symbol}${g.count === 1 ? "" : "s"}${g.label ? ` ("${g.label}")` : ""}`).join(", ")}${s.caption ? `; caption "${s.caption}"` : ""}`;
    case "geometry": {
      const sp = s.spec;
      const cons = sp.constructions.map((c) => JSON.stringify(c)).join("; ");
      const claims = sp.claims.map((c) => JSON.stringify(c)).join("; ");
      return `a geometry figure${sp.title ? ` ("${sp.title}")` : ""} built from: ${cons}${claims ? `; conditions shown: ${claims}` : ""}${sp.draw.filter((d) => "label" in d && d.label).map((d) => `; label "${(d as { label?: string }).label}"`).join("")}`;
    }
  }
}

/** Exact text description of a spec (what a solver would see in the figure). */
export function describeVisual(spec: VisualSpec): string {
  if (spec.kind === "svg") return spec.description;
  if (spec.kind === "cards") {
    return `${spec.cards.length} card${spec.cards.length === 1 ? "" : "s"} in ${spec.columns} column${spec.columns === 1 ? "" : "s"}, in reading order: ${spec.cards
      .map((c, i) => `card ${i + 1}: ${[c.label ? `"${c.label}"` : "", c.figure ? describeLeaf(c.figure) : "", c.caption ? `caption "${c.caption}"` : "", c.answer_box ? "an empty answer box" : ""].filter(Boolean).join(", ")}`)
      .join("; ")}`;
  }
  return describeLeaf(spec);
}

/** Compact guide to the spec for the model's prompt. */
export const VISUAL_GUIDE = `FIGURES — when a question needs a figure, add "figure": a figure spec (data only; the program draws it exactly as specified, so the figure, the stem and the answer must agree). Kinds:
- {"kind":"clock","hour":0-23,"minute":0-59,"label"?:string,"digital"?:bool}
- {"kind":"number_line","min":n,"max":n,"step":n,"label_every"?:int,"points"?:[{"value":n,"label"?:s}],"hops"?:[{"from":n,"to":n,"label"?:s}],"unknown"?:[{"value":n,"text":"?"}]}
- {"kind":"bar_chart","title"?:s,"categories":[s],"values":[n],"value_label"?:s,"axis_max"?:n,"axis_step"?:n,"horizontal"?:bool,"show_values"?:bool}
- {"kind":"pictograph","title"?:s,"symbol":"circle"|"star"|"square"|"triangle"|"heart"|"apple"|"flower","key":n,"rows":[{"label":s,"symbols":n (halves allowed)}]}
- {"kind":"table","title"?:s,"headers":[s],"rows":[[s]],"row_headers"?:bool,"caption"?:s} — a cell "" or "?" is drawn as a box to fill in
- {"kind":"grid_shape","cols":int,"rows":int,"shaded":[[row,col],…] (0-based),"unit_label"?:s}
- {"kind":"fraction","shape":"bar"|"circle"|"rectangle","parts":int,"shaded":int,"label"?:s}
- {"kind":"groups","groups":[{"count":int,"symbol":…,"label"?:s}],"array"?:bool,"caption"?:s}
- {"kind":"geometry","spec":{"needed":true,"constructions":[…],"draw":[…],"claims":[…]}} — triangles, rectangles, squares, polygons, circles, angles, coordinates (constructions like {"op":"rectangle","ids":["A","B","C","D"],"width":6,"height":4}; label sides with draw {"type":"segment","a":"A","b":"B","label":"6 cm"})
- {"kind":"cards","columns":1-4,"cards":[{"label"?:s,"figure"?:<one of the kinds above>,"caption"?:s,"answer_box"?:bool}]} — a sheet of cards, e.g. sequence cards each with a clock and an activity, or picture cards to sort
- {"kind":"svg","svg":"<svg …>…</svg>","description":"exact description of everything drawn"} — ONLY when no kind above fits; simple line drawing, viewBox about 400×300, no text that gives the answer away.
Rules: the figure must show exactly the information the question needs (no more, no less, nothing that gives the answer away unless the template does the same); refer to it in the stem the way the examples do; prefer the same kind and layout of figure as the examples.`;
