import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commitBatch, parseImport } from "@/lib/bank/import";
import { encodePng } from "@/lib/bank/import/images";
import { generateFromTemplate, templateHints } from "@/lib/bank/generate";
import { _closeAllBanks, addItems, createBank, saveAsset, updateItem } from "@/lib/bank/store";
import { resetGlobalCache } from "@/lib/llm/cache";

// The teacher's note given when importing ("模板提示") guides reading the
// scans, is kept on every question, and guides generation from them.

vi.mock("next-auth", () => ({ getServerSession: async () => null }));

const HINT = "Year 1 time-ordering task: each card has a clock and an activity; new questions keep 4 cards and o'clock times.";
type Msg = { role: string; content: string | Array<{ type: string; text?: string }> };
const textOf = (m: Msg) => (typeof m.content === "string" ? m.content : m.content.filter((p) => p.type === "text").map((p) => p.text).join(""));

let root: string;
let calls: Array<{ kind: string; system: string; user: string }>;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bank-hints-"));
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
      const kind = sys.startsWith("You transcribe")
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
          return reply({ text: "1. Look at the cards. Which activity happens first?\nA. lunch\nB. breakfast\nC. dinner\nD. sleep", figures: [] });
        case "template-visual":
          return reply({ items: [{ n: 1, kind: "cards", description: "4 cards with clocks" }], style: {}, layout: "a row of cards" });
        case "generate":
          return reply({ questions: [{ stem: "Look at the cards. Which activity happens last?", type: "multiple_choice", options: ["a", "b", "c", "d"], answer: "D", figure: { kind: "cards", columns: 4, cards: [1, 2, 3, 4].map((h) => ({ label: `${h} o'clock`, figure: { kind: "clock", hour: h, minute: 0 }, caption: `job ${h}` })) } }] });
        case "resolve":
          return reply({ answers: [{ n: 1, answer: "D" }] });
        case "judge":
          return reply({ scores: [{ n: 1, score: 5, reason: "ok" }] });
        case "profile":
          return reply({ summary: "Ordering events by clock times.", answer_form: "one option letter", stem_structure: "Look at the cards." });
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

const png = () => encodePng({ data: new Uint8Array(60 * 80 * 3).fill(240), width: 60, height: 80, channels: 3 });

describe("the teacher's note on an import", () => {
  it("guides reading the scan and is kept on every question", async () => {
    const bank = createBank("local", { name: "Y1", language: "en" });
    const batch = await parseImport({ owner: "local", bankId: bank.id, fileName: "p1.png", data: png(), hint: `  ${HINT}  `, useModel: false, classify: false });
    expect(calls.find((c) => c.kind === "ocr")!.user).toContain(`<<<${HINT}>>>`);
    expect(batch.hint).toBe(HINT);
    expect(batch.drafts[0].template_hint).toBe(HINT);
    const { items } = commitBatch("local", bank.id, batch.id, { rightsConfirmed: true });
    expect(items[0].template_hint).toBe(HINT);
    // Editable later.
    expect(updateItem("local", bank.id, items[0].id, { template_hint: "keep half-past times too" }).template_hint).toBe("keep half-past times too");
  });

  it("is sent through the import route", async () => {
    const { POST } = await import("@/app/api/banks/[id]/imports/route");
    const bank = createBank("local", { name: "Y1", language: "en" });
    const fd = new FormData();
    fd.append("file", new File([new Uint8Array(png())], "p1.png"));
    fd.append("hint", HINT);
    fd.append("use_model", "false");
    fd.append("classify", "false");
    const res = await POST(new Request(`http://t/api/banks/${bank.id}/imports`, { method: "POST", body: fd }), { params: Promise.resolve({ id: bank.id }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { batch: { hint?: string } }).batch.hint).toBe(HINT);
  });

  it("an import without a note adds nothing", async () => {
    const bank = createBank("local", { name: "Y1", language: "en" });
    const batch = await parseImport({ owner: "local", bankId: bank.id, fileName: "p1.png", data: png(), hint: "  ", useModel: false, classify: false });
    expect(batch.hint).toBeUndefined();
    expect(batch.drafts[0].template_hint).toBeUndefined();
    expect(calls.find((c) => c.kind === "ocr")!.user).not.toContain("<<<");
  });
});

describe("generation from questions with notes", () => {
  it("gives the notes to the vision model, the writer and the reviewer", async () => {
    const bank = createBank("local", { name: "Y1", language: "en" });
    const page = saveAsset("local", bank.id, png(), "png");
    const [item] = addItems("local", bank.id, [
      { origin: "imported", fields: { stem: "Look at the cards. Which activity happens first?", type: "multiple_choice", options: ["lunch", "breakfast", "dinner", "sleep"], answer: "B", knowledge_points: [], tags: [], images: [{ asset: page }], template_hint: HINT } },
    ]);
    await generateFromTemplate({ owner: "local", bankId: bank.id, template: { item_ids: [item.id] }, count: 1 });
    expect(calls.find((c) => c.kind === "template-visual")!.user).toContain(HINT);
    const gen = calls.find((c) => c.kind === "generate")!;
    expect(gen.user).toContain("TEACHER'S NOTES on these template questions");
    expect(gen.user).toContain(HINT);
    expect(calls.find((c) => c.kind === "judge")!.user).toContain(HINT);
    // The independent solver does not need them.
    expect(calls.find((c) => c.kind === "resolve")!.user).not.toContain(HINT);
  });

  it("collects distinct notes, at most three", () => {
    expect(templateHints([{ template_hint: "a" }, { template_hint: " a " }, {}, { template_hint: "b" }, { template_hint: "c" }, { template_hint: "d" }])).toEqual(["a", "b", "c"]);
  });
});
