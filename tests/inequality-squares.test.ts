import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseGoal } from "@/lib/lean/geometry/goal";
import { inequalityFit, inequalityMethods, looksSymmetricInequality, polynomialInequalityFit } from "@/lib/lean/inequality";
import { plan, readParts, readSetting, request, script, type HelperPart, type Plan } from "@/lib/lean/inequality/squares";

const hasSympy = spawnSync(process.env.GEOMETRY_PYTHON ?? "python3", ["-c", "import sympy"]).status === 0;

// the statement of the session this route was written for
const SESSION =
  "(a b c : ℝ) (ha : 0 < a) (hb : 0 < b) (hc : 0 < c) : let S : ℝ := a ^ 2 / (a ^ 2 + a * b + b ^ 2) + b ^ 2 / (b ^ 2 + b * c + c ^ 2) + c ^ 2 / (c ^ 2 + c * a + a ^ 2); 1 ≤ S ∧ (S = 1 ↔ a = b ∧ b = c)";
const WITH_PRODUCT = "(a b c : ℝ) (ha : 0 < a) (hb : 0 < b) (hc : 0 < c) (habc : a * b * c = 1) : 3 / 4 ≤ 1 / (1 + a) ^ 2 + 1 / (1 + b) ^ 2 + 1 / (1 + c) ^ 2";

// the goal after the intros, as Lean prints it
const CONTEXT = "a b c : ℝ\nha : 0 < a\nhb : 0 < b\nhc : 0 < c\n";
const GOAL = `${CONTEXT}S : ℝ := a ^ 2 / (a ^ 2 + a * b + b ^ 2) + b ^ 2 / (b ^ 2 + b * c + c ^ 2) + c ^ 2 / (c ^ 2 + c * a + a ^ 2)\n⊢ 1 ≤ S ∧ (S = 1 ↔ a = b ∧ b = c)`;
const goal = (target: string, context = CONTEXT) => parseGoal(`${context}⊢ ${target}`)!;

describe("which statements the route is for", () => {
  it("arithmetic in real variables with a ≤, a ≥ or an equality case; first in line when a variable is stated positive", () => {
    expect(polynomialInequalityFit(SESSION)).toBe(2);
    expect(inequalityFit(SESSION)).toBe(2);
    expect(looksSymmetricInequality(SESSION)).toBe(false);
    expect(polynomialInequalityFit(": ∀ a b c : ℝ, a > 0 → b > 0 → c > 0 → a / (b + c) + b / (c + a) + c / (a + b) ≥ 3 / 2")).toBe(2);
    // only when the two sides are equal
    expect(polynomialInequalityFit("(a b : ℝ) (ha : 0 < a) (hb : 0 < b) : a = b ↔ a / b + b / a = 2")).toBe(2);
    // no sign for any variable: the automation usually has these — the route waits its turn
    expect(polynomialInequalityFit("(a b c d : ℝ) : (a * c + b * d) ^ 2 ≤ (a ^ 2 + b ^ 2) * (c ^ 2 + d ^ 2)")).toBe(1);
  });

  it("not: another type, a function, a root, a sum, a strict inequality alone", () => {
    const no = (t: string) => expect(polynomialInequalityFit(t), t).toBe(0);
    no("(a b : ℕ) (ha : 0 < a) (hb : 0 < b) : 2 * (a * b) ≤ a ^ 2 + b ^ 2");
    no("(a b : ℝ) (ha : 0 < a) (hb : 0 < b) : 2 * Real.sqrt (a * b) ≤ a + b");
    no("(a b : ℝ) (ha : 0 < a) (hb : 0 < b) : 2 * √(a * b) ≤ a + b");
    no("(a b : ℝ) (ha : 0 < a) (hb : 0 < b) : 0 < a * b + a");
    no("(x : ℝ) (hx : 0 < x) : |x - 1| ≤ x + 1");
    no("(f : ℕ → ℝ) (n : ℕ) : ∑ i ∈ Finset.range n, f i ≤ ∑ i ∈ Finset.range n, |f i|");
    no(": IsLeast {t : ℝ | ∃ x y : ℝ, 0 < x ∧ 0 < y ∧ x * y = 1 ∧ t = x + y} 2");
  });

  it("a product of 1 is the pqr route's first; this route follows, without the product", () => {
    expect(inequalityMethods(WITH_PRODUCT)).toEqual(["symmetric", "squares"]);
    expect(inequalityMethods(SESSION)).toEqual(["squares"]);
    expect(inequalityMethods("(a b : ℕ) : a ≤ a + b")).toEqual([]);
  });
});

