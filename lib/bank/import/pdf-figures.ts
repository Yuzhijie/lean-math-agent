/**
 * Figures of a PDF that has a text layer.
 *
 * The questions of such a file come from its text (pdf.ts); what is drawn
 * on the page — embedded pictures and vector drawings (charts, shapes,
 * tables, number cards) — is not text and was left behind. Here the program
 * finds it: every drawing operator of a page gives a box, boxes close to
 * each other are one figure, and a figure belongs to the question whose
 * text starts above it. No model is asked.
 *
 * Pixels: a figure that is exactly one embedded picture is taken from the
 * PDF as it is; anything drawn has to be rendered, which needs
 * @napi-rs/canvas (optional — without it those figures are counted and the
 * import says how to get them).
 *
 * All coordinates are PDF points with the origin at the top left.
 */
import { lt } from "@/lib/llm/output-locale";
import { saveAsset } from "../store";
import type { ParsedQuestion } from "./fields";
import { cropFigure, encodePng, loadCanvas, loadSharp, preparePhoto, type PageImage } from "./images";

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Drawing extends Rect {
  /** Name of the embedded picture, when the drawing is one. */
  image?: string;
}

export interface TextLine extends Rect {
  text: string;
}

export interface PageLayout {
  page: number;
  width: number;
  height: number;
  lines: TextLine[];
  /** Single runs of text, for labels that sit inside a figure; `turned`: written up the page (an axis name). */
  items: Array<Rect & { turned?: boolean }>;
  drawings: Drawing[];
}

export interface FigureRegion extends Rect {
  page: number;
  /** The one embedded picture this figure is, when it is nothing else. */
  image?: string;
}

// ── Finding the figures of a page (pure) ─────────────────────────────

const union = (a: Rect, b: Rect): Rect => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
const near = (a: Rect, b: Rect, gap: number) => a.x0 - gap <= b.x1 && b.x0 - gap <= a.x1 && a.y0 - gap <= b.y1 && b.y0 - gap <= a.y1;
const inside = (r: Rect, x: number, y: number) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;

/** Boxes closer than this are parts of one figure. */
const GAP = 24;
/** Smaller than this on either side: a bullet, an underline, a tick box. */
const MIN_SIDE = 14;

/**
 * The figures of one page: drawings grouped by nearness, grown by the text
 * runs inside them. Left out: what covers the page (backgrounds, clipping
 * rectangles), long thin rules (separators, answer lines), and anything
 * too small to be a figure.
 */
