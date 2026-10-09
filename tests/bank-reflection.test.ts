import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reflectionAnswer, shapeKey, transformCells } from "@/lib/figure/reflection";
import { buildVisual, VISUAL_GUIDE, visualSpecSchema } from "@/lib/figure/visual";
import { generateFromTemplate, reflectionCheck } from "@/lib/bank/generate";
import { encodePng } from "@/lib/bank/import/images";
import { _closeAllBanks, addItems, createBank, saveAsset } from "@/lib/bank/store";
import { resetGlobalCache } from "@/lib/llm/cache";

// "The shape shown in the diagram is reflected in line l and then in line m. Move two shapes into the
// correct position on the diagram that represent these reflections."

/** A P-pentomino: no line of symmetry. */
const STEP: Array<[number, number]> = [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0]];
const SPEC = { kind: "reflection", grid: 3, cells: STEP, cards: ["flip_h", "rotate_90", "flip_v", "rotate_180"] };

describe("reflection in two lines", () => {
  it("knows which card goes where", () => {
    expect(shapeKey(transformCells(STEP, 3, "rotate_180"))).toBe(shapeKey(transformCells(transformCells(STEP, 3, "flip_h"), 3, "flip_v")));
    const a = reflectionAnswer(visualSpecSchema.parse(SPEC) as never);
    expect(a).toMatchObject({ afterFirst: "top-right", afterBoth: "bottom-right", firstCards: [1], bothCards: [4], symmetric: false, duplicateCards: [] });
    // l horizontal: the first image goes to the bottom left
    expect(reflectionAnswer(visualSpecSchema.parse({ ...SPEC, first_line: "horizontal" }) as never)).toMatchObject({ afterFirst: "bottom-left", firstCards: [3] });
    // a symmetric shape, and two cards that look the same
    expect(reflectionAnswer(visualSpecSchema.parse({ ...SPEC, cells: [[0, 0], [0, 1], [1, 0], [1, 1]] }) as never).symmetric).toBe(true);
    const L = [[0, 0], [1, 0], [2, 0], [2, 1], [3, 0], [3, 1], [3, 2], [3, 3]];
    expect(reflectionAnswer(visualSpecSchema.parse({ ...SPEC, grid: 4, cells: L }) as never).duplicateCards).toEqual([3]);
  });

  it("draws the lines, the shape, three target boxes and the cards", () => {
    const v = buildVisual(visualSpecSchema.parse(SPEC));
    expect(v.source).toBe("program");
    expect(v.svg.match(/stroke-dasharray="8 5"/g)?.length).toBe(2);
    expect(v.svg.match(/rx="3" fill="#ffffff" stroke="#1f1f1f"/g)?.length).toBe(3);
    expect(v.description).toContain('a vertical dashed line labelled "l" and a horizontal dashed line labelled "m" cross');
    expect(v.description).toContain("card 1 = the shape reflected left–right, card 2 = the shape turned a quarter turn clockwise, card 3 = the shape reflected top–bottom, card 4 = the shape turned half a turn");
    expect(VISUAL_GUIDE).toContain('{"kind":"reflection"');
  });
});

describe("the program checks the cards in the answer", () => {
  const q = (answer: string, spec: unknown = SPEC) => {
    const v = buildVisual(visualSpecSchema.parse(spec));
    return { type: "other" as const, answer, figure: { spec, svg: v.svg, description: v.description, source: "program" as const, verified: true } };
  };
  it("reads the generated answer wording", () => {
    expect(reflectionCheck(q("Card 1 in the upper-right target; Card 4 in the lower-right target."))).toEqual({ mismatch: false, detail: expect.stringMatching(/card 1 → top-right, card 4 → bottom-right|卡片 1 放右上，卡片 4 放右下/) });
    expect(reflectionCheck(q("Card 4 goes bottom right and card 1 top right"))!.mismatch).toBe(false);
    expect(reflectionCheck(q("1 then 4"))!.mismatch).toBe(false);
    expect(reflectionCheck(q("卡片1放右上，卡片4放右下"))!.mismatch).toBe(false);
  });
  it("fails the wrong cards, a symmetric shape and look-alike cards", () => {
    expect(reflectionCheck(q("Card 1 in the upper-right target; Card 3 in the lower-right target."))!.mismatch).toBe(true);
    expect(reflectionCheck(q("Card 1 then card 4", { ...SPEC, cells: [[0, 0], [0, 1], [1, 0], [1, 1]] }))!.detail).toMatch(/symmetric|对称/);
    expect(reflectionCheck(q("Card 1 then card 4", { ...SPEC, grid: 4, cells: [[0, 0], [1, 0], [2, 0], [2, 1], [3, 0], [3, 1], [3, 2], [3, 3]] }))!.detail).toMatch(/look the same|一样/);
    expect(reflectionCheck({ type: "other", answer: "x", figure: undefined })).toBeNull();
  });
  it("a model-drawn part is allowed in a group, and makes the figure model-drawn", () => {
    const g = buildVisual(visualSpecSchema.parse({ kind: "group", parts: [SPEC, { kind: "svg", svg: "<svg viewBox='0 0 100 40' xmlns='http://www.w3.org/2000/svg'><rect x='5' y='5' width='90' height='30' fill='none' stroke='black'/></svg>", description: "an empty answer strip" }] }));
    expect(g.source).toBe("model");
    expect(g.description).toContain("area 2: an empty answer strip");
  });
});

