import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseGoal } from "@/lib/lean/geometry/goal";
import { inequalityFit, looksSymmetricInequality } from "@/lib/lean/inequality";
import { inlineLets, letsUsed, plan, readParts, readSetting, request, script } from "@/lib/lean/inequality/symmetric";

const hasSympy = spawnSync(process.env.GEOMETRY_PYTHON ?? "python3", ["-c", "import sympy"]).status === 0;

// the statement of the session this prover was written for
const SESSION =
  ": ∀ (x y z : ℝ), 0 < x → 0 < y → 0 < z → x * y * z = 1 → let S : ℝ := 1 / (1 + x)^2 + 1 / (1 + y)^2 + 1 / (1 + z)^2; let D : ℝ := 2 + x + y + z + x * y + y * z + z * x; (S ≥ 3 / 4 + 8 * (x + y + z - 3) / D^2) ∧ (S ≥ 3 / 4) ∧ (S = 3 / 4 ↔ (x = 1 ∧ y = 1 ∧ z = 1))";
const CLASSIC = "(a b c : ℝ) (ha : 0 < a) (hb : 0 < b) (hc : 0 < c) (habc : a * b * c = 1) : 3 / 4 ≤ 1 / (1 + a) ^ 2 + 1 / (1 + b) ^ 2 + 1 / (1 + c) ^ 2";

// the goal after the intros, as Lean prints it
const GOAL = `x y z : ℝ
h1 : 0 < x
h2 : 0 < y
h3 : 0 < z
h4 : x * y * z = 1
S : ℝ := 1 / (1 + x) ^ 2 + 1 / (1 + y) ^ 2 + 1 / (1 + z) ^ 2
D : ℝ := 2 + x + y + z + x * y + y * z + z * x
⊢ S ≥ 3 / 4 + 8 * (x + y + z - 3) / D ^ 2 ∧ S ≥ 3 / 4 ∧ (S = 3 / 4 ↔ x = 1 ∧ y = 1 ∧ z = 1)`;
const goal = (target: string, extra = "") => parseGoal(`a b c : ℝ\nha : 0 < a\nhb : 0 < b\nhc : 0 < c\nhabc : a * b * c = 1\n${extra}⊢ ${target}`)!;

describe("which statements the prover is for", () => {
  it("three reals, each positive, with product 1, and a ≤ or ≥", () => {
    expect(looksSymmetricInequality(SESSION)).toBe(true);
    expect(looksSymmetricInequality(CLASSIC)).toBe(true);
    expect(inequalityFit(CLASSIC)).toBe(2);
    // the reading form's spelling, a bracketed product, `x > 0`
    expect(looksSymmetricInequality(": ∀ (x y z : ℝ), x > 0 → y > 0 → z > 0 → (x * y) * z = 1 → x + y + z ≥ 3")).toBe(true);
  });

  it("not: no product, another product, a variable that may be negative, another number, no inequality", () => {
    const no = (t: string) => expect(inequalityFit(t), t).toBe(0);
    no("(a b : ℝ) (ha : 0 < a) (hb : 0 < b) : 2 * (a * b) ≤ a ^ 2 + b ^ 2");
    no("(a b : ℝ) (ha : 0 < a) (hb : 0 < b) (h : a * b = 1) : 2 ≤ a + b");
    no("(a b c : ℝ) (ha : 0 < a) (hb : 0 < b) (habc : a * b * c = 1) : 3 ≤ a + b + c");
    no("(a b c : ℝ) (ha : 0 < a) (hb : 0 < b) (hc : 0 < c) (habc : a * b * c = 8) : 6 ≤ a + b + c");
    no("(a b c : ℝ) (ha : 0 < a) (hb : 0 < b) (hc : 0 < c) (habc : a * b * c = 1) : a + b + c ≠ 2");
    no("(a b c : ℕ) (ha : 0 < a) (hb : 0 < b) (hc : 0 < c) (habc : a * b * c = 1) : 3 ≤ a + b + c");
    no("(a b c : ℝ) (ha : 0 < a) (hb : 0 < b) (hc : 0 < c) (habc : a * a * c = 1) : 3 ≤ a + b + c");
  });
});

