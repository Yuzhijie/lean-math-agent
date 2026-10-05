/**
 * PDF → questions.
 *
 * Text is extracted per page with unpdf (pdf.js; no page rendering). Lines
 * repeated at the top or bottom of most pages (running headers, footers,
 * "Page 3", "© …", "ICAS …") are removed, then the text is split like a
 * text file, keeping each question's page number.
 *
 * Optionally the model restructures each question's raw text into fields.
 * It is told to copy the stem verbatim; its output is checked against the
 * raw text and anything it rewrote is discarded (the heuristic fields are
 * kept and the draft is marked for review).
 */
import { z } from "zod";
import { chatJson } from "@/lib/llm/client";
import { lt } from "@/lib/llm/output-locale";
import { normaliseStem, stemSimilarity } from "../similarity";
import { BankError } from "../store";
import { QUESTION_TYPES } from "../types";
import { clampStr, mapType, normaliseChoiceAnswer, stripOptionLetter, type ParsedQuestion } from "./fields";
import { splitQuestions, type SourceLine } from "./text";

export async function extractPdfPages(data: Buffer): Promise<string[]> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    // pdf.js takes ownership of (detaches) the buffer it is given: pass a copy.
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const { text } = await extractText(pdf, { mergePages: false });
    return text;
  } catch (e) {
    throw new BankError(lt(`无法读取 PDF：${(e as Error).message}`.slice(0, 300), `Cannot read the PDF: ${(e as Error).message}`.slice(0, 300)), 422);
  }
}

const PAGE_NUMBER = /^(?:page\s*\d+(?:\s*(?:of|\/)\s*\d+)?|第\s*\d+\s*页(?:\s*[,，]?\s*共\s*\d+\s*页)?|[-–—]?\s*\d{1,3}\s*[-–—]?|\d{1,3}\s*\/\s*\d{1,3})$/i;
const QUESTIONISH = /^\s*(?:[(（]?\d{1,3}[.．、)）]|[(（]?[A-E][.．、)）]|Q\d)/;

