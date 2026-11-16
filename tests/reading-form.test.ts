import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { bridgeBody, comparisonsLeft, expandBinderBounds, originalSource, readingForm, scriptInOriginalNames, unindent } from "@/lib/lean/reading-form";
import { statementVariants } from "@/lib/lean/statement-variants";
import { normalizeTheoremType } from "@/lib/llm/autoformalize";
import { parseFixture } from "@/lib/pipeline/prover-regression";

const read = (t: string) => readingForm(t).type;

describe("comparisons turned to ≤ and <", () => {
  it("turns ≥ and > round, sides and all", () => {
    expect(comparisonsLeft("(n : ℕ) (h : n ≥ 5) : 2 ^ n > n ^ 2")).toBe("(n : ℕ) (h : 5 ≤ n) : n ^ 2 < 2 ^ n");
    expect(comparisonsLeft(": ∀ x y : ℝ, x > 0 → y > 0 → x + y ≥ 2 * Real.sqrt (x * y)")).toBe(": ∀ x y : ℝ, 0 < x → 0 < y → 2 * Real.sqrt (x * y) ≤ x + y");
    expect(comparisonsLeft(": ∀ m : ℕ, m > 0 → 56700 > m → ¬ (3 ∣ m ∧ m ≥ 2)")).toBe(": ∀ m : ℕ, 0 < m → m < 56700 → ¬ (3 ∣ m ∧ 2 ≤ m)");
    expect(comparisonsLeft(": 649 > (1 : ℕ) ∧ ∀ m : ℕ, m > 1 → (2025 : ℤ) ∣ ((m : ℤ)^2 - 1) → m ≥ 649")).toBe(": (1 : ℕ) < 649 ∧ ∀ m : ℕ, 1 < m → (2025 : ℤ) ∣ ((m : ℤ)^2 - 1) → 649 ≤ m");
  });

  it("leaves ≤, <, and the arrows that only look like >", () => {
    const t = ": ∀ n : ℕ, 0 < n → (Finset.univ.filter (fun k : Fin n => k.val ≤ 3)).card ≤ 4";
    expect(comparisonsLeft(t)).toBe(t);
    expect(comparisonsLeft(": (fun x : ℕ => x + 1) 2 = 3")).toBe(": (fun x : ℕ => x + 1) 2 = 3");
    expect(comparisonsLeft(": ∀ f : ℕ -> ℕ, f 0 = f 0")).toBe(": ∀ f : ℕ -> ℕ, f 0 = f 0");
  });

  it("finds the sides: a set's bar, absolute values, a sum, an if, a lambda, a subtype", () => {
    expect(comparisonsLeft(": IsLeast {n : ℕ | n > 0 ∧ |(n : ℤ) - 7| ≥ 2} 1")).toBe(": IsLeast {n : ℕ | 0 < n ∧ 2 ≤ |(n : ℤ) - 7|} 1");
    expect(comparisonsLeft(": {x : ℝ | |x| > 1} = {x | x > 1} ∪ {x | -1 > x}")).toBe(": {x : ℝ | 1 < |x|} = {x | 1 < x} ∪ {x | x < -1}");
    expect(comparisonsLeft(": ∀ n : ℕ, ∑ i ∈ Finset.range n, (2 * i + 1) ≥ n")).toBe(": ∀ n : ℕ, n ≤ ∑ i ∈ Finset.range n, (2 * i + 1)");
    expect(comparisonsLeft(": ∀ n : ℕ, n ^ 2 ≥ ∑ i ∈ Finset.range n, i ∧ True")).toBe(": ∀ n : ℕ, ∑ i ∈ Finset.range n, i ≤ n ^ 2 ∧ True");
    expect(comparisonsLeft(": ∀ x : ℤ, (if x > 0 then x else -x) ≥ 0")).toBe(": ∀ x : ℤ, 0 ≤ (if 0 < x then x else -x)");
    expect(comparisonsLeft(": (Finset.filter (fun x => x > 2) (Finset.range 5)).card = 2")).toBe(": (Finset.filter (fun x => 2 < x) (Finset.range 5)).card = 2");
    expect(comparisonsLeft(": (Finset.filter (· ≥ 3) (Finset.range 5)).card = 2")).toBe(": (Finset.filter (3 ≤ ·) (Finset.range 5)).card = 2");
    expect(comparisonsLeft(": ∀ p : {n : ℕ // n > 0}, p.val ≥ 1")).toBe(": ∀ p : {n : ℕ // 0 < n}, 1 ≤ p.val");
    expect(comparisonsLeft(": let P := fun n : ℕ => n ≥ 2; P 3")).toBe(": let P := fun n : ℕ => 2 ≤ n; P 3");
    expect(comparisonsLeft("(F : Finset (Finset ℕ)) (n : ℕ) : n ≥ F.card ∨ F.card > n")).toBe("(F : Finset (Finset ℕ)) (n : ℕ) : F.card ≤ n ∨ n < F.card");
  });

  it("leaves what it cannot delimit: a bound in a binder, a chain, a pipe", () => {
    for (const t of [": ∀ a b ≥ 0, a + b ≥ 0", ": {n ≥ 5 | n ∣ 60} = {6, 10}", ": f <| 3 > 2", ": (a = b) = (c ≥ d = True)"]) {
      const out = comparisonsLeft(t);
      // the comparison outside the binder is still turned
      expect(out).toBe(t === ": ∀ a b ≥ 0, a + b ≥ 0" ? ": ∀ a b ≥ 0, 0 ≤ a + b" : t);
    }
  });
});

