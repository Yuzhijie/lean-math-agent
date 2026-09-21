import { describe, it, expect } from "vitest";
import { librarySearchSuggestions } from "@/lib/lean/suggest";
import { leanStatus } from "./helpers/lean-env";

// Library-search probes against the real Lean (core only; no Mathlib needed).
const lean = await leanStatus();
const describeLean = lean.canVerify ? describe : describe.skip;
const LEAN_TEST_TIMEOUT = Number(process.env.LEAN_BUILD_TIMEOUT_MS ?? 120_000) + 30_000;

describeLean("librarySearchSuggestions (real Lean)", { timeout: LEAN_TEST_TIMEOUT }, () => {
  it("exact? finds a closing lemma application", async () => {
    const out = await librarySearchSuggestions({
      sessionId: "suggest-exact",
      theoremName: "t",
      theoremType: "(a b c : Nat) (h : a ≤ b) : a ≤ b + c",
      prefixTactics: [],
      useMathlib: false,
    });
    expect(out.unavailable).toBe(false);
    expect(out.suggestions.length).toBeGreaterThan(0);
    expect(out.suggestions[0].probe).toBe("exact?");
    expect(out.suggestions[0].closesGoal).toBe(true);
    expect(out.suggestions[0].tactic).toMatch(/^exact /);
  });

  it("runs after a compiling prefix and reports the goal", async () => {
    const out = await librarySearchSuggestions({
      sessionId: "suggest-prefix",
      theoremName: "t",
      theoremType: "(p q : Prop) (hp : p) (hq : q) : p ∧ q",
      prefixTactics: ["constructor", "· exact hp"],
      useMathlib: false,
      probes: ["exact?"],
    });
    expect(out.suggestions.some((s) => s.closesGoal && /\bhq\b/.test(s.tactic))).toBe(true);
  });

  it("partial apply? suggestions are not reported as closing the goal", async () => {
    const out = await librarySearchSuggestions({
      sessionId: "suggest-partial",
      theoremName: "t",
      theoremType: "(a b c : Nat) (h : a ≤ b) : a ≤ c",
      prefixTactics: [],
      useMathlib: false,
      probes: ["apply?"],
    });
    expect(out.suggestions.length).toBeGreaterThan(0);
    expect(out.suggestions.length).toBeLessThanOrEqual(6);
    expect(out.suggestions.every((s) => !s.closesGoal)).toBe(true);
    expect(out.suggestions.some((s) => s.remainingGoals)).toBe(true);
  });

  it("simp? yields a simp only [...] suggestion", async () => {
    const out = await librarySearchSuggestions({
      sessionId: "suggest-simp",
      theoremName: "t",
      theoremType: "(n : Nat) : n * 1 + 0 = n",
      prefixTactics: [],
      useMathlib: false,
      probes: ["simp?"],
    });
    expect(out.suggestions.some((s) => s.probe === "simp?" && /^simp only \[/.test(s.tactic))).toBe(true);
  });
});