/** Lines of each page with running headers / footers removed. */
export function cleanPages(pages: string[]): string[][] {
  const lines = pages.map((p) =>
    p
      .split(/\r?\n/)
      .map((l) => l.replace(/[^\S\n]+/g, " ").trim())
      .filter(Boolean),
  );
  const edge = (arr: string[], i: number) => i < 3 || i >= arr.length - 3;
  const keyOf = (l: string) => (/page|页|\d\s*\/\s*\d/i.test(l) ? l.replace(/\d+/g, "#") : l).toLowerCase();
  const counts = new Map<string, number>();
  for (const page of lines) {
    const seen = new Set<string>();
    page.forEach((l, i) => {
      if (edge(page, i)) seen.add(keyOf(l));
    });
    for (const k of seen) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const threshold = Math.max(2, Math.ceil(pages.length * 0.5));
  return lines.map((page) =>
    page.filter((l, i) => {
      if (/©|^\(c\)\s|^copyright\b/i.test(l)) return false;
      if (!edge(page, i)) return true;
      const bare = /^[-–—]?\s*\d{1,3}\s*[-–—]?$/.test(l);
      if (PAGE_NUMBER.test(l) && (!bare || i === 0 || i === page.length - 1)) return false;
      if (/^ICAS\b/.test(l)) return false;
      if (pages.length >= 2 && !QUESTIONISH.test(l) && (counts.get(keyOf(l)) ?? 0) >= threshold) return false;
      return true;
    }),
  );
}

/** Too little text for the number of pages: a scan (image-only PDF). */
export function looksScanned(pages: string[]): boolean {
  const chars = pages.join("").replace(/\s/g, "").length;
  return chars < Math.max(40, 25 * pages.length);
}

/** Questions from a PDF's text layer; `scanned` when it has (almost) no text — read it with ocrPages instead. */
export async function parsePdf(data: Buffer): Promise<{ questions: ParsedQuestion[]; scanned: false } | { questions: []; scanned: true }> {
  const pages = await extractPdfPages(data);
  if (!pages.length || looksScanned(pages)) return { questions: [], scanned: true };
  const lines: SourceLine[] = cleanPages(pages).flatMap((ls, p) => ls.map((text) => ({ text, page: p + 1 })));
  return { questions: splitQuestions(lines, { joinLines: true, figureCheck: true }), scanned: false };
}

// ── Model restructuring ──────────────────────────────────────────────

const modelItemSchema = z.object({
  i: z.coerce.number().int(),
  stem: z.string(),
  type: z.string().nullish(),
  options: z.array(z.string()).nullish(),
  answer: z.string().nullish(),
  solution: z.string().nullish(),
});
const modelOutputSchema = z.object({ items: z.array(modelItemSchema) });
type ModelItem = z.infer<typeof modelItemSchema>;

const SYSTEM = `You restructure exam questions that were extracted from a PDF into fields. You are a copy clerk, not a teacher.
Rules:
- Copy the question stem VERBATIM from the text: same words, same numbers, same order. Only drop the question number, the answer choices and any answer/solution text from the stem. Do not solve, do not rewrite, do not translate, do not fix grammar, do not add anything.
- If the text lists answer choices (A, B, C …), return them in "options" in order, verbatim, without the letters, and set type "multiple_choice".
- Return "answer" and "solution" ONLY if they are written in the text itself (e.g. "Answer: B", "答案：…"). Never work out an answer yourself; otherwise leave them null.
- type is one of: ${QUESTION_TYPES.join(", ")}.
Return JSON: {"items":[{"i":<index>,"stem":"…","type":"…","options":[…]|null,"answer":"…"|null,"solution":"…"|null}]} with one entry per input question.`;

const ANSWER_IN_TEXT = /答案|解析|answer|ans\.|solution|key/i;

function containedVerbatim(candidate: string, raw: string, heuristic: string): boolean {
  const c = normaliseStem(candidate);
  if (!c) return false;
  if (normaliseStem(raw).includes(c)) return true;
  return stemSimilarity(candidate, heuristic) >= 0.9;
}

/** Merge one model answer into a heuristic question, keeping only what the model copied verbatim. */
export function mergeModelItem(q: ParsedQuestion, m: ModelItem): ParsedQuestion {
  const issues = [...q.issues];
  const raw = q.raw;
  if (!containedVerbatim(m.stem, raw, q.fields.stem)) {
    issues.push(lt("模型改写了题干，已保留原文，请核对", "The model changed the question wording; the original text was kept — please check"));
    return { ...q, issues };
  }
  const fields = { ...q.fields, stem: clampStr(m.stem.trim(), 20_000) };
  const rawNorm = normaliseStem(raw);
  const modelOptions = (m.options ?? []).map((o) => stripOptionLetter(o)).filter((o) => o !== "");
  if (modelOptions.length >= 2 && modelOptions.length <= 10 && modelOptions.every((o) => rawNorm.includes(normaliseStem(o)))) {
    // Prefer the heuristic split when it found the same number of options (it keeps the exact text).
    if (!q.fields.options || q.fields.options.length !== modelOptions.length) fields.options = modelOptions.map((o) => clampStr(o, 2000));
  }
  const type = mapType(m.type);
  if (fields.options && fields.options.length >= 2) fields.type = "multiple_choice";
  else if (type && q.fields.type === "other") fields.type = type;
  // Answers only when the text has one (never a model-solved answer).
  if (!fields.answer && m.answer && ANSWER_IN_TEXT.test(raw) && rawNorm.includes(normaliseStem(m.answer))) {
    fields.answer = clampStr(fields.type === "multiple_choice" ? normaliseChoiceAnswer(m.answer.trim()) : m.answer.trim(), 5000);
  }
  if (!fields.solution && m.solution && rawNorm.includes(normaliseStem(m.solution))) fields.solution = clampStr(m.solution.trim(), 20_000);
  return { ...q, fields, issues };
}

/** Restructure questions with the model in batches; falls back to the heuristic fields (with an issue) on failure. */
export async function refineWithModel(questions: ParsedQuestion[], opts: { batchSize?: number; concurrency?: number } = {}): Promise<ParsedQuestion[]> {
  const size = opts.batchSize ?? 8;
  const chunks: number[][] = [];
  for (let i = 0; i < questions.length; i += size) chunks.push(questions.slice(i, i + size).map((_, k) => i + k));
  const out = [...questions];
  const failed = () => lt("模型整理失败，已使用规则拆分的结果，请核对", "Model restructuring failed; the rule-based split was used — please check");
  const run = async (idx: number[]) => {
    const payload = idx.map((i) => ({ i, text: questions[i].raw.slice(0, 6000) }));
    let items: ModelItem[];
    try {
      const res = await chatJson({
        system: SYSTEM,
        user: `Questions (JSON):\n${JSON.stringify(payload)}`,
        schema: modelOutputSchema,
        schemaName: "bank_import_restructure",
        temperature: 0,
        maxRetries: 1,
      });
      items = res.items;
    } catch {
      for (const i of idx) out[i] = { ...questions[i], issues: [...questions[i].issues, failed()] };
      return;
    }
    const byIndex = new Map(items.map((m) => [m.i, m]));
    for (const i of idx) {
      const m = byIndex.get(i);
      out[i] = m ? mergeModelItem(questions[i], m) : { ...questions[i], issues: [...questions[i].issues, failed()] };
    }
  };
  const limit = Math.max(1, opts.concurrency ?? 3);
  for (let k = 0; k < chunks.length; k += limit) await Promise.all(chunks.slice(k, k + limit).map(run));
  return out;
}