export function figureRegions(layout: PageLayout): FigureRegion[] {
  const { width, height } = layout;
  const groups: Array<Rect & { images: Set<string>; parts: number; rows: Rect[] }> = [];
  for (const d of layout.drawings) {
    const w = d.x1 - d.x0, h = d.y1 - d.y0;
    if (w * h > 0.7 * width * height) continue;
    if ((h < 2 && w > 0.5 * width) || (w < 2 && h > 0.5 * height)) continue;
    if (d.x1 < 0 || d.y1 < 0 || d.x0 > width || d.y0 > height) continue;
    // A small drawing set in a line of text (an icon in an answer choice, keys shown in a sentence) means
    // nothing without its line: the whole row goes into the figure.
    const rows: Rect[] = [];
    if (h >= 6 && w >= 6) {
      // In a line: a run of text level with it ends or starts within a space of it (runs, not whole lines —
      // a label drawn in a figure can be on the "line" of the text beside the figure).
      const level = layout.items.filter((t) => !t.turned && t.y1 > t.y0 && h <= 2.6 * (t.y1 - t.y0) && Math.min(t.y1, d.y1) - Math.max(t.y0, d.y0) >= 0.5 * Math.min(t.y1 - t.y0, h));
      if (level.some((t) => (t.x1 <= d.x0 + 2 && t.x1 >= d.x0 - 8) || (t.x0 >= d.x1 - 2 && t.x0 <= d.x1 + 8))) {
        // The row as far as it runs without a break (text across a wide gap is another column).
        let row: Rect = d;
        for (let grown = true; grown; ) {
          grown = false;
          for (const t of level) {
            if (t.x0 >= row.x0 && t.x1 <= row.x1) continue;
            if (t.x0 - 14 <= row.x1 && row.x0 - 14 <= t.x1) {
              row = union(row, t);
              grown = true;
            }
          }
        }
        rows.push(row);
      }
    }
    groups.push({ x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1, images: new Set(d.image ? [d.image] : []), parts: 1, rows });
  }
  // Merge until nothing is near anything else.
  for (let merged = true; merged; ) {
    merged = false;
    outer: for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        if (!near(groups[i], groups[j], GAP)) continue;
        const g = groups[j];
        Object.assign(groups[i], union(groups[i], g));
        for (const im of g.images) groups[i].images.add(im);
        groups[i].parts += g.parts;
        groups[i].rows.push(...g.rows);
        groups.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }
  const out: FigureRegion[] = [];
  for (const g of groups) {
    if (g.x1 - g.x0 < MIN_SIDE || g.y1 - g.y0 < MIN_SIDE) continue;
    let box: Rect = { x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1 };
    let labels = 0;
    // Labels drawn in the figure (numbers on cards, axis values): text runs whose centre is inside.
    for (const t of layout.items) {
      if (!inside(g, (t.x0 + t.x1) / 2, (t.y0 + t.y1) / 2)) continue;
      box = union(box, t);
      labels++;
    }
    for (const r of g.rows) box = union(box, r);
    // Text set right against the figure and short — a title, an axis name, "5 curls", "124 cm" — is part of
    // it; a full line of the question is not.
    const short = layout.lines.filter((l) => l.x1 - l.x0 < 0.45 * width);
    const long = layout.lines.filter((l) => l.x1 - l.x0 >= 0.45 * width);
    const inLongLine = (t: Rect) => long.some((l) => inside(l, (t.x0 + t.x1) / 2, (t.y0 + t.y1) / 2));
    for (let pass = 0; pass < 4; pass++) {
      const before = box;
      for (const l of short) if (near(box, l, 9) && l.x0 >= box.x0 - 5 && l.x1 <= box.x1 + 5) box = union(box, l);
      for (const t of layout.items) {
        // A number or a word beside it (a scale's values, a row's total), or a short run above or below it.
        if (t.turned ? near(box, t, 16) : near(box, t, 9) && ((t.x1 - t.x0 < 40 && !inLongLine(t)) || (t.x1 - t.x0 < 0.3 * width && t.x0 >= box.x0 - 5 && t.x1 <= box.x1 + 5))) box = union(box, t);
      }
      if (before.x0 === box.x0 && before.y0 === box.y0 && before.x1 === box.x1 && before.y1 === box.y1) break;
    }
    const pad = 4;
    const region: FigureRegion = {
      page: layout.page,
      x0: Math.max(0, box.x0 - pad),
      y0: Math.max(0, box.y0 - pad),
      x1: Math.min(width, box.x1 + pad),
      y1: Math.min(height, box.y1 + pad),
    };
    if ((region.x1 - region.x0) * (region.y1 - region.y0) > 0.7 * width * height) continue;
    if (g.parts === 1 && g.images.size === 1 && !labels && !g.rows.length && region.x1 - region.x0 <= g.x1 - g.x0 + 2 * pad + 0.5 && region.y1 - region.y0 <= g.y1 - g.y0 + 2 * pad + 0.5) region.image = [...g.images][0];
    out.push(region);
  }
  return out.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}

/** Figures at the same place on most pages are the paper's own furniture (logo, header bar). */
export function dropRepeated(pages: FigureRegion[][]): FigureRegion[][] {
  const key = (r: FigureRegion) => [r.x0, r.y0, r.x1, r.y1].map((v) => Math.round(v / 6)).join(",");
  const counts = new Map<string, number>();
  for (const page of pages) for (const k of new Set(page.map(key))) counts.set(k, (counts.get(k) ?? 0) + 1);
  const threshold = Math.max(3, Math.ceil(pages.filter((p) => p.length).length * 0.5));
  return pages.map((page) => page.filter((r) => (counts.get(key(r)) ?? 0) < threshold));
}

