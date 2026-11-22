import { describe, expect, it } from "vitest";
import { absIntervalFinishers, instanceFinishers, modCasesFinishers, pigeonholeFinishers, rootCheckFinishers, rootsFinishers, setRootsStep, solutionPairsFinishers, specialAnglesStep, sqrtFacts, vertexFinishers } from "@/lib/lean/auto/school";
import { readFileSync } from "node:fs";
import { parseGoal } from "@/lib/lean/geometry/goal";
import { parseFixture, regressionReport, ROUTES } from "@/lib/pipeline/prover-regression";

const goal = (text: string) => parseGoal(text)!;

describe("the roots of an equation", () => {
  it("are proved from the product of the (x − root)", () => {
    expect(rootsFinishers(goal("x : ℝ\nh : x ^ 2 - 5 * x + 6 = 0\n⊢ x = 2 ∨ x = 3"))).toEqual([
      "(have hroot : (x - 2) * (x - 3) = 0 := (by nlinarith [h]); simp only [mul_eq_zero, sub_eq_zero] at hroot; tauto)",
    ]);
    // roots with a square root: √2 ^ 2 = 2 among the facts; a negative root in brackets
    const [surd] = rootsFinishers(goal("x : ℝ\nh : x ^ 2 - 2 * x - 1 = 0\n⊢ x = 1 + √2 ∨ x = 1 - √2"));
    expect(surd).toContain("(x - (1 + √2)) * (x - (1 - √2)) = 0 := (by nlinarith [h, Real.sq_sqrt (show (0 : ℝ) ≤ 2 by norm_num), Real.sqrt_nonneg 2])");
    expect(rootsFinishers(goal("x : ℝ\nh : x ^ 3 - x = 0\n⊢ x = -1 ∨ x = 0 ∨ x = 1"))[0]).toContain("(x - (-1)) * (x - 0) * (x - 1) = 0");
    // a double root
    expect(rootsFinishers(goal("x : ℝ\nh : x ^ 2 - 4 * x + 4 = 0\n⊢ x = 2"))[0]).toContain("have hroot : (x - 2) ^ 2 = 0 := (by nlinarith [h]); exact sub_eq_zero.mp");
  });
  it("only where the goal names roots of one variable of an equation of degree two or more", () => {
    expect(rootsFinishers(goal("x : ℝ\nh : 2 * x + 1 = 7\n⊢ x = 3"))).toEqual([]);
    expect(rootsFinishers(goal("x y : ℝ\nh : x ^ 2 = y\n⊢ x = 2 ∨ y = 3"))).toEqual([]);
    expect(rootsFinishers(goal("x y : ℝ\nh : x ^ 2 = y ^ 2\n⊢ x = y ∨ x = -y"))).toEqual([]);
    expect(rootsFinishers(goal("x : ℝ\n⊢ x = 2 ∨ x = 3"))).toEqual([]);
  });
  it("a solution set is membership on both sides; the roots put back in", () => {
    expect(setRootsStep(goal("⊢ {x | x ^ 2 - 5 * x + 6 = 0} = {2, 3}"))).toBe("(ext x; simp only [Set.mem_setOf_eq, Set.mem_insert_iff, Set.mem_singleton_iff, Set.mem_empty_iff_false])");
    expect(setRootsStep(goal("x : ℝ\n⊢ {2, 3} = {x | x ^ 2 - 5 * x + 6 = 0}"))).toContain("ext x'");
    expect(setRootsStep(goal("⊢ {x | 0 < x} = {x | x ^ 2 > 0}"))).toBeUndefined();
    expect(rootCheckFinishers(goal("x : ℝ\nh5 : x = 2 ∨ x = 3\n⊢ x ^ 2 - 5 * x + 6 = 0"))[0]).toBe("(rcases h5 with rfl | rfl <;> norm_num)");
    expect(rootCheckFinishers(goal("x : ℝ\nh : x = 1 + √2 ∨ x = 1 - √2\n⊢ x ^ 2 - 2 * x - 1 = 0"))[1]).toContain("<;> nlinarith [Real.sq_sqrt (show (0 : ℝ) ≤ 2 by norm_num)");
    expect(rootCheckFinishers(goal("x y : ℝ\nh : x = 2 ∨ y = 3\n⊢ x * y = 6"))).toEqual([]);
  });
  it("pairs of solutions: the first unknown's values as roots, the other by linarith in each case", () => {
    expect(solutionPairsFinishers(goal("x y : ℝ\nh1 : x + y = 5\nh2 : x * y = 6\n⊢ x = 2 ∧ y = 3 ∨ x = 3 ∧ y = 2"))).toEqual([
      "(have hmul0 : (x + y) * x = (5) * x := (by rw [h1]); have hmul1 : (x * y) * x = (6) * x := (by rw [h2]); have hroot : (x - 2) * (x - 3) = 0 := (by nlinarith [h1, h2, hmul0, hmul1]); simp only [mul_eq_zero, sub_eq_zero] at hroot; rcases hroot with hcase | hcase <;> first | exact Or.inl ⟨by linarith, by linarith⟩ | exact Or.inr ⟨by linarith, by linarith⟩)",
    ]);
    expect(solutionPairsFinishers(goal("x y : ℝ\nh1 : x + y = 5\n⊢ x = 2 ∨ x = 3"))).toEqual([]);
    expect(solutionPairsFinishers(goal("x y : ℝ\nh1 : x + y = 5\n⊢ x = 2 ∧ y = 3 ∨ y = 3 ∧ x = 2"))).toEqual([]);
  });
  it("the square-root facts are read off the text", () => {
    expect(sqrtFacts("√3 + Real.sqrt 12 - √(3 / 4)")).toEqual([
      "Real.sq_sqrt (show (0 : ℝ) ≤ 3 by norm_num)",
      "Real.sqrt_nonneg 3",
      "Real.sq_sqrt (show (0 : ℝ) ≤ 12 by norm_num)",
      "Real.sqrt_nonneg 12",
      "Real.sq_sqrt (show (0 : ℝ) ≤ (3 / 4) by norm_num)",
      "Real.sqrt_nonneg (3 / 4)",
    ]);
  });
});

