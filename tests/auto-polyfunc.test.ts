import { describe, expect, it } from "vitest";
import { polySquareEq, polySquareFinishers } from "@/lib/lean/auto/polyfunc";
import { finisherEntries } from "@/lib/lean/auto/rules";
import { parseGoal } from "@/lib/lean/geometry/goal";

const goal = "P : Polynomial ℝ\nh : ∀ (x : ℝ), Polynomial.eval (x ^ 2) P = Polynomial.eval x P ^ 2\nh2 : Polynomial.eval 2 P = 1024\n⊢ P = Polynomial.X ^ 10";

describe("P(x²) = P(x)²", () => {
  it("reads the equation, the value and the asked power", () => {
    expect(polySquareEq(parseGoal(goal)!)).toEqual({ poly: "P", eqHyp: "h", valueHyp: "h2", c: 2, v: 1024n, n: 10 });
  });

  it("one finisher of several lines, offered as the poly-square rule", () => {
    const [t] = polySquareFinishers(parseGoal(goal)!);
    expect(t.split("\n").length).toBeGreaterThan(50);
    expect(t).toContain("rw [show (1024 : ℕ) = 2 ^ 10 by norm_num] at h5");
    expect(finisherEntries(parseGoal(goal)!).find((e) => e.rule === "poly-square")?.tactic).toBe(t);
  });

  it("other names and values; a value that is not cⁿ for the asked n is left alone", () => {
    const g = "Q : Polynomial ℝ\nhQ : ∀ (t : ℝ), Polynomial.eval (t ^ 2) Q = Polynomial.eval t Q ^ 2\nh3 : Polynomial.eval 3 Q = 243\n⊢ Q = Polynomial.X ^ 5";
    expect(polySquareEq(parseGoal(g)!)).toMatchObject({ poly: "Q", c: 3, n: 5 });
    expect(polySquareEq(parseGoal(g.replace("243", "244"))!)).toBeUndefined();
  });
});