export interface QuestionStart {
  /** Index of the question in the list. */
  index: number;
  page: number;
  y: number;
}

const squash = (s: string) => s.replace(/\s+/g, "");

/** Where each question's text starts on its page: the line that carries its number and first words. */
export function questionStarts(questions: ParsedQuestion[], layouts: PageLayout[]): QuestionStart[] {
  const byPage = new Map(layouts.map((l) => [l.page, l]));
  const out: QuestionStart[] = [];
  const used = new Set<string>();
  questions.forEach((q, index) => {
    const page = q.fields.source?.page;
    const label = q.fields.source?.label;
    const layout = page ? byPage.get(page) : undefined;
    if (!layout || !label) return;
    const first = squash(q.raw.split("\n")[0] ?? "");
    const body = squash((q.raw.split("\n")[0] ?? "").replace(/^\S+\s/, "")).slice(0, 24);
    const numbered = new RegExp(String.raw`^(?:第|例|Q(?:uestion)?)?[(（]?${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\d)`, "i");
    const hit = layout.lines.findIndex((l, i) => {
      if (used.has(`${page}|${i}`)) return false;
      const t = squash(l.text);
      return numbered.test(t) && (!body || t.includes(body) || first.includes(t.slice(0, 24)));
    });
    if (hit < 0) return;
    used.add(`${page}|${hit}`);
    out.push({ index, page: page!, y: layout.lines[hit].y0 });
  });
  return out.sort((a, b) => a.page - b.page || a.y - b.y);
}

/** A figure further than this below the end of a question's text is not that question's. */
const BLOCK_GAP = 70;

/**
 * Which question each figure belongs to. A question's block on a page runs from the line with its number
 * to the next question's; walking down it, text lines and figures follow each other closely, and the first
 * gap wider than BLOCK_GAP ends it (what stands far below the last question of a page is not its figure).
 * A figure above the first question of a page goes to the question running over from the page before.
 * Figures of one question that stand close together are one figure.
 */
export function assignFigures(regions: FigureRegion[], starts: QuestionStart[], layouts: PageLayout[] = []): Map<number, FigureRegion[]> {
  const out = new Map<number, FigureRegion[]>();
  const linesOf = new Map(layouts.map((l) => [l.page, l.lines]));
  const pages = [...new Set(regions.map((r) => r.page))].sort((a, b) => a - b);
  for (const page of pages) {
    const here = starts.filter((s) => s.page === page);
    const before = starts.filter((s) => s.page < page).at(-1);
    // Blocks from the top of the page down: [from, to, owner].
    const blocks: Array<{ from: number; to: number; owner?: QuestionStart }> = [];
    if (before && before.page === page - 1) blocks.push({ from: 0, to: here[0]?.y ?? Infinity, owner: before });
    here.forEach((s, i) => blocks.push({ from: s.y, to: here[i + 1]?.y ?? Infinity, owner: s }));
    for (const b of blocks) {
      if (!b.owner) continue;
      // A figure beside the first line of its question may start a little above that line.
      const mine = regions.filter((r) => r.page === page && Math.max((r.y0 + r.y1) / 2, r.y0 + 12) >= b.from && Math.max((r.y0 + r.y1) / 2, r.y0 + 12) < b.to);
      if (!mine.length) continue;
      const text = (linesOf.get(page) ?? []).filter((l) => l.y0 >= b.from - 2 && l.y0 < b.to);
      const walk = [...text.map((l) => ({ y0: l.y0, y1: l.y1, region: undefined as FigureRegion | undefined })), ...mine.map((r) => ({ y0: r.y0, y1: r.y1, region: r as FigureRegion | undefined }))].sort((x, y) => x.y0 - y.y0);
      let end = b.owner.page === page ? b.from : walk[0].y0;
      const kept: FigureRegion[] = [];
      for (const w of walk) {
        if (w.y0 - end > BLOCK_GAP) break;
        end = Math.max(end, w.y1);
        if (w.region) kept.push(w.region);
      }
      if (kept.length) out.set(b.owner.index, [...(out.get(b.owner.index) ?? []), ...mergeNear(kept, 40)]);
    }
  }
  return out;
}

