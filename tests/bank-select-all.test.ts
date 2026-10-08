import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerLetters, generateFromTemplate, isSelectAll, selectionCheck, templateTables } from "@/lib/bank/generate";
import { encodePng } from "@/lib/bank/import/images";
import { _closeAllBanks, addItems, createBank, getGeneration, saveAsset } from "@/lib/bank/store";
import { resetGlobalCache } from "@/lib/llm/cache";

// "Select all the items she bought": several options are correct; the answer is a set of letters,
// and for "exactly $5" questions the program checks that exactly one set of options makes the total.

describe("select-all answers", () => {
  it("recognises select-all questions and parses letter sets", () => {
    expect(isSelectAll("Sarah spent exactly $5 buying some of these items.\nSelect all the items she bought for lunch.")).toBe(true);
    expect(isSelectAll("下面哪几样东西加起来正好是 5 元？选出所有正确答案。")).toBe(true);
    expect(isSelectAll("Which item costs the most?")).toBe(false);
    expect(answerLetters("A, D", 4)).toEqual(["A", "D"]);
    expect(answerLetters("D and A", 4)).toEqual(["A", "D"]);
    expect(answerLetters("A、C、D", 4)).toEqual(["A", "C", "D"]);
    expect(answerLetters("AD", 4)).toEqual(["A", "D"]);
    expect(answerLetters("B", 4)).toEqual(["B"]);
    expect(answerLetters("A, E", 4)).toBeNull();
    expect(answerLetters("Apple and bun", 4)).toBeNull();
  });
});

describe("the program checks which options make the total", () => {
  const q = (stem: string, options: string[], answer: string, rows?: string[][], cards?: Array<{ label?: string; caption?: string }>) => ({
    stem,
    type: "multiple_choice" as const,
    options,
    answer,
    figure: rows
      ? { spec: { kind: "table", headers: ["Item", "Price"], rows }, svg: "", description: "", source: "program" as const, verified: true }
      : cards
        ? { spec: { kind: "cards", columns: 4, cards }, svg: "", description: "", source: "program" as const, verified: true }
        : undefined,
  });

  it("fails when more than one set works (the generated question from the bank)", () => {
    const r = selectionCheck(q("Liam spent exactly $5 buying some of the items shown for his lunch.\n\nSelect all the items he bought for lunch.", ["Cheese roll", "Fruit cup", "Yoghurt", "Chicken wrap"], "A, D", [["Cheese roll", "$1"], ["Fruit cup", "$2"], ["Yoghurt", "$2"], ["Chicken wrap", "$4"]]))!;
    expect(r.mismatch).toBe(true);
    expect(r.detail).toMatch(/A \+ B \+ C.*A \+ D|A \+ D.*A \+ B \+ C/);
  });

  it("finds a set the writer missed (cents)", () => {
    const r = selectionCheck(q("Mia bought some snacks at the school canteen. She spent exactly $4.20.\n\nSelect all the items she bought.", ["Granola bar", "Yogurt cup", "Fruit cup", "Bottled water"], "A, B", [["Granola bar", "$1.20"], ["Yogurt cup", "$1.80"], ["Fruit cup", "$2.40"], ["Bottled water", "$0.60"]]))!;
    expect(r.mismatch).toBe(true);
  });

  it("passes when exactly one set works and it is the answer", () => {
    const r = selectionCheck(q("Ava spent exactly $5 buying some of the items shown.\nSelect all the items she bought.", ["Pasta pot", "Banana", "Muffin", "Tuna sandwich"], "A, D", [["Pasta pot", "$1"], ["Banana", "$3"], ["Muffin", "$3"], ["Tuna sandwich", "$4"]]))!;
    expect(r).toEqual({ mismatch: false, detail: expect.stringContaining("A + D") });
    // the same, but the answer names another set
    expect(selectionCheck(q("Ava spent exactly $5 buying some of the items shown.\nSelect all the items she bought.", ["Pasta pot", "Banana", "Muffin", "Tuna sandwich"], "B, C", [["Pasta pot", "$1"], ["Banana", "$3"], ["Muffin", "$3"], ["Tuna sandwich", "$4"]]))!.mismatch).toBe(true);
  });

  it("reads prices from price cards, cents and yuan, and the stem", () => {
    const cards = [{ label: "$1.50", caption: "orange juice" }, { label: "$2.50", caption: "salad sandwich" }, { label: "$2.00", caption: "bun" }, { label: "50c", caption: "apple" }];
    // the template itself: $5 = sandwich + bun + apple, and nothing else
    expect(selectionCheck(q("Sarah spent exactly $5 buying some of these items for her lunch.\nSelect all the items she bought for lunch.", ["salad sandwich", "orange juice", "bun", "apple"], "A, C, D", undefined, cards))).toEqual({ mismatch: false, detail: expect.stringContaining("A + C + D") });
    // $4.50 = sandwich + bun = sandwich + juice + apple
    expect(selectionCheck(q("Sarah spent exactly $4.50 buying some of these items.\nSelect all the items she bought.", ["salad sandwich", "orange juice", "bun", "apple"], "A, C", undefined, cards))!.mismatch).toBe(true);
    expect(selectionCheck(q("小明正好花了 7 元买东西。\n铅笔 2 元\n橡皮 1 元\n尺子 4 元\n本子 3 元\n选出所有他买的东西。", ["铅笔", "橡皮", "尺子", "本子"], "A, B, C", undefined))!.mismatch).toBe(true); // 2+1+4 and 4+3
    // Not applicable: no total, a single-answer question, or prices it cannot find.
    expect(selectionCheck(q("Select all the even numbers.", ["2", "3", "4", "5"], "A, C"))).toBeNull();
    expect(selectionCheck(q("Which item costs exactly $5?", ["a", "b"], "A"))).toBeNull();
    expect(selectionCheck(q("Tom spent exactly $5. Select all the items he bought.", ["kite", "ball"], "A"))).toBeNull();
  });
});

