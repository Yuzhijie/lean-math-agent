import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing
vi.mock("@/lib/llm/client", () => ({
  chatJson: vi.fn(),
  chatText: vi.fn(),
  LlmError: class LlmError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "LlmError";
    }
  },
}));

vi.mock("@/lib/lean/sandbox", () => ({
  verifyLeanSource: vi.fn().mockResolvedValue({ ok: true, log: "ok", status: "ok" }),
}));

import { normalizeTheoremType } from "@/lib/llm/autoformalize";

describe("normalizeTheoremType", () => {
  it("adds colon prefix when missing", () => {
    expect(normalizeTheoremType("∀ (n : ℕ), n + 0 = n")).toBe(
      ": ∀ (n : ℕ), n + 0 = n",
    );
  });

  it("preserves existing colon prefix", () => {
    expect(normalizeTheoremType(": ∀ (n : ℕ), n + 0 = n")).toBe(
      ": ∀ (n : ℕ), n + 0 = n",
    );
  });

  it("trims whitespace", () => {
    expect(normalizeTheoremType("  ∀ n, n + 0 = n  ")).toBe(
      ": ∀ n, n + 0 = n",
    );
  });

  it("handles colon with space", () => {
    expect(normalizeTheoremType(": ∀ n, n = n")).toBe(": ∀ n, n = n");
  });

  it("handles empty string", () => {
    expect(normalizeTheoremType("")).toBe(": ");
  });
});

describe("normalizeTheoremType (binder form)", () => {
  it("leaves binder-form signatures alone", () => {
    expect(normalizeTheoremType("(n : ℕ) : n + 0 = n")).toBe("(n : ℕ) : n + 0 = n");
    expect(normalizeTheoremType("{α : Type} [Fintype α] (s : Finset α) : s.card ≤ Fintype.card α")).toBe(
      "{α : Type} [Fintype α] (s : Finset α) : s.card ≤ Fintype.card α",
    );
  });

  it("still prefixes a bare proposition that happens to start with a parenthesis", () => {
    expect(normalizeTheoremType("(2 : ℝ) + 2 = 4")).toBe(": (2 : ℝ) + 2 = 4");
  });
});
