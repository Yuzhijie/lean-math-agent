import { describe, it, expect } from "vitest";
import { normalizeTheoremType } from "@/lib/llm/autoformalize";

describe("normalizeTheoremType", () => {
  it("adds leading colon when missing", () => {
    expect(normalizeTheoremType("∀ (n : ℕ), n + 0 = n")).toBe(
      ": ∀ (n : ℕ), n + 0 = n",
    );
  });

  it("preserves theorem_type that already has colon", () => {
    expect(normalizeTheoremType(": ∀ (n : ℕ), n + 0 = n")).toBe(
      ": ∀ (n : ℕ), n + 0 = n",
    );
  });

  it("handles parenthesized form without leading colon", () => {
    expect(normalizeTheoremType("(n : Nat) → n + 0 = n")).toBe(
      ": (n : Nat) → n + 0 = n",
    );
  });

  it("trims whitespace before checking", () => {
    expect(normalizeTheoremType("  ∀ n, n + 0 = n  ")).toBe(
      ": ∀ n, n + 0 = n",
    );
  });

  it("preserves colon with leading whitespace", () => {
    expect(normalizeTheoremType("  : ∀ n, n + 0 = n  ")).toBe(
      ": ∀ n, n + 0 = n",
    );
  });

  it("handles complex theorem types", () => {
    const complex = "∀ (a b : ℝ), a > 0 → b > 0 → a * b > 0";
    expect(normalizeTheoremType(complex)).toBe(`: ${complex}`);
  });
});

describe("binders after the colon without ∀", () => {
  it("adds the missing ∀ and leaves everything else alone", () => {
    expect(normalizeTheoremType(": (A B C : ℝ × ℝ) (u v : ℝ), let d := 1; A = B")).toBe(": ∀ (A B C : ℝ × ℝ) (u v : ℝ), let d := 1; A = B");
    expect(normalizeTheoremType(": (f : ℕ → ℕ) (h : f 0 = 1), f 0 = 1")).toBe(": ∀ (f : ℕ → ℕ) (h : f 0 = 1), f 0 = 1");
    expect(normalizeTheoremType(": ∀ (x : ℕ), x = x")).toBe(": ∀ (x : ℕ), x = x");
    expect(normalizeTheoremType(": (x : ℕ) = x")).toBe(": (x : ℕ) = x");
    expect(normalizeTheoremType(": (n : ℕ) → n = n")).toBe(": (n : ℕ) → n = n");
    expect(normalizeTheoremType(": (Finset.range 3).card = 3")).toBe(": (Finset.range 3).card = 3");
    expect(normalizeTheoremType("(n : ℕ) : n + 0 = n")).toBe("(n : ℕ) : n + 0 = n");
    expect(normalizeTheoremType("(x : ℕ) (y : ℕ), x = y")).toBe(": ∀ (x : ℕ) (y : ℕ), x = y");
    expect(normalizeTheoremType(": (x : ℕ)\n  (y : ℕ), x = y")).toBe(": ∀ (x : ℕ)\n  (y : ℕ), x = y");
    expect(normalizeTheoremType(": (p : ℕ) [Fact p.Prime] (h : 2 < p), p ≠ 2")).toBe(": ∀ (p : ℕ) [Fact p.Prime] (h : 2 < p), p ≠ 2");
  });
});
