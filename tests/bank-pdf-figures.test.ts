import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseImport } from "@/lib/bank/import";
import { assignFigures, dropRepeated, figureRegions, pdfLayouts, questionStarts, type FigureRegion, type PageLayout } from "@/lib/bank/import/pdf-figures";
import { parsePdf } from "@/lib/bank/import/pdf";
import { _closeAllBanks, createBank } from "@/lib/bank/store";

// A paper with a text layer whose figures are drawn on the page (an embedded picture, a vector drawing):
// the questions come from the text, and the figures must come with them.

vi.mock("next-auth", () => ({ getServerSession: async () => null }));

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bank-pdffig-"));
  process.env.BANK_STORE_PATH = root;
  process.env.BANK_IMAGES_NO_CANVAS = "1";
  delete process.env.LLM_API_KEY;
});
afterEach(() => {
  _closeAllBanks();
  delete process.env.BANK_STORE_PATH;
  delete process.env.BANK_IMAGES_NO_CANVAS;
  fs.rmSync(root, { recursive: true, force: true });
});

/** One page: text lines at given heights, a picture under question 1, a drawn rectangle under question 2. */
function buildPdf(): Buffer {
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
  const text = (y: number, s: string) => `BT /F1 10 Tf 40 ${y} Td (${s}) Tj ET`;
  const stream = [
    text(760, "1. How many straws are shown here?"),
    "q 150 0 0 100 200 640 cm /Im0 Do Q",
    text(620, "\\(A\\) 5 \\(B\\) 6 \\(C\\) 7 \\(D\\) 8"),
    text(580, "2. What is the area of the rectangle shown below?"),
    "0.5 w 220 470 120 80 re S",
    text(450, "\\(A\\) 10 \\(B\\) 12 \\(C\\) 14 \\(D\\) 16"),
    text(410, "3. What is 7 + 8?"),
    text(390, "\\(A\\) 13 \\(B\\) 14 \\(C\\) 15 \\(D\\) 16"),
  ].join("\n");
  const w = 60, h = 40;
  const px = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set([x * 4, y * 6, 128], (y * w + x) * 3);
  const z = zlib.deflateSync(Buffer.from(px));
  push("%PDF-1.4\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [4 0 R] /Count 1 >>");
  obj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  obj(4, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /Im0 6 0 R >> >> /Contents 5 0 R >>");
  obj(5, `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
  obj(6, [Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${z.length} >>\nstream\n`, "latin1"), z, Buffer.from("\nendstream", "latin1")]);
  const xref = len;
  push(`xref\n0 7\n0000000000 65535 f \n${[1, 2, 3, 4, 5, 6].map((i) => `${String(offsets[i]).padStart(10, "0")} 00000 n \n`).join("")}`);
  push(`trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

const layout = (over: Partial<PageLayout>): PageLayout => ({ page: 1, width: 600, height: 800, lines: [], items: [], drawings: [], ...over });

describe("figures of a page", () => {
  it("groups drawings that stand together and keeps apart those that do not", () => {
    const regions = figureRegions(layout({ drawings: [{ x0: 100, y0: 100, x1: 160, y1: 160 }, { x0: 170, y0: 110, x1: 230, y1: 150 }, { x0: 100, y0: 400, x1: 200, y1: 460 }] }));
    expect(regions).toHaveLength(2);
    expect(regions[0].x1).toBeGreaterThan(230);
    expect(regions[1].y0).toBeLessThan(400);
  });

  it("leaves out the page's background, long rules and marks too small to be a figure", () => {
    const regions = figureRegions(layout({ drawings: [{ x0: 0, y0: 0, x1: 600, y1: 800 }, { x0: 70, y0: 40, x1: 520, y1: 40 }, { x0: 300, y0: 300, x1: 305, y1: 305 }] }));
    expect(regions).toEqual([]);
  });

  it("takes in the labels drawn in a figure and the short caption under it, not the question's lines", () => {
    const label = { x0: 120, y0: 120, x1: 130, y1: 130 };
    const caption = { x0: 110, y0: 166, x1: 150, y1: 176, text: "5 curls" };
    const stem = { x0: 40, y0: 60, x1: 560, y1: 70, text: "1. A long line of the question that runs across the page" };
    const [r] = figureRegions(layout({ drawings: [{ x0: 100, y0: 100, x1: 160, y1: 160 }], items: [label, caption, stem], lines: [caption, stem] }));
    expect(r.y1).toBeGreaterThanOrEqual(176);
    expect(r.y0).toBeGreaterThan(70);
    expect(r.x0).toBeGreaterThan(90);
  });

  it("a small drawing set in a line of text brings its row", () => {
    const before = { x0: 60, y0: 300, x1: 120, y1: 312, text: "(A) star" };
    const after = { x0: 142, y0: 300, x1: 220, y1: 312, text: "and triangle" };
    const [r] = figureRegions(layout({ drawings: [{ x0: 124, y0: 298, x1: 140, y1: 314 }], items: [before, after], lines: [{ ...before, x1: 220 }] }));
    expect(r.x0).toBeLessThanOrEqual(60);
    expect(r.x1).toBeGreaterThanOrEqual(220);
  });

  it("an embedded picture on its own is named, so it can be taken without rendering", () => {
    const [r] = figureRegions(layout({ drawings: [{ x0: 100, y0: 100, x1: 300, y1: 250, image: "img_p0_1" }] }));
    expect(r.image).toBe("img_p0_1");
  });

  it("drops what repeats at the same place on most pages", () => {
    const logo = (page: number): FigureRegion => ({ page, x0: 500, y0: 10, x1: 560, y1: 40 });
    const own: FigureRegion = { page: 2, x0: 100, y0: 300, x1: 200, y1: 400 };
    const out = dropRepeated([[logo(1)], [logo(2), own], [logo(3)], [logo(4)]]);
    expect(out.flat()).toEqual([own]);
  });
});

describe("which question a figure belongs to", () => {
  const starts = [
    { index: 0, page: 1, y: 100 },
    { index: 1, page: 1, y: 400 },
    { index: 2, page: 2, y: 300 },
  ];
  const lines = (page: number, ys: number[]): PageLayout => layout({ page, lines: ys.map((y) => ({ x0: 40, x1: 500, y0: y, y1: y + 10, text: "x" })) });

  it("the question whose text starts above it; close figures of one question are one", () => {
    const a: FigureRegion = { page: 1, x0: 100, y0: 130, x1: 200, y1: 200 };
    const b: FigureRegion = { page: 1, x0: 220, y0: 130, x1: 300, y1: 200 };
    const c: FigureRegion = { page: 1, x0: 100, y0: 430, x1: 200, y1: 500 };
    const out = assignFigures([a, b, c], starts, [lines(1, [100, 115, 210, 400, 415])]);
    expect(out.get(0)).toHaveLength(1);
    expect(out.get(0)![0].x1).toBe(300);
    expect(out.get(1)).toEqual([c]);
  });

  it("a figure above the first question of a page goes to the question from the page before", () => {
    const top: FigureRegion = { page: 2, x0: 100, y0: 60, x1: 300, y1: 200 };
    const out = assignFigures([top], starts, [lines(2, [300])]);
    expect(out.get(1)).toEqual([top]);
  });

  it("what stands far below the end of a question is not its figure", () => {
    const junk: FigureRegion = { page: 2, x0: 0, y0: 600, x1: 150, y1: 800 };
    const out = assignFigures([junk], starts, [lines(2, [300, 315, 330])]);
    expect(out.size).toBe(0);
  });

  it("figures before any question belong to none", () => {
    const cover: FigureRegion = { page: 1, x0: 100, y0: 20, x1: 300, y1: 80 };
    expect(assignFigures([cover], starts, [lines(1, [100])]).size).toBe(0);
  });
});

describe("a text PDF with figures", () => {
  it("finds the picture and the drawing, each under its question", async () => {
    const data = buildPdf();
    const pdf = await parsePdf(data);
    expect(pdf.questions).toHaveLength(3);
    const layouts = await pdfLayouts(data);
    const starts = questionStarts(pdf.questions, layouts);
    expect(starts).toHaveLength(3);
    const by = assignFigures(layouts.flatMap(figureRegions), starts, layouts);
    expect(by.get(0)).toHaveLength(1);
    expect(by.get(0)![0].image).toBeTruthy();
    expect(by.get(1)).toHaveLength(1);
    expect(by.get(1)![0].image).toBeUndefined();
    expect(by.has(2)).toBe(false);
  });

  it("imports the embedded picture with its question, and says what a drawn figure needs", async () => {
    const bank = createBank("local", { name: "b" });
    const batch = await parseImport({ owner: "local", bankId: bank.id, fileName: "paper.pdf", data: buildPdf(), classify: false, useModel: false });
    expect(batch.drafts).toHaveLength(3);
    const [q1, q2, q3] = batch.drafts;
    expect(q1.images).toHaveLength(1);
    expect(batch.assets).toContain(q1.images[0].asset);
    expect(fs.existsSync(path.join(root, "local", bank.id, "assets", q1.images[0].asset))).toBe(true);
    // The "refers to a figure" warning goes once the figure is there.
    expect(q1.issues.join(" ")).not.toMatch(/Refers to a figure|引用了图形/);
    expect(q2.images).toHaveLength(0);
    expect(q2.issues.join(" ")).toMatch(/Refers to a figure|引用了图形/);
    expect(q3.images).toHaveLength(0);
    expect((batch.notes ?? []).join(" ")).toMatch(/@napi-rs\/canvas/);
    expect((batch.notes ?? []).join(" ")).toMatch(/1 figure was taken|取出了 1 个图形/);
  });
});
