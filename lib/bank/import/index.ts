/**
 * Importing questions into a bank through draft batches.
 *
 *   parseImport   file → questions (per format) → validation + duplicate
 *                 checks → draft batch (status "draft"); the original file
 *                 is kept as an asset of the bank
 *   recheckBatch  after the user edits drafts: validate + check again
 *   commitBatch   the user confirmed the rights → selected drafts become items
 *
 * Formats: json / jsonl, csv (tsv), xlsx, markdown / text, pdf (text layer;
 * scanned PDFs are read page by page by the vision model), image (one or
 * more photos / screenshots of pages, read by the vision model — ocr.ts).
 */
import { lt } from "@/lib/llm/output-locale";
import { addItems, BankError, ensureCategoryPath, getBank, getBatch, getCategory, listCategories, listItems, putBatch, saveAsset } from "../store";
import { applyClassification, classifyFailedIssue, classifyQuestions } from "../classify";
import { draftItemSchema, IMPORT_FORMATS, type DraftItem, type ImportBatch, type ImportFormat, type Item } from "../types";
import { checkDrafts, EMPTY_STEM, fieldsOf, isCheckIssue, reportOf, type WorkingDraft } from "./checks";
import { clampStr, recordToFields, type ParsedQuestion } from "./fields";
import { detectImage, IMAGE_EXT, IMAGE_FILE, preparePhoto, scannedPdfPages, type PageImage } from "./images";
import { maxOcrPages, ocrPages } from "./ocr";
import { parsePdf, refineWithModel } from "./pdf";
import { decodeText, previewTable, readRows, rowsToQuestions } from "./tabular";
import { splitText } from "./text";

export { EMPTY_STEM } from "./checks";

/** Most drafts one batch may hold. */
export const MAX_DRAFTS = 5000;

const EXT_FORMAT: Record<string, ImportFormat> = {
  json: "json",
  jsonl: "jsonl",
  ndjson: "jsonl",
  csv: "csv",
  tsv: "csv",
  xlsx: "xlsx",
  md: "markdown",
  markdown: "markdown",
  txt: "text",
  text: "text",
  pdf: "pdf",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  heic: "image",
  heif: "image",
};

const ASSET_EXT: Record<ImportFormat, string> = { json: "json", jsonl: "jsonl", csv: "csv", xlsx: "xlsx", markdown: "md", text: "txt", pdf: "pdf", image: "png" };

export function detectFormat(fileName: string, data: Buffer): ImportFormat {
  const ext = /\.([A-Za-z0-9]+)$/.exec(fileName.trim())?.[1]?.toLowerCase();
  if (ext && EXT_FORMAT[ext]) return EXT_FORMAT[ext];
  if (ext === "xls" || ext === "doc" || ext === "docx") {
    throw new BankError(lt(`暂不支持 .${ext} 文件，请另存为 .xlsx、.csv、.pdf 或文本`, `.${ext} files are not supported yet; save as .xlsx, .csv, .pdf or text`), 415);
  }
  if (data.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (detectImage(data)) return "image";
  if (data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) return "xlsx";
  const head = decodeText(data.subarray(0, 64 * 1024)).trimStart();
  if (head.startsWith("[")) return "json";
  if (head.startsWith("{")) {
    const lines = head.split(/\r?\n/).filter((l) => l.trim());
    return lines.length > 1 && lines.slice(0, 2).every((l) => l.trim().startsWith("{") && l.trim().endsWith("}")) ? "jsonl" : "json";
  }
  return /^#{1,6}\s/m.test(head) ? "markdown" : "text";
}

export async function previewColumns(data: Buffer, format: "csv" | "xlsx"): Promise<{ headers: string[]; suggested: Record<string, string>; sample: string[][] }> {
  return previewTable(data, format);
}

// ── JSON ─────────────────────────────────────────────────────────────

function jsonRecords(text: string): { records: unknown[]; bad: Array<{ line: number; text: string }> } {
  const body = text.replace(/^﻿/, "").trim();
  try {
    const v = JSON.parse(body) as unknown;
    if (Array.isArray(v)) return { records: v, bad: [] };
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      for (const k of ["items", "questions", "data", "records", "problems"]) if (Array.isArray(o[k])) return { records: o[k] as unknown[], bad: [] };
      return { records: [v], bad: [] };
    }
    return { records: [v], bad: [] };
  } catch {
    // JSON Lines.
    const records: unknown[] = [];
    const bad: Array<{ line: number; text: string }> = [];
    body.split(/\r?\n/).forEach((line, i) => {
      const t = line.trim();
      if (!t) return;
      try {
        records.push(JSON.parse(t.replace(/,$/, "")));
      } catch {
        bad.push({ line: i + 1, text: t });
        records.push(Symbol.for("bad"));
      }
    });
    return { records, bad };
  }
}