describe("the goal read", () => {
  it("the variables, their positivity, the product, the lets", () => {
    const s = readSetting(parseGoal(GOAL)!)!;
    expect(s.vars).toEqual(["x", "y", "z"]);
    expect(s.positive).toEqual(["h1", "h2", "h3"]);
    expect(s.product).toBe("h4");
    expect([...s.lets.keys()]).toEqual(["S", "D"]);
    expect(s.lets.get("D")).toBe("2 + x + y + z + x * y + y * z + z * x");
  });

  it("not: a hypothesis without a name, a name the proof uses itself, a missing positivity", () => {
    expect(readSetting(parseGoal("a b c : ℝ\nha : 0 < a\nhb : 0 < b\nhc : 0 < c\na✝ : a * b * c = 1\n⊢ 3 ≤ a + b + c")!)).toBeUndefined();
    expect(readSetting(parseGoal("a b c : ℝ\nha : 0 < a\nhb : 0 < b\nhp_ : 0 < c\nhabc : a * b * c = 1\n⊢ 3 ≤ a + b + c")!)).toBeUndefined();
    expect(readSetting(parseGoal("a b c : ℝ\nha : 0 < a\nhb : 0 < b\nhabc : a * b * c = 1\n⊢ 3 ≤ a + b + c")!)).toBeUndefined();
    expect(readSetting(parseGoal("p_ b c : ℝ\nha : 0 < p_\nhb : 0 < b\nhc : 0 < c\nhabc : p_ * b * c = 1\n⊢ 3 ≤ p_ + b + c")!)).toBeUndefined();
  });

  it("the parts: inequalities either way round, and an equality case", () => {
    const st = parseGoal(GOAL)!;
    expect(readParts(st.target, ["x", "y", "z"])).toEqual([
      { kind: "ineq", small: "3 / 4 + 8 * (x + y + z - 3) / D ^ 2", large: "S" },
      { kind: "ineq", small: "3 / 4", large: "S" },
      { kind: "eqcase", a: "S", b: "3 / 4" },
    ]);
    expect(readParts("3 ≤ a + b + c", ["a", "b", "c"])).toEqual([{ kind: "ineq", small: "3", large: "a + b + c" }]);
    // the equalities in another order
    expect(readParts("a + b + c = 3 ↔ c = 1 ∧ a = 1 ∧ b = 1", ["a", "b", "c"])).toEqual([{ kind: "eqcase", a: "a + b + c", b: "3" }]);
  });

  it("not: a strict inequality, a bare equation, an equality case at other values or for other variables", () => {
    const no = (t: string) => expect(readParts(t, ["a", "b", "c"]), t).toBeUndefined();
    no("3 < a + b + c");
    no("a + b + c = 3");
    no("3 ≤ a + b + c ∧ (a + b + c = 3 ↔ a = 2 ∧ b = 1 ∧ c = 1)");
    no("a + b + c = 3 ↔ a = b ∧ b = c");
    no("a + b + c = 3 ↔ a = 1 ∧ b = 1");
    no("3 ≤ a + b + c ∨ a = 1");
    no("∀ t : ℝ, t ≤ a + b + c");
  });

  it("lets are written out the way `simp only [lets]` leaves them, and only the lets a part uses are unfolded", () => {
    const lets = new Map([
      ["S", "1 / (1 + x) ^ 2"],
      ["D", "2 + x"],
      ["E", "D ^ 2 + S"],
    ]);
    // whole names only, and not a name after a dot
    expect(inlineLets("8 / D ^ 2 + T.S + xD + D'", lets)).toBe("8 / (2 + x) ^ 2 + T.S + xD + D'");
    expect(inlineLets("E", lets)).toBe("((2 + x) ^ 2 + (1 / (1 + x) ^ 2))");
    expect(letsUsed("S - 3 / 4", lets)).toEqual(["S"]);
    expect(letsUsed("E - 1", lets)).toEqual(["S", "D", "E"]);
    expect(letsUsed("x + 1", lets)).toEqual([]);
  });

  it("what is asked of the helper: both sides of every part, the bases of the denominators numbered", () => {
    const req = request(parseGoal(GOAL)!);
    if (typeof req === "string") throw new Error(req);
    // two inequalities, and the equality case both ways round
    expect(req.specs).toHaveLength(4);
    expect(req.specOf).toEqual([[0], [1], [2, 3]]);
    // part 1: S's three bases and D; D is written out
    expect(req.partBases[0].map((i) => req.bases[i])).toEqual(["1 + x", "1 + y", "1 + z", "(2 + x + y + z + x * y + y * z + z * x)"]);
    expect(req.partBases[1].map((i) => req.bases[i])).toEqual(["1 + x", "1 + y", "1 + z"]);
    // a numeric denominator is no base
    expect(JSON.stringify(req.specs[1].rhs)).toBe(JSON.stringify(["/", ["num", "3"], ["num", "4"]]));
    expect(JSON.stringify(req.specs[0].rhs)).toContain('["^",["base",3,');
  });

  it("says why a goal is not of this kind", () => {
    expect(request(parseGoal("a b : ℝ\nha : 0 < a\n⊢ 2 * a ≤ a ^ 2 + 1")!)).toMatch(/not three positive reals/);
    expect(request(goal("3 < a + b + c"))).toMatch(/neither an inequality/);
    expect(request(goal("3 ≤ a + b + Real.sqrt c"))).toMatch(/does not read/);
    expect(request(goal("3 ≤ a + b + c ^ n", "n : ℕ\n"))).toMatch(/does not read/);
  });
});