describe("bounds in binders written out", () => {
  it("∀ x > a, P and ∃ x ≥ a, P", () => {
    expect(expandBinderBounds(": ∀ ε > 0, ∃ δ > 0, δ < ε")).toBe(": ∀ ε, 0 < ε → ∃ δ, 0 < δ ∧ δ < ε");
    expect(expandBinderBounds(": ∀ n ≥ 5, 2 ^ n > n ^ 2")).toBe(": ∀ n, 5 ≤ n → 2 ^ n > n ^ 2");
    expect(expandBinderBounds(": (∃ t ≥ 0, t ≤ 1 ∧ D = t) ∧ ∀ r > (0 : ℝ), r = r")).toBe(": (∃ t, 0 ≤ t ∧ t ≤ 1 ∧ D = t) ∧ ∀ r, (0 : ℝ) < r → r = r");
  });

  it("keeps the scope: brackets where the connective after it would bind differently", () => {
    expect(expandBinderBounds(": ∀ x > 0, P x ↔ Q x")).toBe(": ∀ x, 0 < x → (P x ↔ Q x)");
    expect(expandBinderBounds(": ∃ x > 0, P x ∨ Q x")).toBe(": ∃ x, 0 < x ∧ (P x ∨ Q x)");
    expect(expandBinderBounds(": ∃ x ≥ 2, P x ∧ Q x")).toBe(": ∃ x, 2 ≤ x ∧ P x ∧ Q x");
    expect(expandBinderBounds(": let S := {y : ℕ | ∃ x > 0, y = x}; S = S")).toBe(": let S := {y : ℕ | ∃ x, 0 < x ∧ y = x}; S = S");
    expect(expandBinderBounds(": ∀ i : ℕ, (if ∃ k > 0, i = k ∨ i = 7 then 1 else 0) = 1")).toBe(": ∀ i : ℕ, (if ∃ k, 0 < k ∧ (i = k ∨ i = 7) then 1 else 0) = 1");
    expect(expandBinderBounds(": let P := ∃ k > 0, k = 1 ∨ k = 2; P")).toBe(": let P := ∃ k, 0 < k ∧ (k = 1 ∨ k = 2); P");
  });

  it("leaves the bounds that already point that way, typed binders, several names", () => {
    for (const t of [": ∀ x < 5, x ≤ 4", ": ∀ x ∈ s, x = x", ": ∀ x : ℝ, x > 0 → x ≠ 0", ": ∀ a b > 0, a + b > 0", ": ∃! x > 0, x = 1"]) expect(expandBinderBounds(t)).toBe(t);
  });
});

