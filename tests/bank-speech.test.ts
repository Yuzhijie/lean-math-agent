import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drawSpeech, wrapText } from "@/lib/figure/speech";
import { svgOverlaps } from "@/lib/figure/svg-overlap";
import { buildVisual, VISUAL_GUIDE, visualSpecSchema } from "@/lib/figure/visual";
import { generateFromTemplate } from "@/lib/bank/generate";
import { encodePng } from "@/lib/bank/import/images";
import { _closeAllBanks, addItems, createBank, saveAsset } from "@/lib/bank/store";
import { resetGlobalCache } from "@/lib/llm/cache";

// "Today is Tuesday. Joy said: Tomorrow is my birthday!" — the model drew the speech bubble over the
// child's face. Overlaps in model drawings are now found by the program, and a speech figure is drawn
// by the program so that the bubble never covers the head.

/** The figure generated on the Mac: the bubble covers the head. */
const COVERED = `<svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg"><rect width="400" height="300" fill="white"/><circle cx="200" cy="48" r="34" fill="#f7d6b5" stroke="#333" stroke-width="2"/><path d="M166 39 Q200 5 234 39" fill="#8b5a3c" stroke="#333" stroke-width="2"/><circle cx="188" cy="48" r="3"/><circle cx="212" cy="48" r="3"/><path d="M190 63 Q200 70 210 63" fill="none" stroke="#333" stroke-width="2"/><path d="M170 84 Q200 68 230 84 L245 155 L155 155 Z" fill="#f3a6c8" stroke="#333" stroke-width="2"/><path d="M170 155 L160 205 M230 155 L240 205 M160 205 L145 238 M240 205 L255 238" fill="none" stroke="#333" stroke-width="5" stroke-linecap="round"/><path d="M155 92 L125 125 M245 92 L275 125" fill="none" stroke="#333" stroke-width="5" stroke-linecap="round"/><path d="M80 20 Q80 5 95 5 H305 Q320 5 320 20 V92 Q320 107 305 107 H95 Q80 107 80 92 Z" fill="#fff4b8" stroke="#333" stroke-width="2"/><path d="M125 107 L115 125 L145 107" fill="#fff4b8" stroke="#333" stroke-width="2"/><text x="200" y="38" text-anchor="middle" font-family="Arial" font-size="16">Our class picnic</text><text x="200" y="62" text-anchor="middle" font-family="Arial" font-size="16">is tomorrow!</text><circle cx="65" cy="245" r="12" fill="white" stroke="#333" stroke-width="2"/><text x="88" y="251" font-family="Arial" font-size="17">Tuesday</text><circle cx="65" cy="280" r="12" fill="white" stroke="#333" stroke-width="2"/><text x="88" y="286" font-family="Arial" font-size="17">Friday</text><circle cx="235" cy="245" r="12" fill="white" stroke="#333" stroke-width="2"/><text x="258" y="251" font-family="Arial" font-size="17">Saturday</text><circle cx="235" cy="280" r="12" fill="white" stroke="#333" stroke-width="2"/><text x="258" y="286" font-family="Arial" font-size="17">Sunday</text></svg>`;

describe("things covering each other in a model drawing", () => {
  it("finds the bubble over the face", () => {
    const p = svgOverlaps(COVERED)!;
    expect(p.length).toBeGreaterThan(0);
    expect(p[0]).toMatch(/filled path around \(200, 56\) covers most of an earlier circle around \(200, 48\)/);
  });

  it("accepts backgrounds and details drawn on bigger shapes, flags shapes over text, skips transforms", () => {
    const house = '<svg viewBox="0 0 200 200"><rect width="200" height="200" fill="white"/><rect x="40" y="80" width="120" height="100" fill="#fc8"/><rect x="60" y="100" width="30" height="30" fill="#9cf"/><text x="100" y="195" text-anchor="middle" font-size="12">house</text></svg>';
    expect(svgOverlaps(house)).toEqual([]);
    const overText = '<svg viewBox="0 0 200 100"><text x="20" y="50" font-size="16">Friday</text><rect x="10" y="30" width="80" height="30" fill="yellow"/></svg>';
    expect(svgOverlaps(overText)![0]).toContain('over the text "Friday"');
    expect(svgOverlaps('<svg viewBox="0 0 10 10"><g transform="scale(2)"><circle cx="2" cy="2" r="1" fill="red"/></g></svg>')).toBeNull();
  });
});

describe("speech figures drawn by the program", () => {
  const pen = { ink: "#222", accent: "#7c3aed", fill: "#f9a8d4", paper: "#fff", sw: 2, text: (x: number, y: number, s: string, size = 15, anchor = "middle") => `<text x="${x}" y="${y}" font-size="${size}" text-anchor="${anchor}">${s}</text>` };

  it("puts the bubble beside the head: nothing covers anything", () => {
    for (const text of ["Tomorrow is my birthday!", "今天是星期四，我们班的野餐在后天。", "I have 3 more stickers than you have, and Ben has 2 fewer than me."]) {
      const d = drawSpeech(visualSpecSchema.parse({ kind: "speech", speakers: [{ text, name: "Joy" }, { text: "OK" }], choices: ["Monday", "Tuesday", "Friday", "Sunday"] }) as never, pen);
      expect(svgOverlaps(`<svg viewBox="0 0 ${d.w} ${d.h}">${d.body}</svg>`), text).toEqual([]);
    }
    expect(wrapText("Our class picnic is tomorrow and we will bring fruit", 16, 120).length).toBeGreaterThan(2);
    expect(wrapText("今天是星期四我们班的野餐在后天", 16, 100).every((l) => [...l].length <= 7)).toBe(true);
  });

  it("describes what is said and the choices", () => {
    const v = buildVisual(visualSpecSchema.parse({ kind: "speech", speakers: [{ text: "Tomorrow is my birthday!", name: "Joy" }], choices: ["Monday", "Wednesday", "Thursday", "Sunday"] }));
    expect(v.source).toBe("program");
    expect(v.description).toBe('a child labelled "Joy" with a speech bubble beside the head saying "Tomorrow is my birthday!"; below, 4 answer choices each with an empty circle: Monday, Wednesday, Thursday, Sunday');
    expect(VISUAL_GUIDE).toContain('{"kind":"speech"');
    expect(VISUAL_GUIDE).toContain("nothing may cover anything else");
  });
});

