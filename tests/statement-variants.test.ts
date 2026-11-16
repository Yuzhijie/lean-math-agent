import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { boundNames, renameBound } from "@/lib/lean/statement-text";
import { equivalenceType, statementVariants, VARIANT_KINDS, type VariantKind } from "@/lib/lean/statement-variants";
import { normalizeTheoremType } from "@/lib/llm/autoformalize";
import { parseFixture } from "@/lib/pipeline/prover-regression";

const variant = (type: string, kind: VariantKind) => statementVariants(type, [kind])[0]?.type;

describe("the names a statement binds", () => {
  it("binders before the colon, quantifiers, big operators, fun, let, set-builder", () => {
    expect(boundNames("(n : ℕ) (hn : 0 < n) : ∑ i ∈ Finset.range n, (2 * i + 1) = n ^ 2")).toEqual(["n", "hn", "i"]);
    expect(boundNames(": ∀ x y : ℝ, 0 < x → ∃ z, z ∈ Set.Icc x y")).toEqual(["x", "y", "z"]);
    expect(boundNames(": let S := {k : ℕ | k < 5}; IsGreatest S 4")).toEqual(["S", "k"]);
    expect(boundNames(": (Finset.univ.filter (fun f : Fin 3 → Fin 2 => f 0 = 1)).card = 4")).toEqual(["f"]);
    expect(boundNames(": ∀ n ≥ 1, ∃ (a b : ℕ), a + b = n")).toEqual(["n", "a", "b"]);
    expect(boundNames(": ∀ p ∈ ({(a, b) : ℕ × ℕ | a < b} : Set (ℕ × ℕ)), p.1 < p.2")).toEqual(["p", "a", "b"]);
  });

  it("not members, not constants, not instance brackets, not a literal set", () => {
    expect(boundNames("(s : Finset ℕ) [DecidableEq ℕ] : s.card ≤ s.card + Nat.succ 0")).toEqual(["s"]);
    expect(boundNames(": ({1, 2, 3} : Finset ℕ).card = 3")).toEqual([]);
    expect(boundNames(": |(3 : ℤ) - 5| = 2")).toEqual([]);
  });

  it("renames every occurrence of a bound name and nothing else", () => {
    const t = "(n : ℕ) : n.succ = Nat.succ n ∧ ∀ m, m + n = n + m";
    expect(renameBound(t, new Map([["n", "q"], ["m", "r"]]))).toBe("(q : ℕ) : q.succ = Nat.succ q ∧ ∀ r, r + q = q + r");
    // `n` inside another name, after a dot or in a numeral is not the variable
    expect(renameBound(": ∀ n : ℕ, n.gcd 2 = Nat.gcd n 2 ∧ nn = n1", new Map([["n", "k"]]))).toBe(": ∀ k : ℕ, k.gcd 2 = Nat.gcd k 2 ∧ nn = n1");
  });
});

