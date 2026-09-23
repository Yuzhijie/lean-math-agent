import { describe, expect, it } from "vitest";
import { classifyFailure } from "../scripts/bench";
import { convert, difficultyOf, informalOf, opensOf, statementToType } from "../scripts/fetch-benchmark";

describe("fetch-benchmark conversion", () => {
  it("turns a multi-line miniF2F statement into a single-line signature with current syntax", () => {
    const formal = "theorem amc12a_2019_p21 (z : ℂ) (h₀ : z = (1 + Complex.I) / Real.sqrt 2) :\n  ((∑ k : ℤ in Finset.Icc 1 12, z ^ k ^ 2) * (∑ k : ℤ in Finset.Icc 1 12, 1 / z ^ k ^ 2)) = 36 := by\n";
    expect(statementToType(formal, "amc12a_2019_p21")).toBe(
      "(z : ℂ) (h₀ : z = (1 + Complex.I) / Real.sqrt 2) : ((∑ k : ℤ ∈ Finset.Icc 1 12, z ^ k ^ 2) * (∑ k : ℤ ∈ Finset.Icc 1 12, 1 / z ^ k ^ 2)) = 36",
    );
    expect(statementToType("theorem t : 2 + 2 = 4 := by sorry", "t")).toBe(": 2 + 2 = 4");
    expect(statementToType("lemma other : True := by", "t")).toBeUndefined();
  });

  it("collects opens from the header and strips the doc comment", () => {
    expect(opensOf("import Mathlib\nimport Aesop\n\nset_option maxHeartbeats 0\n\nopen BigOperators Real Nat Topology Rat\n\n")).toEqual([
      "BigOperators",
      "Real",
      "Nat",
      "Topology",
      "Rat",
    ]);
    expect(opensOf(undefined)).toEqual([]);
    expect(informalOf("/-- Show that $2+2=4$.\n  Because.-/\n")).toBe("Show that $2+2=4$. Because.");
  });

  it("assigns difficulty by origin and filters by split", () => {
    expect(difficultyOf("imo_1964_p1_2")).toBe("hard");
    expect(difficultyOf("aime_1983_p1")).toBe("hard");
    expect(difficultyOf("amc12a_2015_p10")).toBe("medium");
    expect(difficultyOf("numbertheory_4x3m7y3neq2003")).toBe("medium");
    expect(difficultyOf("mathd_algebra_478")).toBe("easy");
    const file = convert(
      [
        { name: "a", split: "valid", formal_statement: "theorem a : 1 = 1 := by", header: "open Nat\n" },
        { name: "b", split: "test", formal_statement: "theorem b (n : ℕ) : n = n := by", header: "open Real Nat\n", informal_prefix: "/-- b -/" },
        { name: "c", split: "test", formal_statement: "garbage", header: "" },
      ],
      { split: "test", url: "u" },
    );
    expect(file.theorems.map((t) => t.id)).toEqual(["b"]);
    expect(file.theorems[0]).toMatchObject({ type: "(n : ℕ) : n = n", informal: "b", difficulty: "easy" });
    expect(file.opens).toEqual(["Real", "Nat"]);
  });
});

describe("bench failure taxonomy", () => {
  it("buckets Lean errors by kind and honours the coarse verdicts first", () => {
    expect(classifyFailure({ summary: "unknown identifier 'Nat.foo_bar'" }).kind).toBe("unknown_identifier");
    expect(classifyFailure({ summary: "unsolved goals\nn : ℕ\n⊢ n = n" }).kind).toBe("unsolved_goal");
    expect(classifyFailure({ summary: "type mismatch\n  h\nhas type" }).kind).toBe("type_mismatch");
    expect(classifyFailure({ summary: "linarith failed to find a contradiction" }).kind).toBe("tactic_failed");
    expect(classifyFailure({ summary: "", timedOut: true }).kind).toBe("budget_exhausted");
    expect(classifyFailure({ summary: "x", sorry: true }).kind).toBe("sorry_left");
    expect(classifyFailure({ summary: "x", axioms: true }).kind).toBe("axioms");
    expect(classifyFailure({ summary: "x", statementChanged: true }).kind).toBe("statement_changed");
    expect(classifyFailure({ summary: "" }).kind).toBe("other");
    expect(classifyFailure({ summary: "(deterministic) timeout at whnf" }).kind).toBe("timeout");
  });
});