describe("the other school shapes", () => {
  it("an identity in x: its instances at a few numbers", () => {
    expect(instanceFinishers(goal("k r : ℝ\nhr : ∀ (x : ℝ), x ^ 2 - 4 * x + k = (x - r) ^ 2\n⊢ k = 4"))).toEqual(["linarith [hr 0, hr 1, hr (-1), hr 2]", "nlinarith [hr 0, hr 1, hr (-1), hr 2]"]);
    expect(instanceFinishers(goal("f : ℝ → ℝ\nh : ∀ (x : ℝ), 0 < x → f x = 2\n⊢ f 1 = 2"))).toEqual([]);
  });
  it("an absolute value below a bound is an interval", () => {
    expect(absIntervalFinishers(goal("x : ℝ\n⊢ |x - 1| < 2 ↔ -1 < x ∧ x < 3"))[0]).toBe("(simp only [abs_lt, abs_le]; constructor <;> intro habs <;> constructor <;> linarith [habs.1, habs.2])");
    expect(absIntervalFinishers(goal("x : ℝ\n⊢ |x - 1| < 2"))).toEqual([]);
  });
  it("the least value of a quadratic is at its vertex", () => {
    expect(vertexFinishers(goal("⊢ IsLeast {y | ∃ x, y = x ^ 2 - 4 * x + 7} 3"))).toEqual(["(refine ⟨⟨2, by norm_num⟩, ?_⟩; rintro _ ⟨x, rfl⟩; nlinarith [sq_nonneg (x - 2)])"]);
    expect(vertexFinishers(goal("⊢ IsGreatest {y | ∃ x, y = -2 * x ^ 2 + 120 * x - 1000} 800"))[0]).toContain("⟨⟨30, by norm_num⟩, ?_⟩");
    expect(vertexFinishers(goal("⊢ IsLeast {y | ∃ x, y = 3 * x ^ 2 + x} (-1 / 12)"))[0]).toContain("sq_nonneg (x - (-1 / 6))");
    expect(vertexFinishers(goal("⊢ IsLeast {y | ∃ x, y = x ^ 3 - x} 0"))).toEqual([]);
    expect(vertexFinishers(goal("⊢ IsLeast {y | ∃ x, y = 2 * x + 1} 0"))).toEqual([]);
  });
  it("divisibility of a polynomial in one integer: the residues one by one", () => {
    const [t] = modCasesFinishers(goal("n : ℤ\n⊢ 6 ∣ n ^ 3 - n"));
    expect(t).toContain("have hmod : n % 6 = 0 ∨ n % 6 = 1 ∨ n % 6 = 2 ∨ n % 6 = 3 ∨ n % 6 = 4 ∨ n % 6 = 5 := (by omega); rcases hmod with hmod | hmod | hmod | hmod | hmod | hmod <;> simp [Int.dvd_iff_emod_eq_zero");
    expect(modCasesFinishers(goal("n : ℤ\n⊢ Even (n ^ 2 + n)"))[0]).toContain("n % 2 = 0 ∨ n % 2 = 1");
    expect(modCasesFinishers(goal("n : ℕ\n⊢ 3 ∣ n ^ 3 + 2 * n"))[0]).toContain("Nat.dvd_iff_mod_eq_zero");
    // truncated subtraction, two variables, a large modulus
    expect(modCasesFinishers(goal("n : ℕ\n⊢ 6 ∣ n ^ 3 - n"))).toEqual([]);
    expect(modCasesFinishers(goal("a b : ℤ\n⊢ 2 ∣ a * b + a"))).toEqual([]);
    expect(modCasesFinishers(goal("n : ℤ\n⊢ 341 ∣ n ^ 2"))).toEqual([]);
  });
  it("more pigeons than holes", () => {
    expect(pigeonholeFinishers(goal("f : Fin 13 → Fin 12\n⊢ ∃ i j, i ≠ j ∧ f i = f j"))[0]).toBe("exact Fintype.exists_ne_map_eq_of_card_lt f (by simp)");
    expect(pigeonholeFinishers(goal("f : Fin 13 → Fin 12\n⊢ ∃ i j, f i = f j"))).toEqual([]);
  });
});

