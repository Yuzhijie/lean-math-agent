import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyClassification, categoryPaths, classifyQuestions, normaliseClassification } from "@/lib/bank/classify";
import { commitBatch, parseImport } from "@/lib/bank/import";
import { reclassifyItems } from "@/lib/bank/reclassify";
import { _closeAllBanks, addItems, createBank, ensureCategoryPath, getBank, listCategories, listItems, putCategory } from "@/lib/bank/store";
import { resetGlobalCache } from "@/lib/llm/cache";

// The model decides where an imported question goes in the catalogue, its
// grade, knowledge points and difficulty; the program validates and files it.

let root: string;
const OWNER = "u1";
const buf = (s: string) => Buffer.from(s, "utf8");

type ModelItem = { n: number; path?: string[]; grade?: string; knowledge_points?: string[]; difficulty?: number; type?: string; reason?: string };
/** Fake model: answers the classification prompt with `answer(questionTexts)`. */
function fakeModel(answer: (questions: string[]) => ModelItem[] | Error) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
      const user = body.messages[body.messages.length - 1].content;
      const questions = user.split(/\n\n(?=\[\d+\])/).filter((b) => /^\[\d+\]/.test(b));
      const out = answer(questions);
      if (out instanceof Error) return new Response("boom", { status: 500 });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: out }) } }] }), { status: 200 });
    }),
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bank-classify-"));
  process.env.BANK_STORE_PATH = root;
  process.env.LLM_API_KEY = "k";
  process.env.LLM_BASE_URL = "https://llm.test/v1";
  process.env.LLM_MODEL = "m";
  process.env.LLM_LOG_LEVEL = "silent";
  process.env.LLM_CACHE_ENABLED = "false";
  process.env.LLM_RETRY_MAX = "0";
  resetGlobalCache();
});
afterEach(() => {
  _closeAllBanks();
  vi.unstubAllGlobals();
  for (const k of ["BANK_STORE_PATH", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "LLM_LOG_LEVEL", "LLM_CACHE_ENABLED", "LLM_RETRY_MAX"]) delete process.env[k];
  fs.rmSync(root, { recursive: true, force: true });
});

describe("normalising the model's classification", () => {
  const ctx = { paths: [["Number", "Fractions"]], vocab: ["Fractions", "Place value"] };
  it("reuses existing categories and vocabulary spelling, clamps difficulty", () => {
    const c = normaliseClassification(
      { n: 1, path: ["number", "1. FRACTIONS"], knowledge_points: ["fractions", "Equivalent fractions"], difficulty: 7, grade: "Year 4", type: "numeric", reason: "two steps" },
      { stem: "x", type: "other" },
      ctx,
    )!;
    expect(c.category_path).toEqual(["Number", "Fractions"]);
    expect(c.knowledge_points).toEqual(["Fractions", "Equivalent fractions"]);
    expect(c.difficulty).toBe(5);
    expect(c.type).toBe("numeric");
    expect(c.grade).toBe("Year 4");
  });
  it("keeps a given type and grade, rejects an empty path", () => {
    const c = normaliseClassification({ n: 1, path: ["Algebra"], grade: "Year 9", type: "numeric" }, { stem: "x", type: "multiple_choice", grade: "Year 5" }, ctx)!;
    expect(c.type).toBeUndefined();
    expect(c.grade).toBeUndefined();
    expect(normaliseClassification({ n: 1, path: [] }, { stem: "x", type: "other" }, ctx)).toBeNull();
  });
  it("fills only missing fields unless overwriting", () => {
    const c = { category_path: ["Number"], knowledge_points: ["Place value"], difficulty: 2, grade: "Year 3", reason: "r" };
    const kept = applyClassification({ stem: "x", difficulty: 4, knowledge_points: [] }, c);
    expect(kept).toMatchObject({ difficulty: 4, knowledge_points: ["Place value"], grade: "Year 3", category_path: ["Number"], classified: { by: "model", reason: "r" } });
    expect(applyClassification({ stem: "x", difficulty: 4 }, c, true).difficulty).toBe(2);
  });
});

describe("category paths", () => {
  it("creates nested manual categories once and finds them again", () => {
    const bankId = createBank(OWNER, { name: "b" }).id;
    const a = ensureCategoryPath(OWNER, bankId, ["Number", "Fractions"]);
    const b = ensureCategoryPath(OWNER, bankId, ["number ", "fractions"]);
    expect(a).toBe(b);
    expect(categoryPaths(listCategories(OWNER, bankId))).toEqual(expect.arrayContaining([["Number"], ["Number", "Fractions"]]));
    expect(listCategories(OWNER, bankId)).toHaveLength(2);
  });
});

const paper = `1. What is 3/4 of 20?
(A) 5 (B) 10 (C) 15 (D) 20
2. Round 3478 to the nearest hundred.
(A) 3400 (B) 3500 (C) 3480 (D) 4000
3. A rectangle is 8 cm by 5 cm. What is its area?
(A) 13 (B) 26 (C) 40 (D) 45
`;

