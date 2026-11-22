import { describe, expect, it } from "vitest";
import { boundedIsChunked, boundedMinScripts, orderRefutation, productBoundedScripts } from "@/lib/lean/order-proof";

const MOD = ": Nat.ModEq ((2 ^ 12) * 7 * 13) 65536 (2 ^ 65536) ∧ ∀ n : ℕ, 0 < n → Nat.ModEq ((2 ^ 12) * 7 * 13) n (2 ^ n) → 65536 ≤ n";
const PSP =
  ": (0 < 341 ∧ 341 = 11 * 31 ∧ Nat.Prime 11 ∧ Nat.Prime 31 ∧ 341 ∣ 2 ^ (341 - 1) - 1) ∧ ∀ n p q : ℕ, 0 < n → n < 341 → n = p * q → Nat.Prime p → Nat.Prime q → Odd p → Odd q → p ≠ q → p < q → ¬ n ∣ 2 ^ (n - 1) - 1";
const WRONG =
  ": (2 ^ 1814400 : ℕ) % (3 ^ 5 * 5 ^ 3) = 1 % (3 ^ 5 * 5 ^ 3) ∧ (3 ^ 1814400 : ℕ) % (2 ^ 8 * 7 ^ 2) = 1 % (2 ^ 8 * 7 ^ 2) ∧ ∀ n : ℕ, 0 < n → ((2 ^ n : ℕ) % (3 ^ 5 * 5 ^ 3) = 1 % (3 ^ 5 * 5 ^ 3) ∧ (3 ^ n : ℕ) % (2 ^ 8 * 7 ^ 2) = 1 % (2 ^ 8 * 7 ^ 2)) → 1814400 ≤ n";

describe("the smallest n, bound above the kernel's recursion limit", () => {
  it("checks every number below the bound in pieces of 8000, the variable written 1000 · (k + 8j) + r", () => {
    const [script] = boundedMinScripts(MOD);
    const lines = script.split("\n");
    expect(lines.filter((l) => l.startsWith("have key"))).toHaveLength(9); // 65536 / 8000, rounded up
    expect(lines[1]).toBe(
      "have key1 : ∀ k__ : ℕ, k__ < 8 → ∀ r__ : ℕ, r__ < 1000 → (1000 * (k__ + 8) + r__) < 65536 → (0 < (1000 * (k__ + 8) + r__) → Nat.ModEq ((2 ^ 12) * 7 * 13) (1000 * (k__ + 8) + r__) (2 ^ (1000 * (k__ + 8) + r__)) → False) := by decide +kernel",
    );
    expect(script).toContain("rcases Nat.lt_or_ge n 8000 with hc0 | hc0");
    expect(script).toContain("have h__ := key8 (n / 1000 - 64) (by omega) (n % 1000) (Nat.mod_lt _ (by norm_num))");
    expect(script).toContain("rw [show 1000 * (n / 1000 - 64 + 64) + n % 1000 = n by omega] at h__");
    expect(boundedIsChunked(MOD)).toBe(true);
    expect(boundedIsChunked(": 7 ∣ 2 ^ 3 - 1 ∧ ∀ n : ℕ, 0 < n → 7 ∣ 2 ^ n - 1 → 3 ≤ n")).toBe(false);
  });
});

describe("no product of two primes below the bound", () => {
  it("is one pass over n: every n with the property is 1 or prime", () => {
    const [script] = productBoundedScripts(PSP);
    expect(script.split("\n")[0]).toBe("have key : ∀ n : ℕ, n < 341 → (n ∣ 2 ^ (n - 1) - 1 → n ≤ 1 ∨ Nat.Prime n) := by decide +kernel");
    expect(script).toContain("intro n p q hn__ hlt__ he__ hh0__ hh1__ hh2__ hh3__ hh4__ hh5__ hC__");
    expect(script).toContain("exact Nat.not_prime_mul hp__.one_lt.ne' hq__.one_lt.ne' h1__");
  });
  it("leaves other shapes alone", () => {
    // p is not said to be prime; the conclusion is about q; no bound on n; a bound above 2000
    expect(productBoundedScripts(": ∀ n p q : ℕ, 0 < n → n < 341 → n = p * q → Nat.Prime q → ¬ n ∣ 2 ^ (n - 1) - 1")).toEqual([]);
    expect(productBoundedScripts(": ∀ n p q : ℕ, 0 < n → n < 341 → n = p * q → Nat.Prime p → Nat.Prime q → ¬ q ∣ 2 ^ (n - 1) - 1")).toEqual([]);
    expect(productBoundedScripts(": ∀ n p q : ℕ, 0 < n → n = p * q → Nat.Prime p → Nat.Prime q → ¬ n ∣ 2 ^ (n - 1) - 1")).toEqual([]);
    expect(productBoundedScripts(": ∀ n p q : ℕ, 0 < n → n < 34100 → n = p * q → Nat.Prime p → Nat.Prime q → ¬ n ∣ 2 ^ (n - 1) - 1")).toEqual([]);
    expect(productBoundedScripts(": ∀ n : ℕ, n + 0 = n")).toEqual([]);
  });
});

describe("a smallest n that is not the least common multiple of the orders", () => {
  it("is refuted by the least common multiple, as a proof of the negation for Lean to check", () => {
    const r = orderRefutation(WRONG)!;
    expect(r).toMatchObject({ n: 907200, bound: 1814400 });
    expect(r.type.startsWith(": ¬ ((2 ^ 1814400 : ℕ) % ")).toBe(true);
    expect(r.script).toContain("exact absurd (h.2.2 907200 (by norm_num) (by first | decide +kernel | (and_intros <;> decide +kernel))) (by norm_num)");
  });
  it("says nothing when the bound is the least common multiple, or the statement has binders", () => {
    expect(orderRefutation(WRONG.replaceAll("1814400", "907200"))).toBeUndefined();
    expect(orderRefutation("(k : ℕ) : ∀ n : ℕ, 0 < n → 7 ∣ 2 ^ n - 1 → 6 ≤ n")).toBeUndefined();
    expect(orderRefutation(": ∀ n : ℕ, n + 0 = n")).toBeUndefined();
  });
});
