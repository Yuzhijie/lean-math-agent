/**
 * Things covering each other in a model-drawn SVG: a filled shape drawn over text, or over most of
 * an earlier, smaller shape (a speech bubble drawn over a face). Works on bounding boxes of the
 * top-level shapes; drawings with transforms are not analysed (null). Background shapes (nearly the
 * whole picture) and shapes drawn on top of a bigger one (a window on a house) are fine.
 */

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface El {
  tag: string;
  box: Box;
  opaque: boolean;
  text?: string;
}

const num = (attrs: string, name: string): number | undefined => {
  const m = new RegExp(`\\s${name}\\s*=\\s*["']\\s*(-?[\\d.]+)`).exec(attrs);
  return m ? parseFloat(m[1]) : undefined;
};
const str = (attrs: string, name: string): string | undefined => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`).exec(attrs)?.[1];

function pointsBox(nums: number[]): Box | null {
  if (nums.length < 4) return null;
  const xs = nums.filter((_, i) => i % 2 === 0), ys = nums.filter((_, i) => i % 2 === 1);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** Bounding box of path data with absolute commands (M L H V Q C S T Z, and A end points). Null for relative commands. */
function pathBox(d: string): Box | null {
  if (/[mlhvqcsta]/.test(d.replace(/e-?\d/g, ""))) return null; // relative commands: not analysed
  const xs: number[] = [], ys: number[] = [];
  const re = /([MLHVQCSTAZ])([^MLHVQCSTAZ]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) {
    const c = m[1];
    const n = (m[2].match(/-?\d*\.?\d+(?:e-?\d+)?/g) ?? []).map(Number);
    if (c === "H") xs.push(...n);
    else if (c === "V") ys.push(...n);
    else if (c === "A") for (let i = 0; i + 6 < n.length + 1; i += 7) (xs.push(n[i + 5]), ys.push(n[i + 6]));
    else for (let i = 0; i + 1 < n.length; i += 2) (xs.push(n[i]), ys.push(n[i + 1]));
  }
  if (!xs.length || !ys.length) return null;
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

const area = (b: Box) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
const inter = (a: Box, b: Box): number => area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });

function textWidth(s: string, size: number): number {
  let w = 0;
  for (const ch of s) w += /[⺀-鿿豈-﫿＀-￯]/.test(ch) ? 1 : 0.55;
  return w * size;
}

function elements(svg: string): El[] | null {
  if (/\btransform\s*=/.test(svg) || /<use\b/.test(svg)) return null;
  const out: El[] = [];
  const re = /<(rect|circle|ellipse|polygon|path|text)\b([^>]*?)(\/?)>(?:([^<]*)<\/text>)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg))) {
    const [, tag, attrs, , inner] = m;
    const fill = str(attrs, "fill") ?? (/(^|;)\s*fill\s*:\s*none/.test(str(attrs, "style") ?? "") ? "none" : undefined);
    const opacity = num(attrs, "fill-opacity") ?? num(attrs, "opacity") ?? 1;
    const opaque = fill !== "none" && fill !== "transparent" && opacity > 0.6;
    let box: Box | null = null;
    if (tag === "rect") {
      const x = num(attrs, "x") ?? 0, y = num(attrs, "y") ?? 0, w = num(attrs, "width"), h = num(attrs, "height");
      if (w !== undefined && h !== undefined) box = { x0: x, y0: y, x1: x + w, y1: y + h };
    } else if (tag === "circle" || tag === "ellipse") {
      const cx = num(attrs, "cx") ?? 0, cy = num(attrs, "cy") ?? 0;
      const rx = tag === "circle" ? num(attrs, "r") : num(attrs, "rx"), ry = tag === "circle" ? num(attrs, "r") : num(attrs, "ry");
      if (rx !== undefined && ry !== undefined) box = { x0: cx - rx, y0: cy - ry, x1: cx + rx, y1: cy + ry };
    } else if (tag === "polygon") {
      box = pointsBox((str(attrs, "points") ?? "").match(/-?\d*\.?\d+/g)?.map(Number) ?? []);
    } else if (tag === "path") {
      box = pathBox(str(attrs, "d") ?? "");
    } else if (tag === "text" && inner !== undefined) {
      const t = inner.trim();
      const x = num(attrs, "x") ?? 0, y = num(attrs, "y") ?? 0, size = num(attrs, "font-size") ?? 16;
      const w = textWidth(t, size);
      const anchor = str(attrs, "text-anchor");
      const x0 = anchor === "middle" ? x - w / 2 : anchor === "end" ? x - w : x;
      box = { x0, y0: y - size * 0.8, x1: x0 + w, y1: y + size * 0.2 };
      out.push({ tag, box, opaque: false, text: t });
      continue;
    }
    if (box) out.push({ tag, box, opaque });
  }
  return out;
}

/** Problems with things covering each other ([] = none found; null = not analysed). */
export function svgOverlaps(svg: string): string[] | null {
  const els = elements(svg);
  if (!els) return null;
  const vb = /viewBox\s*=\s*["']\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(svg);
  const canvas = vb ? Number(vb[3]) * Number(vb[4]) : Math.max(...els.map((e) => e.box.x1)) * Math.max(...els.map((e) => e.box.y1));
  const where = (b: Box) => `around (${Math.round((b.x0 + b.x1) / 2)}, ${Math.round((b.y0 + b.y1) / 2)})`;
  const problems: string[] = [];
  els.forEach((top, j) => {
    if (!top.opaque || top.tag === "text" || area(top.box) >= 0.9 * canvas) return;
    for (let i = 0; i < j; i++) {
      const under = els[i];
      if (under.tag === "text") {
        if (under.text && inter(under.box, top.box) > 0.3 * area(under.box)) problems.push(`a filled ${top.tag} drawn over the text "${under.text.slice(0, 30)}"`);
        continue;
      }
      if (area(under.box) >= 0.9 * canvas || area(under.box) >= area(top.box)) continue; // background, or decoration on a bigger shape
      if (inter(under.box, top.box) > 0.5 * area(under.box)) problems.push(`a filled ${top.tag} ${where(top.box)} covers most of an earlier ${under.tag} ${where(under.box)}`);
    }
  });
  return [...new Set(problems)].slice(0, 4);
}