function mergeNear(regions: FigureRegion[], gap: number): FigureRegion[] {
  const rs = regions.map((r) => ({ ...r }));
  for (let merged = true; merged; ) {
    merged = false;
    outer: for (let i = 0; i < rs.length; i++) {
      for (let j = i + 1; j < rs.length; j++) {
        if (!near(rs[i], rs[j], gap)) continue;
        rs[i] = { page: rs[i].page, ...union(rs[i], rs[j]) };
        rs.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }
  return rs.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}

// ── Reading the PDF ──────────────────────────────────────────────────

type Matrix = [number, number, number, number, number, number];
const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

function boxOf(m: Matrix, x0: number, y0: number, x1: number, y1: number, height: number): Rect {
  const xs: number[] = [], ys: number[] = [];
  for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
    xs.push(m[0] * x + m[2] * y + m[4]);
    ys.push(m[1] * x + m[3] * y + m[5]);
  }
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: height - Math.max(...ys), y1: height - Math.min(...ys) };
}

interface PdfPage {
  getViewport(o: { scale: number }): { width: number; height: number; transform: number[] };
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  getTextContent(): Promise<{ items: Array<{ str?: string; width?: number; height?: number; transform?: number[]; hasEOL?: boolean }> }>;
}

/** Text lines (as extractText joins them) and drawing boxes of every page. */
export async function pdfLayouts(data: Buffer, pages?: number[]): Promise<PageLayout[]> {
  const { getDocumentProxy } = await import("unpdf");
  const { OPS } = (await import("unpdf/pdfjs")) as unknown as { OPS: Record<string, number> };
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const out: PageLayout[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    if (pages && !pages.includes(p)) continue;
    const page = (await pdf.getPage(p)) as unknown as PdfPage;
    const vp = page.getViewport({ scale: 1 });
    const { width, height } = vp;
    // Text.
    const lines: TextLine[] = [];
    const items: PageLayout["items"] = [];
    let cur: TextLine | undefined;
    for (const it of (await page.getTextContent()).items) {
      if (it.str == null) continue;
      if (it.str.trim() && it.transform) {
        const h = it.height || Math.hypot(it.transform[2], it.transform[3]);
        const [a, b, , , e, f] = it.transform;
        if (Math.abs(b) > Math.abs(a)) {
          // Written up (or down) the page: it is no part of a line of the question.
          const w = it.width ?? 0;
          items.push({ x0: e - h, x1: e + h * 0.3, y0: b > 0 ? height - f - w : height - f, y1: b > 0 ? height - f : height - f + w, turned: true });
          continue;
        }
        const r: Rect = { x0: e, x1: e + (it.width ?? 0), y0: height - f - h, y1: height - f };
        items.push(r);
        cur = cur ? { ...union(cur, r), text: cur.text + it.str } : { ...r, text: it.str };
      } else if (cur) cur.text += it.str;
      if (it.hasEOL && cur) {
        lines.push(cur);
        cur = undefined;
      }
    }
    if (cur) lines.push(cur);
    // Drawings.
    const drawings: Drawing[] = [];
    const ops = await page.getOperatorList();
    let ctm: Matrix = [1, 0, 0, 1, 0, 0];
    let clip: Rect | undefined;
    let pendingClip = false;
    const stack: Array<{ ctm: Matrix; clip?: Rect }> = [];
    // Only what the clip lets through is seen (a hatching drawn across the page, clipped to a card).
    const push = (d: Drawing) => {
      const c = clip;
      const v = c ? { ...d, x0: Math.max(d.x0, c.x0), y0: Math.max(d.y0, c.y0), x1: Math.min(d.x1, c.x1), y1: Math.min(d.y1, c.y1) } : d;
      if (v.x1 >= v.x0 && v.y1 >= v.y0) drawings.push(v);
    };
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      const args = ops.argsArray[i] ?? [];
      if (fn === OPS.save) stack.push({ ctm, clip });
      else if (fn === OPS.restore) {
        const s = stack.pop();
        if (s) ({ ctm, clip } = s);
      } else if (fn === OPS.transform) ctm = mul(ctm, args as unknown as Matrix);
      else if (fn === OPS.constructPath) {
        const mm = args[2] as ArrayLike<number> | undefined;
        if (!mm || mm.length < 4 || ![0, 1, 2, 3].every((k) => Number.isFinite(mm[k]))) continue;
        const box = boxOf(ctm, mm[0], mm[1], mm[2], mm[3], height);
        // "clip" comes before the path it clips to; clips inside each other narrow.
        if (pendingClip) {
          clip = clip ? { x0: Math.max(clip.x0, box.x0), y0: Math.max(clip.y0, box.y0), x1: Math.min(clip.x1, box.x1), y1: Math.min(clip.y1, box.y1) } : box;
          pendingClip = false;
        }
        // A path that is only ended is there to clip, not to be seen.
        if (args[0] !== OPS.endPath) push(box);
      } else if (fn === OPS.clip || fn === OPS.eoClip) {
        pendingClip = true;
      } else if (fn === OPS.shadingFill) {
        if (clip) push(clip);
      } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject || fn === OPS.paintImageXObjectRepeat) {
        push({ ...boxOf(ctm, 0, 0, 1, 1, height), ...(fn === OPS.paintImageXObject && typeof args[0] === "string" ? { image: args[0] } : {}) });
      }
    }
    out.push({ page: p, width, height, lines, items, drawings });
  }
  return out;
}

