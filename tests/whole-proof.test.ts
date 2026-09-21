import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LeanVerifyResult } from "@/lib/lean/sandbox";

const { sampleMock, verifyMock, suggestMock } = vi.hoisted(() => ({
  sampleMock: vi.fn(),
  verifyMock: vi.fn(),
  suggestMock: vi.fn(),
}));

vi.mock("@/lib/llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/client")>();
  return { ...actual, sampleText: sampleMock };
});
vi.mock("@/lib/lean/sandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lean/sandbox")>();
  return { ...actual, verifyLeanSource: verifyMock };
});
vi.mock("@/lib/lean/suggest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lean/suggest")>();
  return { ...actual, librarySearchSuggestions: suggestMock };
});

import { extractTactics, proveWholeTheorem, loadWholeProofConfig } from "@/lib/prover/whole-proof";
import { proofLayout } from "@/lib/lean/feedback";

const NAME = "amgm";
const TYPE = "(x y : ℝ) : x * y ≤ (x ^ 2 + y ^ 2) / 2";
const SIG = "∀ (x y : ℝ), x * y ≤ (x ^ 2 + y ^ 2) / 2";

function result(partial: Partial<LeanVerifyResult>): LeanVerifyResult {
  return { ok: false, log: "", status: "fail", backend: "repl", messages: [], sorries: [], goals: [], infos: [], durationMs: 1, ...partial };
}
const OK = result({ ok: true, status: "ok", log: "ok", axioms: { axioms: ["propext"], disallowed: [], usesSorry: false, usesNative: false }, signature: SIG, signatureMatch: true });

/** Tactic block of an assembled source (what the verifier was given). */
function tacticsOf(source: string): string {
  const layout = proofLayout(source)!;
  return layout.bodyLines.map((l) => l.replace(/^ {2}/, "")).join("\n").trim();
}

beforeEach(() => {
  sampleMock.mockReset();
  verifyMock.mockReset();
  suggestMock.mockReset();
  suggestMock.mockResolvedValue({ suggestions: [], unavailable: false, durationMs: 0 });
  delete process.env.WHOLE_PROOF_SAMPLES;
  delete process.env.WHOLE_PROOF_ROUNDS;
});

describe("extractTactics", () => {
  it("takes the tactic block from a fenced complete theorem", () => {
    const text = "Here is the proof:\n```lean\ntheorem amgm (x y : ℝ) : x * y ≤ (x ^ 2 + y ^ 2) / 2 := by\n  nlinarith [sq_nonneg (x - y)]\n```\nDone.";
    expect(extractTactics(text)).toBe("nlinarith [sq_nonneg (x - y)]");
  });

  it("drops imports/options, turns `open` into an `open … in` tactic and keeps nested indentation", () => {
    const text = "```lean4\nimport Mathlib\nset_option maxHeartbeats 400000\nopen Real Nat\n\ntheorem t (n : ℕ) : n = n := by\n  induction n with\n  | zero => rfl\n  | succ k ih =>\n    simp\n```";
    expect(extractTactics(text)).toBe("open Real Nat in\ninduction n with\n| zero => rfl\n| succ k ih =>\n  simp");
  });

  it("wraps term-mode proofs in exact, accepts raw tactics and a lone `by`", () => {
    expect(extractTactics("theorem t (n : ℕ) : n + 0 = n := Nat.add_zero n")).toBe("exact Nat.add_zero n");
    expect(extractTactics("  simp\n  ring")).toBe("simp\nring");
    expect(extractTactics("by\n  omega")).toBe("omega");
    expect(extractTactics("theorem t : True := by trivial")).toBe("trivial");
  });

  it("picks the block that holds the proof when several fences are present", () => {
    const text = "Goal:\n```\nn : ℕ\n⊢ n + 0 = n\n```\nProof:\n```lean\ntheorem t (n : ℕ) : n + 0 = n := by\n  simp\n```\nExplanation:\n```\nsimp closes it\n```";
    expect(extractTactics(text)).toBe("simp");
    // An unterminated first fence must not swallow the real block.
    const nested = "```lean\ntheorem in Lean 4 with Mathlib.\n\n```lean\ntheorem t (n : ℕ) : n + 0 = n := by\n  omega\n```";
    expect(extractTactics(nested)).toBe("omega");
  });

  it("cuts trailing declarations and rejects forbidden commands or empty output", () => {
    expect(extractTactics("```lean\ntheorem t : True := by\n  trivial\n\ntheorem helper : True := by\n  trivial\n```")).toBe("trivial");
    expect(extractTactics("```lean\ntheorem t : True := by\n  trivial\n#eval IO.println \"x\"\n```")).toBe("trivial");
    expect(extractTactics("```lean\ntheorem t : True := by\n  native_decide\n```")).toBe("native_decide"); // caught by the axiom check, not the sanitizer
    expect(extractTactics("```lean\ntheorem t : True := by\n  run_tac pwn\n```")).toBeUndefined();
    expect(extractTactics("I cannot prove this.")).toBe("I cannot prove this."); // verification will reject it
    expect(extractTactics("```lean\n```")).toBeUndefined();
  });
});

