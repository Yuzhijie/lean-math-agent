import { describe, expect, it } from "vitest";
import { splitTopLevelColon, typeToProp } from "@/lib/lean/statement-prop";
import { renderFormalization, type FormalizeRow } from "@/scripts/bench-formalize";

describe("statements as propositions", () => {
  it("binder form becomes a ∀, a bare goal stays", () => {
    expect(typeToProp("(a b : ℝ) (h₀ : 0 < a ∧ 0 < b) : a * b > 0")).toBe("∀ (a b : ℝ) (h₀ : 0 < a ∧ 0 < b), a * b > 0");
    expect(typeToProp(": (2 : ℕ) + 2 = 4")).toBe("(2 : ℕ) + 2 = 4");
    expect(typeToProp("[Fintype α] (s : Finset α) : s.card ≤ Fintype.card α")).toBe("∀ [Fintype α] (s : Finset α), s.card ≤ Fintype.card α");
    // `:=` and colons inside brackets are not the split point.
    expect(splitTopLevelColon("(f : ℕ → ℕ) (h : ∀ x, f x = (x : ℕ)) : f 0 = 0")).toEqual({ binders: "(f : ℕ → ℕ) (h : ∀ x, f x = (x : ℕ))", goal: "f 0 = 0" });
    expect(typeToProp("no colon here")).toBeNull();
  });
});

describe("formalization report", () => {
  const row = (id: string, verdict: FormalizeRow["verdict"], accepted: boolean, failed: number[] = []): FormalizeRow => ({ id, difficulty: "easy", verdict, accepted, official: "(x : ℝ) : x = x", ours: "(y : ℝ) : y = y", failed_layers: failed, skipped_layers: [], cost: 0.02, wall_ms: 1000 });
  it("faithful share, acceptance, too-strict and too-loose layers", () => {
    const md = renderFormalization(
      [row("a", "same", true), row("b", "equivalent", false, [3]), row("c", "not_shown", true), row("d", "refuted", false, [6]), row("e", "not_formalized", false, [1, 3]), row("f", "official_broken", true)],
      { file: "minif2f-test.json", commit: "abc1234", started_at: "2026-10-15T00:00:00Z" },
    );
    expect(md).toContain("| **Faithful (same or equivalent)** | **2** | **40%** |");
    expect(md).toContain("Accepted by the validation layers: 2/5 (40%); of those, 1 shown faithful (50%).");
    expect(md).toContain("Rejected although shown faithful: 1");
    expect(md).toContain("Failed layers on the final attempt: 3 back-translation 2, 6 no counterexample 1, 1 elaborates 1.");
    expect(md).toContain("1 official statement(s) did not elaborate");
    expect(md).toContain("| c | not_shown |");
  });
});
