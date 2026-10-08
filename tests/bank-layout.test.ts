import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildVisual, specNodes, VISUAL_GUIDE, visualSpecSchema } from "@/lib/figure/visual";
import { generateFromTemplate, selectionCheck } from "@/lib/bank/generate";
import { encodePng } from "@/lib/bank/import/images";
import { _closeAllBanks, addItems, createBank, saveAsset } from "@/lib/bank/store";
import { resetGlobalCache } from "@/lib/llm/cache";

// The lunch template: priced item cards, then the answer choices as a vertical list with checkboxes
// (two figure areas). Generated copies of the template's wording are reworded before the checks.

const LUNCH = {
  kind: "group",
  parts: [
    { kind: "cards", columns: 2, cards: [{ label: "$1.50", icon: "circle", caption: "orange juice" }, { label: "$2.50", icon: "square", caption: "salad sandwich" }, { label: "$2.00", icon: "flower", caption: "bun" }, { label: "50c", icon: "apple", caption: "apple" }] },
    { kind: "cards", columns: 1, cards: [{ checkbox: true, caption: "salad sandwich" }, { checkbox: true, caption: "orange juice" }, { checkbox: true, caption: "bun" }, { checkbox: true, caption: "apple" }] },
  ],
};

describe("figure areas and choice cards", () => {
  it("draws the priced cards and the checkbox choices as two areas, and describes both", () => {
    const v = buildVisual(visualSpecSchema.parse(LUNCH));
    expect(v.source).toBe("program");
    expect(v.svg.match(/width="22" height="22" rx="3"/g)?.length).toBe(4); // four checkboxes
    expect(v.description).toMatch(/^2 figure areas one under another: area 1: 4 cards in 2 columns/);
    expect(v.description).toContain('card 1: "$1.50", a circle icon, caption "orange juice"');
    expect(v.description).toContain('area 2: 4 cards in 1 column, in reading order: card 1: an empty checkbox on the left, caption "salad sandwich"');
    expect(specNodes(visualSpecSchema.parse(LUNCH)).map((n) => n.kind)).toEqual(["group", "cards", "cards"]);
    expect(VISUAL_GUIDE).toContain('{"kind":"group"');
    expect(VISUAL_GUIDE).toContain('"checkbox"?:bool');
    expect(visualSpecSchema.safeParse({ kind: "group", parts: [LUNCH.parts[0]] }).success).toBe(false); // at least two areas
  });

  it("reads the prices from the cards in a group", () => {
    const v = buildVisual(visualSpecSchema.parse(LUNCH));
    const q = { stem: "Sarah spent exactly $5 buying some of these items for her lunch.\nSelect all the items she bought for lunch.", type: "multiple_choice" as const, options: ["salad sandwich", "orange juice", "bun", "apple"], answer: "A, C, D", figure: { spec: LUNCH, svg: v.svg, description: v.description, source: "program" as const, verified: true } };
    expect(selectionCheck(q)).toEqual({ mismatch: false, detail: expect.stringContaining("A + C + D") });
  });
});

// ── Rewording copies of the template ────────────────────────────────

