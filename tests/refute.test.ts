import { afterAll, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { parseCounterexample, refuteStatement, statementToProp } from "@/lib/lean/refute";
import { canonicalSignature } from "@/lib/llm/autoformalize";
import { shutdownReplPool } from "@/lib/lean/repl";
import { clearVerificationCache, resetLeanAvailability, verifyLeanSource } from "@/lib/lean/sandbox";

const FAKE = path.resolve(__dirname, "fixtures/fake-repl.mjs");

describe("statementToProp", () => {
  it("turns a signature into one proposition", () => {
    expect(statementToProp("(n : ℕ) (h : 0 < n) : n ^ 2 ≥ n")).toBe("∀ (n : ℕ) (h : 0 < n), n ^ 2 ≥ n");
    expect(statementToProp(": ∀ n < 5, n * n < 20")).toBe("∀ n < 5, n * n < 20");
    expect(statementToProp("(f : ℕ → ℕ) (h : ∀ x, f x = x) : f 3 = 3")).toBe("∀ (f : ℕ → ℕ) (h : ∀ x, f x = x), f 3 = 3");
    expect(statementToProp("(s : Finset ℕ) : s.card ≤ s.card + 1")).toBe("∀ (s : Finset ℕ), s.card ≤ s.card + 1");
  });

  it("rejects malformed signatures", () => {
    expect(statementToProp("")).toBeUndefined();
    expect(statementToProp("(n : ℕ)")).toBeUndefined();
    expect(statementToProp("(n : ℕ) :")).toBeUndefined();
  });
});

describe("parseCounterexample", () => {
  it("keeps the assignments and the issue line", () => {
    expect(parseCounterexample("Found a counter-example!\nn := 0\nm := 3\nissue: 0 < 0 does not hold\n(0 shrinks)")).toBe(
      "n := 0; m := 3; issue: 0 < 0 does not hold",
    );
    expect(parseCounterexample("nothing here")).toBeUndefined();
  });
});

describe("canonicalSignature", () => {
  it("renames bound variables positionally", () => {
    expect(canonicalSignature("∀ (n : ℕ), n + 0 = n")).toBe(canonicalSignature("∀ (m : ℕ), m + 0 = m"));
    expect(canonicalSignature("∀ (a b : ℝ) (h : a < b), a ^ 2 < b ^ 2")).toBe(canonicalSignature("∀ (x y : ℝ) (hxy : x < y), x ^ 2 < y ^ 2"));
    expect(canonicalSignature("∀ (n : ℕ), n + 0 = n")).not.toBe(canonicalSignature("∀ (n : ℕ), 0 + n = n"));
    // Namespaced constants are not variables.
    expect(canonicalSignature("∀ (p : ℕ), Nat.Prime p → 2 ≤ p")).toContain("Nat.Prime _v0");
  });
});

describe("refuteStatement (fake REPL)", () => {
  beforeEach(() => {
    process.env.LEAN_REPL_COMMAND = `${process.execPath} ${FAKE}`;
    process.env.LEAN_SERVER_MODE = "server";
    clearVerificationCache();
    resetLeanAvailability();
    shutdownReplPool();
  });
  afterAll(() => {
    shutdownReplPool();
    delete process.env.LEAN_REPL_COMMAND;
  });

  it("reports a decide refutation", async () => {
    const r = await refuteStatement("t", "(n : Nat) : FALSE_STMT n");
    expect(r.verdict).toBe("refuted");
    expect(r.method).toBe("decide");
  });

  it("reports a decidably true statement as confirmed", async () => {
    const r = await refuteStatement("t", ": TRUE_STMT");
    expect(r.verdict).toBe("confirmed");
    expect(r.method).toBe("decide");
  });

  it("falls through to plausible and extracts the counterexample", async () => {
    const r = await refuteStatement("t", "(n : Nat) : PLAUSIBLE_CE n");
    expect(r.verdict).toBe("refuted");
    expect(r.method).toBe("plausible");
    expect(r.counterexample).toBe("n := 0; issue: 0 < 0 does not hold");
  });

  it("reports no counterexample when plausible stays silent", async () => {
    const r = await refuteStatement("t", "(n : Nat) : PLAUSIBLE_OK n");
    expect(r.verdict).toBe("no_counterexample");
  });

  it("is inconclusive when neither probe applies, and skips plausible without Mathlib", async () => {
    const r = await refuteStatement("t", "(x : Real) : 0 ≤ x ^ 2");
    expect(r.verdict).toBe("inconclusive");
    expect(r.detail).toContain("decide");
    expect(r.detail).toContain("plausible");
    const core = await refuteStatement("t", "(n : Nat) : PLAUSIBLE_CE n", { useMathlib: false });
    expect(core.verdict).toBe("inconclusive");
    expect(core.detail).not.toContain("plausible");
  });

  it("never lets a malformed statement reach Lean", async () => {
    const r = await refuteStatement("t", "(n : Nat) : n = n := by rfl");
    expect(r.verdict).toBe("inconclusive");
  });

  it("survives a stray stdout line before the REPL response", async () => {
    const r = await verifyLeanSource("noise", "import Mathlib\n\ntheorem t : True := by\n  trivial -- STDOUT_NOISE", { theoremName: "t" });
    expect(r.ok).toBe(true);
  });
});
