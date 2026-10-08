import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commitBatch, parseImport } from "@/lib/bank/import";
import { encodePng } from "@/lib/bank/import/images";
import { generateFromTemplate, templateHints } from "@/lib/bank/generate";
import { _closeAllBanks, addItems, createBank, saveAsset, updateItem } from "@/lib/bank/store";
import { resetGlobalCache } from "@/lib/llm/cache";

// Reading a scan: the vision model surveys the page, transcribes it, and
// analyses each question as a template (task, what to keep, what each figure
// shows). That analysis is stored as the question's template_hint and the
// figure captions, and guides generation from these questions.

vi.mock("next-auth", () => ({ getServerSession: async () => null }));

const TASK = "Order the 8 time cards of the astronaut's day from 1 to 8, then find the hours between the 2nd and 4th card.";
const NOTE = "Keep 8 cards in two rows, each with an o'clock time label and an analogue clock; the answer is a number of hours.";
const SHOWS = "8 cards: 2 o'clock, 11 o'clock, 9 o'clock, 1 o'clock, 4 o'clock, 8 o'clock, 6 o'clock, 9 o'clock — each with an analogue clock showing that hour";

type Msg = { role: string; content: string | Array<{ type: string; text?: string }> };
const textOf = (m: Msg) => (typeof m.content === "string" ? m.content : m.content.filter((p) => p.type === "text").map((p) => p.text).join(""));

let root: string;
let calls: Array<{ kind: string; system: string; user: string }>;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bank-notes-"));
  process.env.BANK_STORE_PATH = root;
  process.env.LLM_API_KEY = "k";
  process.env.LLM_BASE_URL = "https://llm.test/v1";
  process.env.LLM_MODEL = "m";
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
      const kind = sys.startsWith("You read pages")
        ? "ocr"
        : sys.startsWith("You look at the figures")
          ? "template-visual"
          : sys.startsWith("You write new original")
            ? "generate"
            : sys.startsWith("You solve math")
              ? "resolve"
              : sys.startsWith("You review generated")
                ? "judge"
                : sys.startsWith("You analyse a class")
                  ? "profile"
                  : "other";
      calls.push({ kind, system: sys, user });
      const reply = (c: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(c) } }] }), { status: 200 });
      switch (kind) {
        case "ocr":
          return reply({
            layout: "Banner and title (decoration), instructions, 8 cut-out cards in 2 rows, a final question with an answer box.",
            text: "1. To complete this challenge, order the time sequence cards of an astronaut's day. Write the numbers 1 – 8 in the boxes.\nHow many hours are between the second and fourth correctly sequenced image?",
            figures: [{ question: "1", box: [0.08, 0.4, 0.95, 0.78], kind: "cards", shows: SHOWS }],
            questions: [{ label: "1", task: TASK, template_note: NOTE }],
          });
        case "template-visual":
          return reply({ items: [{ n: 1, kind: "cards", description: "8 cards with clocks" }], style: {}, layout: "two rows of cards" });
        case "generate":
          return reply({ questions: [{ stem: "Order the cards. How many hours are between the first and third card?", type: "numeric", answer: "3", figure: { kind: "cards", columns: 4, cards: [7, 8, 10, 12].map((h) => ({ label: `${h} o'clock`, figure: { kind: "clock", hour: h, minute: 0 }, answer_box: true })) } }] });
        case "resolve":
          return reply({ answers: [{ n: 1, answer: "3" }] });
        case "judge":
          return reply({ scores: [{ n: 1, score: 5, reason: "ok" }] });
        case "profile":
          return reply({ summary: "Ordering events by o'clock times.", answer_form: "a number of hours", stem_structure: "Order the cards, then a question." });
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

const png = () => encodePng({ data: new Uint8Array(200 * 260 * 3).fill(240), width: 200, height: 260, channels: 3 });

describe("reading a scan as a template", () => {
  it("prompts the model to survey, transcribe and analyse, and keeps the analysis", async () => {
    const bank = createBank("local", { name: "Y1", language: "en" });
    const batch = await parseImport({ owner: "local", bankId: bank.id, fileName: "page4.png", data: png(), useModel: false, classify: false });
    const ocr = calls.find((c) => c.kind === "ocr")!;
    // The procedure the model is given.
    expect(ocr.system).toContain("STEP 1 — Survey the page before transcribing");
    expect(ocr.system).toContain("the SHORT hand gives the hour and the LONG hand the minutes");
    expect(ocr.system).toContain("A worksheet task without printed question numbers");
    expect(ocr.system).toContain('"template_note"');

    const d = batch.drafts[0];
    expect(d.template_hint).toBe(`${TASK}\n${NOTE}\n图（cards）：${SHOWS}`.slice(0, 1000));
    // The figure caption says what the figure shows.
    expect(d.images[0].caption).toBe(`cards: ${SHOWS}`.slice(0, 200));
    // Kept on commit and editable.
    const { items } = commitBatch("local", bank.id, batch.id, { rightsConfirmed: true });
    expect(items[0].template_hint).toContain(NOTE);
    expect(updateItem("local", bank.id, items[0].id, { template_hint: "keep half-past times too" }).template_hint).toBe("keep half-past times too");
  });

  it("the import route no longer takes a user note", async () => {
    const { POST } = await import("@/app/api/banks/[id]/imports/route");
    const bank = createBank("local", { name: "Y1", language: "en" });
    const fd = new FormData();
    fd.append("file", new File([new Uint8Array(png())], "p1.png"));
    fd.append("hint", "ignored");
    fd.append("use_model", "false");
    fd.append("classify", "false");
    const res = await POST(new Request(`http://t/api/banks/${bank.id}/imports`, { method: "POST", body: fd }), { params: Promise.resolve({ id: bank.id }) });
    expect(res.status).toBe(200);
    expect(calls.find((c) => c.kind === "ocr")!.user).not.toContain("ignored");
  });
});

describe("generation from analysed questions", () => {
  it("gives the template notes to the vision model, the writer and the reviewer", async () => {
    const bank = createBank("local", { name: "Y1", language: "en" });
    const page = saveAsset("local", bank.id, png(), "png");
    const [item] = addItems("local", bank.id, [
      { origin: "imported", fields: { stem: "Order the time cards. How many hours are between the second and fourth card?", type: "numeric", answer: "4", knowledge_points: [], tags: [], images: [{ asset: page }], template_hint: NOTE } },
    ]);
    await generateFromTemplate({ owner: "local", bankId: bank.id, template: { item_ids: [item.id] }, count: 1 });
    expect(calls.find((c) => c.kind === "template-visual")!.user).toContain(NOTE);
    const gen = calls.find((c) => c.kind === "generate")!;
    expect(gen.user).toContain("TEMPLATE NOTES — how these template questions work");
    expect(gen.user).toContain(NOTE);
    expect(calls.find((c) => c.kind === "judge")!.user).toContain(NOTE);
    expect(calls.find((c) => c.kind === "resolve")!.user).not.toContain(NOTE);
  });

  it("collects distinct notes, at most three", () => {
    expect(templateHints([{ template_hint: "a" }, { template_hint: " a " }, {}, { template_hint: "b" }, { template_hint: "c" }, { template_hint: "d" }])).toEqual(["a", "b", "c"]);
  });
});