describe("the reading form", () => {
  it("is the statement itself when it is already written that way", () => {
    const t = "(n : ℕ) (hn : 5 ≤ n) : n ^ 2 < 2 ^ n";
    expect(readingForm(t)).toEqual({ type: t, changed: false, names: new Map() });
  });

  it("names, bounds and comparisons together", () => {
    const f = readingForm(": ∀ (a' : ℕ → ℕ) (h₀ : a' 0 ≥ 1), ∀ n' ≥ 1, a' n' > 0");
    expect(f.type).toBe(": ∀ (b : ℕ → ℕ) (h_0 : 1 ≤ b 0), ∀ o, 1 ≤ o → 0 < b o");
    expect(f.changed).toBe(true);
    expect([...f.names]).toEqual([["b", "a'"], ["h_0", "h₀"], ["o", "n'"]]);
  });

  it("the binders before the colon too: a proof that names them gets the statement's names back", () => {
    const f = readingForm("(a' : ℕ → ℕ) (h₀ : a' 0 ≥ 1) : ∀ n' ≥ 1, a' n' > 0");
    expect(f.type).toBe("(b : ℕ → ℕ) (h_0 : 1 ≤ b 0) : ∀ o, 1 ≤ o → 0 < b o");
    expect([...f.names]).toEqual([["b", "a'"], ["h_0", "h₀"], ["o", "n'"]]);
    expect(readingForm("(x : ℝ) (h₀ : 0 < x) (h₁ : x ^ 2 = 4) : x = 2").type).toBe("(x : ℝ) (h_0 : 0 < x) (h_1 : x ^ 2 = 4) : x = 2");
    // nothing to rename, nothing to turn: the statement itself
    const t = "(x : ℝ) (hx : 0 < x) (hsq : x ^ 2 = 4) : x = 2";
    expect(readingForm(t).changed).toBe(false);
  });

  it("gives plain names that nothing else in the statement has; other names stay", () => {
    expect(read(": ∀ x₁ x₂ x_1 : ℝ, x₁ + x₂ = x₂ + x₁ + 0 * x_1")).toBe(": ∀ x_1_ x_2 x_1 : ℝ, x_1_ + x_2 = x_2 + x_1_ + 0 * x_1");
    // a primed letter: the next letter of its alphabet that the statement does not use
    expect(read(": ∀ m'' n : ℕ, m''.succ + n = Nat.succ m'' + n")).toBe(": ∀ o n : ℕ, o.succ + n = Nat.succ o + n");
    expect(read(": ∀ A A' B : ℝ × ℝ, dist A A' = dist A' A + 0 * dist A B")).toBe(": ∀ A C B : ℝ × ℝ, dist A C = dist C A + 0 * dist A B");
    expect(read(": ∀ ε' : ℝ, ε' = ε'")).toBe(": ∀ ζ : ℝ, ζ = ζ");
    expect(read(": let Valid' := {k : ℕ | k < 5}; IsGreatest Valid' 4")).toBe(": let Valid_p := {k : ℕ | k < 5}; IsGreatest Valid_p 4");
    // a constant with a prime, a Greek letter, a capital: not bound names with a prime or subscript
    const t = "(α : Type*) [Fintype α] (S : Finset α) : S.card ≤ Fintype.card α ∧ Nat.succ' = Nat.succ'";
    expect(read(t)).toBe(t);
  });

  it("statements written by others (miniF2F): Lean confirmed each of these reading forms says the same (Iff.rfl)", () => {
    const cases: [string, string][] = [
      ["(f : ℚ → ℝ) (h₀ : ∀ x > 0, ∀ y > 0, f (x * y) = f x + f y) (h₁ : ∀ p, Nat.Prime p → f p = p) : f (25 /. 11) < 0", "(f : ℚ → ℝ) (h₀ : ∀ x, 0 < x → ∀ y, 0 < y → f (x * y) = f x + f y) (h₁ : ∀ p, Nat.Prime p → f p = p) : f (25 /. 11) < 0"],
      ["(n : ℕ) (h₀ : 0 < n) : ∃ m, m > n ∧ ∃ p, m * p ≤ m + p", "(n : ℕ) (h₀ : 0 < n) : ∃ m, n < m ∧ ∃ p, m * p ≤ m + p"],
      ["(a b c d : ℝ) (h₀ : 0 < a ∧ 0 < b ∧ 0 < c ∧ 0 < d) : a ^ 2 / b + b ^ 2 / c + c ^ 2 / d + d ^ 2 / a ≥ a + b + c + d", "(a b c d : ℝ) (h₀ : 0 < a ∧ 0 < b ∧ 0 < c ∧ 0 < d) : a + b + c + d ≤ a ^ 2 / b + b ^ 2 / c + c ^ 2 / d + d ^ 2 / a"],
      ["(a : ℝ) (f : ℝ → ℝ) (h₀ : 0 < a) (h₁ : ∀ x, f (x + a) = 1 / 2 + Real.sqrt (f x - f x ^ 2)) : ∃ b > 0, ∀ x, f (x + b) = f x", "(a : ℝ) (f : ℝ → ℝ) (h₀ : 0 < a) (h₁ : ∀ x, f (x + a) = 1 / 2 + Real.sqrt (f x - f x ^ 2)) : ∃ b, 0 < b ∧ ∀ x, f (x + b) = f x"],
      ["(f : ℝ → ℝ) (h₀ : ∀ x < 0, f x = -x ^ 2 - 1) (h₁ : ∀ x, 0 ≤ x ∧ x < 4 → f x = 2) (h₂ : ∀ x ≥ 4, f x = Real.sqrt x) : f Real.pi = 2", "(f : ℝ → ℝ) (h₀ : ∀ x < 0, f x = -x ^ 2 - 1) (h₁ : ∀ x, 0 ≤ x ∧ x < 4 → f x = 2) (h₂ : ∀ x, 4 ≤ x → f x = Real.sqrt x) : f Real.pi = 2"],
      [": ∀ x > 0, 2 - Real.sqrt 2 ≥ 2 - x - 1 / (2 * x)", ": ∀ x, 0 < x → 2 - x - 1 / (2 * x) ≤ 2 - Real.sqrt 2"],
      ["(x : ℝ) (h₀ : x ^ 2 - 5 * x - 4 ≤ 10) : x ≥ -2 ∧ x ≤ 7", "(x : ℝ) (h₀ : x ^ 2 - 5 * x - 4 ≤ 10) : -2 ≤ x ∧ x ≤ 7"],
    ];
    for (const [written, reading] of cases) {
      const f = readingForm(written);
      // (written here with the statement's own names: `h₀` is `h_0` to the provers)
      expect(scriptInOriginalNames(f.type, f)).toBe(reading);
      expect(f.type).not.toMatch(/[₀-₉]/);
    }
  });

  it("one reading form for every way of writing: a statement and its variants on the regression list", () => {
    const fixture = parseFixture(readFileSync(path.join(__dirname, "..", "bench", "provers.json"), "utf8"));
    let flips = 0;
    let primes = 0;
    for (const c of fixture.cases) {
      const base = normalizeTheoremType(c.type);
      const r = read(base);
      // nothing left pointing the other way
      expect(r.replace(/=>|->/g, ""), c.id).not.toMatch(/[≥>]/);
      // and it is stable
      expect(read(r), c.id).toBe(r);
      for (const v of statementVariants(base, ["flip"])) {
        expect(read(v.type), `${c.id}~flip`).toBe(r);
        flips++;
      }
      for (const v of statementVariants(base, ["prime"])) {
        if (/['₀-₉]/.test(base)) continue;
        // the primes are gone: plain names, and with the names taken back and the primes off, the statement's reading form
        const f = readingForm(v.type);
        expect(f.type, `${c.id}~prime`).not.toMatch(/[A-Za-z0-9_]'/);
        expect(scriptInOriginalNames(f.type, f).replace(/'/g, ""), `${c.id}~prime`).toBe(r);
        primes++;
      }
    }
    expect(flips).toBeGreaterThan(40);
    expect(primes).toBeGreaterThan(150);
    // the list itself is nearly all written that way already: the reading form changes little that works today
    expect(fixture.cases.filter((c) => readingForm(normalizeTheoremType(c.type)).changed).map((c) => c.id)).toEqual(["s-hammer-04", "ind-t17", "ind-t19"]);
  });
});

describe("back to the statement as written", () => {
  const written = "(a' : ℕ → ℕ) (h0' : a' 0 ≥ 1) : ∀ n', a' n' ≥ 1 → a' n' > 0";
  const form = readingForm(written);
  const source = `import Mathlib\n\nset_option maxHeartbeats 400000 in\ntheorem t ${form.type} := by\n  intro o hn\n  have := h0_p\n  omega\n`;

  it("the script with the statement's own names, under the statement as written", () => {
    expect(form.type).toBe("(b : ℕ → ℕ) (h0_p : 1 ≤ b 0) : ∀ o, 1 ≤ b o → 0 < b o");
    expect(scriptInOriginalNames("exact h0_p.trans (b_mono o) |>.le.trans (h.b o)", form)).toBe("exact h0'.trans (b_mono n') |>.le.trans (h.b n')");
    const o = originalSource(source, "t", written, form)!;
    expect(o.source).toBe(`import Mathlib\n\nset_option maxHeartbeats 400000 in\ntheorem t ${written} := by\n  intro n' hn\n  have := h0'\n  omega\n`);
    expect(o.tactics).toBe("intro n' hn\nhave := h0'\nomega");
    expect(originalSource("theorem other : True := by\n  trivial\n", "t", written, form)).toBeUndefined();
  });

  it("the bridge: the reading form proved inside, the statement concluded from it", () => {
    const body = "  intro n' hn\n  omega\n";
    expect(bridgeBody(form, body)).toBe(
      ["  have reading : ∀ (a' : ℕ → ℕ) (h0' : 1 ≤ a' 0), ∀ n', 1 ≤ a' n' → 0 < a' n' := by", "    intro a' h0'", "    intro n' hn", "    omega", "  exact reading a' h0'"].join("\n"),
    );
    // no binders before the colon: nothing to introduce or pass
    expect(bridgeBody(readingForm(": ∀ n ≥ 5, 2 ^ n > n ^ 2"), "  intro n hn\n  omega\n")).toBe(["  have reading : ∀ n, 5 ≤ n → n ^ 2 < 2 ^ n := by", "    intro n hn", "    omega", "  exact reading"].join("\n"));
    // instances are introduced without a name and found again by Lean; implicit ones are not passed
    expect(bridgeBody(readingForm("{n : ℕ} [NeZero n] (k : Fin n) (h : k.val ≥ 0) : k.val ≥ 0"), "  exact h\n")).toBe(
      ["  have reading : ∀ {n : ℕ} [NeZero n] (k : Fin n) (h : 0 ≤ k.val), 0 ≤ k.val := by", "    intro n _ k h", "    exact h", "  exact reading k h"].join("\n"),
    );
    // a universe written `Type*` cannot be restated inside a proof
    expect(bridgeBody(readingForm("(α : Type*) (s : Finset α) : s.card ≥ 0"), "  simp\n")).toBeUndefined();
    expect(unindent("  a\n    b\n")).toBe("a\n  b");
  });
});
