import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasMarkdownTable, splitTables, tablesIn, withoutTables } from "@/lib/markdown-table";
import { buildVisual, describeVisual, plainMath, visualSpecSchema } from "@/lib/figure/visual";
import { generateFromTemplate } from "@/lib/bank/generate";
import { _closeAllBanks, addItems, createBank } from "@/lib/bank/store";
import { resetGlobalCache } from "@/lib/llm/cache";

// Templates with tables (as read from scans: Markdown tables in the stem)
// give generated questions with tables, drawn in the template's style.

const STEM = "The table shows how many books four children read.\n| Name | Books |\n|---|---|\n| Mia | 5 |\n| Tom | ? |\nTom read 3 more books than Mia. How many books did Tom read?";

describe("Markdown tables in question text", () => {
  it("are found, parsed and removed", () => {
    expect(hasMarkdownTable(STEM)).toBe(true);
    expect(tablesIn(STEM)).toEqual([{ headers: ["Name", "Books"], rows: [["Mia", "5"], ["Tom", "?"]] }]);
    expect(withoutTables(STEM)).toBe("The table shows how many books four children read.\nTom read 3 more books than Mia. How many books did Tom read?");
    expect(splitTables(STEM).map((s) => s.kind)).toEqual(["text", "table", "text"]);
    // A pipe in ordinary text is not a table; nor is a header without a separator.
    expect(hasMarkdownTable("|x| means the absolute value of x")).toBe(false);
    expect(hasMarkdownTable("| a | b |\n| 1 | 2 |")).toBe(false);
    // Short rows are padded; escaped pipes stay in the cell.
    expect(tablesIn("| a | b | c |\n|---|---|---|\n| 1 \\| 2 |")[0].rows).toEqual([["1 | 2", "", ""]]);
  });
});

describe("drawn tables", () => {
  it("draws blanks to fill in, row headers and simple maths, and describes them", () => {
    const spec = visualSpecSchema.parse({ kind: "table", headers: ["", "Mon", "Tue"], rows: [["Apples", 3, "?"], ["Pears", null, "$\\frac{1}{2}$"]], row_headers: true, caption: "? = to find" });
    const v = buildVisual(spec);
    expect(v.svg).toContain('stroke-dasharray="4 3"'); // answer boxes
    expect(v.svg).toContain(">1/2<");
    expect(v.description).toBe('a table with 2 rows under the header row "" | "Mon" | "Tue" (first column = row labels); rows: Apples | 3 | ? (to find); Pears | (blank) | $\\frac{1}{2}$; note under the table: "? = to find"');
    expect(plainMath("$3 \\times 4 = 12$ cm^2")).toBe("3 × 4 = 12 cm²");
    // Chinese cells get wider columns than the same number of Latin letters.
    const zh = buildVisual(visualSpecSchema.parse({ kind: "table", headers: ["星期一星期二"], rows: [["一"]] }));
    const en = buildVisual(visualSpecSchema.parse({ kind: "table", headers: ["abcdef"], rows: [["a"]] }));
    const width = (svg: string) => Number(/width="(\d+)"/.exec(svg)![1]);
    expect(width(zh.svg)).toBeGreaterThan(width(en.svg));
    expect(describeVisual(visualSpecSchema.parse({ kind: "cards", columns: 1, cards: [{ figure: { kind: "table", headers: ["a"], rows: [["1"]] } }] }))).toContain("a table with 1 row");
  });
});

// ── Generation ───────────────────────────────────────────────────────

