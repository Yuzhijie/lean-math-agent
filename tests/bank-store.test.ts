import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _closeAllBanks,
  addItems,
  backendOf,
  createBank,
  deleteBank,
  deleteCategory,
  getBank,
  listBanks,
  listCategories,
  listItems,
  putCategory,
  readAsset,
  saveAsset,
  updateItem,
} from "@/lib/bank/store";
import { categoryMembers, filterItems } from "@/lib/bank/query";
import { fingerprint, normaliseStem, stemSimilarity, StemIndex } from "@/lib/bank/similarity";
import { vocabFor } from "@/lib/bank/vocab";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bank-"));
  process.env.BANK_STORE_PATH = root;
});
afterEach(() => {
  _closeAllBanks();
  delete process.env.BANK_STORE_PATH;
  delete process.env.BANK_STORE_BACKEND;
  fs.rmSync(root, { recursive: true, force: true });
});

const q = (stem: string, extra: Record<string, unknown> = {}) => ({ fields: { stem, type: "numeric" as const, knowledge_points: [], tags: [], images: [], ...extra }, origin: "imported" as const });

for (const backend of ["sqlite", "jsonl"] as const) {
  describe(`bank store (${backend})`, () => {
    beforeEach(() => {
      if (backend === "jsonl") process.env.BANK_STORE_BACKEND = "jsonl";
    });

    it("creates banks per owner and persists items across reopen", () => {
      const b = createBank("user-1", { name: "Year 5 maths", language: "en" });
      expect(backendOf("user-1", b.id)).toBe(backend);
      addItems("user-1", b.id, [q("What is 3 + 4?", { answer: "7" }), q("What is 6 × 7?", { answer: "42" })]);
      _closeAllBanks();
      const items = listItems("user-1", b.id);
      expect(items.map((i) => i.answer)).toEqual(["7", "42"]);
      expect(items[0].fingerprint).toBe(fingerprint("What is 3 + 4?"));
      expect(listBanks("user-1").map((x) => x.name)).toEqual(["Year 5 maths"]);
    });

    it("isolates accounts", () => {
      const b = createBank("user-1", { name: "mine" });
      expect(listBanks("user-2")).toEqual([]);
      expect(() => getBank("user-2", b.id)).toThrow(/not found/);
      expect(() => listItems("user-2", b.id)).toThrow(/not found/);
    });

    it("updates items and categories; deleting a category unassigns items", () => {
      const b = createBank("local", { name: "b" });
      const [it] = addItems("local", b.id, [q("Solve 2x + 3 = 11")]);
      const parent = putCategory("local", b.id, { name: "Algebra", kind: "manual", parent_id: null });
      const child = putCategory("local", b.id, { name: "Linear equations", kind: "manual", parent_id: parent.id });
      updateItem("local", b.id, it.id, { category_ids: [child.id], difficulty: 2 });
      const items = listItems("local", b.id);
      const cats = listCategories("local", b.id);
      // A parent category contains its children's items.
      expect(categoryMembers(items, cats, parent).map((x) => x.id)).toEqual([it.id]);
      deleteCategory("local", b.id, child.id);
      expect(listItems("local", b.id)[0].category_ids).toEqual([]);
    });

    it("stores assets by content hash and deletes whole banks", () => {
      const b = createBank("local", { name: "b" });
      const name = saveAsset("local", b.id, Buffer.from("png-bytes"), "png");
      expect(name).toMatch(/^[a-f0-9]{32}\.png$/);
      expect(readAsset("local", b.id, name).toString()).toBe("png-bytes");
      expect(() => readAsset("local", b.id, "../../etc/passwd")).toThrow();
      deleteBank("local", b.id);
      expect(listBanks("local")).toEqual([]);
    });
  });
}

describe("duplicate detection", () => {
  it("normalises spacing, punctuation width, numbering and LaTeX spelling", () => {
    expect(normaliseStem("1. 计算 $\\dfrac{1}{2} \\times 4$ 。")).toBe(normaliseStem("计算 \\frac{1}{2}×4."));
    expect(fingerprint("Q3. What is 3+4?")).toBe(fingerprint("What is 3 + 4 ?"));
  });

  it("scores near-duplicates high and different questions low", () => {
    const a = "A rectangle is 12 cm long and 5 cm wide. What is its area?";
    expect(stemSimilarity(a, "A rectangle is 12 cm long and 6 cm wide. What is its area?")).toBeGreaterThan(0.8);
    expect(stemSimilarity(a, "Tom has 3 apples and buys 5 more. How many apples does he have?")).toBeLessThan(0.2);
    const idx = new StemIndex<string>();
    idx.add("x", a);
    idx.add("y", "某班 30 人，18 人喜欢象棋。");
    expect(idx.nearest("某班 30 人，18 人喜欢象棋。")).toEqual({ item: "y", score: 1 });
  });
});

describe("filters and vocabulary", () => {
  it("filters by type, knowledge point, difficulty and text", () => {
    const b = createBank("local", { name: "b" });
    addItems("local", b.id, [
      q("Area of a square with side 4", { type: "numeric", knowledge_points: ["Area"], difficulty: 2 }),
      q("Which fraction is largest?", { type: "multiple_choice", knowledge_points: ["Fractions"], difficulty: 3, options: ["1/2", "2/3", "3/5", "1/3"] }),
    ]);
    const items = listItems("local", b.id);
    expect(filterItems(items, { types: ["multiple_choice"] })).toHaveLength(1);
    expect(filterItems(items, { knowledge_points: ["Area"], difficulty_max: 2 })).toHaveLength(1);
    expect(filterItems(items, { query: "square" })[0].stem).toContain("square");
  });

  it("offers the bank's own vocabulary first", () => {
    const v = vocabFor({ vocab: ["My topic"], language: "en" });
    expect(v[0]).toBe("My topic");
    expect(v).toContain("Fractions");
    expect(vocabFor({ vocab: [], language: "zh" })).toContain("勾股定理");
  });
});
