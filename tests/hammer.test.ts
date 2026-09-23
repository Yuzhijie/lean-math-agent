import { describe, it, expect } from "vitest";
import { goalShape, hammerCandidates, nlinarithHints } from "@/lib/lean/hammer";

describe("goalShape", () => {
  it("reads numeric variables, positivity hypotheses and the target", () => {
    const g = goalShape("case h\nx y : ℝ\nn : ℕ\nhx : 0 < x\nhy : y > 0\nhn : 0 ≤ n\nh : x ≤ y\n⊢ x * y ≤ (x ^ 2 + y ^ 2) / 2");
    expect(g.vars).toEqual([{ name: "x", type: "ℝ" }, { name: "y", type: "ℝ" }, { name: "n", type: "ℕ" }]);
    expect(g.positive).toEqual(["hx", "hy"]);
    expect(g.nonneg).toEqual(["hn"]);
    expect(g.target).toBe("x * y ≤ (x ^ 2 + y ^ 2) / 2");
    expect(g.isInequality).toBe(true);
    expect(g.isEquation).toBe(false);
    expect(g.hasDivision).toBe(true);
    expect(g.field).toBe(true);
    expect(g.binders).toBe(false);
  });

  it("detects equations, binders and Nat-only goals", () => {
    const e = goalShape("a b : ℕ\n⊢ a + b = b + a");
    expect(e.isEquation).toBe(true);
    expect(e.isInequality).toBe(false);
    expect(e.field).toBe(false);
    const b = goalShape("⊢ ∀ (n : ℕ), n + 0 = n");
    expect(b.binders).toBe(true);
    const ne = goalShape("x : ℝ\n⊢ x ≠ 0 → x * x > 0");
    expect(ne.isEquation).toBe(false);
    expect(ne.binders).toBe(true);
  });
});

describe("nlinarithHints", () => {
  it("builds squares of differences/sums and products of positive hypotheses, bounded", () => {
    const g = goalShape("x y z : ℝ\nhx : 0 < x\nhy : 0 < y\n⊢ x * y * z ≤ x ^ 3 + y ^ 3 + z ^ 3");
    const hints = nlinarithHints(g);
    expect(hints).toContain("sq_nonneg (x - y)");
    expect(hints).toContain("sq_nonneg (x + y)");
    expect(hints).toContain("sq_nonneg (y - z)");
    expect(hints.length).toBeLessThanOrEqual(8);
    const g2 = goalShape("a b : ℝ\nha : 0 < a\nhb : 0 < b\n⊢ 2 ≤ a / b + b / a");
    const h2 = nlinarithHints(g2, 12);
    expect(h2).toEqual(expect.arrayContaining(["sq_nonneg (a - b)", "mul_pos ha hb", "mul_pos ha ha", "sq_nonneg a"]));
    // Natural-number variables get no square hints (subtraction truncates).
    expect(nlinarithHints(goalShape("n m : ℕ\n⊢ n * m ≤ n * n + m * m"))).toEqual([]);
  });
});

describe("hammerCandidates", () => {
  it("orders cheap decision procedures first and adapts to the goal", () => {
    const c = hammerCandidates("x y : ℝ\nhx : 0 < x\n⊢ 0 < x ^ 2 + x", true);
    expect(c.slice(0, 5)).toEqual(["rfl", "decide", "simp", "simp_all", "omega"]);
    expect(c).toContain("linarith");
    expect(c).toContain("positivity");
    expect(c.some((t) => t.startsWith("nlinarith [sq_nonneg"))).toBe(true);
    expect(c[c.length - 1]).toBe("exact?");
    expect(c.some((t) => t.includes("field_simp"))).toBe(false);
    expect(c.some((t) => t === "ring")).toBe(false); // not an equation
  });

  it("introduces binders first, adds ring/field_simp for equations, and shrinks without Mathlib", () => {
    const eq = hammerCandidates("⊢ ∀ (a b : ℚ), a / 2 + b / 2 = (a + b) / 2", true);
    expect(eq).toContain("(intros; ring)");
    expect(eq).toContain("(intros; (field_simp; ring))");
    expect(eq).toContain("(intros; omega)");
    const core = hammerCandidates("n : Nat\n⊢ n + 0 = n", false);
    expect(core).toEqual(["rfl", "decide", "simp", "simp_all", "omega", "trivial", "simp_arith", "exact?"]);
  });
});