type Msg = { role: string; content: string };
let root: string;
let calls: Array<{ kind: string; system: string; user: string }>;
let questions: unknown[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bank-tables-"));
  process.env.BANK_STORE_PATH = root;
  process.env.LLM_API_KEY = "k";
  process.env.LLM_BASE_URL = "https://llm.test/v1";
  process.env.LLM_MODEL = "m";
  process.env.LLM_LOG_LEVEL = "silent";
  process.env.LLM_CACHE_ENABLED = "false";
  resetGlobalCache();
  calls = [];
  questions = [
    // a table as a figure spec
    { stem: "The table shows the stickers each child has. Ava has 4 more stickers than Ben. How many stickers does Ava have?", type: "multiple_choice", options: ["4", "9", "13", "5"], answer: "C", figure: { kind: "table", headers: ["Name", "Stickers"], rows: [["Ben", 9], ["Ava", "?"]] } },
    // the writer put the table in the stem: it becomes a drawn table
    { stem: "The table shows the shells each child found.\n| Name | Shells |\n|---|---|\n| Leo | 6 |\n| Zoe | ? |\nZoe found twice as many shells as Leo. How many shells did Zoe find?", type: "multiple_choice", options: ["8", "12", "3", "6"], answer: "B" },
    // no table at all
    { stem: "Sam has 7 marbles and finds 5 more. How many marbles does Sam have now?", type: "multiple_choice", options: ["2", "12", "11", "13"], answer: "B" },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: Msg[] };
      const sys = String(body.messages[0].content);
      const user = String(body.messages[body.messages.length - 1].content);
      const kind = sys.startsWith("You write new original") ? "generate" : sys.startsWith("You solve math") ? "resolve" : sys.startsWith("You review generated") ? "judge" : sys.startsWith("You analyse a class") ? "profile" : "other";
      calls.push({ kind, system: sys, user });
      const reply = (c: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(c) } }] }), { status: 200 });
      if (kind === "generate") return reply({ questions });
      if (kind === "resolve") return reply({ answers: [{ n: 1, answer: "C" }, { n: 2, answer: "B" }, { n: 3, answer: "B" }] });
      if (kind === "judge") return reply({ scores: [1, 2, 3].map((n) => ({ n, score: 5, reason: "ok" })) });
      if (kind === "profile") return reply({ summary: "Reading a table, one-step comparison.", answer_form: "one option letter", stem_structure: "A table, then a question." });
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

function bankWithTableTemplate() {
  const bank = createBank("local", { name: "Tables", language: "en" });
  const items = addItems("local", bank.id, [
    { origin: "imported", fields: { stem: STEM, type: "multiple_choice", options: ["2", "8", "15", "3"], answer: "B", knowledge_points: ["Data"], tags: [], images: [] } },
  ]);
  return { bank, items };
}

describe("generating from a template with a table", () => {
  it("asks for a table, draws it, and fails a question without one", async () => {
    const { bank, items } = bankWithTableTemplate();
    const g = await generateFromTemplate({ owner: "local", bankId: bank.id, template: { item_ids: [items[0].id] }, count: 3 });

    const gen = calls.find((c) => c.kind === "generate")!;
    expect(gen.user).toMatch(/TABLE: the example questions present their data in a table \(e\.g\. 2 columns \("Name", "Books"\), 2 rows\)/);
    expect(gen.system).toContain('{"kind":"table"');
    // The solver sees the drawn table's exact content.
    expect(calls.find((c) => c.kind === "resolve")!.user).toContain('rows: Ben | 9; Ava | ? (to find)');

    const by = (s: string) => g.candidates.find((c) => c.stem.startsWith(s))!;
    const stickers = by("The table shows the stickers");
    expect(stickers.figure?.source).toBe("program");
    expect(stickers.checks.figure).toMatchObject({ ok: true });
    expect(stickers.passed).toBe(true);

    const shells = by("The table shows the shells");
    expect(shells.stem).toBe("The table shows the shells each child found.\nZoe found twice as many shells as Leo. How many shells did Zoe find?");
    expect(shells.figure?.spec).toMatchObject({ kind: "table", headers: ["Name", "Shells"], rows: [["Leo", "6"], ["Zoe", "?"]] });
    expect(shells.checks.figure).toMatchObject({ ok: true });

    const marbles = by("Sam has 7 marbles");
    expect(marbles.checks.figure).toMatchObject({ ok: false });
    expect(marbles.checks.figure!.detail).toMatch(/没有表格|does not/);
    expect(marbles.passed).toBe(false);
  });

  it("does not require tables when the template has none", async () => {
    const bank = createBank("local", { name: "Plain", language: "en" });
    const [item] = addItems("local", bank.id, [{ origin: "imported", fields: { stem: "Tom has 12 apples and eats 5. How many are left?", type: "multiple_choice", options: ["5", "7", "17", "6"], answer: "B", knowledge_points: [], tags: [], images: [] } }]);
    const g = await generateFromTemplate({ owner: "local", bankId: bank.id, template: { item_ids: [item.id] }, count: 3 });
    expect(calls.find((c) => c.kind === "generate")!.user).not.toContain("TABLE:");
    expect(g.candidates.find((c) => c.stem.startsWith("Sam has 7"))!.checks.figure).toBeUndefined();
  });
});
