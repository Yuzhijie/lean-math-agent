import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commitBatch, detectFormat, parseImport, previewColumns, recheckBatch } from "@/lib/bank/import";
import { parseAnswerKey, detectOptions, splitText } from "@/lib/bank/import/text";
import { parseDelimited } from "@/lib/bank/import/tabular";
import { cleanPages } from "@/lib/bank/import/pdf";
import { _closeAllBanks, addItems, createBank, getBatch, listItems, putCategory, readAsset } from "@/lib/bank/store";
import { resetGlobalCache } from "@/lib/llm/cache";
import { withOutputLocale } from "@/lib/llm/output-locale";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bank-import-"));
  process.env.BANK_STORE_PATH = root;
});
afterEach(() => {
  _closeAllBanks();
  delete process.env.BANK_STORE_PATH;
  fs.rmSync(root, { recursive: true, force: true });
});

const OWNER = "user-1";
const newBank = () => createBank(OWNER, { name: "Imports", language: "mixed" }).id;
const buf = (s: string) => Buffer.from(s, "utf8");

// ── Test file builders ───────────────────────────────────────────────

/** Minimal valid PDF: Helvetica, one text line per `Td`, correct xref offsets. */
function buildPdf(pages: string[][]): Buffer {
  const objs: string[] = [];
  const n = pages.length;
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${n} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  pages.forEach((lines, i) => {
    const stream = lines.map((l, k) => `BT /F1 11 Tf 60 ${760 - k * 20} Td (${esc(l)}) Tj ET`).join("\n");
    objs[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objs[5 + i * 2] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objs.length; id++) {
    offsets[id] = Buffer.byteLength(out, "latin1");
    out += `${id} 0 obj\n${objs[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objs.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** Minimal .xlsx: a zip (stored entries) with one sheet of shared strings. */
function buildXlsx(rows: string[][]): Buffer {
  const strings: string[] = [];
  const si = (s: string) => {
    let i = strings.indexOf(s);
    if (i < 0) i = strings.push(s) - 1;
    return i;
  };
  const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const col = (i: number) => String.fromCharCode(65 + i);
  const sheetRows = rows
    .map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => `<c r="${col(ci)}${ri + 1}" t="s"><v>${si(v)}</v></c>`).join("")}</row>`)
    .join("");
  const files: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
  };
  files["xl/sharedStrings.xml"] = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t xml:space="preserve">${xml(s)}</t></si>`).join("")}</sst>`;

  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8");
    const nameBuf = Buffer.from(name, "utf8");
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ── Format detection ─────────────────────────────────────────────────

describe("detectFormat", () => {
  it("uses the extension, then sniffs the content", () => {
    expect(detectFormat("a.CSV", buf("x"))).toBe("csv");
    expect(detectFormat("a.tsv", buf("x"))).toBe("csv");
    expect(detectFormat("a.md", buf("x"))).toBe("markdown");
    expect(detectFormat("upload", buf("%PDF-1.4\n…"))).toBe("pdf");
    expect(detectFormat("upload", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]))).toBe("xlsx");
    expect(detectFormat("upload", buf('  [{"stem":"x"}]'))).toBe("json");
    expect(detectFormat("upload", buf('{"stem":"x"}\n{"stem":"y"}\n'))).toBe("jsonl");
    expect(detectFormat("upload", buf("1. What is 2+2?"))).toBe("text");
    expect(() => detectFormat("old.xls", buf("x"))).toThrow();
  });
});

// ── CSV / Excel ──────────────────────────────────────────────────────

