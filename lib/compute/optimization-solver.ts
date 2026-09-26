// ── Combinatorial Optimization Solver ──────────────────────────────────
//
// Solves problems of the form:
//   "Choose m₁ items from category 1, m₂ from category 2, ...
//    such that total sum = S. Maximize Σ wᵢ·mᵢ."
//
// Deterministic search — no LLM guesswork.

import { lt } from "../llm/output-locale";

// ── Types ─────────────────────────────────────────────────────────────

export interface OptimizationCategory {
  id: string;
  count_variable: string;
  integer_type: "even" | "odd" | "integer";
  min_sum_formula: string;
}

export interface OptimizationStructure {
  objective: "maximize" | "minimize";
  objective_coefficients: Record<string, number>;
  objective_description: string;
  target_sum: number;
  target_description: string;
  categories: OptimizationCategory[];
  key_insight?: string;
}

export interface OptimizationResult {
  optimal_value: number;
  assignments: Record<string, number>;
  is_feasible: boolean;
  reasoning: string;
  example_sets: Record<string, number[]>;
}

// ── Minimum Sum Formulas ──────────────────────────────────────────────

/** Minimum sum of k distinct positive integers of the given type. */
function minSum(type: "even" | "odd" | "integer", k: number): number {
  if (k <= 0) return 0;
  switch (type) {
    case "even":
      // 2 + 4 + ... + 2k = k(k+1)
      return k * (k + 1);
    case "odd":
      // 1 + 3 + ... + (2k-1) = k²
      return k * k;
    case "integer":
      // 1 + 2 + ... + k = k(k+1)/2
      return (k * (k + 1)) / 2;
  }
}