describe("tables are required only when most template figures are tables", () => {
  it("does not turn price cards into a required table", () => {
    expect(templateTables([{ stem: "Sarah spent exactly $5." }], ["cards"]).required).toBe(false);
    expect(templateTables([{ stem: "a" }, { stem: "b" }], ["table", "cards"]).required).toBe(true);
    expect(templateTables([{ stem: "a" }, { stem: "b" }, { stem: "c" }], ["table", "cards", "cards"]).required).toBe(false);
    expect(templateTables([{ stem: "a" }], []).required).toBe(false);
  });
});

// ── Generation ───────────────────────────────────────────────────────

type Msg = { role: string; content: string | Array<{ type: string; text?: string }> };
const textOf = (m: Msg) => (typeof m.content === "string" ? m.content : m.content.filter((p) => p.type === "text").map((p) => p.text).join(""));
let root: string;
let calls: Array<{ kind: string; system: string; user: string }>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bank-select-all-"));
  process.env.BANK_STORE_PATH = root;
  process.env.LLM_API_KEY = "k";
  process.env.LLM_BASE_URL = "https://llm.test/v1";
  process.env.LLM_MODEL = "m";
  process.env.LLM_VISION_MODEL = "v";
  process.env.LLM_LOG_LEVEL = "silent";
  process.env.LLM_CACHE_ENABLED = "false";
  resetGlobalCache();
  calls = [];
  const cards = (items: Array<[string, string]>) => ({ kind: "cards", columns: 4, cards: items.map(([name, price]) => ({ label: price, caption: name })) });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: Msg[] };
      const sys = textOf(body.messages[0]);
      const user = textOf(body.messages[body.messages.length - 1]);
      const kind = sys.startsWith("You look at the figures") ? "template-visual" : sys.startsWith("You write new original") ? "generate" : sys.startsWith("You solve math") ? "resolve" : sys.startsWith("You review generated") ? "judge" : sys.startsWith("You analyse a class") ? "profile" : "other";
      calls.push({ kind, system: sys, user });
      const reply = (c: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(c) } }] }), { status: 200 });
      if (kind === "template-visual")
        return reply({ items: [{ n: 1, kind: "cards", description: "four price cards: orange juice $1.50, salad sandwich $2.50, bun $2.00, apple 50c" }], style: { colour: "colour", accent: "#1565c0", fill: "#e3f2fd", font: "rounded", stroke: "normal", frame: "rounded" }, layout: "a row of four picture cards, each with a name and a price" });
      if (kind === "generate")
        return reply({
          questions: [
            { stem: "Noah spent exactly $6 at the canteen.\nSelect all the items he bought.", type: "multiple_choice", options: ["Pie", "Milk", "Orange", "Salad"], answer: "A and D", figure: cards([["Pie", "$3.50"], ["Milk", "$1.20"], ["Orange", "80c"], ["Salad", "$2.50"]]) },
            { stem: "Liam spent exactly $5 buying some of the items shown for his lunch.\nSelect all the items he bought for lunch.", type: "multiple_choice", options: ["Cheese roll", "Fruit cup", "Yoghurt", "Chicken wrap"], answer: "A, D", figure: cards([["Cheese roll", "$1"], ["Fruit cup", "$2"], ["Yoghurt", "$2"], ["Chicken wrap", "$4"]]) },
          ],
        });
      if (kind === "resolve") return reply({ answers: [{ n: 1, answer: "D, A" }, { n: 2, answer: "unsolvable" }] });
      if (kind === "judge") return reply({ scores: [1, 2].map((n) => ({ n, score: 5, reason: "ok" })) });
      if (kind === "profile") return reply({ summary: "Choose the items whose prices add to a total.", answer_form: "all correct option letters", stem_structure: "A total, then select all." });
      return reply({});
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  _closeAllBanks();
  for (const v of ["BANK_STORE_PATH", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "LLM_VISION_MODEL", "LLM_LOG_LEVEL", "LLM_CACHE_ENABLED"]) delete process.env[v];
  fs.rmSync(root, { recursive: true, force: true });
});