describe("CSV", () => {
  it("parses quoted fields with commas, quotes and newlines, BOM and tabs", () => {
    expect(parseDelimited('﻿a,b\r\n"x, y","say ""hi""\nthere"\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"\nthere'],
    ]);
    expect(parseDelimited("a\tb\n1\t2, 3\n")).toEqual([
      ["a", "b"],
      ["1", "2, 3"],
    ]);
  });

  const csv = [
    "题号,题目内容,选项A,选项B,选项C,选项D,答案,解析,年级,难度,知识点,标签,备注",
    '1,"计算：12 + 30 = ?",32,42,52,62,B,"12+30=42",三年级,易,"整数与四则运算；加法",口算,x',
    '2,"一个长方形长 8 厘米，宽 5 厘米，\n它的面积是多少平方厘米？",,,,,40,,四年级,3,面积,,',
    '3,"下列哪个数最大？",0.5,0.35,0.505,,E,,五年级,9,小数,,',
  ].join("\n");

  it("suggests a mapping from Chinese headers", async () => {
    const p = await previewColumns(buf(csv), "csv");
    expect(p.headers[0]).toBe("题号");
    expect(p.suggested).toMatchObject({
      题号: "label",
      题目内容: "stem",
      选项A: "options",
      选项D: "options",
      答案: "answer",
      解析: "solution",
      年级: "grade",
      难度: "difficulty",
      知识点: "knowledge_points",
      标签: "tags",
    });
    expect(p.suggested["备注"]).toBeUndefined();
    expect(p.sample).toHaveLength(3);
    expect(p.sample[1][1]).toContain("\n");
    const en = await previewColumns(buf("Question,Option A,Option B,Correct Answer,Explanation,Year,Topic\n"), "csv");
    expect(en.suggested).toEqual({ Question: "stem", "Option A": "options", "Option B": "options", "Correct Answer": "answer", Explanation: "solution", Year: "grade", Topic: "knowledge_points" });
  });

  it("imports rows into a draft batch", async () => {
    const bankId = newBank();
    const batch = await parseImport({ owner: OWNER, bankId, fileName: "题库.csv", data: buf(csv) });
    expect(batch.status).toBe("draft");
    expect(batch.format).toBe("csv");
    expect(batch.drafts).toHaveLength(3);
    const [a, b, c] = batch.drafts;
    expect(a).toMatchObject({ stem: "计算：12 + 30 = ?", type: "multiple_choice", options: ["32", "42", "52", "62"], answer: "B", solution: "12+30=42", grade: "三年级", difficulty: 2, knowledge_points: ["整数与四则运算", "加法"], tags: ["口算"], status: "ok", language: "zh" });
    expect(a.source).toEqual({ label: "1", file: "题库.csv" });
    expect(b).toMatchObject({ type: "numeric", answer: "40", difficulty: 3, status: "ok" });
    expect(b.stem).toContain("\n它的面积");
    // Answer E with three options; difficulty 9 is not 1–5.
    expect(c.status).toBe("needs_review");
    expect(c.options).toEqual(["0.5", "0.35", "0.505"]);
    expect(c.difficulty).toBeUndefined();
    expect(c.issues.join(" ")).toMatch(/答案 E 不在选项中/);
    expect(c.issues.join(" ")).toMatch(/难度/);
    expect(batch.report).toEqual({ total: 3, ok: 2, needs_review: 1, duplicate: 0, error: 0 });
    expect(batch.column_map?.["题目内容"]).toBe("stem");
    // The original file is kept as an asset.
    expect(readAsset(OWNER, bankId, batch.assets[0]).toString()).toBe(csv);
  });

  it("uses a given column map and single-column options; messages follow the locale", async () => {
    const bankId = newBank();
    const data = buf("Q,Choices,Key\nWhich is even?,3|5|8|9,C\nPick one,only,A\n");
    const batch = await withOutputLocale("en-US", () => parseImport({ owner: OWNER, bankId, fileName: "x.csv", data, columnMap: { Q: "stem", Choices: "options", Key: "answer" } }));
    expect(batch.drafts[0]).toMatchObject({ stem: "Which is even?", options: ["3", "5", "8", "9"], answer: "C", type: "multiple_choice", status: "ok" });
    expect(batch.drafts[1].status).toBe("needs_review");
    expect(batch.drafts[1].issues).toContain("Multiple choice with fewer than 2 options");
  });

  it("reads a real .xlsx sheet", async () => {
    const data = buildXlsx([
      ["Question", "Option A", "Option B", "Option C", "Answer", "Difficulty"],
      ["What is 7 × 8?", "54", "56", "58", "B", "easy"],
      ["Round 3.46 to one decimal place.", "", "", "", "3.5", ""],
    ]);
    expect(detectFormat("book.xlsx", data)).toBe("xlsx");
    const p = await previewColumns(data, "xlsx");
    expect(p.headers).toEqual(["Question", "Option A", "Option B", "Option C", "Answer", "Difficulty"]);
    const batch = await parseImport({ owner: OWNER, bankId: newBank(), fileName: "book.xlsx", data });
    expect(batch.drafts.map((d) => [d.type, d.options, d.answer, d.difficulty])).toEqual([
      ["multiple_choice", ["54", "56", "58"], "B", 2],
      ["numeric", undefined, "3.5", undefined],
    ]);
  });
});

// ── JSON ─────────────────────────────────────────────────────────────