/** Maximum k such that minSum(type, k) ≤ budget. */
function maxCount(type: "even" | "odd" | "integer", budget: number): number {
  if (budget <= 0) return 0;
  let lo = 1;
  let hi = Math.ceil(Math.sqrt(budget)) + 2;
  while (minSum(type, hi) <= budget) hi *= 2;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (minSum(type, mid) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Step size for adjusting sum within a category (must preserve parity). */
function stepSize(type: "even" | "odd" | "integer"): number {
  return type === "integer" ? 1 : 2;
}

/**
 * Whether we can achieve a specific sum with k items of the given type.
 * remainder = desired_sum - minSum(type, k)
 * Must be ≥ 0 and divisible by stepSize.
 */
function isAchievable(
  type: "even" | "odd" | "integer",
  k: number,
  remainder: number,
): boolean {
  if (remainder < 0) return false;
  if (k === 0) return remainder === 0;
  return remainder % stepSize(type) === 0;
}

// ── Feasibility Check (parity-aware) ──────────────────────────────────

/**
 * For a two-category problem, determine whether (k₁, k₂) is feasible.
 *
 * The sum of k "even" items is always even.
 * The sum of k "odd" items has the same parity as k.
 * The sum of k "integer" items can be any parity (for k ≥ 2).
 *
 * So the total parity constraint depends on the types.
 */
function isParityFeasible(
  cat1: OptimizationCategory,
  k1: number,
  cat2: OptimizationCategory,
  k2: number,
  targetSum: number,
): boolean {
  const min1 = minSum(cat1.integer_type, k1);
  const min2 = minSum(cat2.integer_type, k2);
  const remainder = targetSum - min1 - min2;

  if (remainder < 0) return false;

  // The remainder must be distributable as adjustments to the two sets.
  // Each adjustment to an even/odd set changes the sum by 2.
  // Each adjustment to an integer set changes the sum by 1.
  const step1 = stepSize(cat1.integer_type);
  const step2 = stepSize(cat2.integer_type);

  // If both have step=2, remainder must be even.
  // If at least one has step=1, any remainder ≥ 0 is achievable.
  if (step1 === 2 && step2 === 2) {
    return remainder % 2 === 0;
  }
  // If one has step=1, we can distribute the odd part to that category.
  return true;
}

// ── Main Solver ───────────────────────────────────────────────────────

export function solveOptimization(
  structure: OptimizationStructure,
): OptimizationResult {
  const { objective_coefficients, target_sum, categories } = structure;
  const isMaximize = structure.objective === "maximize";

  // Sort categories by weight (descending) so we iterate over the
  // highest-weight category and greedily assign the rest.
  const sorted = [...categories].sort((a, b) => {
    const wa = objective_coefficients[a.count_variable] ?? 0;
    const wb = objective_coefficients[b.count_variable] ?? 0;
    return wb - wa;
  });

  if (sorted.length === 0) {
    return {
      optimal_value: 0,
      assignments: {},
      is_feasible: false,
      reasoning: "No categories specified",
      example_sets: {},
    };
  }

  if (sorted.length === 1) {
    return solveSingleCategory(sorted[0], structure);
  }

  // For 2+ categories: iterate over the highest-weight category's count,
  // then greedily assign maximum feasible count to remaining categories.
  const primary = sorted[0];
  const w_primary = objective_coefficients[primary.count_variable] ?? 0;
  const maxK = maxCount(primary.integer_type, target_sum);

  let bestValue = isMaximize ? -Infinity : Infinity;
  let bestAssignments: Record<string, number> | null = null;

  for (let k1 = 0; k1 <= maxK; k1++) {
    const minS1 = minSum(primary.integer_type, k1);
    const remaining = target_sum - minS1;
    if (remaining < 0) break;

    // Greedily assign remaining categories
    let budget = remaining;
    const assign: Record<string, number> = {
      [primary.count_variable]: k1,
    };
    let feasible = true;

    for (let i = 1; i < sorted.length; i++) {
      const cat = sorted[i];
      const kMax = maxCount(cat.integer_type, budget);

      // Find the largest feasible k that satisfies parity
      let k = kMax;
      let found = false;
      while (k >= 0) {
        const minSk = minSum(cat.integer_type, k);
        const rem = budget - minSk;

        if (i === sorted.length - 1) {
          // Last category: remainder must be exactly achievable
          if (isAchievable(cat.integer_type, k, rem)) {
            // Also check parity with primary for two-category problems
            if (
              sorted.length === 2 &&
              !isParityFeasible(primary, k1, cat, k, target_sum)
            ) {
              k--;
              continue;
            }
            found = true;
            break;
          }
        } else {
          // Intermediate category: just check we don't exceed budget
          if (rem >= 0) {
            found = true;
            break;
          }
        }
        k--;
      }

      if (!found || k < 0) {
        feasible = false;
        break;
      }

      assign[cat.count_variable] = k;
      budget -= minSum(cat.integer_type, k);
    }

    if (!feasible) continue;

    // Compute objective value
    let objValue = 0;
    for (const [varName, count] of Object.entries(assign)) {
      objValue += (objective_coefficients[varName] ?? 0) * count;
    }

    const isBetter = isMaximize
      ? objValue > bestValue
      : objValue < bestValue;

    if (isBetter) {
      bestValue = objValue;
      bestAssignments = { ...assign };
    }
  }

  if (!bestAssignments) {
    return {
      optimal_value: 0,
      assignments: {},
      is_feasible: false,
      reasoning: `No feasible solution found for target sum ${target_sum}`,
      example_sets: {},
    };
  }

  // Build example sets for each category
  // The total remainder goes entirely to the LAST category to avoid double-counting.
  const exampleSets: Record<string, number[]> = {};
  const reasoningParts: string[] = [];
  const totalMinSum = categories.reduce(
    (sum, cat) => sum + minSum(cat.integer_type, bestAssignments[cat.count_variable]),
    0,
  );
  const totalRemainder = target_sum - totalMinSum;

  for (let i = 0; i < categories.length; i++) {
    const cat = categories[i];
    const k = bestAssignments[cat.count_variable];
    const isLast = i === categories.length - 1;
    const remainder = isLast ? totalRemainder : 0;
    const set = constructSingleSet(cat.integer_type, k, remainder);
    exampleSets[cat.count_variable] = set;
    const setSum = set.reduce((a, b) => a + b, 0);
    reasoningParts.push(
      lt(`${k} 个${typeLabel(cat.integer_type)}，最小和 = ${minSum(cat.integer_type, k)}，实际和 = ${setSum}`, `${k} ${typeLabel(cat.integer_type)}: minimum sum = ${minSum(cat.integer_type, k)}, actual sum = ${setSum}`),
    );
  }

  const coeffStr = categories
    .map((c) => `${objective_coefficients[c.count_variable]}·${c.count_variable}`)
    .join(" + ");

  const assignStr = Object.entries(bestAssignments)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");

  return {
    optimal_value: bestValue,
    assignments: bestAssignments,
    is_feasible: true,
    reasoning: [
      lt(`目标：${isMaximize ? "最大化" : "最小化"} ${coeffStr}`, `Objective: ${isMaximize ? "maximize" : "minimize"} ${coeffStr}`),
      lt(`约束：所有数的总和 = ${target_sum}`, `Constraint: sum of all numbers = ${target_sum}`),
      lt(`最优分配：${assignStr}`, `Optimal assignment: ${assignStr}`),
      ...reasoningParts,
      lt(`最优值 = ${bestValue}`, `Optimal value = ${bestValue}`),
    ].join("\n"),
    example_sets: exampleSets,
  };
}

// ── Single Category Solver ────────────────────────────────────────────

function solveSingleCategory(
  cat: OptimizationCategory,
  structure: OptimizationStructure,
): OptimizationResult {
  const k = maxCount(cat.integer_type, structure.target_sum);
  const minS = minSum(cat.integer_type, k);
  const remainder = structure.target_sum - minS;

  if (!isAchievable(cat.integer_type, k, remainder)) {
    return {
      optimal_value: 0,
      assignments: {},
      is_feasible: false,
      reasoning: "No feasible solution",
      example_sets: {},
    };
  }

  const w = structure.objective_coefficients[cat.count_variable] ?? 0;
  const value = w * k;

  return {
    optimal_value: value,
    assignments: { [cat.count_variable]: k },
    is_feasible: true,
    reasoning: lt(`${k} 个${typeLabel(cat.integer_type)}，总和 = ${structure.target_sum}`, `${k} ${typeLabel(cat.integer_type)}, sum = ${structure.target_sum}`),
    example_sets: {
      [cat.count_variable]: constructSingleSet(cat.integer_type, k, remainder),
    },
  };
}

// ── Construct Example Sets ────────────────────────────────────────────

function constructSingleSet(
  type: "even" | "odd" | "integer",
  k: number,
  remainder: number,
): number[] {
  if (k === 0) return [];

  // Start with the minimum set
  let base: number[];
  switch (type) {
    case "even":
      base = Array.from({ length: k }, (_, i) => 2 * (i + 1));
      break;
    case "odd":
      base = Array.from({ length: k }, (_, i) => 2 * i + 1);
      break;
    case "integer":
      base = Array.from({ length: k }, (_, i) => i + 1);
      break;
  }

  if (remainder === 0) return base;

  // Add the remainder to the last element
  const last = base[k - 1];
  const newLast = last + remainder;

  // Check if newLast is already in the set
  if (!base.slice(0, k - 1).includes(newLast)) {
    base[k - 1] = newLast;
    return base;
  }

  // Collision: add to second-to-last element instead, or find an alternative
  for (let i = k - 1; i >= 0; i--) {
    const candidate = base[i] + remainder;
    if (!base.includes(candidate)) {
      base[i] = candidate;
      return base;
    }
  }

  // Last resort: distribute the remainder across multiple elements
  const step = stepSize(type);
  let remaining = remainder;
  for (let i = k - 1; i >= 0 && remaining > 0; i--) {
    const add = Math.min(remaining, step);
    base[i] += add;
    remaining -= add;
  }

  return base;
}

// ── Helpers ───────────────────────────────────────────────────────────

function typeLabel(type: "even" | "odd" | "integer"): string {
  switch (type) {
    case "even":
      return lt("正偶数", "positive even numbers");
    case "odd":
      return lt("正奇数", "positive odd numbers");
    case "integer":
      return lt("正整数", "positive integers");
  }
}
