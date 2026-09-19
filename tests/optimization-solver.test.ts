import { describe, it, expect } from "vitest";
import {
  solveOptimization,
  type OptimizationStructure,
} from "../lib/compute/optimization-solver";

// ── Helper ──────────────────────────────────────────────────────────

function makeStructure(overrides: Partial<OptimizationStructure> = {}): OptimizationStructure {
  return {
    objective: "maximize",
    objective_coefficients: { m: 3, n: 4 },
    objective_description: "最大化 3m+4n",
    target_sum: 1987,
    target_description: "所有数总和为1987",
    categories: [
      {
        id: "even",
        count_variable: "m",
        integer_type: "even",
        min_sum_formula: "m(m+1)",
      },
      {
        id: "odd",
        count_variable: "n",
        integer_type: "odd",
        min_sum_formula: "n²",
      },
    ],
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("optimization-solver", () => {
  it("solves the 1987 problem: max 3m+4n = 221", () => {
    const result = solveOptimization(makeStructure());

    expect(result.is_feasible).toBe(true);
    expect(result.optimal_value).toBe(221);
    expect(result.assignments.m).toBe(27);
    expect(result.assignments.n).toBe(35);
  });

  it("returns feasible example sets that sum to target", () => {
    const result = solveOptimization(makeStructure());

    expect(result.is_feasible).toBe(true);
    const evenSet = result.example_sets.m;
    const oddSet = result.example_sets.n;

    // All evens
    expect(evenSet.every((x) => x > 0 && x % 2 === 0)).toBe(true);
    // All odds
    expect(oddSet.every((x) => x > 0 && x % 2 === 1)).toBe(true);

    // Distinct within each set
    expect(new Set(evenSet).size).toBe(evenSet.length);
    expect(new Set(oddSet).size).toBe(oddSet.length);

    // Total sum = 1987
    const totalSum = evenSet.reduce((a, b) => a + b, 0) + oddSet.reduce((a, b) => a + b, 0);
    expect(totalSum).toBe(1987);
  });

  it("handles even target sum (n must be even)", () => {
    const result = solveOptimization(
      makeStructure({ target_sum: 1988 }),
    );

    expect(result.is_feasible).toBe(true);
    // n must be even for target_sum = 1988
    expect(result.assignments.n % 2).toBe(0);
  });

  it("handles single category (only evens) - infeasible for odd target", () => {
    const result = solveOptimization(
      makeStructure({
        objective_coefficients: { m: 1 },
        categories: [
          {
            id: "even",
            count_variable: "m",
            integer_type: "even",
            min_sum_formula: "m(m+1)",
          },
        ],
      }),
    );

    // Sum of m distinct positive evens is always even, can never equal 1987 (odd)
    expect(result.is_feasible).toBe(false);
  });

  it("handles integer type category", () => {
    const result = solveOptimization({
      objective: "maximize",
      objective_coefficients: { k: 1 },
      objective_description: "最大化 k",
      target_sum: 100,
      target_description: "总和为100",
      categories: [
        {
          id: "ints",
          count_variable: "k",
          integer_type: "integer",
          min_sum_formula: "k(k+1)/2",
        },
      ],
    });

    expect(result.is_feasible).toBe(true);
    // max k such that k(k+1)/2 ≤ 100 → k = 13 (13*14/2=91), remainder=9
    expect(result.assignments.k).toBe(13);
    expect(result.optimal_value).toBe(13);
  });

  it("handles minimization objective", () => {
    const result = solveOptimization({
      objective: "minimize",
      objective_coefficients: { m: 1, n: 1 },
      objective_description: "最小化 m+n",
      target_sum: 100,
      target_description: "总和为100",
      categories: [
        {
          id: "even",
          count_variable: "m",
          integer_type: "even",
          min_sum_formula: "m(m+1)",
        },
        {
          id: "odd",
          count_variable: "n",
          integer_type: "odd",
          min_sum_formula: "n²",
        },
      ],
    });

    expect(result.is_feasible).toBe(true);
    // Should find minimum m+n
    expect(result.optimal_value).toBeLessThanOrEqual(20);
  });
});