describe("JSON", () => {
  it("maps fields leniently and turns bad records into error drafts", async () => {
    const data = buf(
      JSON.stringify({
        items: [
          { question: "Solve 2x + 3 = 11.", answer: 4, difficulty: "medium", topics: "Equations, Algebra" },
          { 题目: "下列说法正确的是（ ）", 选项: { A: "对顶角相等", B: "同位角相等" }, 答案: "(a)", 题型: "单选题" },
          { answer: "5" },
          42,
          { stem: "Explain why.", difficulty: 9, type: "essay" },
        ],
      }),
    );
    const batch = await parseImport({ owner: OWNER, bankId: newBank(), fileName: "q.json", data });
    const d = batch.drafts;
    expect(d[0]).toMatchObject({ stem: "Solve 2x + 3 = 11.", answer: "4", type: "numeric", difficulty: 3, knowledge_points: ["Equations", "Algebra"], status: "ok", language: "en" });
    expect(d[1]).toMatchObject({ type: "multiple_choice", options: ["对顶角相等", "同位角相等"], answer: "A", status: "ok" });
    expect(d[2].status).toBe("error");
    expect(d[2].issues.join(" ")).toMatch(/没有题目字段/);
    expect(d[2].raw).toContain('"answer": "5"');
    expect(d[3].status).toBe("error");
    expect(d[4].status).toBe("needs_review");
    expect(d[4].issues.join(" ")).toMatch(/essay/);
    expect(batch.report).toMatchObject({ total: 5, ok: 2, needs_review: 1, error: 2 });
  });

  it("reads JSON Lines and our own export shape", async () => {
    const bankId = newBank();
    const exported = {
      id: "abc",
      bank_id: "other",
      stem: "What is 3 + 4?",
      type: "numeric",
      answer: "7",
      knowledge_points: ["Addition and subtraction"],
      tags: [],
      images: [],
      category_ids: ["c1"],
      origin: "manual",
      fingerprint: "f",
      created_at: 1,
      updated_at: 1,
      source: { page: 2, label: "5" },
    };
    const data = buf(`${JSON.stringify(exported)}\nnot json\n${JSON.stringify({ problem: "Find the area of a 3 by 4 rectangle." })}\n`);
    const batch = await parseImport({ owner: OWNER, bankId, fileName: "export.jsonl", data });
    expect(batch.format).toBe("jsonl");
    expect(batch.drafts[0]).toMatchObject({ stem: "What is 3 + 4?", answer: "7", type: "numeric", source: { page: 2, label: "5", file: "export.jsonl" }, status: "ok" });
    expect(batch.drafts[1]).toMatchObject({ status: "error" });
    expect(batch.drafts[1].issues[0]).toMatch(/第 2 行/);
    expect(batch.drafts[2].stem).toBe("Find the area of a 3 by 4 rectangle.");
  });
});

// ── Markdown / text ──────────────────────────────────────────────────