function parseJson(data: Buffer): ParsedQuestion[] {
  const parsed = jsonRecords(decodeText(data));
  const bad = parsed.bad;
  // Our own export starts with a bank header line ({kind: "bank", …}); it is not a question.
  const records = parsed.records.filter((r) => !(r && typeof r === "object" && !Array.isArray(r) && (r as { kind?: unknown }).kind === "bank"));
  let b = 0;
  return records.map((rec, i) => {
    if (typeof rec === "symbol") {
      const line = bad[b++];
      return {
        fields: recordToFields({}).fields,
        raw: clampStr(line.text, 40_000),
        issues: [lt(`第 ${line.line} 行不是有效的 JSON`, `Line ${line.line} is not valid JSON`)],
      };
    }
    if (typeof rec === "string") {
      const { fields, issues } = recordToFields({ stem: rec });
      return { fields, raw: rec, issues };
    }
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
      return { fields: recordToFields({}).fields, raw: clampStr(JSON.stringify(rec) ?? "", 40_000), issues: [lt(`第 ${i + 1} 条记录不是对象`, `Record ${i + 1} is not an object`)] };
    }
    const { fields, issues } = recordToFields(rec as Record<string, unknown>);
    if (!fields.stem) issues.unshift(lt(`第 ${i + 1} 条记录没有题目字段（stem / question / 题目）`, `Record ${i + 1} has no question field (stem / question / 题目)`));
    return { fields, raw: clampStr(JSON.stringify(rec, null, 2), 40_000), issues };
  });
}

// ── Public API ───────────────────────────────────────────────────────

