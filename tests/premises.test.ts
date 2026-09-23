import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  conclusionOf,
  formatPremises,
  goalParts,
  localHintsForUnknownIdentifiers,
  mainRelation,
  premiseStats,
  resetPremiseCache,
  retrievePremises,
  similarNames,
} from "@/lib/lean/premises";
import { Bm25Index, leanTokens, weightedQuery } from "@/lib/search/bm25";

describe("leanTokens", () => {
  it("maps notation to Mathlib naming tokens and splits identifiers", () => {
    expect(leanTokens("a * b ≤ (a ^ 2 + b ^ 2) / 2")).toEqual(["mul", "le", "sq", "add", "sq", "div", "two"]);
    expect(leanTokens("Finset.sum_range_succ")).toEqual(["finset", "sum", "range", "succ"]);
    expect(leanTokens("∑ i ∈ Finset.range n, f i")).toEqual(["sum", "mem", "finset", "range"]);
    expect(leanTokens("Nat.Prime p → p ∣ m * n")).toEqual(["nat", "prime", "dvd", "mul"]);
    expect(leanTokens("|x| ≤ |y| ↔ ¬ x < 0")).toEqual(["abs", "le", "abs", "iff", "not", "lt", "zero"]);
  });

  it("drops binder names, universe levels and numerals", () => {
    expect(leanTokens("∀ {α : Type u_1} (h₁ : x ≤ 10), True")).toEqual(["le"]);
  });
});

describe("Bm25Index", () => {
  it("ranks documents sharing rarer query tokens higher", () => {
    const idx = new Bm25Index<string>();
    idx.add("sq_nonneg", leanTokens("sq_nonneg 0 ≤ a ^ 2"));
    idx.add("add_comm", leanTokens("add_comm a + b = b + a"));
    idx.add("mul_pos", leanTokens("mul_pos 0 < a → 0 < b → 0 < a * b"));
    const hits = idx.search(weightedQuery([{ text: "0 ≤ x ^ 2" }]), 3);
    expect(hits[0].item).toBe("sq_nonneg");
    expect(hits.map((h) => h.item)).not.toContain("add_comm");
  });
});

describe("goalParts / relations", () => {
  it("splits hypotheses from the target and drops binder names", () => {
    const g = "a b : ℝ\nha : 0 < a\nhab : a < b\n⊢ a ^ 2 < b ^ 2";
    expect(goalParts(g)).toEqual({ hypotheses: ["ℝ", "0 < a", "a < b"], target: "a ^ 2 < b ^ 2" });
  });

  it("treats a bare statement as the target", () => {
    expect(goalParts("(n : ℕ) : n + 0 = n").target).toBe("(n : ℕ) : n + 0 = n");
  });

  it("finds the conclusion and its main relation", () => {
    expect(conclusionOf("0 < a → 0 < b → 0 < a * b")).toBe("0 < a * b");
    expect(conclusionOf("∀ (a b : α), (a + b) ^ 2 = a ^ 2 + 2 * a * b + b ^ 2")).toContain("(a + b) ^ 2 =");
    expect(mainRelation("0 < a * b")).toBe("<");
    expect(mainRelation("|a| ≤ b ↔ -b ≤ a ∧ a ≤ b")).toBe("↔");
    expect(mainRelation("∀ (n : ℕ), (2 * n) % 2 = 0")).toBe("=");
    expect(mainRelation("p ∣ m * n")).toBe("∣");
  });
});

const savedIndexPath = process.env.PREMISE_INDEX_PATH;
const restoreIndexPath = () => {
  if (savedIndexPath === undefined) delete process.env.PREMISE_INDEX_PATH;
  else process.env.PREMISE_INDEX_PATH = savedIndexPath;
};

describe("retrievePremises (seed only)", () => {
  beforeEach(() => {
    process.env.PREMISE_INDEX_PATH = path.join(os.tmpdir(), "no-such-premise-index.json");
    resetPremiseCache();
  });
  afterEach(() => {
    restoreIndexPath();
    resetPremiseCache();
  });

  it("finds the AM-GM helper for a squares goal", async () => {
    const hits = await retrievePremises("a b : ℝ\n⊢ a * b ≤ (a ^ 2 + b ^ 2) / 2", { k: 5 });
    expect(hits.map((h) => h.name)).toContain("two_mul_le_add_sq");
  });

  it("finds sum_range_succ for a Finset.range sum", async () => {
    const hits = await retrievePremises("n : ℕ\n⊢ ∑ i ∈ Finset.range (n + 1), (2 * i + 1) = (n + 1) ^ 2", { k: 6 });
    expect(hits.map((h) => h.name)).toContain("Finset.sum_range_succ");
  });

  it("prefers the log bound for a log goal", async () => {
    const hits = await retrievePremises("x : ℝ\nhx : 0 < x\n⊢ Real.log x ≤ x - 1", { k: 3 });
    expect(hits[0].name).toBe("Real.log_le_sub_one_of_pos");
  });

  it("returns nothing for an empty goal", async () => {
    expect(await retrievePremises("   ")).toEqual([]);
  });

  it("formats a prompt block and reports stats", async () => {
    const hits = await retrievePremises("n : ℕ\n⊢ Even (n * (n + 1))", { k: 2 });
    const block = formatPremises(hits);
    expect(block).toMatch(/^Possibly relevant Mathlib lemmas/);
    expect(block).toContain("- Nat.even_mul_succ_self :");
    expect(formatPremises([])).toBe("");
    const stats = await premiseStats();
    expect(stats.fromFile).toBe(0);
    expect(stats.total).toBeGreaterThan(500);
  });

  it("suggests similar names for an unknown identifier", async () => {
    const hits = await similarNames("Nat.sqrt_le_sqrt", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.name)).toContain("Real.sqrt_le_sqrt");
    const block = await localHintsForUnknownIdentifiers(["Nat.sqrt_le_sqrt"]);
    expect(block).toContain("`Nat.sqrt_le_sqrt` does not exist");
    expect(await localHintsForUnknownIdentifiers([])).toBe("");
  });
});

describe("retrievePremises (built index file)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "premises-"));
    const file = path.join(dir, "index.json");
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        entries: [
          ["My.frobnicate_le_frobnicate", "∀ (a b : ℕ), a ≤ b → frobnicate a ≤ frobnicate b", "My.Mod"],
          ["My.frobnicate_def", "frobnicate = fun n => n + 1", "My.Mod", "def"],
        ],
      }),
    );
    process.env.PREMISE_INDEX_PATH = file;
    resetPremiseCache();
  });
  afterEach(async () => {
    restoreIndexPath();
    resetPremiseCache();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("merges the file with the seed and hides definitions unless asked", async () => {
    const stats = await premiseStats();
    expect(stats.fromFile).toBe(2);
    const hits = await retrievePremises("a b : ℕ\nh : a ≤ b\n⊢ frobnicate a ≤ frobnicate b", { k: 3 });
    expect(hits[0].name).toBe("My.frobnicate_le_frobnicate");
    expect(hits.map((h) => h.name)).not.toContain("My.frobnicate_def");
    const withDefs = await retrievePremises("⊢ frobnicate 3 = 4", { k: 3, includeDefs: true });
    expect(withDefs.map((h) => h.name)).toContain("My.frobnicate_def");
  });
});
