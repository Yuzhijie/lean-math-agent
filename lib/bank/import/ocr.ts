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

const pageSchema = z.object({
  text: z.string().default(""),
  figures: z
    .array(
      z.object({
        question: z.union([z.string(), z.number()]).nullish(),
        box: z.array(z.coerce.number()).length(4),
      }),
    )
    .nullish(),
  unreadable: z.boolean().nullish(),
});
export type PageTranscription = z.infer<typeof pageSchema>;

const SYSTEM = `You transcribe pages of a maths exam or worksheet from an image. You are a copy clerk, not a teacher.
Rules:
- Transcribe the printed text VERBATIM in reading order (two columns: the whole left column, then the right). Keep the page's language. Do not translate, solve, correct, summarise or add anything.
- Start every question on a new line with its number exactly as printed, followed by ". " (e.g. "12. …"; keep "第3题" or "例1" as printed). Sub-parts like "(a)" stay inside their question.
- Put each answer choice on its own line as "A. …", "B. …" in order.
- Write mathematics in LaTeX between $ … $ (e.g. $\\frac{3}{4}$, $x^2$, $\\sqrt{2}$). Plain numbers and words stay plain.
- Keep printed answer or solution lines ("Answer: …", "答案：…", an answer key) as text.
- Leave out running headers and footers, page numbers, logos and copyright lines. Ignore handwriting (student answers, ticks, marks).
- A table of words or numbers: transcribe it as a Markdown table inside its question.
- Pictures, diagrams, graphs, number lines and shapes: do not describe them. List each one in "figures" with the number of the question it belongs to and its bounding box as fractions of the page width and height [x0, y0, x1, y1] (top-left, bottom-right; 0 to 1). Include the labels drawn in the figure inside the box.
- Where text cannot be read, write [?] — never guess. Set "unreadable": true if the page as a whole cannot be read.
Return JSON: {"text":"…","figures":[{"question":"12","box":[0.1,0.4,0.5,0.6]}],"unreadable":false}`;

/** Ask the vision model to transcribe one page. */
export async function transcribePage(img: PageImage): Promise<PageTranscription> {
  return chatJson({
    role: "vision",
    system: SYSTEM,
    user: `Page ${img.page}. Transcribe it as JSON.`,
    images: [dataUrl(img)],
    schema: pageSchema,
    schemaName: "bank_import_ocr_page",
    temperature: 0,
    maxTokens: 8000,
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
  const figureOf = new Map<string, Box[]>();
  const looseFigures = new Map<number, Box[]>();
  results.forEach((r, i) => {
    for (const f of r?.figures ?? []) {
      const box = normaliseBox({ x0: f.box[0], y0: f.box[1], x1: f.box[2], y1: f.box[3] });
      if (!box) continue;
      const page = pages[i].page;
      const key = labelKey(f.question);
      if (key) figureOf.set(`${page}|${key}`, [...(figureOf.get(`${page}|${key}`) ?? []), box]);
      else looseFigures.set(page, [...(looseFigures.get(page) ?? []), box]);
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
    let boxes: Array<{ page: number; box: Box }> = [];
    if (page && label && figureOf.has(`${page}|${label}`)) {
      boxes = figureOf.get(`${page}|${label}`)!.map((box) => ({ page, box }));
      figureOf.delete(`${page}|${label}`);
    } else if (label) {
      for (const [k, bs] of byLabelAnyPage(label)) {
        boxes.push(...bs.map((box) => ({ page: Number(k.split("|")[0]), box })));
        figureOf.delete(k);
      }
    }
    let cropFailed = false;
    for (const { page: p, box } of boxes.slice(0, 6)) {
      const img = pageByNumber.get(p);
      const cut = img ? await cropFigure(img, box) : null;
      if (cut) {
        const name = saveAsset(owner, bankId, cut.data, cut.ext);
        assets.push(name);
        images.push({ asset: name, caption: lt(`第 ${p} 页的图`, `Figure from page ${p}`) });
      } else cropFailed = true;
    }
    const keptIssues = images.length > q.fields.images.length ? issues.filter((x) => x !== FIGURE_ISSUE_ZH && x !== FIGURE_ISSUE_EN) : issues;
    if (cropFailed) keptIssues.push(lt("图形未能裁剪，请对照原图补充", "A figure could not be cut out; add it from the original page"));
    out.push({
      ...q,
      fields: { ...q.fields, images, source: { ...q.fields.source, ...(page && pageAsset.has(page) ? { page_image: pageAsset.get(page) } : {}) } },
      issues: keptIssues,
    });
  }

  const unmatched = [...figureOf.keys()].length + [...looseFigures.values()].reduce((s, b) => s + b.length, 0);
  if (unmatched) notes.push(lt(`有 ${unmatched} 个图形未能对应到题目，请在复核时对照原图`, `${unmatched} figure(s) could not be matched to a question; compare with the original pages in review`));
  return { questions: out, assets, notes };
}
