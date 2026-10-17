import { describe, expect, it } from "vitest";
import { MAX_TEMPLATE_RUNS, templateRuns } from "@/lib/bank/template-runs";
import { templateRefSchema } from "@/lib/bank/types";

describe("templateRuns", () => {
  it("a category is one template", () => {
    expect(templateRuns({ kind: "category", categoryId: "c1" })).toEqual([{ key: "c1", ref: { category_id: "c1" } }]);
  });

  it("each picked question is a template of its own, in the order picked", () => {
    const runs = templateRuns({ kind: "items", itemIds: ["a", "b", "c"] });
    expect(runs.map((r) => r.ref)).toEqual([{ item_ids: ["a"] }, { item_ids: ["b"] }, { item_ids: ["c"] }]);
    expect(runs.map((r) => r.itemId)).toEqual(["a", "b", "c"]);
    for (const r of runs) expect(templateRefSchema.safeParse(r.ref).success).toBe(true);
  });

  it("one picked question is one run", () => {
    expect(templateRuns({ kind: "items", itemIds: ["a"] })).toHaveLength(1);
  });

  it("drops repeats and caps the number of runs", () => {
    expect(templateRuns({ kind: "items", itemIds: ["a", "a", "b"] }).map((r) => r.key)).toEqual(["a", "b"]);
    const many = Array.from({ length: MAX_TEMPLATE_RUNS + 5 }, (_, i) => `i${i}`);
    expect(templateRuns({ kind: "items", itemIds: many })).toHaveLength(MAX_TEMPLATE_RUNS);
  });
});
