import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseImport } from "@/lib/bank/import";
import { applyAnswerKey, parseAnswerKey } from "@/lib/bank/import/answer-key";
import { parsePdf } from "@/lib/bank/import/pdf";
import type { RawImage } from "@/lib/bank/import/images";
import { _closeAllBanks, createBank } from "@/lib/bank/store";
import { resetGlobalCache } from "@/lib/llm/cache";

// A paper exported from an online test: a text cover, one screenshot per question (no text on those pages),
// and a results page with the answer key ("2019 Year2 Mathematics.pdf").

vi.mock("next-auth", () => ({ getServerSession: async () => null }));

let root: string;
const ENV = ["BANK_STORE_PATH", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "LLM_VISION_MODEL", "LLM_LOG_LEVEL", "LLM_CACHE_ENABLED", "LLM_RETRY_MAX", "LLM_MAX_HTTP_RETRIES"];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bank-pdfpic-"));
  process.env.BANK_STORE_PATH = root;
  process.env.LLM_API_KEY = "k";
  process.env.LLM_BASE_URL = "https://llm.test/v1";
  process.env.LLM_MODEL = "text-model";
  process.env.LLM_VISION_MODEL = "vision-model";
  process.env.LLM_LOG_LEVEL = "silent";
  process.env.LLM_CACHE_ENABLED = "false";
  process.env.LLM_RETRY_MAX = "0";
  process.env.LLM_MAX_HTTP_RETRIES = "0";
  resetGlobalCache();
});
afterEach(() => {
  _closeAllBanks();
  vi.unstubAllGlobals();
  for (const k of ENV) delete process.env[k];
  fs.rmSync(root, { recursive: true, force: true });
});

const img = (shade: number): RawImage => ({ data: new Uint8Array(300 * 200 * 3).fill(shade), width: 300, height: 200, channels: 3 });

/** PDF whose pages are text (lines) or a single image. */
function buildMixedPdf(pages: Array<string[] | RawImage>): Buffer {
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let len = 0;
  const push = (b: Buffer | string) => {
    const x = typeof b === "string" ? Buffer.from(b, "latin1") : b;
    parts.push(x);
    len += x.length;
  };
  const obj = (id: number, body: string | Buffer[]) => {
    offsets[id] = len;
    push(`${id} 0 obj\n`);
    if (typeof body === "string") push(body);
    else body.forEach(push);
    push("\nendobj\n");
  };
  push("%PDF-1.4\n");
  const n = pages.length;
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 3} 0 R`).join(" ")}] /Count ${n} >>`);
  obj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  pages.forEach((p, i) => {
    const pageId = 4 + i * 3, contentId = pageId + 1, imgId = pageId + 2;
    if (Array.isArray(p)) {
      const stream = p.map((l, k) => `BT /F1 10 Tf 40 ${770 - k * 14} Td (${esc(l)}) Tj ET`).join("\n");
      obj(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
      obj(contentId, `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
      obj(imgId, "<< >>");
    } else {
      const content = "q 612 0 0 792 0 0 cm /Im0 Do Q";
      obj(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 ${imgId} 0 R >> >> /Contents ${contentId} 0 R >>`);
      obj(contentId, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
      const z = zlib.deflateSync(Buffer.from(p.data));
      obj(imgId, [Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${z.length} >>\nstream\n`, "latin1"), z, Buffer.from("\nendstream", "latin1")]);
    }
  });
  const size = 4 + n * 3;
  const xref = len;
  push(`xref\n0 ${size}\n0000000000 65535 f \n`);
  for (let id = 1; id < size; id++) push(`${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

const COVER = ["PAPER", "2019", "MATHEMATICS", "INTRODUCTORY PAPER"];
// The results page as pdf.js extracts it: numbers, then answers, then categories, then descriptors.
const RESULTS = ["Results", "1", "2", "3", "4", "5", "C", "C", "B", "A", "75", "Category", "Question", "number Correct", "answer Mark Descriptor", "Number & Arithmetic", "Number & Arithmetic", "Measures & Units", "Chance & Data", "Measures & Units", "Add two numbers less than ten", "Understand 'ahead' and follow a number sequence", "Identify consecutive months", "Interpret a simple picture graph", "Use doubling and addition to solve a length problem"];
const SCREENS: Record<number, string> = {
  2: "1. Ravi blew 2 bubbles.\nThen he blew 4 more bubbles.\nHow many bubbles has Ravi blown?\nA. 2\nB. 4\nC. 6\nD. 8",
  3: "2. Mia is 3 places ahead of Tom in the line. Tom is 5th. Where is Mia?\nA. 1st\nB. 4th\nC. 2nd\nD. 8th",
  4: "3. Which month comes straight after April?\nA. March\nB. May\nC. June\nD. July",
  5: "4. The picture graph shows pets. Which pet do most children have?\nA. dog\nB. cat\nC. fish\nD. bird",
  6: "5. A ribbon is 25 cm long. Sam doubles it and adds 25 cm. How long is it now? Write the number of centimetres.",
};

function fakeVision() {
  const pagesRead: number[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string | Array<{ type: string; text?: string }> }> };
      const sys = String(body.messages[0].content);
      const last = body.messages[body.messages.length - 1].content;
      const user = typeof last === "string" ? last : last.filter((p) => p.type === "text").map((p) => p.text).join("");
      const reply = (c: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(c) } }] }), { status: 200 });
      if (sys.startsWith("You read pages")) {
        const n = Number(/Page (\d+)/.exec(user)?.[1]);
        pagesRead.push(n);
        return reply({ text: SCREENS[n] ?? "", figures: [] });
      }
      return reply({});
    }),
  );
  return pagesRead;
}