export async function parseImport(args: {
  owner: string;
  bankId: string;
  fileName: string;
  data: Buffer;
  format?: ImportFormat;
  columnMap?: Record<string, string>;
  useModel?: boolean;
  /** Let the model decide catalogue place, grade, knowledge points and difficulty (default true). */
  classify?: boolean;
  /** More page images after the first file (photos of a multi-page paper), read as one batch in this order. */
  moreImages?: Array<{ fileName: string; data: Buffer }>;
  /** The teacher's note about the material: guides reading scans and is kept on every question (template_hint). */
  hint?: string;
}): Promise<ImportBatch> {
  const { owner, bankId, fileName, data } = args;
  const hint = args.hint?.trim() ? clampStr(args.hint.trim(), 1000) : undefined;
  const bank = getBank(owner, bankId);
  const format = args.format ?? detectFormat(fileName, data);
  if (!IMPORT_FORMATS.includes(format)) throw new BankError(lt("不支持的文件格式", "Unsupported file format"), 415);
  if (!data.length) throw new BankError(lt("文件是空的", "The file is empty"), 400);

  let questions: ParsedQuestion[];
  let columnMap: Record<string, string> | undefined;
  let notes: string[] = [];
  let ocrAssets: string[] = [];
  let ocr = false;
  switch (format) {
    case "json":
    case "jsonl":
      questions = parseJson(data);
      break;
    case "csv":
    case "xlsx": {
      const rows = await readRows(data, format);
      if (rows.length < 2) throw new BankError(lt("表格中没有数据行（第一行应是表头）", "The sheet has no data rows (the first row should be the headers)"), 422);
      columnMap = args.columnMap ?? (await previewTable(data, format)).suggested;
      questions = rowsToQuestions(rows, columnMap);
      break;
    }
    case "markdown":
    case "text":
      questions = splitText(decodeText(data));
      break;
    case "pdf": {
      const pdf = await parsePdf(data);
      if (pdf.scanned) {
        requireVision(bank.allow_model, "pdf");
        const pages = await scannedPdfPages(data, { maxPages: maxOcrPages() });
        if (!pages.length) throw new BankError(lt("这个 PDF 既没有文字也没有可识别的页面图像", "This PDF has neither text nor page images to read"), 422);
        ({ questions, notes, ocrAssets } = await readScans(owner, bankId, pages, notes, hint));
        ocr = true;
      } else questions = pdf.questions;
      if (args.useModel !== false && bank.allow_model && process.env.LLM_API_KEY && questions.length) questions = await refineWithModel(questions);
      break;
    }
    case "image": {
      requireVision(bank.allow_model, "image");
      const files = [{ fileName, data }, ...(args.moreImages ?? [])];
      if (files.length > maxOcrPages()) {
        throw new BankError(lt(`一次最多识别 ${maxOcrPages()} 张图片，请分批导入`, `At most ${maxOcrPages()} images per import; import them in parts`), 413);
      }
      const pages: PageImage[] = [];
      for (const [i, f] of files.entries()) {
        if (!detectImage(f.data) && !IMAGE_FILE.test(f.fileName)) throw new BankError(lt(`${f.fileName} 不是图片`, `${f.fileName} is not an image`), 415);
        pages.push(await preparePhoto(f.data, i + 1));
      }
      ({ questions, notes, ocrAssets } = await readScans(owner, bankId, pages, notes, hint));
      ocr = true;
      if (args.useModel !== false && questions.length) questions = await refineWithModel(questions);
      break;
    }
  }
  if (!questions.length) throw new BankError(lt("文件中没有找到题目", "No questions were found in the file"), 422);
  if (questions.length > MAX_DRAFTS) throw new BankError(lt(`一次最多导入 ${MAX_DRAFTS} 道题，请拆分文件`, `At most ${MAX_DRAFTS} questions per import; split the file`), 413);

  // The model decides the catalogue place, grade, knowledge points and difficulty (kept editable in review).
  if (args.classify !== false && bank.allow_model && process.env.LLM_API_KEY) {
    try {
      const result = await classifyQuestions(
        questions.map((q) => q.fields),
        { bank, categories: listCategories(owner, bankId) },
      );
      questions = questions.map((q, i) => (result[i] ? { ...q, fields: applyClassification(q.fields, result[i]) } : { ...q, issues: [...q.issues, classifyFailedIssue()] }));
    } catch {
      questions = questions.map((q) => ({ ...q, issues: [...q.issues, classifyFailedIssue()] }));
    }
  }

  const file = clampStr(fileName, 300);
  // The teacher's note goes with every question (a value already in the file wins).
  const working: WorkingDraft[] = questions.map((q) => ({
    fields: { ...q.fields, source: { ...q.fields.source, file }, ...(hint && !q.fields.template_hint ? { template_hint: hint } : {}) },
    raw: q.raw,
    issues: q.issues,
  }));
  const drafts = checkDrafts(working, listItems(owner, bankId));
  // The original file is kept; for images the page images saved by the OCR step are the originals (scaled).
  const originals = format === "image" ? [] : [saveAsset(owner, bankId, data, ASSET_EXT[format])];
  const more = args.moreImages?.length ?? 0;
  return putBatch(owner, bankId, {
    file_name: more ? clampStr(lt(`${file} 等 ${more + 1} 张图片`, `${file} and ${more} more image${more === 1 ? "" : "s"}`), 300) : file,
    format,
    status: "draft",
    rights_confirmed: false,
    column_map: columnMap,
    drafts,
    assets: [...originals, ...ocrAssets],
    ...(notes.length ? { notes } : {}),
    ...(ocr ? { ocr: true } : {}),
    ...(hint ? { hint } : {}),
    report: reportOf(drafts),
  });
}

/** Reading scans needs the model: the bank must allow sending content to it and a model must be configured. */
function requireVision(allowModel: boolean, kind: "pdf" | "image") {
  const what = kind === "pdf" ? lt("这个 PDF 没有可提取的文字（扫描件），", "This PDF has no extractable text (a scan); ") : "";
  if (!allowModel) {
    throw new BankError(
      lt(`${what}识别图片需要把页面图像发送给模型，而此题库设置为不允许发送给模型。`, `${what}reading images means sending the page images to the model, and this bank does not allow sending content to the model.`),
      422,
    );
  }
  if (!process.env.LLM_API_KEY) throw new BankError(lt(`${what}识别图片需要配置模型（LLM_API_KEY）。`, `${what}reading images needs a configured model (LLM_API_KEY).`), 422);
}

