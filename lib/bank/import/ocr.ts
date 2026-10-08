/**
 * Scans and photos → questions.
 *
 * Each page image goes to the vision model (role "vision", see
 * lib/llm/config.ts), which transcribes it verbatim in reading order —
 * questions numbered as printed, choices on their own lines, maths in
 * LaTeX — and reports where figures are. The transcription is then split
 * by the same rules as a text file (lib/bank/import/text.ts), so answer
 * keys, numbering and choices are handled the same way; figures are cut
 * out of the page and attached to their question, and every draft keeps
 * its page image so the reviewer can compare. Nothing read from an image
 * is trusted: every draft is marked for review.
 *
 * The prompt makes the model survey the page first (regions, reading
 * order, decoration vs information), then transcribe, then analyse every
 * question as a template: its task, what a new question of the same kind
 * must keep, and exactly what each figure shows (clock times, values,
 * cards in order). That analysis becomes the question's template_hint and
 * the figure captions, which guide generation from these questions.
 */
import { z } from "zod";
import { chatJson } from "@/lib/llm/client";
import { lt } from "@/lib/llm/output-locale";
import { BankError, saveAsset } from "../store";
import type { ParsedQuestion } from "./fields";
import { cropFigure, dataUrl, IMAGE_EXT, normaliseBox, type Box, type PageImage } from "./images";
import { splitQuestions, type SourceLine } from "./text";

/** Most page images read in one import (env BANK_OCR_MAX_PAGES). */
export function maxOcrPages(): number {
  const n = Number(process.env.BANK_OCR_MAX_PAGES);
  return Number.isInteger(n) && n > 0 ? n : 30;
}

const label = z.union([z.string(), z.number()]).nullish();
const pageSchema = z.object({
  /** The model's survey of the page before transcribing (regions, reading order, what is decoration). */
  layout: z.string().nullish(),
  text: z.string().default(""),
  figures: z
    .array(
      z.object({
        question: label,
        box: z.array(z.coerce.number()).length(4),
        /** clock, table, bar_chart, number_line, shape, picture, cards, … */
        kind: z.string().nullish(),
        /** Exactly what the figure shows (every label, number, time, value). */
        shows: z.string().nullish(),
      }),
    )
    .nullish(),
  /** Each question analysed as a template for new questions. */
  questions: z
    .array(
      z.object({
        label,
        /** What the student has to do. */
        task: z.string().nullish(),
        /** What a new question of the same kind must keep (structure, figure role, answer form, number range). */
        template_note: z.string().nullish(),
      }),
    )
    .nullish(),
  unreadable: z.boolean().nullish(),
});
export type PageTranscription = z.infer<typeof pageSchema>;

const SYSTEM = `You read pages of a maths exam or worksheet from an image, so that the questions can be stored exactly and later used as templates for new questions of the same kind.
Work in three steps.

STEP 1 — Survey the page before transcribing (write it in "layout", 1–3 sentences):
- Find the regions: title and instructions, question blocks, figures (clocks, tables, charts, number lines, shapes, cards with pictures), answer boxes or lines, and pure decoration (illustrations, logos, banners, borders) that carries no maths information.
- Work out the reading order (two columns: the whole left column, then the right; cards: left to right, top to bottom) and which instructions, figures and tables belong to which question.
- A worksheet task without printed question numbers (e.g. a "challenge" with instructions, a set of cards and a final question) is ONE question: number it "1." (or continue from the previous number on the page).

STEP 2 — Transcribe ("text"). You are a copy clerk, not a teacher:
- Transcribe the printed text VERBATIM in reading order. Keep the page's language. Do not translate, solve, correct, summarise or add anything.
- Start every question on a new line with its number exactly as printed, followed by ". " (e.g. "12. …"; keep "第3题" or "例1" as printed). Sub-parts like "(a)" stay inside their question. Instructions that introduce a question go inside that question, after its number.
- Put each answer choice on its own line as "A. …", "B. …" in order.
- Write mathematics in LaTeX between $ … $ (e.g. $\\frac{3}{4}$, $x^2$, $\\sqrt{2}$). Plain numbers and words stay plain.
- Keep printed answer or solution lines ("Answer: …", "答案：…", an answer key) as text.
- Leave out running headers and footers, page numbers, logos, brand names, copyright lines and decoration. Ignore handwriting (student answers, crossings-out, ticks, marks) — transcribe what is printed.
- A table of words or numbers: transcribe it as a Markdown table inside its question, each row on its own line: a header row, a separator line like |---|---|, then the body rows. Keep every cell; leave an empty cell empty and write ? where the paper shows a box or blank to fill in.
- Pictures, diagrams, graphs, number lines, clocks and shapes are not transcribed as text: list each one in "figures" (see below).
- Where printed text cannot be read, write [?] — never guess. Set "unreadable": true if the page as a whole cannot be read.

STEP 3 — Figures and templates:
- "figures": one entry per figure that carries maths information, with the number of the question it belongs to, its bounding box as fractions of the page width and height [x0, y0, x1, y1] (top-left, bottom-right; 0 to 1, including the labels drawn in it), its "kind" (clock, digital_clock, table, bar_chart, pictograph, number_line, grid_shape, fraction, shape, star, speech, cube_stack, solid, groups, cards, picture, other) and "shows": exactly what it shows — every label, number and value, read carefully: on a clock the SHORT hand gives the hour and the LONG hand the minutes (e.g. "analogue clock showing 7:30"); read bars and points against the scale; count tally marks, objects and squares one by one. 3D figures: "cube_stack" for anything built from blocks — small cubes stacked together, steps, a building made of box shapes — give the number of unit blocks in each column as seen from above, back row first, left to right (e.g. "back row 3 2 1, front row 1 1 0; 8 cubes"), any piece on top of a column (half-cylinder, roof, pyramid, cylinder, cone, dome — which column and which way it runs), whether lines between the cubes are drawn or it is plain blocks, oblique (front faces are squares) or isometric (no face square-on) view, and any views drawn with it (front / side / top plans, or empty grids to draw in); plans shown on their own (front, side and top views of one object) are also "cube_stack" — describe the object they show the same way; "speech" for someone saying something in a speech bubble — who speaks and the exact words, and any answer choices drawn under it; "star" for a star shape — the number of points, whether lines cut it into identical pieces (from the centre to the tips, or to the inner corners), any piece drawn separately (which corners it has), lines of symmetry and any angle labels; "solid" for a single solid (cube, cuboid, prism, pyramid, cylinder, cone, sphere, hemisphere) — give the solid, the text on each edge (length, width, height, radius) and whether hidden edges are dashed. A set of picture cards is one figure of kind "cards" whose "shows" lists every card in reading order.
- "questions": for every question on the page, its "label", the "task" (what the student has to do, one sentence) and a "template_note": 1–3 sentences on what a new question of the same kind must keep — the structure and layout, what information is in the figure or table rather than in the text, the answer form, the size and type of numbers used. Write task and template_note in the language of the page.

Return JSON only:
{"layout":"…","text":"…","figures":[{"question":"1","box":[0.1,0.4,0.5,0.6],"kind":"clock","shows":"analogue clock showing 2:00"}],"questions":[{"label":"1","task":"…","template_note":"…"}],"unreadable":false}`;

