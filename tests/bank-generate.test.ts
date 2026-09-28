import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGlobalCache } from "@/lib/llm/cache";
import { withOutputLocale } from "@/lib/llm/output-locale";
import { _closeAllBanks, addItems, createBank, getCategory, getGeneration, listItems, putCategory, updateItem } from "@/lib/bank/store";
import { getProfile, pickExemplars, styleProfile } from "@/lib/bank/profile";
import { adoptCandidates, generateFromTemplate, parseNumber, resolveTemplate } from "@/lib/bank/generate";
import type { Item } from "@/lib/bank/types";

// Same-type generation: profiles (cached per category), candidate writing and
// the four checks, with a fake model that recognises each call by its prompt.

type Msg = { role: string; content: string };
type Kind = "profile" | "generate" | "resolve" | "judge";

function kindOf(messages: Msg[]): Kind {
  const sys = messages.find((m) => m.role === "system")?.content ?? "";
  if (sys.startsWith("You analyse a class")) return "profile";
  if (sys.startsWith("You write new original")) return "generate";
  if (sys.startsWith("You solve math questions")) return "resolve";
  if (sys.startsWith("You review generated")) return "judge";
  throw new Error("unknown call: " + sys.slice(0, 60));
}

const EXEMPLAR = "Tom has 12 apples and gives away 5 of them to his friends. How many apples does he have left?";

let replies: Partial<Record<Kind, unknown>>;
const bodies = () => vi.mocked(fetch).mock.calls.map((c) => JSON.parse(c[1]?.body as string) as { messages: Msg[] });
const callsOf = (k: Kind) => bodies().filter((b) => kindOf(b.messages) === k);

function ok(content: unknown): Response {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bank-gen-"));
  process.env.BANK_STORE_PATH = root;
  process.env.LLM_API_KEY = "k";
  process.env.LLM_BASE_URL = "https://llm.test/v1";
  process.env.LLM_MODEL = "m";
  process.env.LLM_LOG_LEVEL = "silent";
  process.env.LLM_CACHE_ENABLED = "false";
  resetGlobalCache();
  replies = {
    profile: { summary: "One-step word problems with whole numbers.", answer_form: "one option letter", stem_structure: "A person has some objects; one operation." },
    generate: {
      questions: [
        // wrong answer: 8 × 7 = 56 is B, not A
        { stem: "A garden has 8 rows of tulips with 7 tulips in each row. How many tulips are there in total?", type: "multiple_choice", options: ["54", "56", "58", "60"], answer: "A", solution: "SOLUTION-MARK 8×7" },
        // copies an exemplar
        { stem: EXEMPLAR, type: "multiple_choice", options: ["5", "7", "17", "6"], answer: "B", solution: "12 − 5 = 7" },
        // three options where four are required
        { stem: "A train travels 60 km every hour. How far does it travel in 2 hours?", type: "multiple_choice", options: ["100 km", "120 km", "140 km"], answer: "B", solution: "60 × 2" },
        // good (option letters in the text are stripped)
        { stem: "A baker makes 24 muffins and packs them equally into 6 boxes. How many muffins are in each box?", type: "multiple_choice", options: ["A. 3", "B. 4", "C. 5", "D. 6"], answer: "B", solution: "24 ÷ 6 = 4" },
      ],
    },
    resolve: { answers: [1, 2, 3, 4].map((n) => ({ n, answer: "B" })) },
    judge: { scores: [1, 2, 3, 4].map((n) => ({ n, score: 4, reason: "same type" })) },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { messages: Msg[] };
      const r = replies[kindOf(body.messages)];
      if (r instanceof Error) throw r;
      return ok(r);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  _closeAllBanks();
  for (const v of ["BANK_STORE_PATH", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "LLM_LOG_LEVEL", "LLM_CACHE_ENABLED"]) delete process.env[v];
  fs.rmSync(root, { recursive: true, force: true });
});

const mc = (stem: string, options: string[], answer: string) => ({
  fields: { stem, type: "multiple_choice" as const, options, answer, grade: "Year 3", difficulty: 2, knowledge_points: ["subtraction"], tags: [], images: [] },
  origin: "imported" as const,
});

