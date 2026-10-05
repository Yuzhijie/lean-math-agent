/**
 * Page images for importing scans and photos.
 *
 *  - photos / screenshots (PNG, JPEG, WebP, GIF) are oriented (EXIF) and
 *    scaled to at most MAX_SIDE pixels on the long side;
 *  - a scanned PDF has no text layer: each page's scan is taken from the
 *    images embedded in the page (the largest one, or same-width strips
 *    stacked) — no page rendering, so no native canvas is needed;
 *  - figures are cut out of a page by a box the model reports.
 *
 * sharp (installed with Next.js) is used when it loads; without it, raw
 * PDF pixels are scaled, cropped and PNG-encoded in plain JavaScript and
 * photos are passed through unchanged (and cannot be cropped).
 */
import zlib from "node:zlib";
import { lt } from "@/lib/llm/output-locale";
import { BankError } from "../store";

export type ImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface PageImage {
  data: Buffer;
  mime: ImageMime;
  /** 1-based page number in the import (file order, then PDF page). */
  page: number;
  width?: number;
  height?: number;
  /** Raw pixels kept for cropping when sharp is unavailable (PDF scans only). */
  raw?: RawImage;
}

export interface RawImage {
  data: Uint8Array;
  width: number;
  height: number;
  channels: 1 | 3 | 4;
}

/** Normalised box (0–1) of a region on a page. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const MAX_SIDE = 2000;
/** Largest image sent as-is when it cannot be scaled (no sharp). */
const MAX_PASSTHROUGH_BYTES = 8 * 1024 * 1024;

export const IMAGE_EXT: Record<ImageMime, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/** Image type from the file's first bytes; "heic" for iPhone photos (not readable by most models). */
export function detectImage(data: Buffer): ImageMime | "heic" | undefined {
  if (data.length < 12) return undefined;
  if (data[0] === 0x89 && data.subarray(1, 4).toString("latin1") === "PNG") return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (data.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (data.subarray(4, 8).toString("latin1") === "ftyp" && /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(data.subarray(8, 12).toString("latin1"))) return "heic";
  return undefined;
}

export const IMAGE_FILE = /\.(png|jpe?g|webp|gif|heic|heif)$/i;

/** The part of sharp's API used here (sharp is loaded at run time and may be absent). */
interface SharpImage {
  rotate(): SharpImage;
  resize(o: { width?: number; height?: number; fit?: "inside"; withoutEnlargement?: boolean }): SharpImage;
  flatten(o: { background: string }): SharpImage;
  jpeg(o?: { quality?: number }): SharpImage;
  png(): SharpImage;
  extract(o: { left: number; top: number; width: number; height: number }): SharpImage;
  toBuffer(): Promise<Buffer>;
  toBuffer(o: { resolveWithObject: true }): Promise<{ data: Buffer; info: { width: number; height: number } }>;
  metadata(): Promise<{ width?: number; height?: number }>;
}
type Sharp = (input: Buffer, opts?: { animated?: boolean; raw?: { width: number; height: number; channels: 1 | 3 | 4 } }) => SharpImage;
let sharpModule: Sharp | null | undefined;

/**
 * sharp if it can be loaded (it is an optional dependency of Next.js). The
 * specifier is a variable and the import is marked for the bundlers to leave
 * alone, so the build never depends on sharp being installed and Node
 * resolves it from node_modules at run time.
 */
export async function loadSharp(): Promise<Sharp | null> {
  if (process.env.BANK_IMAGES_NO_SHARP === "1") return null;
  if (sharpModule === undefined) {
    try {
      const spec = "sharp";
      const m = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ spec)) as { default?: Sharp } | Sharp;
      sharpModule = typeof m === "function" ? m : (m.default ?? null);
    } catch {
      sharpModule = null;
    }
  }
  return sharpModule;
}

export function dataUrl(img: Pick<PageImage, "data" | "mime">): string {
  return `data:${img.mime};base64,${img.data.toString("base64")}`;
}