describe("variants of a statement", () => {
  it("prime: every bound name with a prime", () => {
    expect(variant("(n : ℕ) (h : 5 ≤ n) : 2 ^ n > n ^ 2", "prime")).toBe("(n' : ℕ) (h' : 5 ≤ n') : 2 ^ n' > n' ^ 2");
    // a name that already exists is not taken
    expect(variant(": ∀ x x' : ℕ, x + x' = x' + x", "prime")).toBe(": ∀ x'' x''' : ℕ, x'' + x''' = x''' + x''");
  });

  it("letters: single letters move within their alphabet, longer names get a subscript", () => {
    expect(variant(": ∀ n : ℕ, ∑ i ∈ Finset.range n, i = n * (n - 1) / 2", "letters")).toBe(": ∀ q : ℕ, ∑ l ∈ Finset.range q, l = q * (q - 1) / 2");
    expect(variant(": let Valid := {k : ℕ | k < 5}; IsGreatest Valid 4", "letters")).toBe(": let Valid₁ := {n : ℕ | n < 5}; IsGreatest Valid₁ 4");
    expect(variant("(A B : ℝ × ℝ) : dist A B = dist B A", "letters")).toBe("(D E : ℝ × ℝ) : dist D E = dist E D");
  });

  it("subscript: the one-letter names get a subscript; longer names stay", () => {
    expect(variant("(x y : ℝ) (hx : 0 < x) : x * y = y * x", "subscript")).toBe("(x₁ y₁ : ℝ) (hx : 0 < x₁) : x₁ * y₁ = y₁ * x₁");
    expect(variant(": ∀ a a₁ : ℕ, a + a₁ = a₁ + a", "subscript")).toBe(": ∀ a₂ a₁ : ℕ, a₂ + a₁ = a₁ + a₂");
    expect(variant(": let Valid := 3; Valid = 3", "subscript")).toBeUndefined();
  });

  it("case: the first letter of a longer name; single letters stay", () => {
    expect(variant(": let Valid := {k : ℕ | k < 5}; IsGreatest Valid 4", "case")).toBe(": let valid := {k : ℕ | k < 5}; IsGreatest valid 4");
    expect(variant(": ∀ n : ℕ, n = n", "case")).toBeUndefined();
  });

  it("binders: before the colon ↔ behind it", () => {
    expect(variant("(n : ℕ) (hn : 0 < n) : n ≠ 0", "binders")).toBe(": ∀ (n : ℕ) (hn : 0 < n), n ≠ 0");
    expect(variant(": ∀ n : ℕ, 0 < n → n ≠ 0", "binders")).toBe("(n : ℕ) (hv1 : 0 < n) : n ≠ 0");
    expect(variant(": ∀ (a b : ℤ), a ∣ b → b ∣ a → 0 ≤ a → 0 ≤ b → a = b", "binders")).toBe("(a b : ℤ) (hv1 : a ∣ b) (hv2 : b ∣ a) (hv3 : 0 ≤ a) (hv4 : 0 ≤ b) : a = b");
  });

  it("binders: leaves alone what it cannot move safely", () => {
    // a bound in the binder, an iff at the top, an arrow inside a quantifier's scope
    expect(variant(": ∀ n ≥ 1, n ≠ 0", "binders")).toBeUndefined();
    expect(variant(": ∀ n : ℕ, (0 < n ↔ n ≠ 0)", "binders")).toBe("(n : ℕ) : 0 < n ↔ n ≠ 0");
    expect(variant(": 0 < 1 ↔ 1 ≠ 0", "binders")).toBeUndefined();
    expect(variant(": (∃ k : ℕ, k < 3) ∧ ∀ m : ℕ, m < 3 → m ≤ 2", "binders")).toBeUndefined();
    expect(variant(": ∃ k : ℕ, k < 3 → k ≤ 2", "binders")).toBeUndefined();
    // a binder written with an arrow moves as a binder, not as a hypothesis
    expect(variant(": (D E : ℝ × ℝ) → D.1 = E.1 → D.2 = E.2 → D = E", "binders")).toBe("(D E : ℝ × ℝ) (hv1 : D.1 = E.1) (hv2 : D.2 = E.2) : D = E");
    expect(variant(": ((2 : ℕ) = 2) → True", "binders")).toBe("(hv1 : (2 : ℕ) = 2) : True");
    expect(variant(": (D : ℝ) → (∃ t : ℝ, D = t) → D = D", "binders")).toBe("(D : ℝ) (hv1 : ∃ t : ℝ, D = t) : D = D");
  });

  it("flip: comparisons between plain operands, not bounds in binders, not compound sides", () => {
    expect(variant("(n : ℕ) (h : 0 < n) : n ≥ 1", "flip")).toBe("(n : ℕ) (h : n > 0) : 1 ≤ n");
    expect(variant(": ∀ n ≥ 1, n + 1 > 1 ∧ (n ≤ (n + 1))", "flip")).toBe(": ∀ n ≥ 1, n + 1 > 1 ∧ ((n + 1) ≥ n)");
    expect(variant(": ∀ x y : ℝ, x + y ≤ 10 → f x < 3", "flip")).toBeUndefined();
    expect(variant(": ∀ s : Finset ℕ, s.card ≤ 5 → 0 ≤ s.card", "flip")).toBe(": ∀ s : Finset ℕ, 5 ≥ s.card → s.card ≥ 0");
  });

  it("one variant per kind at most, each different from the statement and from each other", () => {
    const t = "(n : ℕ) (hn : 5 ≤ n) : n ^ 2 < 2 ^ n";
    const vs = statementVariants(t);
    expect(vs.map((v) => v.kind)).toEqual(["prime", "letters", "subscript", "case", "binders", "flip"]); // case: hn → Hn
    expect(new Set(vs.map((v) => v.type)).size).toBe(vs.length);
    expect(vs.every((v) => v.type !== t && v.note)).toBe(true);
    expect(statementVariants(": (2 : ℕ) + 2 = 4")).toEqual([]);
    expect(statementVariants(t, ["flip"]).map((v) => v.kind)).toEqual(["flip"]);
  });

  it("the equivalence Lean is asked to confirm", () => {
    expect(equivalenceType("(n : ℕ) : n = n", ": ∀ q : ℕ, q = q")).toBe(": (∀ (n : ℕ), n = n) ↔ (∀ q : ℕ, q = q)");
    expect(equivalenceType("no colon", ": True")).toBeUndefined();
    // `Type*` twice would be two universes: one named universe on both sides
    expect(equivalenceType("(α : Type*) (s : Finset α) : s = s", "(β : Type*) (s : Finset β) : s = s")).toBe(": (∀ (α : Type u_same) (s : Finset α), s = s) ↔ (∀ (β : Type u_same) (s : Finset β), s = s)");
  });
});