describe("sin, cos and tan of the special angles", () => {
  it("are replaced by their values, the argument brought to π/6, π/4, π/3, π/2 or π minus one of them", () => {
    expect(specialAnglesStep(goal("⊢ 2 * Real.sin (Real.pi / 3) - Real.tan (Real.pi / 4) = √3 - 1"))).toMatch(/^\(simp only \[Real\.sin_pi_sub, Real\.sin_zero, Real\.sin_pi_div_six/);
    const deg = specialAnglesStep(goal("⊢ Real.sin (150 * Real.pi / 180) + Real.cos (2 * Real.pi / 3) = 0"))!;
    expect(deg).toContain("rw [show (150 * Real.pi / 180 : ℝ) = Real.pi - Real.pi / 6 by ring, show (2 * Real.pi / 3 : ℝ) = Real.pi - Real.pi / 3 by ring]; simp only [");
    expect(deg).not.toContain("Real.tan_pi_div_two");
  });
  it("not for other angles, a variable angle, or tan 90°", () => {
    expect(specialAnglesStep(goal("⊢ Real.sin (Real.pi / 12) < 1"))).toBeUndefined();
    expect(specialAnglesStep(goal("x : ℝ\n⊢ Real.sin (x * Real.pi) = 0"))).toBeUndefined();
    expect(specialAnglesStep(goal("⊢ Real.tan (Real.pi / 2) = 0"))).toBeUndefined();
    expect(specialAnglesStep(goal("x : ℝ\n⊢ x = 1"))).toBeUndefined();
  });
});

describe("bench/school.json", () => {
  const fixture = parseFixture(readFileSync("bench/school.json", "utf8"));
  it("has primary and middle school statements of every kind, each with the route that proves it", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(150);
    for (const c of fixture.cases) {
      expect(c.for, c.id).toMatch(/^(primary|middle)\/.+/);
      expect(ROUTES as readonly string[], c.id).toContain(c.expect);
    }
    const kinds = new Set(fixture.cases.map((c) => c.for));
    for (const k of ["primary/计算", "primary/应用题", "primary/数论", "primary/图形", "primary/计数", "middle/方程", "middle/不等式", "middle/函数", "middle/二次根式", "middle/几何", "middle/几何证明", "middle/代数证明", "middle/概率统计"]) expect(kinds, k).toContain(k);
  });
  it("its report lists its own runs only, under its own file name", () => {
    const run = (name: string, at: string) => ({ file: `${name}.jsonl`, meta: { type: "run" as const, at, fixture: name, selected: 1, host: "h", args: [] }, rows: [{ id: fixture.cases[0].id, expect: "hammer" as const, strategy: "hammer" as const, ms: 1000 }] });
    const md = regressionReport(fixture, [run("provers-v1", "2026-11-22T05:01:00.000Z"), run(fixture.name, "2026-11-22T11:01:00.000Z")], { file: "bench/school.json" });
    expect(md).toContain("# bench/school.json 的回归");
    expect(md).toContain("2026-11-22 11:01");
    expect(md).not.toContain("2026-11-22 05:01");
  });
});