/** A photo or screenshot ready for the model: upright, at most MAX_SIDE px, JPEG/PNG. */
export async function preparePhoto(data: Buffer, page: number): Promise<PageImage> {
  const kind = detectImage(data);
  if (kind === "heic") {
    throw new BankError(lt("暂不支持 HEIC 照片，请在手机上导出为 JPEG（或截屏）后再上传", "HEIC photos are not supported; export them as JPEG (or take a screenshot) and upload again"), 415);
  }
  if (!kind) throw new BankError(lt("无法识别的图片格式（支持 PNG、JPEG、WebP、GIF）", "Unrecognised image format (PNG, JPEG, WebP and GIF are supported)"), 415);
  const sharp = await loadSharp();
  if (sharp) {
    try {
      const { data: out, info } = await sharp(data, { animated: false })
        .rotate()
        .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 85 })
        .toBuffer({ resolveWithObject: true });
      return { data: out, mime: "image/jpeg", page, width: info.width, height: info.height };
    } catch (e) {
      throw new BankError(lt(`无法读取图片：${(e as Error).message}`.slice(0, 300), `Cannot read the image: ${(e as Error).message}`.slice(0, 300)), 422);
    }
  }
  if (data.length > MAX_PASSTHROUGH_BYTES) {
    throw new BankError(lt("图片太大（超过 8 MB），请压缩或截屏后再上传", "The image is too large (over 8 MB); compress it or take a screenshot and upload again"), 413);
  }
  return { data, mime: kind, page };
}

// ── Raw pixels (PDF scans) ───────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const tb = Buffer.concat([Buffer.from(type, "latin1"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(tb));
  return Buffer.concat([len, tb, crc]);
}

/** PNG from raw 8-bit pixels (grey, RGB or RGBA). */
export function encodePng(img: RawImage): Buffer {
  const { width, height, channels } = img;
  const colorType = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  const stride = width * channels;
  const rows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    rows[y * (stride + 1)] = 0; // filter: none
    rows.set(img.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(rows, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Box-filter downscale so the long side is at most `max`. */
export function downscaleRaw(img: RawImage, max = MAX_SIDE): RawImage {
  const f = Math.max(img.width, img.height) / max;
  if (f <= 1) return img;
  const w = Math.max(1, Math.round(img.width / f));
  const h = Math.max(1, Math.round(img.height / f));
  const c = img.channels;
  const out = new Uint8Array(w * h * c);
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor(y * f);
    const sy1 = Math.min(img.height, Math.max(sy0 + 1, Math.floor((y + 1) * f)));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x * f);
      const sx1 = Math.min(img.width, Math.max(sx0 + 1, Math.floor((x + 1) * f)));
      for (let k = 0; k < c; k++) {
        let sum = 0;
        for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) sum += img.data[(sy * img.width + sx) * c + k];
        out[(y * w + x) * c + k] = Math.round(sum / ((sy1 - sy0) * (sx1 - sx0)));
      }
    }
  }
  return { data: out, width: w, height: h, channels: c };
}

export function cropRaw(img: RawImage, box: Box): RawImage | null {
  const x0 = Math.floor(box.x0 * img.width), x1 = Math.ceil(box.x1 * img.width);
  const y0 = Math.floor(box.y0 * img.height), y1 = Math.ceil(box.y1 * img.height);
  const w = x1 - x0, h = y1 - y0;
  if (w < 8 || h < 8) return null;
  const c = img.channels;
  const out = new Uint8Array(w * h * c);
  for (let y = 0; y < h; y++) out.set(img.data.subarray(((y0 + y) * img.width + x0) * c, ((y0 + y) * img.width + x1) * c), y * w * c);
  return { data: out, width: w, height: h, channels: c };
}