// ── Generation ───────────────────────────────────────────────────────

type Msg = { role: string; content: string | Array<{ type: string; text?: string }> };
const textOf = (m: Msg) => (typeof m.content === "string" ? m.content : m.content.filter((p) => p.type === "text").map((p) => p.text).join(""));
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bank-reflection-"));
  process.env.BANK_STORE_PATH = root;
  process.env.LLM_API_KEY = "k";
  process.env.LLM_BASE_URL = "https://llm.test/v1";
  process.env.LLM_MODEL = "m";
  process.env.LLM_LOG_LEVEL = "silent";
  process.env.LLM_CACHE_ENABLED = "false";
  resetGlobalCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: Msg[] };
      const sys = textOf(body.messages[0]);
      const reply = (c: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(c) } }] }), { status: 200 });
      if (sys.startsWith("You write new original"))
        return reply({
          questions: [
            { stem: "The shape shown is reflected first in line $l$ and then in line $m$. Move two of the shape cards into the correct target positions.", type: "other", answer: "Card 1 in the upper-right target; Card 4 in the lower-right target.", figure: SPEC },
            { stem: "The polygon is reflected in line $l$ and then the image in line $m$. Place two cards in the target boxes.", type: "other", answer: "Card 1 in the upper-right target; Card 3 in the lower-right target.", figure: SPEC },
          ],
        });
      if (sys.startsWith("You review generated")) return reply({ scores: [1, 2].map((n) => ({ n, score: 5, reason: "ok" })) });
      if (sys.startsWith("You analyse a class")) return reply({ summary: "Two reflections; place cards.", answer_form: "two cards and their places", stem_structure: "Reflect in l then m." });
      return reply({});
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  _closeAllBanks();
  for (const v of ["BANK_STORE_PATH", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "LLM_LOG_LEVEL", "LLM_CACHE_ENABLED"]) delete process.env[v];
  fs.rmSync(root, { recursive: true, force: true });
});

describe("generating from the reflection template", () => {
  it("checks the free-text answers by the program", async () => {
    const bank = createBank("local", { name: "Reflections", language: "en" });
    const page = saveAsset("local", bank.id, encodePng({ data: new Uint8Array(60 * 40 * 3).fill(230), width: 60, height: 40, channels: 3 }), "png");
    const [item] = addItems("local", bank.id, [{ origin: "imported", fields: { stem: "The shape shown in the diagram is reflected in line $l$ and then in line $m$.\nMove two shapes into the correct position on the diagram that represent these reflections.", type: "other", knowledge_points: [], tags: [], images: [{ asset: page, caption: "reflection: a stepped shape top-left, lines l and m" }, { asset: page, caption: "cards: four shape cards" }] } }]);
    const g = await generateFromTemplate({ owner: "local", bankId: bank.id, template: { item_ids: [item.id] }, count: 2 });
    const right = g.candidates.find((c) => c.answer.includes("Card 4"))!;
    expect(right.checks.answer).toMatchObject({ ok: true });
    expect(right.checks.answer!.skipped).toBeFalsy();
    expect(right.checks.figure).toMatchObject({ ok: true });
    const wrong = g.candidates.find((c) => c.answer.includes("Card 3"))!;
    expect(wrong.checks.answer).toMatchObject({ ok: false });
    expect(wrong.passed).toBe(false);
  });
});
