import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildVisual, describeVisual, sanitizeSvg, visualSpecSchema, type FigureStyle } from "@/lib/figure/visual";
import { adoptCandidates, generateFromTemplate } from "@/lib/bank/generate";
import { encodePng, loadSharp } from "@/lib/bank/import/images";
import { _closeAllBanks, addItems, createBank, readAsset, saveAsset } from "@/lib/bank/store";
import { resetGlobalCache } from "@/lib/llm/cache";

// Questions generated from templates that have figures (scans / photos)
// come with a figure spec the program draws in the template's style; the
// re-solve sees an exact description of the drawn figure.

const STYLE: FigureStyle = { colour: "colour", accent: "#5b3fa8", fill: "#d9cff5", font: "rounded", stroke: "normal", frame: "dashed" };

describe("figure specs", () => {
  it("draws every kind and describes exactly what is drawn", () => {
    const clock = buildVisual(visualSpecSchema.parse({ kind: "clock", hour: 14, minute: 15 }), STYLE);
    expect(clock.svg).toMatch(/^<svg[^>]*viewBox/);
    expect(clock.description).toBe("an analogue clock showing 2:15");
    expect(clock.source).toBe("program");
    expect(clock.verified).toBe(true);

    const cards = visualSpecSchema.parse({
      kind: "cards",
      columns: 2,
      cards: [
        { label: "7 o'clock", figure: { kind: "clock", hour: 7, minute: 0 }, caption: "wake up", answer_box: true },
        { label: "noon", figure: { kind: "clock", hour: 12, minute: 0, digital: true }, answer_box: true },
      ],
    });
    expect(describeVisual(cards)).toBe('2 cards in 2 columns, in reading order: card 1: "7 o\'clock", an analogue clock showing 7:00, caption "wake up", an empty answer box; card 2: "noon", a digital clock showing 12:00, an empty answer box');
    expect(buildVisual(cards, STYLE).svg).toContain('stroke-dasharray="7 5"'); // dashed cut-out cards like the template

    const grid = visualSpecSchema.parse({ kind: "grid_shape", cols: 6, rows: 4, shaded: [[0, 0], [0, 1], [1, 0]] });
    expect(describeVisual(grid)).toMatch(/made of 3 squares \(its outline is 8 square sides long\)/);
    const bars = visualSpecSchema.parse({ kind: "bar_chart", categories: ["Red", "Blue"], values: [3, 7] });
    expect(describeVisual(bars)).toContain("Red = 3, Blue = 7");
    const picto = visualSpecSchema.parse({ kind: "pictograph", symbol: "star", key: 2, rows: [{ label: "Mia", symbols: 2.5 }] });
    expect(describeVisual(picto)).toContain("Mia has 2.5 symbols (= 5)");
    for (const raw of [
      { kind: "number_line", min: 0, max: 20, step: 1, label_every: 5, points: [{ value: 13, label: "P" }], hops: [{ from: 5, to: 8 }] },
      { kind: "table", headers: ["a", "b"], rows: [["1", 2]] },
      { kind: "fraction", shape: "circle", parts: 8, shaded: 3 },
      { kind: "groups", groups: [{ count: 4, symbol: "apple" }] },
    ]) {
      expect(buildVisual(visualSpecSchema.parse(raw), STYLE).svg).toMatch(/<\/svg>$/);
    }
  });

  it("checks geometry conditions and draws on paper", () => {
    const ok = buildVisual(visualSpecSchema.parse({ kind: "geometry", spec: { needed: true, constructions: [{ op: "rectangle", ids: ["A", "B", "C", "D"], width: 6, height: 4 }], claims: [{ type: "length", segment: ["A", "B"], value: 6 }] } }), STYLE);
    expect(ok.verified).toBe(true);
    expect(ok.svg).not.toMatch(/#cbd5e1/); // not the app's dark-theme strokes
    const bad = buildVisual(visualSpecSchema.parse({ kind: "geometry", spec: { needed: true, constructions: [{ op: "rectangle", ids: ["A", "B", "C", "D"], width: 6, height: 4 }], claims: [{ type: "length", segment: ["A", "B"], value: 9 }] } }), STYLE);
    expect(bad.verified).toBe(false);
    expect(bad.issues.length).toBeGreaterThan(0);
  });

  it("strips anything active from a model-drawn SVG", () => {
    const clean = sanitizeSvg('x <svg onload="alert(1)"><script>alert(2)</script><a href="https://evil"><rect fill="url(https://evil/x)"/></a><image href="https://e/x.png"/></svg> y')!;
    expect(clean).not.toMatch(/onload|script|https:|<image/);
    const built = buildVisual(visualSpecSchema.parse({ kind: "svg", svg: "<svg viewBox='0 0 10 10'><circle r='3'/></svg>", description: "a dot" }));
    expect(built).toMatchObject({ source: "model", verified: false, description: "a dot" });
  });
});

// ── Generation from a template with figures ──────────────────────────

type Msg = { role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> };
const textOf = (m: Msg) => (typeof m.content === "string" ? m.content : m.content.filter((p) => p.type === "text").map((p) => p.text).join(""));
const imagesOf = (m: Msg): number => (typeof m.content === "string" ? 0 : m.content.filter((p) => p.type === "image_url").length);

let root: string;
let calls: Array<{ kind: string; model: string; system: string; user: string; images: number }>;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bank-figgen-"));
  process.env.BANK_STORE_PATH = root;
  process.env.LLM_API_KEY = "k";
  process.env.LLM_BASE_URL = "https://llm.test/v1";
  process.env.LLM_MODEL = "text-model";
  process.env.LLM_VISION_MODEL = "vision-model";
  process.env.LLM_LOG_LEVEL = "silent";
  process.env.LLM_CACHE_ENABLED = "false";
  resetGlobalCache();
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { model: string; messages: Msg[] };
      const sys = textOf(body.messages[0]);
      const last = body.messages[body.messages.length - 1];
      const kind = sys.startsWith("You look at the figures")
        ? "template-visual"
        : sys.startsWith("You write new original")
          ? "generate"
          : sys.startsWith("You solve math")
            ? "resolve"
            : sys.startsWith("You review generated")
              ? "judge"
              : sys.startsWith("You check a figure")
                ? "figure-check"
                : sys.startsWith("You analyse a class")
                  ? "profile"
                  : "other";
      calls.push({ kind, model: body.model, system: sys, user: textOf(last), images: imagesOf(last) });
      const reply = (c: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(c) } }] }), { status: 200 });
      switch (kind) {
        case "template-visual":
          return reply({
            items: [{ n: 1, kind: "cards", description: "4 dashed cut-out cards; each has a time like '2 o'clock', an analogue clock showing it, a picture of an activity and an answer box." }],
            style: { colour: "colour", accent: "#5b3fa8", fill: "#d9cff5", font: "rounded", stroke: "normal", frame: "dashed" },
            layout: "a row of cards, each with a time label, a clock and an answer box",
          });
        case "generate":
          return reply({
            questions: [
              {
                stem: "Look at the clock. What time does it show?",
                type: "multiple_choice",
                options: ["2:15", "3:10", "2:45", "3:15"],
                answer: "A",
                solution: "The short hand is just past 2, the long hand on 3.",
                figure: { kind: "clock", hour: 2, minute: 15 },
              },
              {
                stem: "The picture shows a cake cut into equal pieces. How many pieces are there?",
                type: "multiple_choice",
                options: ["4", "6", "8", "10"],
                answer: "B",
                figure: { kind: "svg", svg: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='40' fill='none' stroke='black'/></svg>", description: "a round cake cut into 6 equal pieces" },
              },
              { stem: "Look at the number line. Which number is at P?", type: "multiple_choice", options: ["11", "12", "13", "14"], answer: "C", figure: { kind: "number_line", min: 0, max: 20 } },
              { stem: "Look at the clock below. What time is it?", type: "multiple_choice", options: ["1:00", "2:00", "3:00", "4:00"], answer: "B" },
            ],
          });
        case "resolve":
          return reply({ answers: [{ n: 1, answer: "A" }, { n: 2, answer: "B" }, { n: 3, answer: "C" }, { n: 4, answer: "B" }] });
        case "judge":
          return reply({ scores: [1, 2, 3, 4].map((n) => ({ n, score: 5, reason: "same type" })) });
        case "figure-check":
          return reply({ ok: false, problems: "the cake has no cuts" });
        case "profile":
          return reply({ summary: "Reading analogue clocks to the hour.", answer_form: "one option letter", stem_structure: "Look at the clock." });
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

function bankWithScannedTemplate() {
  const bank = createBank("local", { name: "Clocks", language: "en" });
  const page = saveAsset("local", bank.id, encodePng({ data: new Uint8Array(60 * 40 * 3).fill(230), width: 60, height: 40, channels: 3 }), "png");
  const [item] = addItems("local", bank.id, [
    {
      origin: "imported",
      fields: {
        stem: "Look at the cards. Which activity happens second in the astronaut's day?",
        type: "multiple_choice",
        options: ["eat lunch", "fix the rocket", "wake up", "read a book"],
        answer: "B",
        knowledge_points: ["Time"],
        tags: [],
        images: [{ asset: page }],
        source: { page: 1, page_image: page },
      },
    },
  ]);
  return { bank, item };
}

describe("generating from a template with figures", () => {
  it("reads the template's figures, draws new figures in its style and checks them", async () => {
    const { bank, item } = bankWithScannedTemplate();
    const g = await generateFromTemplate({ owner: "local", bankId: bank.id, template: { item_ids: [item.id] }, count: 4 });

    // The vision model saw the template's figure; the writer got its description and the figure guide.
    const tv = calls.find((c) => c.kind === "template-visual")!;
    expect(tv.model).toBe("vision-model");
    expect(tv.images).toBe(1);
    const gen = calls.find((c) => c.kind === "generate")!;
    expect(gen.model).toBe("text-model");
    expect(gen.user).toContain("Figure of example 1: 4 dashed cut-out cards");
    expect(gen.user).toMatch(/Figure: these questions come with a figure \(kinds: cards\)/);
    expect(gen.system).toContain('{"kind":"clock"');
    // The independent solver saw the exact figure description.
    expect(calls.find((c) => c.kind === "resolve")!.user).toContain("[Figure: an analogue clock showing 2:15]");

    const byStem = (s: string) => g.candidates.find((c) => c.stem.startsWith(s))!;
    const clock = byStem("Look at the clock. What");
    expect(clock.figure).toMatchObject({ source: "program", verified: true, description: "an analogue clock showing 2:15" });
    expect(clock.figure!.svg).toContain("#5b3fa8"); // the template's accent colour
    expect(clock.checks.figure).toMatchObject({ ok: true });
    expect(clock.passed).toBe(true);

    // Model-drawn SVG: re-read by the vision model, which found a problem.
    const cake = byStem("The picture shows a cake");
    expect(cake.figure?.source).toBe("model");
    const sharp = await loadSharp();
    if (sharp) {
      expect(cake.checks.figure).toMatchObject({ ok: false });
      expect(cake.checks.figure!.detail).toMatch(/no cuts/);
      expect(calls.find((c) => c.kind === "figure-check")!.images).toBe(1);
    }
    // Unusable spec and missing figure fail the figure check.
    expect(byStem("Look at the number line").checks.figure).toMatchObject({ ok: false });
    expect(byStem("Look at the number line").checks.figure!.detail).toMatch(/invalid figure spec|图形描述无效/);
    expect(byStem("Look at the clock below").checks.figure).toMatchObject({ ok: false });

    // Adopting stores the figure as the item's image.
    const [adopted] = await adoptCandidates("local", bank.id, g.id, [clock.id]);
    expect(adopted.images).toHaveLength(1);
    expect(readAsset("local", bank.id, adopted.images[0].asset).length).toBeGreaterThan(100);
  });

  it("without template images there is no vision call and no figure check", async () => {
    const bank = createBank("local", { name: "Words", language: "en" });
    const [item] = addItems("local", bank.id, [{ origin: "imported", fields: { stem: "Tom has 12 apples and gives away 5. How many are left?", type: "numeric", answer: "7", knowledge_points: [], tags: [], images: [] } }]);
    const g = await generateFromTemplate({ owner: "local", bankId: bank.id, template: { item_ids: [item.id] }, count: 1 });
    expect(calls.some((c) => c.kind === "template-visual")).toBe(false);
    expect(calls.find((c) => c.kind === "generate")!.system).not.toContain('{"kind":"clock"');
    expect(g.candidates.every((c) => !c.figure || c.checks.figure)).toBe(true);
  });
});