describe("generating from a select-all template", () => {
  it("keeps the whole answer set, checks it, keeps the card layout and records the figure plan", async () => {
    const bank = createBank("local", { name: "Lunch", language: "en" });
    const page = saveAsset("local", bank.id, encodePng({ data: new Uint8Array(60 * 40 * 3).fill(230), width: 60, height: 40, channels: 3 }), "png");
    const [item] = addItems("local", bank.id, [
      {
        origin: "imported",
        fields: { stem: "Sarah spent exactly $5 buying some of these items for her lunch.\n\nSelect all the items she bought for lunch.", type: "multiple_choice", options: ["salad sandwich", "orange juice", "bun", "apple"], answer: "A, C, D", knowledge_points: [], tags: [], images: [{ asset: page, caption: "cards: Four food-item picture cards: orange juice, $1.50; salad sandwich, $2.50; bun, $2.00; apple, 50c." }] },
      },
    ]);
    const g = await generateFromTemplate({ owner: "local", bankId: bank.id, template: { item_ids: [item.id] }, count: 2 });
    const gen = calls.find((c) => c.kind === "generate")!;
    expect(gen.system).toContain('"Select all" questions');
    expect(gen.user).toContain("keep the examples' kind (cards); do not turn it into a table");
    expect(gen.user).not.toContain("TABLE:");
    expect(gen.user).not.toContain("AREAS:"); // one image on the template question
    expect(calls.find((c) => c.kind === "resolve")!.system).toContain('"Select all" questions: every correct letter');

    const noah = g.candidates.find((c) => c.stem.startsWith("Noah"))!;
    expect(noah.answer).toBe("A, D");
    expect(noah.checks.format).toMatchObject({ ok: true });
    expect(noah.checks.answer).toMatchObject({ ok: true });
    expect(noah.checks.answer!.detail).toContain("A + D");
    expect(noah.figure?.spec).toMatchObject({ kind: "cards" });
    expect(noah.passed).toBe(true);

    const liam = g.candidates.find((c) => c.stem.startsWith("Liam"))!;
    expect(liam.checks.answer).toMatchObject({ ok: false });
    expect(liam.checks.answer!.detail).toMatch(/A \+ B \+ C/);

    expect(getGeneration("local", bank.id, g.id).figure_plan).toMatchObject({ kinds: ["cards"], tables: false, solids: [] });
  });
});