describe("the goal read", () => {
  it("the variables of the goal, what the context says of their signs, the lets", () => {
    const s = readSetting(parseGoal(GOAL)!)!;
    expect(s.vars).toEqual(["a", "b", "c"]);
    expect(s.signs).toEqual(["pos", "pos", "pos"]);
    expect(s.signHyps).toEqual(["ha", "hb", "hc"]);
    expect([...s.lets.keys()]).toEqual(["S"]);
    expect(s.constrained).toBe(false);
    // `x > 0`, `0 ≤ y`, a variable without a sign; a variable the goal does not mention is left out
    const mixed = readSetting(parseGoal("x y z w : ℝ\nhx : x > 0\nhy : 0 ≤ y\n⊢ 2 * x * y ≤ x ^ 2 + y ^ 2 + z ^ 2")!)!;
    expect(mixed.vars).toEqual(["x", "y", "z"]);
    expect(mixed.signs).toEqual(["pos", "nonneg", "free"]);
    expect(mixed.signHyps).toEqual(["hx", "hy", undefined]);
  });

  it("anything else the context states makes a failing point no counterexample", () => {
    expect(readSetting(goal("3 ≤ a + b + c", `${CONTEXT}habc : a * b * c = 1\n`))!.constrained).toBe(true);
    expect(readSetting(goal("3 ≤ a + b + c", `${CONTEXT}n : ℕ\n`))!.constrained).toBe(false);
  });

  it("not: no real variable, more than four, a name without access, a name the proof uses itself", () => {
    expect(readSetting(parseGoal("n : ℕ\n⊢ n ≤ n + 1")!)).toBeUndefined();
    expect(readSetting(parseGoal("a b c d e : ℝ\n⊢ 0 ≤ a ^ 2 + b ^ 2 + c ^ 2 + d ^ 2 + e ^ 2")!)).toBeUndefined();
    expect(readSetting(parseGoal("a b : ℝ\na✝ : 0 < a\nhb : 0 < b\n⊢ 2 ≤ a / b + b / a")!)).toBeUndefined();
    expect(readSetting(parseGoal("a b : ℝ\nhfrac_ : 0 < a\nhb : 0 < b\n⊢ 2 ≤ a / b + b / a")!)).toBeUndefined();
    expect(readSetting(parseGoal("a b : ℝ\nhn3_ : 0 < a\nhb : 0 < b\n⊢ 2 ≤ a / b + b / a")!)).toBeUndefined();
  });

  it("the parts: inequalities either way round, an equality case between variables either way round", () => {
    const vars = ["a", "b", "c"];
    expect(readParts("1 ≤ S ∧ (S = 1 ↔ a = b ∧ b = c)", vars)).toEqual([
      { kind: "ineq", small: "1", large: "S" },
      { kind: "eqcase", a: "S", b: "1", targets: [[0, 1], [1, 2]], reversed: false },
    ]);
    expect(readParts("S ≥ 1", vars)).toEqual([{ kind: "ineq", small: "1", large: "S" }]);
    expect(readParts("a = b ∧ b = c ∧ c = a ↔ T = 8 * a * b * c", vars)).toEqual([{ kind: "eqcase", a: "T", b: "8 * a * b * c", targets: [[0, 1], [1, 2], [2, 0]], reversed: true }]);
    expect(readParts("a / b + b / a = 2 ↔ a = b", vars)).toEqual([{ kind: "eqcase", a: "a / b + b / a", b: "2", targets: [[0, 1]], reversed: false }]);
  });

  it("not: a strict inequality, a bare equation, an equality case at a number, two equalities of variables", () => {
    const vars = ["a", "b", "c"];
    expect(readParts("1 < S", vars)).toBeUndefined();
    expect(readParts("1 ≤ S ∧ S = 1", vars)).toBeUndefined();
    expect(readParts("S = 1 ↔ a = 1 ∧ b = 1", vars)).toBeUndefined();
    expect(readParts("a = b ↔ b = a", vars)).toBeUndefined();
    expect(readParts("S = 1 ↔ a = a", vars)).toBeUndefined();
    expect(readParts("S = 1 ↔ a = b ∨ b = c", vars)).toBeUndefined();
  });

  it("what is asked of the helper: an inequality once, an equality case both ways round with its pairs", () => {
    const req = request(parseGoal(GOAL)!);
    if (typeof req === "string") throw new Error(req);
    expect(req.specOf).toEqual([[0], [1, 2]]);
    expect(req.specs[0].targets).toBeUndefined();
    expect(req.specs[1].targets).toEqual([[0, 1], [1, 2]]);
    expect(req.specs[2]).toEqual({ lhs: req.specs[1].rhs, rhs: req.specs[1].lhs, targets: [[0, 1], [1, 2]] });
    // the let is written out for the helper
    expect(JSON.stringify(req.specs[0].lhs)).toContain('["var",2]');
    expect(req.specs[0].rhs).toEqual(["num", "1"]);
  });

  it("says why a goal is not of this kind", () => {
    expect(request(parseGoal("n : ℕ\n⊢ n ≤ n + 1")!)).toMatch(/real variables/);
    expect(request(goal("1 < a + b + c"))).toMatch(/neither an inequality/);
    expect(request(goal("Real.exp a ≤ Real.exp (a + b + c)"))).toMatch(/does not read/);
    expect(request(goal("2 * a * b ≤ a ^ 2 + b ^ 2 ∧ (a ^ 2 + b ^ 2 = 2 * a * b ↔ a = b)", "a b : ℝ\nha : 0 < a\nhb : 0 ≤ b\n"))).toMatch(/every variable positive/);
  });
});

