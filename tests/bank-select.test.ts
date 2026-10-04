import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { difficultyLevelOf, gradeLevelOf } from "@/lib/bank/generator-bridge";
import { selectTemplateItems, templateOptions } from "@/lib/bank/select";
import { _closeAllBanks, addItems, createBank, ensureCategoryPath, listCategories, listItems } from "@/lib/bank/store";
import type { ItemFields } from "@/lib/bank/types";
import { resetGlobalCache } from "@/lib/llm/cache";
import { POST as generatePOST } from "@/app/api/generate-problem/route";

// Problem generator, method 1: Level / Difficulty / Topic pick the bank
// questions that serve as the template for new questions.

let root: string;
const OWNER = "local";
vi.mock("next-auth", () => ({ getServerSession: async () => null }));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bank-select-"));
  process.env.BANK_STORE_PATH = root;
});
afterEach(() => {
  _closeAllBanks();
  vi.unstubAllGlobals();
  for (const k of ["BANK_STORE_PATH", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "LLM_LOG_LEVEL", "LLM_CACHE_ENABLED"]) delete process.env[k];
  fs.rmSync(root, { recursive: true, force: true });
});

const q = (stem: string, grade: string, difficulty: number, kp: string): ItemFields => ({
  stem,
  type: "multiple_choice",
  options: ["1", "2", "3", "4"],
  answer: "B",
  grade,
  difficulty,
  knowledge_points: [kp],
  tags: [],
  images: [],
});

function seed() {
  const bankId = createBank(OWNER, { name: "Y4", language: "en" }).id;
  const fractions = ensureCategoryPath(OWNER, bankId, ["Number", "Fractions"])!;
  const place = ensureCategoryPath(OWNER, bankId, ["Number", "Place value"])!;
  const area = ensureCategoryPath(OWNER, bankId, ["Measurement", "Area"])!;
  addItems(OWNER, bankId, [
    { fields: q("What is 1/2 of 10?", "Year 4", 1, "Fractions"), origin: "imported", category_ids: [fractions] },
    { fields: q("What is 3/4 of 20?", "Year 4", 2, "Fractions"), origin: "imported", category_ids: [fractions] },
    { fields: q("Which fraction is larger, 2/3 or 3/5?", "Year 5", 3, "Fractions"), origin: "imported", category_ids: [fractions] },
    { fields: q("Round 3478 to the nearest hundred.", "Year 4", 1, "Place value"), origin: "imported", category_ids: [place] },
    { fields: q("Area of a 6 by 4 rectangle?", "Year 4", 2, "Area"), origin: "imported", category_ids: [area] },
  ]);
  const cats = listCategories(OWNER, bankId);
  const number = cats.find((c) => c.name === "Number")!.id;
  return { bankId, fractions, number, area, items: listItems(OWNER, bankId), cats };
}

describe("selecting template questions", () => {
  it("matches level, difficulty and topic (a parent category includes its sub-categories)", () => {
    const { items, cats, fractions, number } = seed();
    expect(selectTemplateItems(items, cats, { grade: "Year 4", difficulty: 2, category_id: fractions }).items.map((i) => i.stem)).toEqual(["What is 3/4 of 20?"]);
    expect(selectTemplateItems(items, cats, { grade: "year 4", category_id: number }).items).toHaveLength(3);
    expect(selectTemplateItems(items, cats, { knowledge_point: "fractions" }).items).toHaveLength(3);
  });

  it("widens difficulty, then level, but never the topic", () => {
    const { items, cats, fractions, area } = seed();
    const near = selectTemplateItems(items, cats, { grade: "Year 4", difficulty: 3, category_id: fractions });
    expect(near.relaxed).toEqual(["difficulty_near"]);
    expect(near.items.map((i) => i.difficulty)).toEqual([2]);
    const anyDiff = selectTemplateItems(items, cats, { grade: "Year 4", difficulty: 5, category_id: area });
    expect(anyDiff.relaxed).toEqual(["difficulty_any"]);
    const anyGrade = selectTemplateItems(items, cats, { grade: "Year 6", category_id: fractions });
    expect(anyGrade.relaxed).toEqual(["grade_any"]);
    expect(anyGrade.items).toHaveLength(3);
    expect(selectTemplateItems(items, cats, { knowledge_point: "Probability" }).items).toHaveLength(0);
  });

  it("offers levels, topics with counts and an index for counting in the browser", () => {
    const { items, cats } = seed();
    const o = templateOptions(items, cats);
    expect(o.grades).toEqual([{ value: "Year 4", count: 4 }, { value: "Year 5", count: 1 }]);
    expect(o.topics.map((t) => `${t.path} (${t.count})`)).toEqual(["Measurement (1)", "Measurement › Area (1)", "Number (4)", "Number › Fractions (3)", "Number › Place value (1)"]);
    expect(o.index).toHaveLength(5);
    expect(o.index[0].c).toHaveLength(2); // its topic and the parent
  });

  it("maps bank levels to the built-in levels", () => {
    expect(gradeLevelOf("Year 4")).toBe("elementary");
    expect(gradeLevelOf("Year 8")).toBe("middle");
    expect(gradeLevelOf("四年级")).toBe("elementary");
    expect(gradeLevelOf("初二")).toBe("middle");
    expect(gradeLevelOf("高一")).toBe("high");
    expect(difficultyLevelOf(2)).toBe("standard");
    expect(difficultyLevelOf(4)).toBe("competition");
  });
});