describe("import with model classification", () => {
  it("classifies drafts, then files committed questions into created categories", async () => {
    const bankId = createBank(OWNER, { name: "Y4", language: "en" }).id;
    fakeModel((qs) =>
      qs.map((q, k) => {
        const n = k + 1;
        if (q.includes("3/4")) return { n, path: ["Number", "Fractions"], grade: "Year 4", knowledge_points: ["Fractions"], difficulty: 2, reason: "two steps" };
        if (q.includes("Round")) return { n, path: ["Number", "Place value"], grade: "Year 4", knowledge_points: ["Estimation and rounding"], difficulty: 1 };
        return { n, path: ["Measurement", "Area"], grade: "Year 4", knowledge_points: ["Area"], difficulty: 2 };
      }),
    );
    const batch = await parseImport({ owner: OWNER, bankId, fileName: "y4.md", data: buf(paper) });
    expect(batch.drafts.map((d) => d.category_path)).toEqual([["Number", "Fractions"], ["Number", "Place value"], ["Measurement", "Area"]]);
    expect(batch.drafts[0]).toMatchObject({ grade: "Year 4", difficulty: 2, knowledge_points: ["Fractions"], classified: { by: "model", reason: "two steps" } });

    commitBatch(OWNER, bankId, batch.id, { rightsConfirmed: true });
    const cats = listCategories(OWNER, bankId);
    expect(categoryPaths(cats).map((p) => p.join(" > ")).sort()).toEqual(["Measurement", "Measurement > Area", "Number", "Number > Fractions", "Number > Place value"]);
    const items = listItems(OWNER, bankId);
    const fractions = cats.find((c) => c.name === "Fractions")!;
    expect(items.find((it) => it.stem.includes("3/4"))!.category_ids).toEqual([fractions.id]);
    expect(items.every((it) => !("category_path" in it))).toBe(true);
  });

  it("can be switched off, and a failing model only adds a note", async () => {
    const bankId = createBank(OWNER, { name: "Y4", language: "en" }).id;
    fakeModel(() => new Error("down"));
    const off = await parseImport({ owner: OWNER, bankId, fileName: "a.md", data: buf(paper), classify: false });
    expect(off.drafts[0].category_path).toBeUndefined();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    const failed = await parseImport({ owner: OWNER, bankId, fileName: "b.md", data: buf(paper) });
    expect(failed.drafts).toHaveLength(3);
    expect(failed.drafts[0].issues.join()).toMatch(/classification failed|分类失败/);
  });

  it("is skipped when the bank may not send content to the model", async () => {
    const bankId = createBank(OWNER, { name: "Private", allow_model: false }).id;
    fakeModel(() => []);
    const batch = await parseImport({ owner: OWNER, bankId, fileName: "a.md", data: buf(paper) });
    expect(batch.drafts[0].classified).toBeUndefined();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("tells the model the existing catalogue so it can reuse it", async () => {
    const bankId = createBank(OWNER, { name: "Y4", language: "en" }).id;
    const num = putCategory(OWNER, bankId, { name: "Number", parent_id: null, kind: "manual" });
    putCategory(OWNER, bankId, { name: "Fractions", parent_id: num.id, kind: "manual" });
    let prompt = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        prompt = String(init.body);
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [{ n: 1, path: ["Number", "Fractions"], difficulty: 2 }] }) } }] }), { status: 200 });
      }),
    );
    await classifyQuestions([{ stem: "What is 3/4 of 20?", type: "multiple_choice" }], { bank: getBank(OWNER, bankId), categories: listCategories(OWNER, bankId) });
    expect(prompt).toContain("Number > Fractions");
    expect(prompt).toContain("Measurement:"); // built-in vocabulary strands for an English bank
  });
});

describe("re-classifying questions already in the bank", () => {
  it("files them into categories and fills missing fields", async () => {
    const bankId = createBank(OWNER, { name: "Old", language: "en" }).id;
    const [a, b] = addItems(OWNER, bankId, [
      { fields: { stem: "What is 3/4 of 20?", type: "multiple_choice", options: ["5", "10", "15", "20"], answer: "C", knowledge_points: [], tags: [], images: [], difficulty: 4 }, origin: "imported" },
      { fields: { stem: "Find the area of a 8 cm by 5 cm rectangle.", type: "other", knowledge_points: [], tags: [], images: [] }, origin: "imported" },
    ]);
    fakeModel((qs) => qs.map((q, k) => (q.includes("3/4") ? { n: k + 1, path: ["Number", "Fractions"], difficulty: 2, grade: "Year 4" } : { n: k + 1, path: ["Measurement", "Area"], difficulty: 2, type: "numeric" })));
    const res = await reclassifyItems(OWNER, bankId, {});
    expect(res).toEqual({ classified: 2, failed: 0, categories_created: 4 });
    const items = Object.fromEntries(listItems(OWNER, bankId).map((it) => [it.id, it]));
    expect(items[a.id].difficulty).toBe(4); // kept without overwrite
    expect(items[a.id].grade).toBe("Year 4");
    expect(items[b.id].type).toBe("numeric");
    expect(items[b.id].category_ids).toHaveLength(1);
    await reclassifyItems(OWNER, bankId, { itemIds: [a.id], overwrite: true });
    expect(listItems(OWNER, bankId).find((it) => it.id === a.id)!.difficulty).toBe(2);
    expect(listCategories(OWNER, bankId)).toHaveLength(4); // same paths reused
  });
});