describe.skipIf(!hasSympy)("the proof written from the helper's algebra (SymPy)", () => {
  it("the session's statement: D replaced by (1 + x)(1 + y)(1 + z), three parts, the equality case through p = 0", async () => {
    const pl = await plan(parseGoal(GOAL)!);
    if ("reason" in pl) throw new Error(pl.reason);
    // 2 + x + y + z + xy + yz + zx = (1 + x)(1 + y)(1 + z) once xyz = 1: the common denominator has degree 6, not 10
    expect(pl.answer.rewrites).toHaveLength(1);
    expect(pl.answer.rewrites[0]).toMatchObject({ id: 3, product: [[0, 1], [1, 1], [2, 1]] });
    expect(pl.chosen.map((c) => c.part.den.length)).toEqual([3, 3, 3]);
    expect(pl.chosen[2].part.linear).toBe("P");
    const lines = script(pl).split("\n");
    // AM–GM once, for (x, y, z) and for (xy, yz, zx); the two sums as variables
    expect(lines[0]).toBe("have amgm_ : ∀ a b c : ℝ, 0 < a → 0 < b → 0 < c → a * b * c = 1 → 3 ≤ a + b + c := by");
    expect(lines).toContain("obtain ⟨p_, hpd_⟩ : ∃ p_ : ℝ, p_ = x + y + z - 3 := ⟨_, rfl⟩");
    expect(lines).toContain("  linarith [amgm_ x y z h1 h2 h3 h4]");
    expect(lines).toContain("have hb3_ : (2 + x + y + z + x * y + y * z + z * x) = (1 + x) * (1 + y) * (1 + z) := by linear_combination (-1) * h4");
    expect(lines).toContain("refine ⟨?_, ?_, ?_⟩");
    // part 1: both lets unfolded, D rewritten, the fraction checked without the hypothesis
    const first = lines.findIndex((l) => l.startsWith("· have hfrac_ : S - (3 / 4 + 8 * (x + y + z - 3) / D ^ 2) = "));
    expect(lines.slice(first + 1, first + 5)).toEqual(["    simp only [S, D]", "    rw [hb3_]", "    field_simp", "    ring"]);
    expect(lines).toContain("  have hg_ : (0:ℝ) ≤ 1 * (q_ ^ 2 + 5 * p_ ^ 2 + 2 * p_ * q_) := mul_nonneg ((by norm_num : (0:ℝ) ≤ 1)) ((by positivity : (0:ℝ) ≤ q_ ^ 2 + 5 * p_ ^ 2 + 2 * p_ * q_))");
    // part 2 uses S only
    expect(lines.filter((l) => l.trim() === "simp only [S]").length).toBe(2);
    // the equality case: the form multiplied out is 0, every monomial ≥ 0, so 32 p ≤ 0
    expect(lines).toContain("    have hp0_ : p_ = 0 := le_antisymm (by linarith only [hzero_, hp_, hq_, ht1_, ht2_, pow_nonneg hp_ 2, mul_nonneg (hp_) (hq_), pow_nonneg hq_ 2]) hp_");
    expect(lines).toContain("    exact ⟨by linarith only [hp0_, hxy_, hyz_], by linarith only [hp0_, hxy_, hyz_], by linarith only [hp0_, hxy_, hyz_]⟩");
    expect(lines.slice(-2)).toEqual(["  · rintro ⟨rfl, rfl, rfl⟩", "    norm_num [S]"]);
    // nothing searched over the statement's whole context, nothing unproved
    expect(script(pl)).not.toMatch(/sorry|native_decide|first \||\bnlinarith \[/);
  });

  it("one inequality: no bullets; a factor that needs p² ≥ 3q or q² ≥ 3p is left to nlinarith with exactly those facts", async () => {
    const pl = await plan(goal("a + b + c ≤ a ^ 2 + b ^ 2 + c ^ 2"));
    if ("reason" in pl) throw new Error(pl.reason);
    const text = script(pl);
    expect(text).not.toContain("refine ⟨");
    expect(text).toContain("have hfrac_ : a ^ 2 + b ^ 2 + c ^ 2 - (a + b + c) = ");
    expect(text).toContain("(by nlinarith only [hp_, hq_, ht1_, ht2_, mul_nonneg hp_ hq_, sq_nonneg p_, sq_nonneg q_, sq_nonneg (p_ - q_), sq_nonneg (p_ + q_)] : (0:ℝ) ≤ ");
    expect(text.split("\n").at(-1)).toBe("exact sub_nonneg.mp hdiff_");
    // no lets: nothing to unfold
    expect(text).not.toContain("simp only [");
  });

  it("a factor's sign is the factor's own (1/x² + 1/y² + 1/z² ≥ x + y + z is q² ≥ 3p, not a negative form)", async () => {
    const pl = await plan(goal("a + b + c ≤ 1 / a ^ 2 + 1 / b ^ 2 + 1 / c ^ 2"));
    if ("reason" in pl) throw new Error(pl.reason);
    expect(pl.chosen[0].part.g_const).toBe("1");
    expect(pl.chosen[0].part.g.map((g) => g.kind)).toEqual(["other"]);
  });

  it("an inequality that fails at x = y = z = 1 is a counterexample, not a failed proof", async () => {
    const r = await plan(goal("1 ≤ 1 / (1 + a) ^ 2 + 1 / (1 + b) ^ 2 + 1 / (1 + c) ^ 2"));
    expect(r).toEqual({ reason: "1 ≤ 1 / (1 + a) ^ 2 + 1 / (1 + b) ^ 2 + 1 / (1 + c) ^ 2 is false at a = b = c = 1", counterexample: "a = b = c = 1" });
  });

  it("says so when the two sides are not symmetric, or the equality case does not follow from the form", async () => {
    expect(await plan(goal("a + 2 * b ≤ a ^ 2 + b ^ 2 + c ^ 2"))).toEqual({ reason: "not symmetric" });
    // Σ 1/a² − (a + b + c) is q² − 3p itself: nothing is left beside the fact to force p = 0
    const r = await plan(goal("a + b + c ≤ 1 / a ^ 2 + 1 / b ^ 2 + 1 / c ^ 2 ∧ (1 / a ^ 2 + 1 / b ^ 2 + 1 / c ^ 2 = a + b + c ↔ a = 1 ∧ b = 1 ∧ c = 1)"));
    expect(r).toMatchObject({ reason: expect.stringMatching(/^part 2: .*equality case/) });
  });

  it("an equality case that needs p² ≥ 3q: a² + b² + c² = a + b + c is p² + 5p − 2q = 0, and ⅔ of the fact leaves ⅓p² + p", async () => {
    const pl = await plan(goal("a + b + c ≤ a ^ 2 + b ^ 2 + c ^ 2 ∧ (a ^ 2 + b ^ 2 + c ^ 2 = a + b + c ↔ a = 1 ∧ b = 1 ∧ c = 1)"));
    if ("reason" in pl) throw new Error(pl.reason);
    expect(pl.chosen[1].part.linear).toBe("P");
    expect(pl.chosen[1].part.rest).toEqual([
      ["1/3", { v0: 2 }],
      ["1", { v0: 1 }],
    ]);
    const lines = script(pl).split("\n");
    expect(lines).toContain("    have hp0_ : p_ = 0 := le_antisymm (by linarith only [hzero_, hp_, hq_, ht1_, ht2_, pow_nonneg hp_ 2]) hp_");
    expect(lines.slice(-2)).toEqual(["  · rintro ⟨rfl, rfl, rfl⟩", "    norm_num"]);
  });
});