describe("POST /api/generate-problem with source bank", () => {
  const json = (body: unknown) => new Request("http://t/api/generate-problem", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("sends the matching bank questions as the template and returns checked problems", async () => {
    const { bankId, fractions } = seed();
    process.env.LLM_API_KEY = "k";
    process.env.LLM_BASE_URL = "https://llm.test/v1";
    process.env.LLM_MODEL = "m";
    process.env.LLM_LOG_LEVEL = "silent";
    process.env.LLM_CACHE_ENABLED = "false";
    resetGlobalCache();
    const prompts: string[] = [];
    const reply = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        const msgs = JSON.parse(String(init.body)).messages as Array<{ content: string }>;
        const sys = msgs[0].content;
        prompts.push(msgs[msgs.length - 1].content);
        if (sys.startsWith("You analyse a class")) return reply({ summary: "Fraction of a quantity, Year 4.", knowledge_points: ["Fractions"] });
        if (sys.startsWith("You review generated")) return reply({ scores: [{ n: 1, score: 5, reason: "fits" }] });
        if (sys.startsWith("You solve math questions")) return reply({ answers: [{ n: 1, answer: "C" }] });
        return reply({ questions: [{ stem: "What is 2/5 of 30?", type: "multiple_choice", options: ["6", "10", "12", "15"], answer: "C", solution: "30 ÷ 5 × 2 = 12", difficulty: 2 }] });
      }),
    );
    const res = await generatePOST(json({ source: "bank", bank_id: bankId, grade: "Year 4", difficulty: 2, category_id: fractions, count: 1 }));
    const body = (await res.json()) as { problems: Array<{ statement: string; answer: string; bank: { passed: boolean; template_label: string; topic_category_id: string; grade: string } }>; matched: number };
    expect(res.status).toBe(200);
    expect(body.matched).toBe(1);
    const p = body.problems[0];
    expect(p.statement).toBe("What is 2/5 of 30?\nA. 6\nB. 10\nC. 12\nD. 15");
    expect(p.answer).toMatch(/^C\. 12/);
    expect(p.bank).toMatchObject({ passed: true, topic_category_id: fractions, grade: "Year 4", template_label: expect.stringMatching(/^Year 4 · Number › Fractions · (difficulty|难度) 2$/) });
    // The template question went to the model; the target level and difficulty are in the profile.
    const gen = prompts.find((x) => x.includes("Write 2 new question"))!;
    expect(gen).toContain("What is 3/4 of 20?");
    expect(gen).not.toContain("Round 3478");
    expect(gen).toMatch(/Grade: Year 4/);
    expect(gen).toMatch(/Difficulty \(1–5\): 2/);
  });

  it("reports a topic with no questions instead of generating something unrelated", async () => {
    const { bankId } = seed();
    process.env.LLM_API_KEY = "k";
    const res = await generatePOST(json({ source: "bank", bank_id: bankId, knowledge_point: "Probability" }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/Probability/);
  });

  it("keeps the built-in method unchanged", async () => {
    const res = await generatePOST(json({ grade_level: "nope" }));
    expect(res.status).toBe(400);
  });
});
