import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeanVerifyResult } from "@/lib/lean/sandbox";

const { sampleMock, verifyMock, suggestMock } = vi.hoisted(() => ({ sampleMock: vi.fn(), verifyMock: vi.fn(), suggestMock: vi.fn() }));
vi.mock("@/lib/llm/client", async (orig) => ({ ...(await orig<typeof import("@/lib/llm/client")>()), sampleText: sampleMock }));
vi.mock("@/lib/lean/sandbox", async (orig) => ({ ...(await orig<typeof import("@/lib/lean/sandbox")>()), verifyLeanSource: verifyMock }));
vi.mock("@/lib/lean/suggest", async (orig) => ({ ...(await orig<typeof import("@/lib/lean/suggest")>()), librarySearchSuggestions: suggestMock }));

import { nativeProverSettings, proverPromptStyle } from "@/lib/llm/config";
import { nativeProverPrompt } from "@/lib/llm/prompts";
import { extractTactics, helperDeclarationNames, proveWholeTheorem } from "@/lib/prover/whole-proof";

const result = (p: Partial<LeanVerifyResult>): LeanVerifyResult => ({ ok: false, log: "", status: "fail", backend: "repl", messages: [], sorries: [], goals: [], infos: [], durationMs: 1, ...p });
const ENV = ["LLM_PROVER_MODEL", "LLM_PROVER_MODELS", "LLM_PROVER_PROMPT", "LLM_PROVER_MAX_TOKENS", "LLM_PROVER_TIMEOUT_MS", "LLM_PROVER_TEMPERATURE"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  sampleMock.mockReset();
  verifyMock.mockReset();
  suggestMock.mockReset();
  suggestMock.mockResolvedValue({ suggestions: [], unavailable: false, durationMs: 0 });
});
afterEach(() => {
  for (const k of ENV) if (saved[k] === undefined) delete process.env[k];
  else process.env[k] = saved[k];
});

describe("prover prompt style", () => {
  it("uses the native template for models named *prover*, chat otherwise, and honours the override", () => {
    expect(proverPromptStyle()).toBe("chat");
    process.env.LLM_PROVER_MODEL = "deepseek/deepseek-prover-v2-671b";
    expect(proverPromptStyle()).toBe("native");
    process.env.LLM_PROVER_MODEL = "Goedel-LM/Goedel-Prover-V2-32B";
    expect(proverPromptStyle()).toBe("native");
    process.env.LLM_PROVER_MODEL = "openai/gpt-5.6-luna";
    expect(proverPromptStyle()).toBe("chat");
    process.env.LLM_PROVER_PROMPT = "native";
    expect(proverPromptStyle()).toBe("native");
    expect(nativeProverSettings()).toEqual({ maxTokens: 16384, timeoutMs: 600000, temperature: undefined });
    process.env.LLM_PROVER_MAX_TOKENS = "32768";
    expect(nativeProverSettings().maxTokens).toBe(32768);
  });

  it("builds the miniF2F-style prompt the provers were trained on", () => {
    const p = nativeProverPrompt({ theoremName: "t", theoremType: "(n : ℕ) : n + 0 = n", problemText: "Show that n + 0 = n.", opens: ["Finset"] });
    expect(p.startsWith("Complete the following Lean 4 code:\n\n```lean4\nimport Mathlib\nimport Aesop\n")).toBe(true);
    expect(p).toContain("open BigOperators Real Nat Topology Rat Finset\n\n/-- Show that n + 0 = n. -/\ntheorem t (n : ℕ) : n + 0 = n := by\n  sorry\n```");
    expect(p).toContain("provide a detailed proof plan");
  });
});

describe("prover output with a plan and helper lemmas", () => {
  const output = [
    "### Proof plan",
    "1. Bound each term.",
    "```lean4",
    "lemma helper (x : ℝ) : 0 ≤ x ^ 2 := by",
    "  positivity",
    "```",
    "Now the full proof:",
    "```lean4",
    "import Mathlib",
    "open Real",
    "",
    "lemma aux (x y : ℝ) : 0 ≤ (x - y) ^ 2 := by",
    "  positivity",
    "",
    "/-- the target -/",
    "theorem amgm (x y : ℝ) : x * y ≤ (x ^ 2 + y ^ 2) / 2 := by",
    "  nlinarith [sq_nonneg (x - y)]",
    "```",
  ].join("\n");

  it("takes the proof of the named theorem, not the first lemma", () => {
    expect(extractTactics(output, "amgm")).toBe("open Real in\nnlinarith [sq_nonneg (x - y)]");
    expect(helperDeclarationNames(output, "amgm")).toEqual(["aux"]);
  });

  it("falls back to the last theorem when the prover renamed it", () => {
    expect(extractTactics(output.replace("theorem amgm", "theorem renamed"), "amgm")).toBe("open Real in\nnlinarith [sq_nonneg (x - y)]");
  });
});

describe("whole-proof loop with a native prover", () => {
  it("sends one user message with long output and a repair turn with Lean's errors", async () => {
    process.env.LLM_PROVER_MODEL = "deepseek/deepseek-prover-v2-671b";
    // The loop reuses one messages array; keep a copy of what each call saw.
    const seen: { messages: { role: string; content: string }[]; maxTokens?: number; timeoutMs?: number }[] = [];
    const replies = [
      "Plan…\n```lean4\ntheorem t (n : ℕ) : n + 0 = n := by\n  rfl_bad\n```",
      "Fixed:\n```lean4\ntheorem t (n : ℕ) : n + 0 = n := by\n  simp\n```",
    ];
    sampleMock.mockImplementation(async (a: { messages: { role: string; content: string }[]; maxTokens?: number; timeoutMs?: number }) => {
      seen.push({ ...a, messages: a.messages.map((m) => ({ ...m })) });
      return [replies[seen.length - 1]];
    });
    verifyMock.mockImplementation(async (_id: string, source: string) =>
      source.includes("simp")
        ? result({ ok: true, status: "ok", axioms: { axioms: [], disallowed: [], usesSorry: false, usesNative: false }, signatureMatch: true })
        : result({ log: "error: unknown tactic", messages: [{ severity: "error", message: "unknown tactic", line: 4, column: 2 }] }),
    );
    const r = await proveWholeTheorem({ sessionId: "s", theoremName: "t", theoremType: "(n : ℕ) : n + 0 = n", problemText: "n plus zero", config: { samples: 1, rounds: 1, timeBudgetMs: 3_600_000, suggest: false } });
    expect(r.ok).toBe(true);
    expect(r.tactics).toBe("simp");
    const first = seen[0];
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0].role).toBe("user");
    expect(first.messages[0].content).toContain("Complete the following Lean 4 code:");
    expect(first.maxTokens).toBe(16384);
    expect(first.timeoutMs).toBe(600000);
    const second = seen[1];
    expect(second.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(second.messages[1].content).toContain("rfl_bad");
    expect(second.messages[2].content).toContain("does not compile");
  });

  it("keeps the chat prompt for a general model", async () => {
    sampleMock.mockResolvedValueOnce(["```lean\ntheorem t (n : ℕ) : n + 0 = n := by\n  simp\n```"]);
    verifyMock.mockResolvedValue(result({ ok: true, status: "ok", signatureMatch: true }));
    await proveWholeTheorem({ sessionId: "s", theoremName: "t", theoremType: "(n : ℕ) : n + 0 = n", config: { samples: 1, rounds: 0, suggest: false } });
    const first = sampleMock.mock.calls[0][0];
    expect(first.messages[0].role).toBe("system");
    expect(first.maxTokens).toBe(4096);
  });
});