describe("loadWholeProofConfig", () => {
  it("reads env defaults and lets overrides win", () => {
    process.env.WHOLE_PROOF_SAMPLES = "6";
    process.env.WHOLE_PROOF_ROUNDS = "1";
    expect(loadWholeProofConfig()).toMatchObject({ samples: 6, rounds: 1, temperature: 0.8, suggest: true });
    expect(loadWholeProofConfig({ samples: 2, rounds: 0, suggest: false })).toMatchObject({ samples: 2, rounds: 0, suggest: false });
  });
});

describe("proveWholeTheorem", () => {
  it("succeeds in round 0 when one of the sampled proofs verifies (statement lock applied)", async () => {
    sampleMock.mockResolvedValueOnce([
      "```lean\ntheorem amgm (x y : ℝ) : x * y ≤ (x ^ 2 + y ^ 2) / 2 := by\n  linarith\n```",
      "```lean\ntheorem amgm (x y : ℝ) : x * y ≤ (x ^ 2 + y ^ 2) / 2 := by\n  nlinarith [sq_nonneg (x - y)]\n```",
    ]);
    verifyMock.mockImplementation(async (_id: string, source: string) =>
      /nlinarith/.test(source)
        ? OK
        : result({ messages: [{ severity: "error", line: 7, column: 2, message: "linarith failed" }] }),
    );

    const r = await proveWholeTheorem({
      sessionId: "s",
      theoremName: NAME,
      theoremType: TYPE,
      expectedSignature: SIG,
      initialGoal: "x y : ℝ\n⊢ x * y ≤ (x ^ 2 + y ^ 2) / 2",
      config: { samples: 2, rounds: 2 },
    });

    expect(r.ok).toBe(true);
    expect(r.tactics).toBe("nlinarith [sq_nonneg (x - y)]");
    expect(r.rounds).toBe(1);
    expect(r.samples).toBe(2);
    expect(r.candidates.map((c) => c.ok)).toEqual([false, true]);
    expect(r.source).toContain(`theorem ${NAME} ${TYPE} := by`);
    // Every verification is the strict one with the statement lock.
    for (const call of verifyMock.mock.calls) {
      expect(call[2]).toMatchObject({ theoremName: NAME, expectedSignature: SIG });
      expect(call[2].allowSorry).toBeFalsy();
    }
    // The prover role, temperature sampling, and the goal state in the prompt.
    expect(sampleMock).toHaveBeenCalledTimes(1);
    const args = sampleMock.mock.calls[0][0];
    expect(args.role).toBe("prover");
    expect(args.n).toBe(2);
    expect(args.messages[1].content).toContain("⊢ x * y ≤ (x ^ 2 + y ^ 2) / 2");
    expect(args.messages[1].content).toContain(`theorem ${NAME} ${TYPE} := by\n  sorry`);
  });

  it("repairs with Lean feedback and library-search suggestions, then succeeds", async () => {
    sampleMock
      .mockResolvedValueOnce(["```lean\ntheorem amgm (x y : ℝ) : x * y ≤ (x ^ 2 + y ^ 2) / 2 := by\n  have h := sq_nonneg (x - y)\n  rw [foo] at h\n  linarith\n```"])
      .mockResolvedValueOnce(["```lean\ntheorem amgm (x y : ℝ) : x * y ≤ (x ^ 2 + y ^ 2) / 2 := by\n  have h := sq_nonneg (x - y)\n  nlinarith [h]\n```"]);
    verifyMock.mockImplementation(async (_id: string, source: string) => {
      const t = tacticsOf(source);
      if (/nlinarith/.test(t)) return OK;
      // error on the second tactic line: header(1) + 3 imports + blank + theorem(6) → body starts at 7
      return result({ messages: [{ severity: "error", line: 8, column: 6, message: "unknown identifier 'foo'" }] });
    });
    suggestMock.mockResolvedValueOnce({
      suggestions: [{ probe: "exact?", tactic: "nlinarith [h]", closesGoal: true }],
      goal: "h : 0 ≤ (x - y) ^ 2\n⊢ x * y ≤ (x ^ 2 + y ^ 2) / 2",
      unavailable: false,
      durationMs: 3,
    });

    const progress: string[] = [];
    const r = await proveWholeTheorem({
      sessionId: "s",
      theoremName: NAME,
      theoremType: TYPE,
      config: { samples: 1, rounds: 2 },
      onProgress: (p) => progress.push(`${p.round}:${p.status}`),
    });

    expect(r.ok).toBe(true);
    expect(r.rounds).toBe(2);
    expect(r.samples).toBe(2);
    expect(r.suggestions).toEqual(["nlinarith [h]"]);
    expect(progress).toEqual(["0:sampling", "0:verifying", "0:fail", "0:searching", "1:sampling", "1:verifying", "1:ok"]);

    // The suggestion probe ran after the compiling prefix (before the failing line).
    expect(suggestMock).toHaveBeenCalledTimes(1);
    expect(suggestMock.mock.calls[0][0]).toMatchObject({ theoremName: NAME, prefixTactics: ["have h := sq_nonneg (x - y)"] });

    // The repair prompt: previous attempt, positioned error, suggestion; conversation stays short.
    const repair = sampleMock.mock.calls[1][0].messages;
    expect(repair).toHaveLength(3);
    expect(repair[2].content).toContain("Repair round 1");
    expect(repair[2].content).toContain("rw [foo] at h");
    expect(repair[2].content).toContain("proof line 2: `rw [foo] at h`");
    expect(repair[2].content).toContain("unknown identifier 'foo'");
    expect(repair[2].content).toContain("(exact?, closes the goal) nlinarith [h]");
  });

  it("gives up after the configured rounds with the failure history", async () => {
    sampleMock.mockResolvedValue(["```lean\ntheorem amgm (x y : ℝ) : x * y ≤ (x ^ 2 + y ^ 2) / 2 := by\n  simp\n```"]);
    verifyMock.mockResolvedValue(result({ messages: [{ severity: "error", line: 7, column: 2, message: "simp made no progress" }] }));
    const r = await proveWholeTheorem({ sessionId: "s", theoremName: NAME, theoremType: TYPE, config: { samples: 1, rounds: 1, suggest: false } });
    expect(r.ok).toBe(false);
    expect(r.unavailable).toBe(false);
    // Identical tactics are not re-verified; the second round produced nothing new.
    expect(verifyMock).toHaveBeenCalledTimes(1);
    expect(r.candidates).toHaveLength(1);
    expect(r.log).toContain("simp made no progress");
    expect(suggestMock).not.toHaveBeenCalled();
  });

  it("reports Lean unavailable and skips repairs", async () => {
    sampleMock.mockResolvedValue(["```lean\ntheorem amgm (x y : ℝ) : x * y ≤ (x ^ 2 + y ^ 2) / 2 := by\n  nlinarith\n```"]);
    verifyMock.mockResolvedValue(result({ status: "unavailable", log: "no lake" }));
    const r = await proveWholeTheorem({ sessionId: "s", theoremName: NAME, theoremType: TYPE, config: { samples: 1, rounds: 3 } });
    expect(r.ok).toBe(false);
    expect(r.unavailable).toBe(true);
    expect(sampleMock).toHaveBeenCalledTimes(1);
  });

  it("re-verifies sorry-rejected candidates with allowSorry to expose open goals for the repair prompt", async () => {
    sampleMock
      .mockResolvedValueOnce(["```lean\ntheorem amgm (x y : ℝ) : x * y ≤ (x ^ 2 + y ^ 2) / 2 := by\n  have h := sq_nonneg (x - y)\n  sorry\n```"])
      .mockResolvedValueOnce(["```lean\ntheorem amgm (x y : ℝ) : x * y ≤ (x ^ 2 + y ^ 2) / 2 := by\n  nlinarith [sq_nonneg (x - y)]\n```"]);
    verifyMock.mockImplementation(async (_id: string, source: string, opts?: { allowSorry?: boolean }) => {
      if (/nlinarith/.test(source)) return OK;
      if (opts?.allowSorry) {
        return result({ ok: true, status: "ok", sorries: [{ line: 8, column: 2, goal: "h : 0 ≤ (x - y) ^ 2\n⊢ x * y ≤ (x ^ 2 + y ^ 2) / 2" }], goals: ["…"] });
      }
      return result({ rejected: "source contains `sorry`; final verify requires a complete proof", log: "sorry" });
    });
    const r = await proveWholeTheorem({ sessionId: "s", theoremName: NAME, theoremType: TYPE, config: { samples: 1, rounds: 1, suggest: false } });
    expect(r.ok).toBe(true);
    const repair = sampleMock.mock.calls[1][0].messages[2].content as string;
    expect(repair).toContain("Goals still open at `sorry`");
    expect(repair).toContain("⊢ x * y ≤ (x ^ 2 + y ^ 2) / 2");
  });

  it("stops when the time budget is spent and surfaces LLM failures as a non-result", async () => {
    sampleMock.mockRejectedValue(new Error("LLM HTTP 500: down"));
    const r = await proveWholeTheorem({ sessionId: "s", theoremName: NAME, theoremType: TYPE, config: { samples: 1, rounds: 1 } });
    expect(r.ok).toBe(false);
    expect(r.log).toContain("sampling failed");
    expect(verifyMock).not.toHaveBeenCalled();
  });
});