/** A sane box: coordinates as fractions (0–1, or 0–1000 scaled down), padded a little, clamped. */
export function normaliseBox(b: Box): Box | null {
  let { x0, y0, x1, y1 } = b;
  if ([x0, y0, x1, y1].some((v) => !Number.isFinite(v))) return null;
  if (Math.max(x0, y0, x1, y1) > 1.5) [x0, y0, x1, y1] = [x0, y0, x1, y1].map((v) => v / 1000);
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 < y0) [y0, y1] = [y1, y0];
  // Too small to be a figure (judged before padding).
  if (x1 - x0 < 0.02 || y1 - y0 < 0.015) return null;
  const pad = 0.01;
  const box = { x0: Math.max(0, x0 - pad), y0: Math.max(0, y0 - pad), x1: Math.min(1, x1 + pad), y1: Math.min(1, y1 + pad) };
  // A "figure" that is nearly the whole page is not a figure.
  if ((box.x1 - box.x0) * (box.y1 - box.y0) > 0.85) return null;
  return box;
}

/** Cut a figure out of a page image; null when it cannot be cropped. */
export async function cropFigure(page: PageImage, box: Box): Promise<{ data: Buffer; ext: string } | null> {
  if (page.raw) {
    const part = cropRaw(page.raw, box);
    return part ? { data: encodePng(part), ext: "png" } : null;
  }
  const sharp = await loadSharp();
  if (!sharp) return null;
  try {
    const meta = await sharp(page.data).metadata();
    const W = meta.width ?? page.width, H = meta.height ?? page.height;
    if (!W || !H) return null;
    const left = Math.floor(box.x0 * W), top = Math.floor(box.y0 * H);
    const width = Math.min(W - left, Math.ceil((box.x1 - box.x0) * W)), height = Math.min(H - top, Math.ceil((box.y1 - box.y0) * H));
    if (width < 8 || height < 8) return null;
    return { data: await sharp(page.data).extract({ left, top, width, height }).png().toBuffer(), ext: "png" };
  } catch {
    return null;
  }
}

/** The scan of one PDF page from its embedded images: the largest, or same-width strips stacked top to bottom. */
export function pageScan(images: RawImage[]): RawImage | null {
  const big = images.filter((im) => im.width >= 200 && im.height >= 50);
  if (!big.length) return null;
  const largest = big.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
  const strips = big.filter((im) => im.width === largest.width && im.channels === largest.channels);
  if (strips.length < 2 || largest.height > largest.width * 0.9) return largest;
  const height = strips.reduce((s, im) => s + im.height, 0);
  const out = new Uint8Array(largest.width * height * largest.channels);
  let off = 0;
  for (const im of strips) {
    out.set(im.data.subarray(0, im.width * im.height * im.channels), off);
    off += im.width * im.height * im.channels;
  }
  return { data: out, width: largest.width, height, channels: largest.channels };
}

/** Page images of a scanned PDF (no text layer), at most `maxPages`. */
export async function scannedPdfPages(data: Buffer, opts: { maxPages: number; firstPage?: number }): Promise<PageImage[]> {
  const { extractImages, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(data));
  if (pdf.numPages > opts.maxPages) {
    throw new BankError(
      lt(`扫描版 PDF 一次最多识别 ${opts.maxPages} 页（此文件 ${pdf.numPages} 页），请拆分后分批导入`, `A scanned PDF can have at most ${opts.maxPages} pages per import (this one has ${pdf.numPages}); split it and import in parts`),
      413,
    );
  }
  const sharp = await loadSharp();
  const pages: PageImage[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const raw = pageScan(((await extractImages(pdf, p)) as Array<{ data: Uint8ClampedArray; width: number; height: number; channels: 1 | 3 | 4 }>).map((im) => ({ data: new Uint8Array(im.data.buffer, im.data.byteOffset, im.data.byteLength), width: im.width, height: im.height, channels: im.channels })));
    if (!raw) continue;
    const page = (opts.firstPage ?? 1) + p - 1;
    if (sharp) {
      const { data: out, info } = await sharp(Buffer.from(raw.data), { raw: { width: raw.width, height: raw.height, channels: raw.channels } })
        .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer({ resolveWithObject: true });
      pages.push({ data: out, mime: "image/png", page, width: info.width, height: info.height });
    } else {
      const small = downscaleRaw(raw);
      pages.push({ data: encodePng(small), mime: "image/png", page, width: small.width, height: small.height, raw: small });
    }
  }
  return pages;
}