function setup(bankFields: Parameters<typeof createBank>[1] = { name: "Year 3", language: "en" }) {
  const bank = createBank("local", bankFields);
  const cat = putCategory("local", bank.id, { name: "One-step problems", kind: "manual", parent_id: null });
  const items = addItems("local", bank.id, [
    mc(EXEMPLAR, ["5", "7", "17", "6"], "B"),
    mc("A shop sells pencils for 3 dollars each. How much do 4 pencils cost?", ["7", "10", "12", "14"], "C"),
    mc("Sara reads 15 pages every day. How many pages does she read in 3 days?", ["18", "30", "45", "60"], "C"),
  ]).map((it) => updateItem("local", bank.id, it.id, { category_ids: [cat.id] }));
  return { bank, cat, items };
}

describe("template profiles", () => {
  it("derives, caches and recomputes when members change", async () => {
    const { bank, cat, items } = setup();
    const p = await getProfile("local", bank.id, cat.id);
    expect(p).toMatchObject({ type: "multiple_choice", option_count: 4, grade: "Year 3", difficulty_range: [2, 2], language: "en", needs_figure: false, knowledge_points: ["subtraction"] });
    expect(p.summary).toContain("One-step word problems");
    expect(p.exemplar_ids).toHaveLength(3);
    expect(getCategory("local", bank.id, cat.id).profile?.items_hash).toBe(p.items_hash);
    expect(callsOf("profile")).toHaveLength(1);

    await getProfile("local", bank.id, cat.id);
    expect(callsOf("profile")).toHaveLength(1);

    updateItem("local", bank.id, items[1].id, { difficulty: 4 });
    const p2 = await getProfile("local", bank.id, cat.id);
    expect(callsOf("profile")).toHaveLength(2);
    expect(p2.difficulty_range).toEqual([2, 4]);
    expect(p2.items_hash).not.toBe(p.items_hash);

    await getProfile("local", bank.id, cat.id, { refresh: true });
    expect(callsOf("profile")).toHaveLength(3);
  });

  it("keeps counted fields when the model fails, and does not cache the fallback", async () => {
    const { bank, cat } = setup();
    replies.profile = "not json";
    const p = await getProfile("local", bank.id, cat.id);
    expect(p.type).toBe("multiple_choice");
    expect(p.summary).toMatch(/^3 道题/);
    expect(getCategory("local", bank.id, cat.id).profile).toBeUndefined();
  });

  it("rejects an empty category", async () => {
    const bank = createBank("local", { name: "b" });
    const cat = putCategory("local", bank.id, { name: "empty", kind: "manual", parent_id: null });
    await expect(getProfile("local", bank.id, cat.id)).rejects.toMatchObject({ status: 400 });
  });

  it("builds a style profile without a model call", async () => {
    const bank = createBank("local", { name: "b" });
    const style = { type: "multiple_choice" as const, grade: "Year 5", knowledge_points: ["fractions"], difficulty: 3, notes: "ICAS-style, everyday contexts" };
    const cat = putCategory("local", bank.id, { name: "ICAS", kind: "style", parent_id: null, style });
    const p = await getProfile("local", bank.id, cat.id);
    expect(p).toMatchObject({ type: "multiple_choice", option_count: 4, grade: "Year 5", difficulty_range: [3, 3], items_hash: "style" });
    expect(p.summary).toContain("ICAS-style");
    expect(styleProfile(style).stem_structure).toBe("ICAS-style, everyday contexts");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("picks diverse exemplars deterministically", () => {
    const mk = (id: string, stem: string) => ({ id, stem, answer: "1" }) as Item;
    const items = [mk("a", "What is 12 + 5 apples in the basket?"), mk("b", "What is 12 + 6 apples in the basket?"), mk("c", "A triangle has sides 3, 4 and 5; find its area.")];
    expect(pickExemplars(items, 2).map((x) => x.id)).toEqual(["a", "c"]);
    expect(pickExemplars(items, 2).map((x) => x.id)).toEqual(["a", "c"]);
  });
});

describe("parseNumber", () => {
  it("reads numbers with units, fractions and LaTeX", () => {
    expect(parseNumber("12 cm")).toBe(12);
    expect(parseNumber("$12$")).toBe(12);
    expect(parseNumber("1/2")).toBe(0.5);
    expect(parseNumber("0.5")).toBe(0.5);
    expect(parseNumber("\\frac{3}{4}")).toBe(0.75);
    expect(parseNumber("x = -3")).toBe(-3);
    expect(parseNumber("1,200 m^2")).toBe(1200);
    expect(parseNumber("1 1/2")).toBe(1.5);
    expect(parseNumber("12 + 5")).toBeNull();
    expect(parseNumber("about seven")).toBeNull();
  });
});

describe("same-type generation", () => {
  it("checks every candidate and puts passed ones first", async () => {
    const { bank, cat } = setup();
    const g = await generateFromTemplate({ owner: "local", bankId: bank.id, template: { category_id: cat.id }, count: 3 });
    expect(g.mode).toBe("same_type");
    expect(g.requested).toBe(3);
    expect(g.template_label).toBe("One-step problems");
    expect(g.candidates).toHaveLength(4);

    const [good, ...failed] = g.candidates;
    expect(good.stem).toMatch(/baker/);
    expect(good.passed).toBe(true);
    expect(good.options).toEqual(["3", "4", "5", "6"]);
    expect(good.checks.answer.detail).toContain("B");
    expect(failed.every((c) => !c.passed)).toBe(true);

    const by = (re: RegExp) => g.candidates.find((c) => re.test(c.stem))!;
    const wrong = by(/garden/);
    expect(wrong.checks.answer).toMatchObject({ ok: false });
    expect(wrong.checks.answer.detail).toContain("B");
    expect(wrong.checks.format.ok).toBe(true);
    const copy = by(/Tom has 12 apples/);
    expect(copy.checks.novelty.ok).toBe(false);
    expect(copy.checks.novelty.detail).toContain("100%");
    expect(copy.checks.answer.ok).toBe(true);
    const three = by(/train/);
    expect(three.checks.format.ok).toBe(false);
    expect(three.checks.format.detail).toMatch(/3/);

    // One call of each kind; 1.5 × 3 → 5 candidates requested; the solver never sees the proposed answers.
    expect(callsOf("generate")).toHaveLength(1);
    expect(callsOf("generate")[0].messages[1].content).toContain("Write 5 new question(s)");
    expect(callsOf("generate")[0].messages[1].content).toContain("do NOT copy");
    const solve = callsOf("resolve");
    expect(solve).toHaveLength(1);
    expect(solve[0].messages[1].content).not.toMatch(/Answer:|SOLUTION-MARK/);
    expect(callsOf("judge")).toHaveLength(1);

    expect(getGeneration("local", bank.id, g.id)).toEqual(g);
  });

  it("marks the answer check skipped when the re-solve call fails", async () => {
    const { bank, cat } = setup();
    replies.resolve = { nope: true };
    const g = await generateFromTemplate({ owner: "local", bankId: bank.id, template: { category_id: cat.id }, count: 3 });
    for (const c of g.candidates) expect(c.checks.answer).toMatchObject({ ok: true, skipped: true });
    // The wrong-answer candidate now passes (its answer could not be checked); the others still fail.
    expect(g.candidates.filter((c) => c.passed).map((c) => c.stem)).toEqual([expect.stringMatching(/garden/), expect.stringMatching(/baker/)]);
  });

  it("fails a bare computation whose answer is wrong, whatever the re-solve says", async () => {
    const { bank, cat } = setup();
    replies.generate = { questions: [{ stem: "Compute $36 \\times 12 = ?$ and choose the result.", type: "multiple_choice", options: ["422", "432", "442", "452"], answer: "A", solution: "" }] };
    replies.resolve = { answers: [{ n: 1, answer: "A" }] };
    const g = await generateFromTemplate({ owner: "local", bankId: bank.id, template: { category_id: cat.id }, count: 1 });
    expect(g.candidates[0].checks.answer.ok).toBe(false);
    expect(g.candidates[0].checks.answer.detail).toContain("432");
  });

  it("refuses when the bank does not allow the model", async () => {
    const { bank, cat } = setup({ name: "private", allow_model: false });
    await expect(generateFromTemplate({ owner: "local", bankId: bank.id, template: { category_id: cat.id }, count: 3 })).rejects.toMatchObject({ status: 403 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("writes in the bank language when it is pinned", async () => {
    const { bank, cat } = setup({ name: "pinned", language: "en", pin_language: true });
    await generateFromTemplate({ owner: "local", bankId: bank.id, template: { category_id: cat.id }, count: 1 });
    for (const k of ["profile", "generate", "resolve", "judge"] as const) expect(callsOf(k)[0].messages[0].content).toContain("OUTPUT LANGUAGE: English");
    // Check details stay in the request's language (Chinese outside a request).
    expect(getGeneration("local", bank.id, (await generateFromTemplate({ owner: "local", bankId: bank.id, template: { category_id: cat.id }, count: 1 })).id).candidates[0].checks.format.detail).toMatch(/[一-鿿]/);
  });

  it("follows the request language when not pinned", async () => {
    const { bank, cat } = setup();
    await generateFromTemplate({ owner: "local", bankId: bank.id, template: { category_id: cat.id }, count: 1 });
    expect(callsOf("generate")[0].messages[0].content).not.toContain("OUTPUT LANGUAGE: English");
    const g = await withOutputLocale("en-US", () => generateFromTemplate({ owner: "local", bankId: bank.id, template: { category_id: cat.id }, count: 1 }));
    expect(callsOf("generate")[1].messages[0].content).toContain("OUTPUT LANGUAGE: English");
    expect(g.candidates.find((c) => /train/.test(c.stem))!.checks.format.detail).toBe("3 options, expected 4");
  });

  it("resolves selected questions and style templates", async () => {
    const { bank, items } = setup();
    const sel = await resolveTemplate("local", bank.id, { item_ids: [items[0].id, items[2].id] });
    expect(sel.label).toBe("2 道选中的题目");
    expect(sel.exemplars.map((x) => x.id)).toEqual([items[0].id, items[2].id]);
    expect(sel.profile.option_count).toBe(4);
    const style = await withOutputLocale("en-US", () => resolveTemplate("local", bank.id, { style: { type: "numeric", knowledge_points: [] } }));
    expect(style.label).toBe("style template");
    expect(style.exemplars).toEqual([]);
    await expect(resolveTemplate("local", bank.id, {})).rejects.toMatchObject({ status: 400 });
  });
});

describe("adopting candidates", () => {
  it("adds items once, tagging unchecked ones", async () => {
    const { bank, cat } = setup();
    const target = putCategory("local", bank.id, { name: "Generated", kind: "manual", parent_id: null });
    const g = await generateFromTemplate({ owner: "local", bankId: bank.id, template: { category_id: cat.id }, count: 3 });
    const good = g.candidates[0];
    const bad = g.candidates.find((c) => !c.passed)!;
    const before = listItems("local", bank.id).length;

    const items = adoptCandidates("local", bank.id, g.id, [good.id, bad.id, good.id], { categoryId: target.id });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ origin: "generated", stem: good.stem, answer: "B", options: good.options, category_ids: [target.id], tags: ["generated"], language: "en" });
    expect(items[0].generated_from).toEqual({ generation_id: g.id, template_label: "One-step problems" });
    expect(items[1].tags).toEqual(["generated", "unchecked"]);
    expect(listItems("local", bank.id)).toHaveLength(before + 2);

    const saved = getGeneration("local", bank.id, g.id);
    expect(saved.candidates.find((c) => c.id === good.id)!.adopted_item_id).toBe(items[0].id);
    expect(adoptCandidates("local", bank.id, g.id, [good.id, bad.id])).toEqual([]);
    expect(listItems("local", bank.id)).toHaveLength(before + 2);
    expect(() => adoptCandidates("local", bank.id, g.id, ["missing"])).toThrow(/不存在|not found/);
  });
});