// ── Generation ───────────────────────────────────────────────────────

type Msg = { role: string; content: string | Array<{ type: string; text?: string }> };
const textOf = (m: Msg) => (typeof m.content === "string" ? m.content : m.content.filter((p) => p.type === "text").map((p) => p.text).join(""));
let root: string;
let calls: Array<{ kind: string; system: string; user: string }>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bank-speech-"));
  process.env.BANK_STORE_PATH = root;
  process.env.LLM_API_KEY = "k";
  process.env.LLM_BASE_URL = "https://llm.test/v1";
  process.env.LLM_MODEL = "m";
  process.env.LLM_VISION_MODEL = "v";
  process.env.LLM_LOG_LEVEL = "silent";
  process.env.LLM_CACHE_ENABLED = "false";
  resetGlobalCache();
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: Msg[] };
      const sys = textOf(body.messages[0]);
      const user = textOf(body.messages[body.messages.length - 1]);
      const kind = sys.startsWith("You look at the figures") ? "template-visual" : sys.startsWith("You write new original") ? "generate" : sys.startsWith("You fix the figure specs") ? "repair" : sys.startsWith("You check a figure") ? "figure-check" : sys.startsWith("You solve math") ? "resolve" : sys.startsWith("You review generated") ? "judge" : sys.startsWith("You analyse a class") ? "profile" : "other";
      calls.push({ kind, system: sys, user });
      const reply = (c: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(c) } }] }), { status: 200 });
      switch (kind) {
        case "template-visual":
          return reply({ items: [{ n: 1, kind: "svg", description: "a child with a speech bubble; four answer choices with circles" }], style: { colour: "colour", accent: "#7c3aed", fill: "#f9a8d4", font: "rounded", stroke: "normal", frame: "none" } });
        case "generate":
          return reply({ questions: [{ stem: "Today is Thursday. Mia said, “Our class picnic is tomorrow!” What day is the class picnic?", type: "short_answer", answer: "Friday", figure: { kind: "svg", svg: COVERED, description: "A child below a speech bubble saying Our class picnic is tomorrow!; four choices Tuesday, Friday, Saturday, Sunday." } }] });
        case "figure-check":
          return reply({ ok: true, problems: "" });
        case "repair":
          return reply({ fixes: [{ n: 1, figure: { kind: "speech", speakers: [{ text: "Our class picnic is tomorrow!", name: "Mia" }], choices: ["Tuesday", "Friday", "Saturday", "Sunday"] } }] });
        case "judge":
          return reply({ scores: [{ n: 1, score: 5, reason: "ok" }] });
        case "profile":
          return reply({ summary: "Days of the week: tomorrow / yesterday.", answer_form: "a day", stem_structure: "Today is …; someone says …" });
        default:
          return reply({});
      }
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  _closeAllBanks();
  for (const v of ["BANK_STORE_PATH", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "LLM_VISION_MODEL", "LLM_LOG_LEVEL", "LLM_CACHE_ENABLED"]) delete process.env[v];
  fs.rmSync(root, { recursive: true, force: true });
});

describe("generating from the speech-bubble template", () => {
  it("rejects the covered drawing without asking the vision model and redraws it as a speech figure", async () => {
    const bank = createBank("local", { name: "Days", language: "en" });
    const page = saveAsset("local", bank.id, encodePng({ data: new Uint8Array(60 * 40 * 3).fill(230), width: 60, height: 40, channels: 3 }), "png");
    const [item] = addItems("local", bank.id, [
      { origin: "imported", fields: { stem: "Today is Tuesday.\nJoy said to her school friends:\nTomorrow is my birthday!\nWhat day is Joy\u2019s birthday?", type: "short_answer", answer: "Wednesday", knowledge_points: [], tags: [], images: [{ asset: page, caption: "other: a girl with a speech bubble" }] } },
    ]);
    const g = await generateFromTemplate({ owner: "local", bankId: bank.id, template: { item_ids: [item.id] }, count: 1 });
    const repair = calls.find((c) => c.kind === "repair")!;
    expect(repair.user).toMatch(/covers most of an earlier circle/);
    expect(repair.user).toContain('"speech" for someone saying something');
    // The program caught the overlap: the vision model was not asked about the covered drawing.
    expect(calls.filter((c) => c.kind === "figure-check").length).toBe(0);
    const c = g.candidates[0];
    expect(c.figure?.source).toBe("program");
    expect(c.figure?.spec).toMatchObject({ kind: "speech" });
    expect(c.checks.figure).toMatchObject({ ok: true });
  });
});