type Msg = { role: string; content: string | Array<{ type: string; text?: string }> };
const textOf = (m: Msg) => (typeof m.content === "string" ? m.content : m.content.filter((p) => p.type === "text").map((p) => p.text).join(""));
let root: string;
let calls: Array<{ kind: string; system: string; user: string }>;
const TEMPLATE = "Sarah spent exactly $5 buying some of these items for her lunch.\n\nSelect all the items she bought for lunch.";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bank-layout-"));
  process.env.BANK_STORE_PATH = root;
  process.env.LLM_API_KEY = "k";
  process.env.LLM_BASE_URL = "https://llm.test/v1";
  process.env.LLM_MODEL = "m";
  process.env.LLM_LOG_LEVEL = "silent";
  process.env.LLM_CACHE_ENABLED = "false";
  resetGlobalCache();
  calls = [];
  const fig = (items: Array<[string, string]>) => ({
    kind: "group",
    parts: [
      { kind: "cards", columns: 2, cards: items.map(([n, p]) => ({ label: p, icon: "circle", caption: n })) },
      { kind: "cards", columns: 1, cards: items.map(([n]) => ({ checkbox: true, caption: n })) },
    ],
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: Msg[] };
      const sys = textOf(body.messages[0]);
      const user = textOf(body.messages[body.messages.length - 1]);
      const kind = sys.startsWith("You write new original") ? "generate" : sys.startsWith("You reword generated") ? "reword" : sys.startsWith("You solve math") ? "resolve" : sys.startsWith("You review generated") ? "judge" : sys.startsWith("You analyse a class") ? "profile" : "other";
      calls.push({ kind, system: sys, user });
      const reply = (c: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(c) } }] }), { status: 200 });
      switch (kind) {
        case "generate":
          return reply({
            questions: [
              { stem: "Mia spent exactly $5 buying some of these items for her lunch.\n\nSelect all the items she bought for lunch.", type: "multiple_choice", options: ["Tuna wrap", "Fruit cup", "Yoghurt", "Lemonade"], answer: "A, B, C", figure: fig([["Tuna wrap", "$1.00"], ["Fruit cup", "$1.50"], ["Yoghurt", "$2.50"], ["Lemonade", "$3.00"]]) },
              { stem: "Noah spent exactly $5 buying some of these items for his lunch.\n\nSelect all the items he bought for lunch.", type: "multiple_choice", options: ["Muffin", "Milk", "Cheese roll", "Iced tea"], answer: "A, B, D", figure: fig([["Muffin", "50c"], ["Milk", "$1.50"], ["Cheese roll", "$2.25"], ["Iced tea", "$3.00"]]) },
            ],
          });
        case "reword":
          return reply({
            stems: [
              { n: 1, stem: "At the school canteen, Mia's lunch cost her exactly $5.\n\nTick every item that Mia chose." },
              // changes the amount: must be ignored
              { n: 2, stem: "Noah paid $6 at the tuck shop. Tick every item he picked." },
            ],
          });
        case "resolve":
          return reply({ answers: [{ n: 1, answer: "A, B, C" }, { n: 2, answer: "A, B, D" }] });
        case "judge":
          return reply({ scores: [1, 2].map((n) => ({ n, score: 5, reason: "ok" })) });
        case "profile":
          return reply({ summary: "Choose the items whose prices add to a total.", answer_form: "all correct option letters", stem_structure: "A total, then select all." });
        default:
          return reply({});
      }
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  _closeAllBanks();
  for (const v of ["BANK_STORE_PATH", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "LLM_LOG_LEVEL", "LLM_CACHE_ENABLED"]) delete process.env[v];
  fs.rmSync(root, { recursive: true, force: true });
});

describe("stems that copy the template's wording", () => {
  it("are reworded once, keeping every number; a rewording that changes a number is ignored", async () => {
    const bank = createBank("local", { name: "Lunch", language: "en" });
    const page = saveAsset("local", bank.id, encodePng({ data: new Uint8Array(60 * 40 * 3).fill(230), width: 60, height: 40, channels: 3 }), "png");
    // two images, as imported from the scan: the priced cards and the choices with checkboxes
    const [item] = addItems("local", bank.id, [{ origin: "imported", fields: { stem: TEMPLATE, type: "multiple_choice", options: ["salad sandwich", "orange juice", "bun", "apple"], answer: "A, C, D", knowledge_points: [], tags: [], images: [{ asset: page, caption: "cards: four priced food cards" }, { asset: page, caption: "cards: four choices with checkboxes" }] } }]);
    const g = await generateFromTemplate({ owner: "local", bankId: bank.id, template: { item_ids: [item.id] }, count: 2 });
    expect(calls.find((c) => c.kind === "generate")!.user).toContain('AREAS: each example has 2 separate figure areas');
    expect(g.candidates[0].figure?.spec).toMatchObject({ kind: "group" });
    const reword = calls.find((c) => c.kind === "reword")!;
    expect(reword.user).toContain("Too close");
    expect(reword.user).toContain("Sarah spent exactly $5");

    const mia = g.candidates.find((c) => c.stem.includes("Mia"))!;
    expect(mia.stem).toBe("At the school canteen, Mia's lunch cost her exactly $5.\n\nTick every item that Mia chose.");
    expect(mia.checks.novelty).toMatchObject({ ok: true });
    expect(mia.answer).toBe("A, B, C");
    expect(mia.checks.answer).toMatchObject({ ok: true });

    const noah = g.candidates.find((c) => c.stem.includes("Noah"))!;
    expect(noah.stem).toContain("Noah spent exactly $5"); // the $6 rewording was rejected
    expect(noah.checks.novelty).toMatchObject({ ok: false });
  });
});