describe("Markdown and text", () => {
  it("detects options in lines and inline", () => {
    expect(detectOptions("Which is prime?\nA. 4\nB. 6\nC. 7\nD. 9")).toEqual({ stem: "Which is prime?", options: ["4", "6", "7", "9"] });
    expect(detectOptions("最小的是（ ）\nA．0.3  B．0.03  C．3  D．30")).toEqual({ stem: "最小的是（ ）", options: ["0.3", "0.03", "3", "30"] });
    expect(detectOptions("Pick (A) one (B) two")).toEqual({ stem: "Pick", options: ["one", "two"] });
    expect(detectOptions("A train leaves at 3 pm.\nHow long is the trip?")).toBeUndefined();
    expect(detectOptions("Choose:\nA 12\nB 15\nC 18")).toEqual({ stem: "Choose:", options: ["12", "15", "18"] });
  });

  it("parses answer keys in several layouts", () => {
    const key = parseAnswerKey(["1. B", "2 C", "3) 12", "4-D", "5 A 6 B 7 C", "8-10 BDA", "| 11 | 12 |", "| E | A |", "13. C 解析：因为…"]);
    expect(Object.fromEntries([...key].map(([n, e]) => [n, e.answer]))).toEqual({ 1: "B", 2: "C", 3: "12", 4: "D", 5: "A", 6: "B", 7: "C", 8: "B", 9: "D", 10: "A", 11: "E", 12: "A", 13: "C" });
    expect(key.get(13)?.solution).toBe("因为…");
  });

  const md = `# Year 5 Practice

Answer all questions.

## Part A

1. Which number is a multiple of 7?
A. 12
B. 21
C. 25
D. 30

**2.** A shop sells pens at $3 each. How much do 4 pens cost?
Answer: $12
Solution: 4 × 3 = 12.

3. 计算 (1) 3+4；(2) 5×6
(1) 第一问
(2) 第二问

Q4 is not a start in this file
4、Which fraction is largest? (A) 1/2 (B) 2/3 (C) 3/5

## Answers

1. B
4. B
`;

  it("splits numbered questions and attaches answers", async () => {
    const batch = await parseImport({ owner: OWNER, bankId: newBank(), fileName: "paper.md", data: buf(md) });
    const d = batch.drafts;
    expect(d.map((x) => x.source?.label)).toEqual(["1", "2", "3", "4"]);
    expect(d[0]).toMatchObject({ stem: "Which number is a multiple of 7?", options: ["12", "21", "25", "30"], type: "multiple_choice", answer: "B", status: "ok" });
    expect(d[1]).toMatchObject({ answer: "$12", solution: "4 × 3 = 12.", type: "numeric" });
    expect(d[1].stem).toBe("A shop sells pens at $3 each. How much do 4 pens cost?");
    // "(1)" sub-parts stay in question 3.
    expect(d[2].stem).toContain("(1) 第一问\n(2) 第二问");
    expect(d[3]).toMatchObject({ stem: "Which fraction is largest?", options: ["1/2", "2/3", "3/5"], answer: "B" });
    expect(d[0].raw).toMatch(/^1\. Which number/);
    // "Q4 …" is not the numbering style of this file: it stays in question 3.
    expect(d[2].raw).toContain("Q4 is not a start");
  });

  it("handles Chinese numbering, inline markers and 例", () => {
    const qs = splitText(`一、选择题
1、下列各数中，最小的数是（ ）
A．-2  B．0  C．1  D．3
【答案】A
【解析】负数小于零。
2、方程 2x=6 的解是 x=____。 答案：3
二、解答题
例1 已知 a+b=5，求 2a+2b。
第3题 计算 1+2+…+10。
`);
    expect(qs.map((q) => q.fields.source?.label)).toEqual(["1", "2", "例1", "3"]);
    expect(qs[0].fields).toMatchObject({ stem: "下列各数中，最小的数是（ ）", options: ["-2", "0", "1", "3"], answer: "A", solution: "负数小于零。" });
    expect(qs[1].fields).toMatchObject({ stem: "方程 2x=6 的解是 x=____。", answer: "3", type: "numeric" });
    expect(qs[3].fields.stem).toBe("计算 1+2+…+10。");
  });
});

describe("text edge cases", () => {
  it("keeps body lines that look like headings or a bare Answer line", () => {
    const qs = splitText("1. Part A of the shape is shaded.\nWhat fraction is shaded?\nAnswer\n2. What is 5 + 5?\n3. What is 2 + 2?\n");
    expect(qs).toHaveLength(3);
    expect(qs[0].fields.stem).toContain("Part A of the shape");
    expect(qs[1].fields.stem).toBe("What is 5 + 5?");
  });

  it("falls back to blank-line blocks without numbering", () => {
    const qs = splitText("What is 2 + 2?\n\nWhat is 3 + 3?\n");
    expect(qs.map((q) => q.fields.stem)).toEqual(["What is 2 + 2?", "What is 3 + 3?"]);
    expect(qs[0].issues[0]).toMatch(/没有找到题号/);
  });

  it("keeps an emptied stem as an error draft on recheck", async () => {
    const bankId = newBank();
    const batch = await parseImport({ owner: OWNER, bankId, fileName: "q.txt", data: buf("1. What is 2 + 2?\n") });
    const re = recheckBatch(OWNER, bankId, batch.id, [{ ...batch.drafts[0], stem: " " }]);
    expect(re.drafts[0].status).toBe("error");
    expect(re.report?.error).toBe(1);
  });
});

// ── PDF ──────────────────────────────────────────────────────────────

const PDF_PAGES = [
  [
    "Example Maths Competition - Year 5",
    "1. Which number is a multiple of 7?",
    "A. 12",
    "B. 21",
    "C. 25",
    "D. 30",
    "2. A shop sells pens at $3 each. How much do",
    "4 pens cost?",
    "A. $7    B. $12    C. $15    D. $34",
    "(c) Example Maths Pty Ltd",
    "Page 1",
  ],
  [
    "Example Maths Competition - Year 5",
    "3. The graph below shows the number of books read.",
    "How many books were read in total?",
    "A. 10",
    "B. 12",
    "C. 14",
    "D. 16",
    "(c) Example Maths Pty Ltd",
    "Page 2",
  ],
];