// ── Attaching the figures to the questions ───────────────────────────

const FIGURE_ISSUES = ["题目引用了图形，请对照原文件的页面核对", "Refers to a figure; check the original page"];
/** Most figures kept for one question. */
const MAX_PER_QUESTION = 6;
const SCALE = 2.5;

export interface AttachResult {
  questions: ParsedQuestion[];
  assets: string[];
  notes: string[];
  /** Figures attached / figures found that belong to a question. */
  attached: number;
  found: number;
}

/**
 * The figures of a text PDF, cut out and attached to its questions (`fields.images`). Never fails the import:
 * whatever goes wrong, the questions come back as they were with a note.
 */
export async function attachPdfFigures(owner: string, bankId: string, data: Buffer, questions: ParsedQuestion[], opts: { skipPages?: number[] } = {}): Promise<AttachResult> {
  const none = (notes: string[] = []): AttachResult => ({ questions, assets: [], notes, attached: 0, found: 0 });
  try {
    const skip = new Set(opts.skipPages ?? []);
    const layouts = (await pdfLayouts(data)).filter((l) => !skip.has(l.page));
    const starts = questionStarts(questions, layouts);
    if (!starts.length) return none();
    const regions = dropRepeated(layouts.map(figureRegions)).flat();
    const byQuestion = assignFigures(regions, starts, layouts);
    const found = [...byQuestion.values()].reduce((s, r) => s + r.length, 0);
    if (!found) return none();

    const sizeOf = new Map(layouts.map((l) => [l.page, l]));
    const canvas = await loadCanvas();
    const rendered = new Map<number, PageImage | null>();
    const pageImage = async (p: number): Promise<PageImage | null> => {
      if (!canvas) return null;
      if (!rendered.has(p)) {
        try {
          const { renderPageAsImage } = await import("unpdf");
          const png = Buffer.from(await renderPageAsImage(new Uint8Array(data), p, { canvasImport: async () => canvas as never, scale: SCALE }));
          rendered.set(p, { data: png, mime: "image/png", page: p });
        } catch {
          rendered.set(p, null);
        }
      }
      return rendered.get(p) ?? null;
    };
    // Embedded pictures, for figures that are exactly one of them (no rendering needed).
    const embedded = new Map<number, Map<string, Buffer>>();
    const embeddedImage = async (p: number, key: string): Promise<Buffer | null> => {
      if (!embedded.has(p)) {
        const m = new Map<string, Buffer>();
        try {
          const { extractImages, getDocumentProxy } = await import("unpdf");
          const pdf = await getDocumentProxy(new Uint8Array(data));
          for (const im of (await extractImages(pdf, p)) as Array<{ data: Uint8ClampedArray; width: number; height: number; channels: 1 | 3 | 4; key: string }>) {
            m.set(im.key, encodePng({ data: new Uint8Array(im.data.buffer, im.data.byteOffset, im.data.byteLength), width: im.width, height: im.height, channels: im.channels }));
          }
        } catch {
          /* no embedded pictures to take */
        }
        embedded.set(p, m);
      }
      return embedded.get(p)!.get(key) ?? null;
    };

    const assets: string[] = [];
    let attached = 0;
    let unrendered = 0;
    let blank = 0;
    const out: ParsedQuestion[] = [];
    for (const [index, q] of questions.entries()) {
      const figs = (byQuestion.get(index) ?? []).slice(0, MAX_PER_QUESTION);
      if (!figs.length) {
        out.push(q);
        continue;
      }
      const images = [...q.fields.images];
      for (const r of figs) {
        const size = sizeOf.get(r.page)!;
        let cut: { data: Buffer; ext: string } | null = null;
        const page = await pageImage(r.page);
        if (page) cut = await cropFigure(page, { x0: r.x0 / size.width, y0: r.y0 / size.height, x1: r.x1 / size.width, y1: r.y1 / size.height });
        if (!cut && r.image) {
          const png = await embeddedImage(r.page, r.image);
          if (png) {
            // Scaled like a photo when it is large; kept as it is otherwise.
            const photo = await preparePhoto(png, r.page).catch(() => null);
            cut = photo ? { data: photo.data, ext: photo.mime === "image/jpeg" ? "jpg" : "png" } : { data: png, ext: "png" };
          }
        }
        if (!cut) {
          unrendered++;
          continue;
        }
        if (await isBlank(cut.data)) {
          blank++;
          continue;
        }
        const name = saveAsset(owner, bankId, cut.data, cut.ext);
        assets.push(name);
        images.push({ asset: name, caption: lt(`第 ${r.page} 页的图`, `Figure from page ${r.page}`) });
        attached++;
      }
      const got = images.length > q.fields.images.length;
      out.push({ ...q, fields: { ...q.fields, images }, issues: got ? q.issues.filter((x) => !FIGURE_ISSUES.includes(x)) : q.issues });
    }
    const notes: string[] = [];
    if (attached) notes.push(lt(`从 PDF 中取出了 ${attached} 个图形并附在对应的题目上，请在复核时核对归属`, `${attached} figure${attached === 1 ? " was" : "s were"} taken from the PDF and attached to the questions; check in review that each is with the right question`));
    if (blank) notes.push(lt(`有 ${blank} 个图形在原文件的页面上是空白的（被底色盖住或没有画出内容），未导入`, `${blank} figure${blank === 1 ? " is" : "s are"} blank on the file's own page (covered by a fill, or nothing drawn) and ${blank === 1 ? "was" : "were"} not imported`));
    if (unrendered) {
      notes.push(
        lt(
          `有 ${unrendered} 个图形是矢量绘制的，需要渲染页面才能取出：在项目目录运行 npm install @napi-rs/canvas 后重新导入即可`,
          `${unrendered} figure${unrendered === 1 ? " is" : "s are"} drawn as vector graphics and can only be taken by rendering the page: run npm install @napi-rs/canvas in the project folder and import again`,
        ),
      );
    }
    return { questions: out, assets, notes, attached, found };
  } catch (e) {
    return none([lt(`未能取出 PDF 中的图形：${(e as Error).message}`.slice(0, 200), `The figures of the PDF could not be taken: ${(e as Error).message}`.slice(0, 200))]);
  }
}

/** A crop of (almost) one colour shows nothing. Undecided without sharp: kept. */
async function isBlank(png: Buffer): Promise<boolean> {
  const sharp = await loadSharp();
  if (!sharp) return false;
  try {
    const { data } = await (sharp(png) as unknown as { resize(o: object): { greyscale(): { raw(): { toBuffer(o: { resolveWithObject: true }): Promise<{ data: Buffer }> } } } })
      .resize({ width: 64, height: 64, fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let lo = 255, hi = 0;
    for (const v of data) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return hi - lo < 12;
  } catch {
    return false;
  }
}