describe("the proof written from a plan", () => {
  // 2 ≤ a/b + b/a with its equality case: (a − b)² / (ab)
  const part: HelperPart = {
    ok: true,
    den_const: "1",
    den: [
      { poly: [["1", { v0: 1 }]], exp: 1 },
      { poly: [["1", { v1: 1 }]], exp: 1 },
    ],
    N: [
      ["1", { v0: 2 }],
      ["-2", { v0: 1, v1: 1 }],
      ["1", { v1: 2 }],
    ],
    mult: 0,
    terms: [{ c: "1", mu: {}, a: { v0: 1 }, b: { v1: 1 } }],
    rest: [],
    equal: { ok: true, uses: [0], targets: [{ u: 0, v: 1, n: 1, w: {}, cof: [[0, [["1", {}]]]] }], back: [[["1", { v0: 1 }], ["-1", { v1: 1 }]]] },
  };
  const st = parseGoal("a b : ℝ\nha : 0 < a\nhb : 0 < b\n⊢ 2 ≤ a / b + b / a ∧ (a / b + b / a = 2 ↔ a = b)")!;
  const setting = readSetting(st)!;
  const parts = readParts(st.target, setting.vars)!;
  const pl: Plan = { setting, parts, chosen: [{ part, swapped: false }, { part, swapped: false }] };

  it("the fraction and its squares once, then the inequality and both directions of the equality case", () => {
    const lines = script(pl).split("\n");
    expect(lines.filter((l) => l.includes("have hfrac_"))).toHaveLength(1);
    expect(lines.slice(0, 6)).toEqual([
      "have hden_ : (0:ℝ) < 1 * (a) * (b) := by positivity",
      "have hfrac_ : a / b + b / a - (2) = (b ^ 2 + a ^ 2 - 2 * a * b) / (1 * (a) * (b)) := by",
      "  field_simp",
      "  ring",
      "have hsq_ : b ^ 2 + a ^ 2 - 2 * a * b = 1 * ((a - b) ^ 2) := by ring",
      "refine ⟨?_, ?_⟩",
    ]);
    const text = lines.join("\n");
    expect(text).toContain("· have hN_ : (0:ℝ) ≤ b ^ 2 + a ^ 2 - 2 * a * b := by\n    rw [hsq_]\n    positivity");
    expect(text).toContain("  exact sub_nonneg.mp hdiff_");
    // forward: the square is 0, so a − b = 0, so 1 · a¹ = 1 · b¹
    expect(text).toContain("  · intro heq_");
    expect(text).toContain("have e0_ : a - b = 0 := (pow_eq_zero_iff (by norm_num : (2:ℕ) ≠ 0)).mp (le_antisymm (by linarith only [hzero_, hn0_]) hn0_)");
    expect(text).toContain("have hpow_ : (1 : ℝ) * a ^ 1 = 1 * b ^ 1 := by linear_combination (1) * e0_");
    expect(text).toContain("exact (pow_left_inj₀ ha.le hb.le (by norm_num : (1:ℕ) ≠ 0)).mp (mul_left_cancel₀ (by positivity : (1 : ℝ) ≠ 0) hpow_)");
    expect(text).toContain("    exact ht0_");
    // backward: the numerator is a multiple of a − b
    expect(text).toContain("  · intro hb0_\n    have hN0_ : b ^ 2 + a ^ 2 - 2 * a * b = 0 := by linear_combination (-b + a) * hb0_");
    expect(text).toContain("    linarith only [hd0_]");
    expect(text).not.toMatch(/nlinarith|sorry|first \|/);
  });

  it("an equality case written the other way round proves its directions in that order", () => {
    const reversed = parseGoal("a b : ℝ\nha : 0 < a\nhb : 0 < b\n⊢ a = b ↔ a / b + b / a = 2")!;
    const text = script({ setting, parts: readParts(reversed.target, setting.vars)!, chosen: [{ part, swapped: false }] });
    expect(text.indexOf("· intro hb0_")).toBeGreaterThan(0);
    expect(text.indexOf("· intro hb0_")).toBeLessThan(text.indexOf("· intro heq_"));
    // one part: no bullets around it
    expect(text.startsWith("have hden_")).toBe(true);
    expect(text).not.toContain("refine");
  });

  it("a multiplier: the squares are those of (a + b) · N, and N ≥ 0 follows from the product", () => {
    const scaled: HelperPart = { ...part, mult: 1, equal: undefined, terms: [{ c: "1", mu: { v0: 1 }, a: { v0: 1 }, b: { v1: 1 } }], rest: [["2", { v1: 3 }]] };
    const one = parseGoal("a b : ℝ\nha : 0 < a\nhb : 0 < b\n⊢ 2 ≤ a / b + b / a")!;
    const text = script({ setting, parts: readParts(one.target, setting.vars)!, chosen: [{ part: scaled, swapped: false }] });
    expect(text).toContain("have hsq_ : (a + b) * (b ^ 2 + a ^ 2 - 2 * a * b) = 1 * (a * (a - b) ^ 2) + 2 * (b ^ 3) := by ring");
    expect(text).toContain("  have hm_ : (0:ℝ) ≤ (a + b) * (b ^ 2 + a ^ 2 - 2 * a * b) := by\n    rw [hsq_]\n    positivity\n  exact nonneg_of_mul_nonneg_right hm_ (by positivity)");
  });
});

