import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseImport } from "@/lib/bank/import";
import { cropRaw, detectImage, downscaleRaw, encodePng, loadSharp, normaliseBox, pageScan, type RawImage } from "@/lib/bank/import/images";
import { _closeAllBanks, createBank, readAsset } from "@/lib/bank/store";
import { resetGlobalCache } from "@/lib/llm/cache";
import { withOutputLocale } from "@/lib/llm/output-locale";

// Scans and photos: page images are read by the vision model, split like
// text, figures are cut out and attached, and every draft is marked for review.

vi.mock("next-auth", () => ({ getServerSession: async () => null }));

let root: string;
const OWNER = "local";
const ENV = ["BANK_STORE_PATH", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "LLM_VISION_MODEL", "LLM_LOG_LEVEL", "LLM_CACHE_ENABLED", "LLM_RETRY_MAX", "LLM_MAX_HTTP_RETRIES", "BANK_IMAGES_NO_SHARP"];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bank-ocr-"));
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

const newBank = (allow_model = true) => createBank(OWNER, { name: "Scans", language: "en", allow_model }).id;

/** White page with a black rectangle (the "figure") at the given fractions. */
function page(w: number, h: number, fig?: [number, number, number, number], channels: 1 | 3 = 3): RawImage {
  const data = new Uint8Array(w * h * channels).fill(255);
  if (fig) {
    for (let y = Math.floor(fig[1] * h); y < Math.floor(fig[3] * h); y++)
      for (let x = Math.floor(fig[0] * w); x < Math.floor(fig[2] * w); x++) for (let c = 0; c < channels; c++) data[(y * w + x) * channels + c] = 0;
  }
  return { data, width: w, height: h, channels };
}

/** A PDF whose pages are only images (a scan): one RGB FlateDecode image per page, no text. */
function buildScanPdf(images: RawImage[]): Buffer {
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let len = 0;
  const push = (b: Buffer | string) => {
    const x = typeof b === "string" ? Buffer.from(b, "latin1") : b;
    parts.push(x);
    len += x.length;
  };
  push("%PDF-1.4\n");
  const n = images.length;
  const obj = (id: number, body: string | Buffer[]) => {
    offsets[id] = len;
    push(`${id} 0 obj\n`);
    if (typeof body === "string") push(body);
    else body.forEach(push);
    push("\nendobj\n");
  };
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Kids [${images.map((_, i) => `${3 + i * 3} 0 R`).join(" ")}] /Count ${n} >>`);
  images.forEach((im, i) => {
    const pageId = 3 + i * 3, contentId = pageId + 1, imgId = pageId + 2;
    const content = `q 612 0 0 792 0 0 cm /Im0 Do Q`;
    obj(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 ${imgId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    obj(contentId, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const z = zlib.deflateSync(Buffer.from(im.data));
    obj(imgId, [
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${im.width} /Height ${im.height} /ColorSpace /${im.channels === 1 ? "DeviceGray" : "DeviceRGB"} /BitsPerComponent 8 /Filter /FlateDecode /Length ${z.length} >>\nstream\n`, "latin1"),
      z,
      Buffer.from("\nendstream", "latin1"),
    ]);
  });
  const size = 3 + n * 3;
  const xref = len;
  push(`xref\n0 ${size}\n0000000000 65535 f \n`);
  for (let id = 1; id < size; id++) push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

type Call = { model: string; system: string; user: string; images: string[] };
const PAGES: Record<number, { text: string; figures?: Array<{ question: string; box: number[] }> }> = {
  1: {
    text: "Year 3 Maths\n1. Which shape has 4 equal sides?\nA. triangle\nB. square\nC. circle\nD. pentagon\n2. The number line shows the point P. What number is at P?\nA. 3\nB. 4",
    figures: [{ question: "2", box: [0.25, 0.5, 0.75, 0.9] }],
  },
  2: { text: "C. 5\nD. 6\n3. What is $\\frac{1}{2}$ of [?]?" },
};

/** Fake OpenAI endpoint: the vision model transcribes "Page N", other calls are answered by `other`. */
function fakeModel(opts: { failPages?: number[]; other?: (system: string) => unknown } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { model: string; messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }> };
      const sys = String(body.messages[0].content);
      const last = body.messages[body.messages.length - 1].content;
      const user = typeof last === "string" ? last : last.filter((p) => p.type === "text").map((p) => p.text).join("");
      const images = typeof last === "string" ? [] : last.filter((p) => p.type === "image_url").map((p) => p.image_url!.url);
      calls.push({ model: body.model, system: sys, user, images });
      const reply = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
      if (sys.startsWith("You transcribe")) {
        const n = Number(/Page (\d+)/.exec(user)?.[1]);
        if (opts.failPages?.includes(n)) return new Response("model does not support images", { status: 400 });
        return reply(PAGES[n] ?? { text: "" });
      }
      return reply(opts.other ? opts.other(sys) : {});
    }),
  );
  return calls;
}

