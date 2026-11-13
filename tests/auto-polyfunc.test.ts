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

  it("a name the script binds itself is renamed when the statement already uses it", () => {
    // `h3` is the value hypothesis here and a binder of the script: the statement used to be refused
    const g = "Q : Polynomial ℝ\nhQ : ∀ (t : ℝ), Polynomial.eval (t ^ 2) Q = Polynomial.eval t Q ^ 2\nh3 : Polynomial.eval 3 Q = 243\n⊢ Q = Polynomial.X ^ 5";
    const [t] = polySquareFinishers(parseGoal(g)!);
    expect(t).toContain("have h4 := h3\n");
    expect(t).toContain("have h3_pf : Q.coeff (S.max' hS) * Q.coeff Q.natDegree = 0");
    expect(t).toContain("exact mul_ne_zero hmc hpf_lead h3_pf");
    expect(t).toContain("rw [show (243 : ℕ) = 3 ^ 5 by norm_num] at h5");
    expect(t).not.toMatch(/hpf_[PHV]\b/);
    // the ∀ … → … form after the search's own `intro P`, `intro h1`, `intro h2`
    const g2 = goal.replace("\nh :", "\nh1 :");
    const [u] = polySquareFinishers(parseGoal(g2)!);
    expect(u).toContain("simp [Polynomial.eval_comp, h1]");
    expect(u).toContain("rintro ⟨i, j⟩ hij ⟨h1_pf, h2'⟩");
    expect(u).toContain("apply h1_pf");
    expect(u).toContain("have h1_pf := h1 1");
    expect(u).toContain("linear_combination -h1_pf");
    expect(u).toContain("have h4 := h2\n");
    // a polynomial called S: the script's own set S moves, `P.natDegree` becomes `S.natDegree`
    const [w] = polySquareFinishers(parseGoal(goal.replace(/\bP\b/g, "S"))!);
    expect(w).toContain("let S_pf := (Finset.range S.natDegree).filter (fun j => S.coeff j ≠ 0)");
    expect(w).toContain("S_pf.max' hS");
    // without a clash the script is what it was
    expect(polySquareFinishers(parseGoal(goal)!)[0]).not.toContain("_pf");
    // names the renaming itself would produce are left alone
    expect(polySquareFinishers(parseGoal(goal.replace("\nh :", "\nh1_pf :"))!)).toEqual([]);
  });
});