describe("PDF", () => {
  it("removes running headers and footers", () => {
    const pages = cleanPages(["Header\n1. a\nA. 12\nFooter\n3", "Header\n2. b\nA. 12\nFooter\n4", "Header\n3. c\nFooter\n5"]);
    expect(pages).toEqual([["1. a", "A. 12"], ["2. b", "A. 12"], ["3. c"]]);
  });

  it("splits questions with options and page numbers (no model)", async () => {
    const data = buildPdf(PDF_PAGES);
    expect(detectFormat("paper.pdf", data)).toBe("pdf");
    const batch = await parseImport({ owner: OWNER, bankId: newBank(), fileName: "paper.pdf", data, useModel: false });
    const d = batch.drafts;
    expect(d).toHaveLength(3);
    expect(d.map((x) => x.source?.page)).toEqual([1, 1, 2]);
    expect(d.map((x) => x.source?.label)).toEqual(["1", "2", "3"]);
    expect(d[0]).toMatchObject({ stem: "Which number is a multiple of 7?", options: ["12", "21", "25", "30"], type: "multiple_choice", status: "ok" });
    expect(d[1].stem).toBe("A shop sells pens at $3 each. How much do 4 pens cost?");
    expect(d[1].options).toEqual(["$7", "$12", "$15", "$34"]);
    expect(d[2].status).toBe("needs_review");
    expect(d[2].issues.join(" ")).toMatch(/图形/);
    for (const x of d) expect(x.raw).not.toMatch(/Example Maths|Page \d/);
    expect(d[1].options?.[3]).toBe("$34");
  });

  it("refuses scanned PDFs", async () => {
    const data = buildPdf([["1"], ["2"]]);
    await expect(parseImport({ owner: OWNER, bankId: newBank(), fileName: "scan.pdf", data, useModel: false })).rejects.toThrow(/扫描/);
  });

  describe("with the model", () => {
    const okResponse = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    beforeEach(() => {
      process.env.LLM_API_KEY = "k";
      process.env.LLM_BASE_URL = "https://llm.test/v1";
      process.env.LLM_MODEL = "m";
      process.env.LLM_LOG_LEVEL = "silent";
      process.env.LLM_CACHE_ENABLED = "false";
      process.env.LLM_RETRY_MAX = "0";
      resetGlobalCache();
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      for (const v of ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "LLM_LOG_LEVEL", "LLM_CACHE_ENABLED", "LLM_RETRY_MAX"]) delete process.env[v];
    });

    it("keeps verbatim stems and flags rewritten ones", async () => {
      const fetchMock = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
        expect(body.messages[0].content).toMatch(/VERBATIM/);
        return okResponse(
          JSON.stringify({
            items: [
              { i: 0, stem: "Which number is a multiple of 7?", type: "multiple_choice", options: ["12", "21", "25", "30"], answer: "B" },
              { i: 1, stem: "Pens cost $3 each at a shop. What is the price of 4 pens?", type: "multiple_choice", options: ["$7", "$12", "$15", "$34"] },
              { i: 2, stem: "The graph below shows the number of books read. How many books were read in total?", type: "multiple_choice", options: ["10", "12", "14", "16"] },
            ],
          }),
        );
      });
      vi.stubGlobal("fetch", fetchMock);
      const batch = await parseImport({ owner: OWNER, bankId: newBank(), fileName: "paper.pdf", data: buildPdf(PDF_PAGES) });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const d = batch.drafts;
      expect(d[0]).toMatchObject({ stem: "Which number is a multiple of 7?", status: "ok" });
      // The model solved it: no answer in the text, so the answer is not taken.
      expect(d[0].answer).toBeUndefined();
      // Rewritten stem: the original text is kept and the draft is flagged.
      expect(d[1].stem).toBe("A shop sells pens at $3 each. How much do 4 pens cost?");
      expect(d[1].status).toBe("needs_review");
      expect(d[1].issues.join(" ")).toMatch(/改写/);
      expect(d[2].stem).toBe("The graph below shows the number of books read. How many books were read in total?");
    });

    it("falls back to the heuristics when the model call fails", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 400 })));
      const batch = await parseImport({ owner: OWNER, bankId: newBank(), fileName: "paper.pdf", data: buildPdf(PDF_PAGES) });
      expect(batch.drafts).toHaveLength(3);
      expect(batch.drafts[0].options).toEqual(["12", "21", "25", "30"]);
      expect(batch.drafts.every((x) => x.status === "needs_review" && x.issues.some((i) => /模型整理失败/.test(i)))).toBe(true);
    });
  });
});

