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