async function readScans(owner: string, bankId: string, pages: PageImage[], notes: string[], hint?: string): Promise<{ questions: ParsedQuestion[]; notes: string[]; ocrAssets: string[] }> {
  const res = await ocrPages(owner, bankId, pages, { hint });
  return { questions: res.questions, notes: [...notes, ...res.notes], ocrAssets: res.assets };
}

const contentKey = (d: Partial<DraftItem>) => JSON.stringify([d.stem, d.type, d.options ?? [], d.answer ?? "", d.solution ?? ""]);

/** Drafts ready for checking: parse issues are kept only for drafts whose content the user has not changed. */
function toWorking(drafts: DraftItem[], stored: DraftItem[]): WorkingDraft[] {
  const byId = new Map(stored.map((d) => [d.draft_id, d]));
  return drafts.map((d) => {
    const prev = byId.get(d.draft_id);
    const unchanged = prev && contentKey(prev) === contentKey(d);
    return {
      draft_id: d.draft_id,
      fields: fieldsOf(d),
      raw: d.raw ?? prev?.raw ?? "",
      issues: unchanged ? prev.issues.filter((x) => !isCheckIssue(x)) : [],
      include: d.include,
      prevStatus: prev?.status,
    };
  });
}

function draftBatch(owner: string, bankId: string, batchId: string): ImportBatch {
  const batch = getBatch(owner, bankId, batchId);
  if (batch.status !== "draft") throw new BankError(lt("这批导入已经提交或放弃，不能再修改", "This import batch was already committed or discarded"), 409);
  return batch;
}

export function recheckBatch(owner: string, bankId: string, batchId: string, drafts?: DraftItem[]): ImportBatch {
  const batch = draftBatch(owner, bankId, batchId);
  let next: DraftItem[] = batch.drafts;
  if (drafts) {
    if (drafts.length > MAX_DRAFTS) throw new BankError(lt(`一次最多导入 ${MAX_DRAFTS} 道题`, `At most ${MAX_DRAFTS} questions per import`), 413);
    next = drafts.map((d, i) => {
      // Lenient: an edited draft with an emptied stem is kept (as an error) instead of rejecting the whole request.
      const parsed = draftItemSchema.safeParse({ ...d, stem: d.stem?.trim() ? d.stem : EMPTY_STEM });
      if (!parsed.success) throw new BankError(lt(`第 ${i + 1} 条草稿无效：${parsed.error.issues[0]?.path.join(".")}`, `Draft ${i + 1} is invalid: ${parsed.error.issues[0]?.path.join(".")}`), 400);
      return parsed.data;
    });
  }
  const checked = checkDrafts(toWorking(next, batch.drafts), listItems(owner, bankId));
  return putBatch(owner, bankId, { ...batch, drafts: checked, report: reportOf(checked) });
}

export function commitBatch(owner: string, bankId: string, batchId: string, opts: { rightsConfirmed: boolean; categoryId?: string }): { batch: ImportBatch; items: Item[] } {
  const batch = draftBatch(owner, bankId, batchId);
  if (!opts.rightsConfirmed) {
    throw new BankError(lt("请先确认你有权使用这些题目（版权或授权）", "Please confirm you have the right to use these questions (copyright or licence) first"), 400);
  }
  if (opts.categoryId) getCategory(owner, bankId, opts.categoryId);
  // Check again: the bank may have changed since the batch was parsed.
  const drafts = checkDrafts(toWorking(batch.drafts, batch.drafts), listItems(owner, bankId));
  const chosen = drafts.filter((d) => d.include && d.status !== "error" && d.status !== "duplicate");
  const items = chosen.length
    ? addItems(
        owner,
        bankId,
        chosen.map((d) => {
          const { category_path, ...fields } = fieldsOf(d);
          // The model's (or the reviewer's) catalogue place: create the categories if missing.
          const leaf = category_path?.length ? ensureCategoryPath(owner, bankId, category_path) : undefined;
          const category_ids = [...new Set([opts.categoryId, leaf].filter((x): x is string => !!x))];
          return { fields, origin: "imported" as const, category_ids };
        }),
      )
    : [];
  const saved = putBatch(owner, bankId, {
    ...batch,
    drafts,
    status: "committed",
    rights_confirmed: true,
    report: { ...reportOf(drafts), committed: items.length },
  });
  return { batch: saved, items };
}