/** Ask the vision model to read one page. */
export async function transcribePage(img: PageImage): Promise<PageTranscription> {
  return chatJson({
    role: "vision",
    system: SYSTEM,
    user: `Page ${img.page}. Follow the three steps and return the JSON.`,
    images: [dataUrl(img)],
    schema: pageSchema,
    schemaName: "bank_import_ocr_page",
    temperature: 0,
    maxTokens: 10000,
    maxRetries: 1,
    keepLanguage: true,
    noCache: false,
  });
}

const labelKey = (s: string | number | null | undefined) => String(s ?? "").replace(/[^0-9A-Za-z一二三四五六七八九十]/g, "").toLowerCase();

const OCR_ISSUE = () => lt("由图片识别，请对照原图核对文字、公式和选项", "Read from an image; check the text, formulas and choices against the original");
const UNREADABLE_ISSUE = () => lt("有无法辨认的文字（[?]），请对照原图补全", "Some text could not be read ([?]); complete it from the original");
const FIGURE_ISSUE_EN = "Refers to a figure; check the original page";
const FIGURE_ISSUE_ZH = "题目引用了图形，请对照原文件的页面核对";

export interface OcrResult {
  questions: ParsedQuestion[];
  /** Asset names saved (page images and figures). */
  assets: string[];
  /** Pages that could not be read, and other notes for the reviewer. */
  notes: string[];
}

/**
 * Read page images into questions. Page images and figures are saved as
 * assets of the bank. Throws when no page could be read at all.
 */