describe("answer keys", () => {
  it("columns (pdf.js), rows (layout text) and inline lists", () => {
    const cols = parseAnswerKey(RESULTS.join("\n"))!;
    expect([...cols.entries()]).toEqual([
      ["1", { answer: "C", category: "Number & Arithmetic" }],
      ["2", { answer: "C", category: "Number & Arithmetic" }],
      ["3", { answer: "B", category: "Measures & Units" }],
      ["4", { answer: "A", category: "Chance & Data" }],
      ["5", { answer: "75", category: "Measures & Units" }],
    ]);
    // At full size (30 questions) the header words are not taken for categories.
    const cats = ["Number & Arithmetic", "Measures & Units", "Chance & Data", "Algebra & Patterns", "Space & Geometry"];
    const thirty = parseAnswerKey(["Results", ...Array.from({ length: 30 }, (_, i) => String(i + 1)), ...Array.from({ length: 30 }, (_, i) => (i === 29 ? "75" : "ABCDE"[i % 5])), "Category", "Question", "number Correct", "answer Mark Descriptor", ...Array.from({ length: 30 }, (_, i) => cats[(i * 3) % 5])].join("\n"))!;
    expect(thirty.get("1")?.category).toBe(cats[0]);
    expect(thirty.get("30")).toEqual({ answer: "75", category: cats[(29 * 3) % 5] });
    const rows = parseAnswerKey("Question   Correct\n   1         C              Number & Arithmetic   Add two numbers\n   2         C              Number & Arithmetic   Ahead\n   3         B              Measures & Units      Months\n   4         A              Chance & Data   Graph\n   5         B              Algebra & Patterns   Place value\n  28         5              Algebra & Patterns   Pattern")!;
    expect(rows.get("3")).toEqual({ answer: "B", category: "Measures & Units" });
    expect(rows.get("28")?.answer).toBe("5");
    expect(parseAnswerKey("参考答案：1.C 2.B 3.A 4.D 5.C 6.B")?.get("4")?.answer).toBe("D");
    // Not keys: questions, a cover, a score page.
    expect(parseAnswerKey("1. What is 2 + 3?\nA. 4\nB. 5\n2. What is 6 - 1?")).toBeNull();
    expect(parseAnswerKey(COVER.join("\n"))).toBeNull();
    expect(parseAnswerKey("Results\nYour mark is 0 / 30 0%\nClick here to reset the test")).toBeNull();
  });

  it("fills empty answers by question number, maps values to option letters, reports disagreements", () => {
    const q = (label: string, options?: string[], answer?: string) => ({ fields: { stem: "s", type: "multiple_choice" as const, options, answer, knowledge_points: [], tags: [], images: [], source: { label } }, raw: "", issues: [] });
    const key = parseAnswerKey("参考答案：1.C 2.B 3.A 4.D 5.C")!;
    key.set("6", { answer: "8" });
    const r = applyAnswerKey([q("1", ["a", "b", "c", "d"]), q("2", ["a", "b", "c", "d"], "B"), q("3", ["a", "b", "c", "d"], "D"), q("6", ["6", "7", "8"])], key);
    expect(r.filled).toBe(2);
    expect(r.questions.map((x) => x.fields.answer)).toEqual(["C", "B", "D", "C"]);
    expect(r.questions[2].issues.join()).toMatch(/A/);
  });
});

describe("a PDF of question screenshots with a text cover and an answer key", () => {
  const PDF = () => buildMixedPdf([COVER, img(240), img(230), img(220), img(210), img(200), RESULTS]);

  it("parsePdf: picture pages to read, the key kept out of the questions", async () => {
    const p = await parsePdf(PDF());
    expect(p.scanned).toBe(false);
    expect(p.picturePages).toEqual([2, 3, 4, 5, 6]);
    expect(p.answerKeyPages).toEqual([7]);
    expect(p.questions).toEqual([]); // the cover is not a question
    expect(p.answerKey?.get("5")?.answer).toBe("75");
  });

  it("imports 5 questions read from the pictures, with the answers from the key", async () => {
    const pagesRead = fakeVision();
    const bank = createBank("local", { name: "ICAS", language: "en", allow_model: true }).id;
    const batch = await parseImport({ owner: "local", bankId: bank, fileName: "2019 Year2 Mathematics.pdf", data: PDF(), useModel: false, classify: false });
    expect(pagesRead.sort()).toEqual([2, 3, 4, 5, 6]);
    expect(batch.drafts).toHaveLength(5);
    expect(batch.drafts.map((d) => d.answer)).toEqual(["C", "C", "B", "A", "75"]);
    expect(batch.drafts[0].stem).toMatch(/^Ravi blew 2 bubbles/);
    expect(batch.drafts[0].options).toEqual(["2", "4", "6", "8"]);
    expect(batch.drafts[0].tags).toContain("Number & Arithmetic");
    expect(batch.drafts[0].source?.page).toBe(2);
    expect((batch.notes ?? []).join(" ")).toMatch(/5 pages are pictures|5 页是图片/);
    expect((batch.notes ?? []).join(" ")).toMatch(/Filled in 5 answers|填入了 5 道题/);
  });
});