describe("on the regression list", () => {
  const fixture = parseFixture(readFileSync(path.join(__dirname, "..", "bench", "provers.json"), "utf8"));
  const all = fixture.cases.map((c) => ({ c, base: normalizeTheoremType(c.type), variants: statementVariants(normalizeTheoremType(c.type)) }));
  const balanced = (s: string) => {
    let depth = 0;
    for (const ch of s) {
      if ("([{⟨".includes(ch)) depth++;
      else if (")]}⟩".includes(ch)) depth--;
      if (depth < 0) return false;
    }
    return depth === 0;
  };

  it("nearly every statement has a variant, and every kind occurs", () => {
    expect(all.filter((x) => x.variants.length).length).toBeGreaterThan(all.length * 0.9);
    for (const kind of VARIANT_KINDS) expect(all.some((x) => x.variants.some((v) => v.kind === kind)), kind).toBe(true);
  });

  it("a renaming keeps the text apart from the names: same length class, same brackets, same symbols", () => {
    const symbols = (s: string) => s.replace(/[A-Za-z0-9_'₀-₉αβγδεζηθικμνξορςστυφχψω\s]/g, "");
    for (const { c, base, variants } of all)
      for (const v of variants.filter((x) => x.kind !== "binders" && x.kind !== "flip")) {
        expect(balanced(v.type), `${c.id}~${v.kind}`).toBe(true);
        expect(symbols(v.type), `${c.id}~${v.kind}`).toBe(symbols(base));
      }
  });

  it("prime: taking the primes away gives the statement back", () => {
    for (const { c, base, variants } of all) {
      const v = variants.find((x) => x.kind === "prime");
      if (!v || base.includes("'")) continue;
      expect(v.type.replace(/'/g, ""), c.id).toBe(base);
    }
  });

  it("flip: turning the comparisons round twice gives the statement back", () => {
    for (const { c, base, variants } of all) {
      const v = variants.find((x) => x.kind === "flip");
      if (!v) continue;
      expect(balanced(v.type), c.id).toBe(true);
      expect(statementVariants(v.type, ["flip"])[0]?.type, c.id).toBe(base);
    }
  });
});
