import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LeanVerifyResult } from "@/lib/lean/sandbox";

const { verifyMock } = vi.hoisted(() => ({ verifyMock: vi.fn() }));
vi.mock("@/lib/lean/sandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lean/sandbox")>();
  return { ...actual, verifyLeanSource: verifyMock };
});

import { formatSuggestions, librarySearchSuggestions, parseTryThis } from "@/lib/lean/suggest";
import { proofLayout } from "@/lib/lean/feedback";

function result(partial: Partial<LeanVerifyResult>): LeanVerifyResult {
  return { ok: true, log: "ok", status: "ok", backend: "repl", messages: [], sorries: [], goals: [], infos: [], durationMs: 1, ...partial };
}

beforeEach(() => {
  verifyMock.mockReset();
});

describe("parseTryThis", () => {
  it("reads the Lean ≥ 4.20 tagged format and the old inline format", () => {
    expect(parseTryThis(["Try this:\n  [apply] exact Nat.add_eq_left.mpr rfl"])).toEqual([{ tactic: "exact Nat.add_eq_left.mpr rfl" }]);
    expect(parseTryThis(["Try this: exact Nat.le_trans h h2"])).toEqual([{ tactic: "exact Nat.le_trans h h2" }]);
  });

  it("splits several suggestions in one message and keeps multi-line ones together", () => {
    const infos = [
      "Try this:\n  [apply] refine Nat.le_antisymm ?_ ?_\n  [apply] exact foo\n    bar",
      "unrelated info",
      "Try this:\n  [simp] simp only [Nat.add_zero]",
    ];
    expect(parseTryThis(infos)).toEqual([
      { tactic: "refine Nat.le_antisymm ?_ ?_" },
      { tactic: "exact foo\n  bar" },
      { tactic: "simp only [Nat.add_zero]" },
    ]);
  });

  it("separates the remaining-subgoal comments of partial apply? suggestions", () => {
    const parsed = parseTryThis(["Try this:\n  [apply] refine Nat.le_of_lt_succ ?_\n  -- Remaining subgoals:\n  -- ⊢ a < c.succ"]);
    expect(parsed).toEqual([{ tactic: "refine Nat.le_of_lt_succ ?_", remainingGoals: "⊢ a < c.succ" }]);
  });
});

describe("librarySearchSuggestions (mocked verifier)", () => {
  it("stops after exact? closes the goal and reports closesGoal", async () => {
    verifyMock.mockImplementation(async (_id: string, source: string) =>
      result({ infos: ["Try this:\n  [apply] exact Nat.le_add_right_of_le h"], messages: [] }),
    );
    const out = await librarySearchSuggestions({
      sessionId: "s",
      theoremName: "t",
      theoremType: "(a b c : ℕ) (h : a ≤ b) : a ≤ b + c",
      prefixTactics: [],
      useMathlib: false,
    });
    expect(out.suggestions).toEqual([{ probe: "exact?", tactic: "exact Nat.le_add_right_of_le h", closesGoal: true }]);
    expect(verifyMock).toHaveBeenCalledTimes(1);
    const source = verifyMock.mock.calls[0][1] as string;
    expect(source).toMatch(/:= by\n  exact\?\n/);
    expect(verifyMock.mock.calls[0][2]).toMatchObject({ allowSorry: true, checkAxioms: false, wantSignature: false });
  });

  it("runs apply? and simp? after the prefix when exact? fails, marks partial suggestions and dedupes", async () => {
    verifyMock.mockImplementation(async (_id: string, source: string) => {
      const layout = proofLayout(source)!;
      const last = layout.bodyLines.map((l) => l.trim()).filter(Boolean).pop();
      const probeLine = layout.bodyStart + layout.bodyLines.findIndex((l) => l.trim() === last);
      if (last === "exact?") {
        return result({ messages: [{ severity: "error", line: probeLine, column: 2, message: "`exact?` could not close the goal. Try `apply?` to see partial suggestions." }] });
      }
      if (last === "apply?") {
        // A partial apply? admits the goal (sorry warning, no error) and lists remaining subgoals.
        return result({
          infos: [
            "Try this:\n  [apply] refine Nat.le_trans ?_ h2\n  -- Remaining subgoals:\n  -- ⊢ a ≤ b",
            "Try this:\n  [apply] refine Nat.le_trans ?_ h2\n  -- Remaining subgoals:\n  -- ⊢ a ≤ b",
          ],
          messages: [{ severity: "warning", line: layout.theoremLine, column: 8, message: "declaration uses `sorry`" }],
        });
      }
      if (last === "simp?") {
        return result({ messages: [{ severity: "error", line: probeLine, column: 2, message: "simp made no progress" }] });
      }
      return result({ goals: ["a b c : ℕ\nh : a ≤ b\n⊢ a ≤ c"] }); // the `sorry` goal probe
    });
    const out = await librarySearchSuggestions({
      sessionId: "s",
      theoremName: "t",
      theoremType: "(a b c : ℕ) (h : a ≤ b) (h2 : b ≤ c) : a ≤ c",
      prefixTactics: ["have h3 : a ≤ b := h"],
      useMathlib: false,
    });
    expect(out.suggestions).toEqual([{ probe: "apply?", tactic: "refine Nat.le_trans ?_ h2", closesGoal: false, remainingGoals: "⊢ a ≤ b" }]);
    expect(out.goal).toContain("⊢ a ≤ c");
    // Every probe source keeps the prefix before the probe.
    for (const call of verifyMock.mock.calls) {
      expect(call[1]).toContain("have h3 : a ≤ b := h");
    }
    const text = formatSuggestions(out.suggestions, out.goal);
    expect(text).toContain("- (apply?) refine Nat.le_trans ?_ h2  -- remaining: ⊢ a ≤ b");
    expect(text).toContain("⊢ a ≤ c");
  });

  it("reports unavailable Lean and never throws", async () => {
    verifyMock.mockResolvedValue(result({ ok: false, status: "unavailable", log: "no lake" }));
    const out = await librarySearchSuggestions({ sessionId: "s", theoremName: "t", theoremType: ": True", prefixTactics: [] });
    expect(out.unavailable).toBe(true);
    expect(out.suggestions).toEqual([]);

    verifyMock.mockRejectedValue(new Error("crash"));
    const out2 = await librarySearchSuggestions({ sessionId: "s", theoremName: "t", theoremType: ": True", prefixTactics: [] });
    expect(out2.suggestions).toEqual([]);
    expect(formatSuggestions([])).toBe("");
  });
});