describe.skipIf(!hasSympy)("the plan from the helper's algebra (SymPy)", () => {
  const planned = async (st: ReturnType<typeof parseGoal>) => {
    const pl = await plan(st!, 30_000);
    if ("reason" in pl) throw new Error(pl.reason);
    return pl;
  };

  it("the session's statement: three squares with a monomial each, a = b from a product of two of them (a³ = b³)", async () => {
    const pl = await planned(parseGoal(GOAL));
    expect(pl.chosen.map((c) => c.swapped)).toEqual([false, false]);
    const part = pl.chosen[1].part;
    expect(part.mult).toBe(0);
    expect(part.rest).toEqual([]);
    expect(part.terms).toHaveLength(3);
    expect(part.den).toHaveLength(3);
    expect(part.equal!.targets.map((t) => [t.u, t.v, t.n])).toEqual([[0, 1, 3], [1, 2, 3]]);
    const text = script(pl);
    expect(text.split("\n").filter((l) => l.includes("have hfrac_"))).toHaveLength(1);
    expect(text).toContain("  simp only [S]\n  field_simp\n  ring");
    expect(text).toContain("(pow_left_inj₀ ha.le hb.le (by norm_num : (3:ℕ) ≠ 0)).mp");
    expect(text).toContain("(pow_left_inj₀ hb.le hc.le (by norm_num : (3:ℕ) ≠ 0)).mp");
    expect(text).toContain("  · rintro ⟨hb0_, hb1_⟩");
    expect(text).toContain("    exact ⟨ht0_, ht1_⟩");
    expect(text).not.toMatch(/nlinarith|sorry/);
  });

  it("a / b + b / c + c / a ≥ 3 needs the multiplier a + b + c: three-term AM–GM is no sum of such squares", async () => {
    const pl = await planned(goal("3 ≤ a / b + b / c + c / a"));
    expect(pl.chosen[0].part.mult).toBe(1);
    expect(script(pl)).toContain("have hsq_ : (a + b + c) * (");
  });

  it("a symmetric numerator of degree 12: the search is over orbits of pairs — seconds where every pair on its own took over 40", async () => {
    const started = Date.now();
    const pl = await planned(goal("3 * a ^ 4 * b ^ 4 * c ^ 4 ≤ a ^ 12 + b ^ 12 + c ^ 12"));
    expect(Date.now() - started).toBeLessThan(20_000);
    // the squares come in whole orbits: with one, its images under every permutation of a, b, c
    const key = (t: { mu: Record<string, number>; a: Record<string, number>; b: Record<string, number> }, swap: Record<string, string>) => {
      const moved = (e: Record<string, number>) => JSON.stringify(Object.entries(e).map(([v, k]) => [swap[v] ?? v, k]).sort());
      return [moved(t.mu), ...[moved(t.a), moved(t.b)].sort()].join("|");
    };
    const terms = pl.chosen[0].part.terms;
    const all = new Set(terms.map((t) => key(t, {})));
    for (const t of terms) expect(all.has(key(t, { v0: "v1", v1: "v2", v2: "v0" }))).toBe(true);
    expect(terms.length % 3).toBe(0);
  });

  it("variables without a sign: only even powers multiply the squares (Cauchy–Schwarz in two terms)", async () => {
    const pl = await planned(parseGoal("a b c d : ℝ\n⊢ (a * c + b * d) ^ 2 ≤ (a ^ 2 + b ^ 2) * (c ^ 2 + d ^ 2)"));
    const part = pl.chosen[0].part;
    expect(part.den).toEqual([]);
    for (const t of part.terms) for (const e of Object.values(t.mu)) expect(e % 2).toBe(0);
    expect(script(pl)).toContain("  ring\n"); // no field_simp without a denominator
    expect(script(pl)).not.toContain("field_simp");
    // the same with odd multipliers is refused: a·(a − b)² has no sign
    const odd = await plan(parseGoal("a b : ℝ\n⊢ a ^ 2 * b + a * b ^ 2 ≤ a ^ 3 + b ^ 3")!, 30_000);
    expect("reason" in odd && odd.reason).toMatch(/false at|not a sum/);
  });

  it("an inequality that fails at a point is a counterexample — unless the context says more than the signs", async () => {
    const wrong = "11 / 10 ≤ a ^ 2 / (a ^ 2 + a * b + b ^ 2) + b ^ 2 / (b ^ 2 + b * c + c ^ 2) + c ^ 2 / (c ^ 2 + c * a + a ^ 2)";
    expect(await plan(goal(wrong), 30_000)).toEqual({ reason: `${wrong} is false at a = 1, b = 1, c = 1`, counterexample: "a = 1, b = 1, c = 1" });
    const constrained = await plan(goal("4 ≤ a + b + c", `${CONTEXT}h : a + b + c = 5\n`), 30_000);
    expect(constrained).toEqual({ reason: "4 ≤ a + b + c is false at a = 1, b = 1, c = 1" });
  });

  it("says so when the squares are not there, a denominator may vanish, or the equality case is another one", async () => {
    // Schur's inequality is true and no sum of AM–GM steps
    expect(await plan(goal("0 ≤ a * (a - b) * (a - c) + b * (b - c) * (b - a) + c * (c - a) * (c - b)"), 30_000)).toEqual({ reason: "not a sum of AM–GM steps between two monomials" });
    expect(await plan(parseGoal("a b : ℝ\nha : 0 < a\nhb : 0 ≤ b\n⊢ 2 ≤ a / b + b / a")!, 30_000)).toEqual({ reason: "a denominator in a variable that is not known to be positive" });
    // c (a − b)² = 0 says a = b, nothing about c
    const other = await plan(goal("2 * a * b * c ≤ (a ^ 2 + b ^ 2) * c ∧ ((a ^ 2 + b ^ 2) * c = 2 * a * b * c ↔ a = b ∧ b = c)"), 30_000);
    expect("reason" in other && other.reason).toMatch(/^part 2: the squares being 0 does not give/);
  });
});
