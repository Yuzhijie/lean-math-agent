/**
 * Someone saying something — "Today is Tuesday. Joy said to her friends: Tomorrow is my birthday!" —
 * drawn by the program: a simple figure per speaker with a speech bubble beside the head (never over
 * it), and optionally the answer choices underneath with empty circles to mark.
 *
 * The figures are plain and generic (round head, simple body); template illustrations are never
 * imitated. Pure and deterministic (server and browser).
 */
import { z } from "zod";

export const speechSchema = z.object({
  kind: z.literal("speech"),
  speakers: z
    .array(z.object({ text: z.string().min(1).max(160), name: z.string().max(24).optional() }))
    .min(1)
    .max(3),
  /** Answer choices drawn under the speakers, each with an empty circle, in two columns. */
  choices: z.array(z.string().min(1).max(40)).min(2).max(6).optional(),
  caption: z.string().max(60).optional(),
});

export type SpeechSpec = z.infer<typeof speechSchema>;

export interface SpeechPen {
  ink: string;
  accent: string;
  fill: string;
  paper: string;
  sw: number;
  text(x: number, y: number, s: string, size?: number, anchor?: "start" | "middle" | "end"): string;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const wide = (ch: string) => /[⺀-鿿豈-﫿＀-￯]/.test(ch);

function width(s: string, size: number): number {
  let w = 0;
  for (const ch of s) w += wide(ch) ? 1 : 0.56;
  return w * size;
}

/** Wrap text into lines no wider than `max` px (words for spaced text, characters for CJK). */
export function wrapText(s: string, size: number, max: number): string[] {
  const tokens = s.match(/[⺀-鿿豈-﫿＀-￯][，。！？、：；”’）]?|[^\s⺀-鿿豈-﫿＀-￯]+|\s+/g) ?? [s];
  const lines: string[] = [];
  let cur = "";
  for (const t of tokens) {
    const next = /^\s+$/.test(t) ? (cur ? cur + " " : "") : cur + t;
    if (!/^\s+$/.test(t) && cur && width(next, size) > max) {
      lines.push(cur.trimEnd());
      cur = t;
    } else cur = next;
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  return lines.length ? lines : [s];
}

function person(x: number, y: number, pen: SpeechPen): string {
  // Head centre (x, y + 26); total height ≈ 150.
  const st = `stroke="${pen.ink}" stroke-width="${Math.max(1.5, pen.sw)}" stroke-linecap="round" stroke-linejoin="round"`;
  return [
    `<circle cx="${x}" cy="${y + 26}" r="24" fill="${pen.paper}" ${st}/>`,
    `<circle cx="${x - 8}" cy="${y + 23}" r="2.2" fill="${pen.ink}"/><circle cx="${x + 8}" cy="${y + 23}" r="2.2" fill="${pen.ink}"/>`,
    `<path d="M${x - 8},${y + 33} Q${x},${y + 39} ${x + 8},${y + 33}" fill="none" ${st}/>`,
    `<path d="M${x - 18},${y + 58} Q${x},${y + 50} ${x + 18},${y + 58} L${x + 28},${y + 110} L${x - 28},${y + 110} Z" fill="${pen.fill}" ${st}/>`,
    `<path d="M${x - 20},${y + 64} L${x - 38},${y + 92} M${x + 20},${y + 64} L${x + 38},${y + 92}" fill="none" ${st}/>`,
    `<path d="M${x - 12},${y + 110} L${x - 14},${y + 148} M${x + 12},${y + 110} L${x + 14},${y + 148}" fill="none" ${st}/>`,
  ].join("");
}

export function drawSpeech(s: SpeechSpec, pen: SpeechPen): { w: number; h: number; body: string } {
  const size = 16, lineH = 21, maxText = 210;
  const parts: string[] = [];
  let x = 0;
  let rowH = 0;
  for (const sp of s.speakers) {
    const lines = wrapText(sp.text, size, maxText);
    const tw = Math.max(...lines.map((l) => width(l, size)));
    const bw = Math.max(70, tw + 28), bh = lines.length * lineH + 20;
    const px = x + 42; // person centre
    const bx = px + 44; // bubble left edge: right of the head and arms
    const top = 4;
    const by = top; // bubble top
    const headY = Math.max(top, by + bh - 30); // head below the bubble's lower part, never under it
    // Bubble with a tail pointing at the head.
    const tailY = Math.min(by + bh - 6, headY + 22);
    parts.push(
      `<rect x="${r1(bx)}" y="${r1(by)}" width="${r1(bw)}" height="${r1(bh)}" rx="14" fill="${pen.paper}" stroke="${pen.accent}" stroke-width="${Math.max(1.5, pen.sw)}"/>`,
      `<path d="M${r1(bx + 1)},${r1(tailY - 12)} L${r1(px + 28)},${r1(headY + 26)} L${r1(bx + 1)},${r1(tailY)}" fill="${pen.paper}" stroke="${pen.accent}" stroke-width="${Math.max(1.5, pen.sw)}" stroke-linejoin="round"/>`,
      `<line x1="${r1(bx + 1.5)}" y1="${r1(tailY - 11)}" x2="${r1(bx + 1.5)}" y2="${r1(tailY - 1)}" stroke="${pen.paper}" stroke-width="3"/>`,
    );
    lines.forEach((l, i) => parts.push(pen.text(bx + bw / 2, by + 10 + lineH * (i + 1) - 5, l, size)));
    parts.push(person(px, headY, pen));
    let h = headY + 150;
    if (sp.name) {
      parts.push(pen.text(px, h + 18, sp.name, 14));
      h += 24;
    }
    rowH = Math.max(rowH, h, by + bh);
    x = bx + bw + 28;
  }
  let w = x - 28;
  let h = rowH;
  if (s.choices?.length) {
    const colW = Math.max(150, ...s.choices.map((c) => width(c, 17) + 52));
    const cols = 2;
    s.choices.forEach((c, i) => {
      const cx = (i % cols) * colW + 14, cy = h + 30 + Math.floor(i / cols) * 36;
      parts.push(`<circle cx="${cx}" cy="${cy}" r="11" fill="${pen.paper}" stroke="${pen.ink}" stroke-width="1.6"/>`, pen.text(cx + 22, cy + 6, c, 17, "start"));
    });
    h += 30 + Math.ceil(s.choices.length / cols) * 36;
    w = Math.max(w, cols * colW);
  }
  if (s.caption) {
    parts.push(pen.text(0, h + 22, s.caption, 14, "start"));
    h += 30;
  }
  return { w, h, body: parts.join("") };
}

export function describeSpeech(s: SpeechSpec): string {
  const who = s.speakers.map((sp) => `${sp.name ? `a child labelled "${sp.name}"` : "a child"} with a speech bubble beside the head saying "${sp.text}"`);
  return `${who.join("; ")}${s.choices?.length ? `; below, ${s.choices.length} answer choices each with an empty circle: ${s.choices.join(", ")}` : ""}${s.caption ? `; caption "${s.caption}"` : ""}`;
}