export async function ocrPages(owner: string, bankId: string, pages: PageImage[], opts: { concurrency?: number } = {}): Promise<OcrResult> {
  const notes: string[] = [];
  const assets: string[] = [];
  const results: Array<PageTranscription | null> = new Array(pages.length).fill(null);
  let lastError = "";
  const limit = Math.max(1, opts.concurrency ?? 3);
  for (let k = 0; k < pages.length; k += limit) {
    await Promise.all(
      pages.slice(k, k + limit).map(async (img, j) => {
        try {
          results[k + j] = await transcribePage(img);
        } catch (e) {
          lastError = (e as Error).message;
          notes.push(lt(`第 ${img.page} 页识别失败：${lastError}`.slice(0, 300), `Page ${img.page} could not be read: ${lastError}`.slice(0, 300)));
        }
      }),
    );
  }
  if (results.every((r) => r === null)) {
    throw new BankError(
      lt(
        `图片识别失败：${lastError}`.slice(0, 240) + "。请确认所配置的模型能读取图片（可用 LLM_VISION_MODEL 指定一个视觉模型）。",
        `Reading the images failed: ${lastError}`.slice(0, 240) + ". Make sure the configured model accepts images (set LLM_VISION_MODEL to a vision model).",
      ),
      502,
    );
  }

  // Page images are kept so the reviewer can compare each question with its page.
  const pageAsset = new Map<number, string>();
  for (const img of pages) {
    const name = saveAsset(owner, bankId, img.data, IMAGE_EXT[img.mime]);
    pageAsset.set(img.page, name);
    assets.push(name);
  }

  const lines: SourceLine[] = [];
  results.forEach((r, i) => {
    if (!r) return;
    const page = pages[i].page;
    if (r.unreadable && !r.text.trim()) notes.push(lt(`第 ${page} 页无法辨认`, `Page ${page} could not be read`));
    for (const text of r.text.split(/\r?\n/)) lines.push({ text, page });
  });
  const questions = splitQuestions(lines, { figureCheck: true });

  // Figures: cut out and attach to the question with the same number on that page.
  type Fig = { box: Box; kind?: string; shows?: string };
  const figureOf = new Map<string, Fig[]>();
  const looseFigures = new Map<number, Fig[]>();
  // The model's analysis of each question as a template, by page and number.
  const analysisOf = new Map<string, { task?: string; note?: string }>();
  results.forEach((r, i) => {
    const page = pages[i].page;
    for (const f of r?.figures ?? []) {
      const box = normaliseBox({ x0: f.box[0], y0: f.box[1], x1: f.box[2], y1: f.box[3] });
      if (!box) continue;
      const fig: Fig = { box, kind: f.kind?.trim() || undefined, shows: f.shows?.trim() || undefined };
      const key = labelKey(f.question);
      if (key) figureOf.set(`${page}|${key}`, [...(figureOf.get(`${page}|${key}`) ?? []), fig]);
      else looseFigures.set(page, [...(looseFigures.get(page) ?? []), fig]);
    }
    for (const q of r?.questions ?? []) {
      const key = labelKey(q.label);
      if (key && !analysisOf.has(key)) analysisOf.set(key, { task: q.task?.trim() || undefined, note: q.template_note?.trim() || undefined });
    }
  });
  const pageByNumber = new Map(pages.map((p) => [p.page, p]));
  // A figure listed under a question on a page where that question does not start (it continues from the
  // previous page) still belongs to it: match by number alone when the page match fails.
  const byLabelAnyPage = (label: string) => [...figureOf.entries()].filter(([k]) => k.endsWith(`|${label}`));

  const out: ParsedQuestion[] = [];
  for (const q of questions) {
    const page = q.fields.source?.page;
    const label = labelKey(q.fields.source?.label);
    const issues = [OCR_ISSUE(), ...q.issues];
    if (/\[\?\]/.test(q.raw)) issues.push(UNREADABLE_ISSUE());
    const images = [...q.fields.images];
    let figs: Array<{ page: number } & Fig> = [];
    if (page && label && figureOf.has(`${page}|${label}`)) {
      figs = figureOf.get(`${page}|${label}`)!.map((f) => ({ page, ...f }));
      figureOf.delete(`${page}|${label}`);
    } else if (label) {
      for (const [k, fs] of byLabelAnyPage(label)) {
        figs.push(...fs.map((f) => ({ page: Number(k.split("|")[0]), ...f })));
        figureOf.delete(k);
      }
    }
    let cropFailed = false;
    for (const { page: p, box, kind, shows } of figs.slice(0, 6)) {
      const img = pageByNumber.get(p);
      const cut = img ? await cropFigure(img, box) : null;
      if (cut) {
        const name = saveAsset(owner, bankId, cut.data, cut.ext);
        assets.push(name);
        // The caption says what the figure shows (as read by the model), so it is useful without the image.
        const caption = shows ? `${kind ? `${kind}: ` : ""}${shows}` : lt(`第 ${p} 页的图`, `Figure from page ${p}`);
        images.push({ asset: name, caption: caption.slice(0, 200) });
      } else cropFailed = true;
    }
    // The model's understanding of the question as a template (task, what to keep, what each figure shows).
    const analysis = label ? analysisOf.get(label) : undefined;
    const figureLines = figs.filter((f) => f.shows).map((f) => lt(`图（${f.kind ?? "图形"}）：${f.shows}`, `Figure (${f.kind ?? "figure"}): ${f.shows}`));
    const templateHint = [analysis?.task, analysis?.note, ...figureLines].filter(Boolean).join("\n").slice(0, 1000) || undefined;
    const keptIssues = images.length > q.fields.images.length ? issues.filter((x) => x !== FIGURE_ISSUE_ZH && x !== FIGURE_ISSUE_EN) : issues;
    if (cropFailed) keptIssues.push(lt("图形未能裁剪，请对照原图补充", "A figure could not be cut out; add it from the original page"));
    out.push({
      ...q,
      fields: {
        ...q.fields,
        images,
        source: { ...q.fields.source, ...(page && pageAsset.has(page) ? { page_image: pageAsset.get(page) } : {}) },
        ...(templateHint ? { template_hint: templateHint } : {}),
      },
      issues: keptIssues,
    });
  }

  const unmatched = [...figureOf.keys()].length + [...looseFigures.values()].reduce((s, b) => s + b.length, 0);
  if (unmatched) notes.push(lt(`有 ${unmatched} 个图形未能对应到题目，请在复核时对照原图`, `${unmatched} figure(s) could not be matched to a question; compare with the original pages in review`));
  return { questions: out, assets, notes };
}
