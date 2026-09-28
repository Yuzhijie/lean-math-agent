/**
 * CSV / TSV and Excel sheets → rows → question records.
 */
import { lt } from "@/lib/llm/output-locale";
import { BankError } from "../store";
import { FIELD_NAMES, optionLetterOf, recordToFields, suggestMapping, type ParsedQuestion } from "./fields";

/** Decode a text file: UTF-8 (with or without BOM), UTF-16 with BOM, else GB18030 (Chinese Excel exports). */
export function decodeText(data: Buffer): string {
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) return new TextDecoder("utf-16le").decode(data.subarray(2));
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) return new TextDecoder("utf-16be").decode(data.subarray(2));
  const body = data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? data.subarray(3) : data;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    try {
      return new TextDecoder("gb18030").decode(body);
    } catch {
      return new TextDecoder("utf-8").decode(body);
    }
  }
}

/** Delimiter of a CSV text: tab when the first line has more tabs than commas (and semicolons). */
export function detectDelimiter(text: string): "," | "\t" | ";" {
  let inQ = false;
  const counts = { ",": 0, "\t": 0, ";": 0 };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') inQ = !inQ;
    else if (!inQ && (c === "\n" || c === "\r")) break;
    else if (!inQ && (c === "," || c === "\t" || c === ";")) counts[c]++;
  }
  if (counts["\t"] > counts[","] && counts["\t"] >= counts[";"]) return "\t";
  if (counts[";"] > counts[","]) return ";";
  return ",";
}

/** RFC 4180: quoted fields ("" escapes a quote), delimiters and newlines inside quotes, CRLF or LF. */
export function parseDelimited(input: string, delimiter?: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const d = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQ = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQ = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field.trim() === "") {
      field = "";
      inQ = true;
      i++;
    } else if (c === d) {
      row.push(field);
      field = "";
      i++;
    } else if (c === "\r" || c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += c === "\r" && text[i + 1] === "\n" ? 2 : 1;
    } else {
      field += c;
      i++;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}

function cellText(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

/** Rows of the first sheet of an .xlsx file, as strings. */
export async function readXlsxRows(data: Buffer): Promise<string[][]> {
  let sheet: unknown[][];
  try {
    const { readSheet } = await import("read-excel-file/node");
    sheet = (await readSheet(data)) as unknown[][];
  } catch (e) {
    throw new BankError(lt(`无法读取 Excel 文件（仅支持 .xlsx）：${(e as Error).message}`.slice(0, 300), `Cannot read the Excel file (only .xlsx is supported): ${(e as Error).message}`.slice(0, 300)), 422);
  }
  return sheet.map((r) => r.map(cellText)).filter((r) => r.some((x) => x.trim() !== ""));
}

export async function readRows(data: Buffer, format: "csv" | "xlsx"): Promise<string[][]> {
  return format === "xlsx" ? readXlsxRows(data) : parseDelimited(decodeText(data));
}

/** Header names, with blank or repeated ones made unique ("Column 3", "Answer (2)"). */
export function headerNames(row: string[]): string[] {
  const seen = new Map<string, number>();
  return row.map((h, i) => {
    let name = h.trim() || `Column ${i + 1}`;
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    if (n) name = `${name} (${n + 1})`;
    return name;
  });
}

export async function previewTable(data: Buffer, format: "csv" | "xlsx") {
  const rows = await readRows(data, format);
  const headers = rows.length ? headerNames(rows[0]) : [];
  const sample = rows.slice(1, 6).map((r) => headers.map((_, i) => (r[i] ?? "").trim()));
  return { headers, suggested: suggestMapping(headers), sample };
}

/**
 * Spreadsheet rows → questions. `columnMap` maps header → field name
 * (FIELD_NAMES); several columns may map to "options" (one option per
 * cell, in column order), knowledge_points or tags (merged), or stem
 * (joined by line breaks).
 */
export function rowsToQuestions(rows: string[][], columnMap: Record<string, string>): ParsedQuestion[] {
  if (!rows.length) return [];
  const headers = headerNames(rows[0]);
  const known = new Set<string>(FIELD_NAMES);
  const cols = headers
    .map((h, i) => ({ h, i, field: columnMap[h] }))
    .filter((c): c is { h: string; i: number; field: string } => !!c.field && known.has(c.field));
  if (!cols.some((c) => c.field === "stem")) {
    throw new BankError(lt("请指定哪一列是题目（题干）", "Choose which column holds the question text"), 400);
  }
  const optionCols = cols.filter((c) => c.field === "options");
  const out: ParsedQuestion[] = [];
  for (const row of rows.slice(1)) {
    const cell = (i: number) => (row[i] ?? "").trim();
    if (!cols.some((c) => cell(c.i))) continue;
    const rec: Record<string, unknown> = {};
    const add = (f: string, v: string) => {
      if (!v) return;
      if (f === "stem") rec.stem = rec.stem ? `${rec.stem}\n${v}` : v;
      else if (f === "knowledge_points" || f === "tags") rec[f] = [...((rec[f] as string[]) ?? []), v];
      else if (rec[f] === undefined) rec[f] = v;
    };
    for (const c of cols) if (c.field !== "options") add(c.field, cell(c.i));
    if (optionCols.length === 1) rec.options = cell(optionCols[0].i) || undefined;
    else if (optionCols.length > 1) {
      // One option per column; order by the letter in the header when there is one.
      const allLettered = optionCols.every((c) => optionLetterOf(c.h));
      const sorted = allLettered ? [...optionCols].sort((a, b) => optionLetterOf(a.h)!.localeCompare(optionLetterOf(b.h)!)) : optionCols;
      const opts = sorted.map((c) => cell(c.i));
      while (opts.length && !opts[opts.length - 1]) opts.pop();
      if (opts.length) rec.options = opts;
    }
    const { fields, issues } = recordToFields(rec);
    const raw = headers
      .map((h, i) => (cell(i) ? `${h}: ${cell(i)}` : ""))
      .filter(Boolean)
      .join("\n");
    out.push({ fields, raw, issues });
  }
  return out;
}
