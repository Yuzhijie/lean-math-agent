import { describe, it, expect } from "vitest";
import { assembleLeanSource } from "@/lib/lean/assemble";
import {
  compilingPrefix,
  dedent,
  formatVerificationFeedback,
  proofLayout,
  summarizeFailure,
  tacticLineOf,
} from "@/lib/lean/feedback";
import type { LeanVerifyResult } from "@/lib/lean/sandbox";

function result(partial: Partial<LeanVerifyResult>): LeanVerifyResult {
  return {
    ok: false,
    log: "",
    status: "fail",
    backend: "repl",
    messages: [],
    sorries: [],
    goals: [],
    infos: [],
    durationMs: 1,
    ...partial,
  };
}

// header comment (1) + 3 imports (2-4) + blank (5) + theorem (6) + body from 7
const SOURCE = assembleLeanSource({
  theoremName: "t",
  theoremType: "(a b : ℕ) (h : a ≤ b) : a * a ≤ b * b",
  stepCodes: ["have h2 : a ≤ b := h\nrw [foo]\nexact Nat.mul_le_mul h h"],
  useMathlib: true,
});

describe("proofLayout", () => {
  it("locates the theorem line and the tactic body", () => {
    const layout = proofLayout(SOURCE)!;
    expect(layout.theoremLine).toBe(6);
    expect(layout.bodyStart).toBe(7);
    expect(layout.bodyLines.slice(0, 3)).toEqual(["  have h2 : a ≤ b := h", "  rw [foo]", "  exact Nat.mul_le_mul h h"]);
    expect(tacticLineOf({ severity: "error", line: 8, column: 2, message: "" }, layout)).toBe(2);
    expect(tacticLineOf({ severity: "error", line: 3, column: 0, message: "" }, layout)).toBeUndefined();
  });

  it("returns undefined for sources without a tactic proof", () => {
    expect(proofLayout("theorem t : True := trivial")).toBeUndefined();
  });
});

describe("formatVerificationFeedback", () => {
  it("reports errors relative to the proof with the offending line, then open goals", () => {
    const r = result({
      messages: [
        { severity: "error", line: 8, column: 2, message: "unknown identifier 'foo'" },
        { severity: "error", line: 6, column: 50, message: "unsolved goals\na b : ℕ\n⊢ a * a ≤ b * b" },
        { severity: "warning", line: 6, column: 0, message: "declaration uses 'sorry'" },
      ],
      sorries: [{ line: 9, column: 2, goal: "a b : ℕ\nh : a ≤ b\n⊢ a * a ≤ b * b" }],
    });
    const text = formatVerificationFeedback(r, SOURCE);
    expect(text).toContain("Lean reported 2 errors.");
    expect(text).toContain("Error 1 (proof line 2: `rw [foo]`):\n  unknown identifier 'foo'");
    expect(text).toContain("Error 2 (at the theorem statement / whole proof):");
    expect(text).toContain("Goals still open at `sorry` (1):");
    expect(text).toContain("⊢ a * a ≤ b * b");
    // The sorry warning is noise for the model.
    expect(text).not.toContain("declaration uses");
  });

  it("explains textual rejections and truncates long output", () => {
    const r = result({ rejected: "source contains `sorry`; final verify requires a complete proof" });
    expect(formatVerificationFeedback(r, SOURCE)).toContain("rejected before Lean ran: source contains `sorry`");
    const long = result({
      messages: Array.from({ length: 20 }, (_, i) => ({ severity: "error" as const, line: 7, column: 0, message: "x".repeat(500) + i })),
    });
    const text = formatVerificationFeedback(long, SOURCE, { maxMessages: 3, maxChars: 800 });
    expect(text.length).toBeLessThanOrEqual(802);
    expect(text).toContain("Lean reported 20 errors (showing the first 3).");
  });

  it("summarizeFailure gives one line", () => {
    expect(summarizeFailure(result({ ok: true }))).toBe("ok");
    expect(summarizeFailure(result({ messages: [{ severity: "error", line: 7, column: 0, message: "boom\ndetails" }] }))).toBe("boom");
    expect(summarizeFailure(result({ rejected: "no" }))).toBe("no");
    expect(summarizeFailure(result({ log: "raw log" }))).toBe("raw log");
  });
});

describe("compilingPrefix", () => {
  it("is the tactics before the first failing one", () => {
    const r = result({ messages: [{ severity: "error", line: 8, column: 2, message: "unknown identifier 'foo'" }] });
    expect(compilingPrefix(r, SOURCE)).toEqual(["have h2 : a ≤ b := h"]);
  });

  it("is empty when the first tactic fails, and the lines before `sorry` for partial proofs", () => {
    const first = result({ messages: [{ severity: "error", line: 7, column: 2, message: "nope" }] });
    expect(compilingPrefix(first, SOURCE)).toEqual([]);

    const src = assembleLeanSource({ theoremName: "t", theoremType: ": True ∧ True", stepCodes: ["constructor\n· trivial\n· sorry"] });
    const partial = result({ sorries: [{ line: 4, column: 4, goal: "⊢ True" }] });
    expect(compilingPrefix(partial, src)).toEqual(["constructor", "· trivial"]);
  });

  it("is the whole body when only 'unsolved goals' at the theorem line remains, undefined when fine", () => {
    const r = result({ messages: [{ severity: "error", line: 6, column: 40, message: "unsolved goals\n⊢ False" }] });
    expect(compilingPrefix(r, SOURCE)).toEqual(["have h2 : a ≤ b := h", "rw [foo]", "exact Nat.mul_le_mul h h"]);
    expect(compilingPrefix(result({ ok: true, status: "ok" }), SOURCE)).toBeUndefined();
  });

  it("dedent removes common indentation only", () => {
    expect(dedent(["    a", "      b", "", "    c"])).toEqual(["a", "  b", "", "c"]);
  });
});