// ── Duplicates, recheck, commit ──────────────────────────────────────

describe("duplicates and commit", () => {
  const fields = (stem: string) => ({ fields: { stem, type: "numeric" as const, knowledge_points: [], tags: [], images: [] }, origin: "manual" as const });

  it("flags duplicates against the bank and within the batch", async () => {
    const bankId = newBank();
    const [existing, near] = addItems(OWNER, bankId, [fields("What is 3 + 4?"), fields("A rectangle is 12 cm long and 5 cm wide. What is its area?")]);
    const text = `1. What is 3+4 ?
2. A rectangle is 12 cm long and 6 cm wide. What is its area?
3. What is 10 - 7?
4. What is 10 - 7?
`;
    const batch = await parseImport({ owner: OWNER, bankId, fileName: "q.txt", data: buf(text) });
    const d = batch.drafts;
    expect(d[0]).toMatchObject({ status: "duplicate", duplicate_of: existing.id, include: false });
    expect(d[1]).toMatchObject({ status: "near_duplicate", duplicate_of: near.id, include: true });
    expect(d[1].issues[0]).toMatch(/相似/);
    expect(d[2].status).toBe("ok");
    expect(d[3]).toMatchObject({ status: "duplicate", duplicate_of: d[2].draft_id, include: false });
    expect(batch.report).toEqual({ total: 4, ok: 1, needs_review: 0, duplicate: 3, error: 0 });
  });

  it("rechecks edited drafts and commits the selected ones", async () => {
    const bankId = newBank();
    addItems(OWNER, bankId, [fields("What is 3 + 4?")]);
    const text = "1. What is 3 + 4?\n2. Which is odd?\nA. 2\nB. 3\nAnswer: C\n3. What is 6 × 7?\n4. What is 8 ÷ 2?\n";
    const batch = await parseImport({ owner: OWNER, bankId, fileName: "q.txt", data: buf(text) });
    expect(batch.drafts.map((x) => x.status)).toEqual(["duplicate", "needs_review", "ok", "ok"]);

    // The user fixes the answer and leaves out question 4.
    const edited = batch.drafts.map((x) => (x.draft_id === batch.drafts[1].draft_id ? { ...x, answer: "B" } : x.draft_id === batch.drafts[3].draft_id ? { ...x, include: false } : x));
    const re = recheckBatch(OWNER, bankId, batch.id, edited);
    expect(re.drafts.map((x) => x.status)).toEqual(["duplicate", "ok", "ok", "ok"]);
    expect(re.report).toMatchObject({ ok: 3, duplicate: 1 });

    expect(() => commitBatch(OWNER, bankId, batch.id, { rightsConfirmed: false })).toThrow(/确认/);
    const cat = putCategory(OWNER, bankId, { name: "Imported", kind: "manual", parent_id: null });
    const { batch: done, items } = commitBatch(OWNER, bankId, batch.id, { rightsConfirmed: true, categoryId: cat.id });
    expect(items.map((i) => i.stem)).toEqual(["Which is odd?", "What is 6 × 7?"]);
    expect(items[0]).toMatchObject({ origin: "imported", category_ids: [cat.id], answer: "B", options: ["2", "3"], source: { label: "2", file: "q.txt" } });
    expect(done).toMatchObject({ status: "committed", rights_confirmed: true });
    expect(done.report?.committed).toBe(2);
    expect(listItems(OWNER, bankId)).toHaveLength(3);
    expect(getBatch(OWNER, bankId, batch.id).status).toBe("committed");
    expect(() => commitBatch(OWNER, bankId, batch.id, { rightsConfirmed: true })).toThrow();
  });

  it("keeps parse issues until the draft is edited", async () => {
    const bankId = newBank();
    const batch = await parseImport({ owner: OWNER, bankId, fileName: "q.json", data: buf(JSON.stringify([{ stem: "Hard one", difficulty: "extreme" }])) });
    expect(batch.drafts[0].status).toBe("needs_review");
    expect(recheckBatch(OWNER, bankId, batch.id).drafts[0].status).toBe("needs_review");
    const re = recheckBatch(OWNER, bankId, batch.id, [{ ...batch.drafts[0], stem: "Hard one, edited" }]);
    expect(re.drafts[0]).toMatchObject({ status: "ok", issues: [] });
  });
});