describe("image helpers", () => {
  it("detects formats, including HEIC", () => {
    expect(detectImage(encodePng(page(10, 10)))).toBe("image/png");
    expect(detectImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe("image/jpeg");
    expect(detectImage(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic", "latin1"), Buffer.alloc(8)]))).toBe("heic");
    expect(detectImage(Buffer.from("hello world!"))).toBeUndefined();
  });

  it("encodes PNG that sharp can read back", async () => {
    const sharp = await loadSharp();
    if (!sharp) return;
    const meta = await sharp(encodePng(page(37, 21, [0, 0, 0.5, 0.5], 1))).metadata();
    expect([meta.width, meta.height]).toEqual([37, 21]);
  });

  it("scales, crops and normalises boxes", () => {
    const small = downscaleRaw(page(4000, 3000), 2000);
    expect([small.width, small.height]).toEqual([2000, 1500]);
    const cut = cropRaw(page(100, 100), { x0: 0.1, y0: 0.2, x1: 0.5, y1: 0.6 })!;
    expect([cut.width, cut.height]).toEqual([40, 40]);
    const b = normaliseBox({ x0: 100, y0: 200, x1: 500, y1: 600 })!; // 0–1000 coordinates, padded by 0.01
    expect(b.x0).toBeCloseTo(0.09);
    expect(b.y1).toBeCloseTo(0.61);
    expect(normaliseBox({ x0: 0, y0: 0, x1: 1, y1: 1 })).toBeNull(); // whole page is not a figure
    expect(normaliseBox({ x0: 0.5, y0: 0.5, x1: 0.51, y1: 0.505 })).toBeNull();
  });

  it("stacks same-width strips of a page scan", () => {
    const strip = page(800, 100);
    expect(pageScan([strip, strip, strip])).toMatchObject({ width: 800, height: 300 });
    expect(pageScan([page(20, 20)])).toBeNull();
  });
});

describe("importing photos of a paper", () => {
  const png = (fig?: [number, number, number, number]) => encodePng(page(600, 800, fig));

  for (const noSharp of [false, true]) {
    it(`reads several images as one paper, attaches figures, keeps page images${noSharp ? " (without sharp)" : ""}`, async () => {
      if (noSharp) process.env.BANK_IMAGES_NO_SHARP = "1";
      const calls = fakeModel();
      const bankId = newBank();
      const batch = await withOutputLocale("en-US", () =>
        parseImport({ owner: OWNER, bankId, fileName: "p1.png", data: png([0.25, 0.5, 0.75, 0.9]), moreImages: [{ fileName: "p2.png", data: png() }], useModel: false, classify: false }),
      );
      expect(batch.format).toBe("image");
      expect(batch.ocr).toBe(true);
      expect(batch.file_name).toMatch(/p1\.png/);
      const d = batch.drafts;
      expect(d.map((x) => x.source?.label)).toEqual(["1", "2", "3"]);
      expect(d[0]).toMatchObject({ stem: "Which shape has 4 equal sides?", options: ["triangle", "square", "circle", "pentagon"], type: "multiple_choice" });
      // Choices continue on the next page.
      expect(d[1].options).toEqual(["3", "4", "5", "6"]);
      expect(d.map((x) => x.source?.page)).toEqual([1, 1, 2]);
      // Every draft is marked for review and keeps its page image.
      for (const x of d) {
        expect(x.status).toBe("needs_review");
        expect(x.issues[0]).toMatch(/Read from an image/);
        expect(readAsset(OWNER, bankId, x.source!.page_image!).length).toBeGreaterThan(0);
      }
      expect(d[0].source?.page_image).not.toBe(d[2].source?.page_image);
      // The figure was cut out for question 2 only; the "refers to a figure" issue is gone.
      expect(d[1].images).toHaveLength(noSharp ? 0 : 1);
      if (!noSharp) {
        expect(d[1].issues.join()).not.toMatch(/Refers to a figure/);
        const sharp = (await loadSharp())!;
        const meta = await sharp(readAsset(OWNER, bankId, d[1].images[0].asset)).metadata();
        expect(meta.width).toBeGreaterThan(290);
        expect(meta.width).toBeLessThan(320);
      } else {
        // A photo cannot be cropped without sharp: the reviewer is told.
        expect(d[1].issues.join()).toMatch(/could not be cut out/);
      }
      expect(d[0].images).toHaveLength(0);
      expect(d[2].issues.join()).toMatch(/could not be read \(\[\?\]\)/);
      // The vision model got one image per call, and the prompt was not switched to English.
      const vision = calls.filter((c) => c.system.startsWith("You transcribe"));
      expect(vision).toHaveLength(2);
      expect(vision.every((c) => c.model === "vision-model" && c.images.length === 1 && c.images[0].startsWith("data:image/"))).toBe(true);
      expect(vision[0].user).not.toMatch(/Answer in English/);
    });
  }

  it("tidies and classifies with the text model afterwards", async () => {
    const calls = fakeModel({
      other: (sys) =>
        sys.startsWith("You restructure")
          ? { items: [] }
          : { items: [1, 2, 3].map((n) => ({ n, path: ["Geometry"], difficulty: 1, grade: "Year 3" })) },
    });
    const batch = await parseImport({ owner: OWNER, bankId: newBank(), fileName: "p1.png", data: png(), moreImages: [{ fileName: "p2.png", data: png() }] });
    expect(batch.drafts).toHaveLength(3);
    expect(batch.drafts[0].grade).toBe("Year 3");
    const other = calls.filter((c) => !c.system.startsWith("You transcribe"));
    expect(other.length).toBeGreaterThanOrEqual(2);
    expect(other.every((c) => c.model === "text-model" && c.images.length === 0)).toBe(true);
  });

  it("reports a page the model could not read and keeps the rest", async () => {
    fakeModel({ failPages: [2] });
    const batch = await withOutputLocale("en-US", () =>
      parseImport({ owner: OWNER, bankId: newBank(), fileName: "p1.png", data: png(), moreImages: [{ fileName: "p2.png", data: png() }], useModel: false, classify: false }),
    );
    expect(batch.drafts.map((x) => x.source?.label)).toEqual(["1", "2"]);
    expect(batch.notes?.join()).toMatch(/Page 2 could not be read/);
  });

  it("explains a model that cannot read images", async () => {
    fakeModel({ failPages: [1] });
    await expect(withOutputLocale("en-US", () => parseImport({ owner: OWNER, bankId: newBank(), fileName: "p1.png", data: png(), useModel: false, classify: false }))).rejects.toThrow(/LLM_VISION_MODEL/);
  });

  it("needs a bank that may send content to the model", async () => {
    const calls = fakeModel();
    await expect(parseImport({ owner: OWNER, bankId: newBank(false), fileName: "p1.png", data: png() })).rejects.toThrow(/不允许发送给模型/);
    expect(calls).toHaveLength(0);
  });

  it("asks for JPEG instead of HEIC", async () => {
    fakeModel();
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic", "latin1"), Buffer.alloc(64)]);
    await expect(parseImport({ owner: OWNER, bankId: newBank(), fileName: "IMG_0001.HEIC", data: heic })).rejects.toThrow(/HEIC/);
  });
});

describe("importing a scanned PDF", () => {
  for (const noSharp of [false, true]) {
    it(`reads the page scans with the vision model and crops figures${noSharp ? " (without sharp)" : ""}`, async () => {
      if (noSharp) process.env.BANK_IMAGES_NO_SHARP = "1";
      const calls = fakeModel();
      const bankId = newBank();
      const data = buildScanPdf([page(300, 400, [0.25, 0.5, 0.75, 0.9]), page(300, 400, undefined, 1)]);
      const batch = await parseImport({ owner: OWNER, bankId, fileName: "scan.pdf", data, useModel: false, classify: false });
      expect(batch.format).toBe("pdf");
      expect(batch.ocr).toBe(true);
      expect(batch.drafts).toHaveLength(3);
      expect(calls.filter((c) => c.images.length === 1 && c.images[0].startsWith("data:image/png"))).toHaveLength(2);
      // The figure is cropped from the scan's pixels even without sharp.
      expect(batch.drafts[1].images).toHaveLength(1);
      const fig = readAsset(OWNER, bankId, batch.drafts[1].images[0].asset);
      expect(detectImage(fig)).toBe("image/png");
      expect(fig.readUInt32BE(16)).toBeGreaterThan(140); // width ≈ 0.52 × 300
      expect(fig.readUInt32BE(16)).toBeLessThan(165);
      // The original PDF is kept too.
      expect(batch.assets.some((a) => a.endsWith(".pdf"))).toBe(true);
    });
  }

  it("is refused for a bank that may not send content to the model", async () => {
    fakeModel();
    const data = buildScanPdf([page(300, 400)]);
    await expect(parseImport({ owner: OWNER, bankId: newBank(false), fileName: "scan.pdf", data })).rejects.toThrow(/扫描件/);
  });
});

describe("POST /api/banks/:id/imports with several files", () => {
  const post = async (bankId: string, files: Array<[string, Buffer]>) => {
    const { POST } = await import("@/app/api/banks/[id]/imports/route");
    const fd = new FormData();
    for (const [name, data] of files) fd.append("file", new File([new Uint8Array(data)], name));
    fd.append("use_model", "false");
    fd.append("classify", "false");
    return POST(new Request(`http://t/api/banks/${bankId}/imports`, { method: "POST", body: fd }), { params: Promise.resolve({ id: bankId }) });
  };

  it("reads several images as one batch, and refuses several non-images", async () => {
    fakeModel();
    const bankId = newBank();
    const img = encodePng(page(60, 80));
    const res = await post(bankId, [["p1.png", img], ["p2.png", img]]);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { batch: { drafts: unknown[] } }).batch.drafts).toHaveLength(3);
    const bad = await post(bankId, [["a.txt", Buffer.from("1. x")], ["b.txt", Buffer.from("1. y")]]);
    expect(bad.status).toBe(400);
  });
});
