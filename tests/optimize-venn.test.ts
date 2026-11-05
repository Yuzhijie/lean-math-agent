import { describe, expect, it } from "vitest";
import { blockPredicates, describeRegions, objectiveAt, readVennGoal, solveRegions } from "@/lib/lean/optimize/venn";

// the witness goal of "|A| = |B| = |C| = 18, pairwise intersections 6, |U| = 40: max |A △ B △ C|" as Lean prints it
const GOAL =
  "∃ A B C, A.card = (18 : ℕ) ∧ B.card = (18 : ℕ) ∧ C.card = (18 : ℕ) ∧ (A ∩ B).card = (6 : ℕ) ∧ (B ∩ C).card = (6 : ℕ) ∧ (C ∩ A).card = (6 : ℕ) ∧ (34 : ℕ) = ((A \\ B ∪ B \\ A) \\ C ∪ C \\ (A \\ B ∪ B \\ A)).card";

describe("Venn optimisation", () => {
  it("reads the conditions and the value", () => {
    const r = readVennGoal(GOAL, 34)!;
    expect(r.binders).toEqual(["A", "B", "C"]);
    expect(r.problem.conds).toHaveLength(6);
    expect(r.problem.objective.coef.size).toBe(1);
  });

  it("finds region sizes with the value 34 and none with more", () => {
    const { problem } = readVennGoal(GOAL, 34)!;
    const sizes = solveRegions(problem, 40, 34, 34)!;
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(40);
    expect(objectiveAt(problem, sizes)).toBe(34);
    expect(sizes[7]).toBe(4); // all three
    expect(solveRegions(problem, 40, 35, 1000)).toBeUndefined();
    // with a bigger universe the triple part can grow: 18 + 4·6 = 42 at most
    expect(objectiveAt(problem, solveRegions(problem, 60, 35, 1000)!)).toBeGreaterThan(34);
    const preds = blockPredicates(["A", "B", "C"], sizes);
    expect(preds).toHaveLength(3);
    expect(describeRegions(["A", "B", "C"], sizes)).toContain("A∩B∩C: 4");
  });
});
