import { beforeEach, describe, expect, it, vi } from "vitest";

// The Lean attempt for a solved computational problem really proves the accepted statement
// (automation first, then the whole-proof loop) and reports what it tried when it cannot.

const m = vi.hoisted(() => ({
  autoformalize: vi.fn(),
  hammerTheorem: vi.fn(),
  verifyLeanSource: vi.fn(),
  checkLeanAvailable: vi.fn(),
  tryTrivialProof: vi.fn(),
  proveWholeTheorem: vi.fn(),
  buildProverContext: vi.fn(),
  rememberVerifiedProof: vi.fn(),
  replayRecalled: vi.fn(),
  rememberRepair: vi.fn(),
}));

vi.mock("@/lib/llm/autoformalize", () => ({ autoformalize: m.autoformalize }));
vi.mock("@/lib/lean/hammer", () => ({ hammerTheorem: m.hammerTheorem }));
vi.mock("@/lib/lean/sandbox", () => ({ verifyLeanSource: m.verifyLeanSource, checkLeanAvailable: m.checkLeanAvailable }));
vi.mock("@/lib/lean/trivial-proof", () => ({ tryTrivialProof: m.tryTrivialProof }));
vi.mock("@/lib/prover/whole-proof", () => ({ proveWholeTheorem: m.proveWholeTheorem, wholeProofEnabled: () => true }));
vi.mock("@/lib/prover/context", () => ({ buildProverContext: m.buildProverContext, rememberVerifiedProof: m.rememberVerifiedProof }));
vi.mock("@/lib/prover/replay", () => ({ replayRecalled: m.replayRecalled }));
vi.mock("@/lib/lean/proof-memory", () => ({ rememberRepair: m.rememberRepair }));

const { attemptLeanFormalization, leanAttemptRetryable, bigExponents, multiplicativeOrder, orderConditions, orderProofScripts, primePowers, proofHints } = await import("@/lib/pipeline/lean-attempt");
const { hugePower } = await import("@/lib/compute/nat-expr");

const GCD = {
  theorem_name: "gcd_two_powers",
  theorem_type: ": Nat.gcd (2 ^ (2024 : ℕ) + 1) (2 ^ (3036 : ℕ) - 1) = 1",
  formal_statement: "theorem gcd_two_powers : Nat.gcd (2 ^ (2024 : ℕ) + 1) (2 ^ (3036 : ℕ) - 1) = 1 := by sorry",
  formal_signature: "Nat.gcd (2 ^ 2024 + 1) (2 ^ 3036 - 1) = 1",
  validation_results: [],
  accepted: true,
};
const okVerify = { ok: true, backend: "repl", axioms: { axioms: [] }, signatureMatch: true, messages: [], log: "ok" };

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.autoformalize.mockResolvedValue(GCD);
  m.checkLeanAvailable.mockResolvedValue({ ok: true });
  m.hammerTheorem.mockResolvedValue(undefined);
  m.tryTrivialProof.mockResolvedValue(null);
  m.verifyLeanSource.mockResolvedValue(okVerify);
  m.buildProverContext.mockResolvedValue({ block: "", premises: [], recalled: [] });
  m.rememberVerifiedProof.mockResolvedValue(true);
  m.replayRecalled.mockResolvedValue(undefined);
  m.rememberRepair.mockResolvedValue(true);
});

describe("expert iteration: the Lean attempt and the proof memory", () => {
  const entry = { id: "e1", theorem_name: "old_gcd", theorem_type: ": Nat.gcd 5 7 = 1", tactics: "decide +kernel", source: "lean-attempt" };

  it("replays a remembered proof of a similar statement before asking the model", async () => {
    m.buildProverContext.mockResolvedValue({ block: "Similar proofs …", premises: [], recalled: [entry] });
    m.replayRecalled.mockResolvedValue({ tactics: "norm_num", source: "theorem gcd_two_powers … := by norm_num", verification: okVerify, entry, tried: 1 });
    const a = await attemptLeanFormalization("p", { answer: "1" });
    expect(a).toMatchObject({ success: true, strategy: "memory", attempts: 1 });
    expect(m.proveWholeTheorem).not.toHaveBeenCalled();
    expect(m.rememberVerifiedProof).toHaveBeenCalledWith(expect.objectContaining({ tactics: "norm_num", strategy: "memory", source: "lean-attempt" }));
  });

  it("gives the prover the recalled proofs and premises, and remembers its proof and the repair pair", async () => {
    m.buildProverContext.mockResolvedValue({ block: "Possibly relevant Mathlib lemmas …", premises: [], recalled: [entry] });
    m.proveWholeTheorem.mockResolvedValue({
      ok: true,
      source: "theorem gcd_two_powers … := by\n  norm_num",
      tactics: "norm_num",
      verification: okVerify,
      samples: 4,
      rounds: 2,
      candidates: [],
      repairedFrom: { tactics: "simp", feedback: "unsolved goals" },
    });
    const a = await attemptLeanFormalization("求最大公因数", { answer: "1" });
    expect(a).toMatchObject({ success: true, strategy: "whole_proof" });
    expect(m.proveWholeTheorem.mock.calls[0][0].premises).toContain("Possibly relevant");
    expect(m.rememberVerifiedProof).toHaveBeenCalledWith(
      expect.objectContaining({ theoremName: "gcd_two_powers", tactics: "norm_num", strategy: "whole_proof", source: "lean-attempt", problemText: expect.stringContaining("求最大公因数") }),
    );
    expect(m.rememberRepair).toHaveBeenCalledWith(expect.objectContaining({ failed_tactics: "simp", fixed_tactics: "norm_num", source: "lean-attempt" }));
  });

  it("remembers automation proofs too, and nothing when the attempt fails", async () => {
    m.hammerTheorem.mockResolvedValue({ tactic: "decide +kernel", attempts: [], durationMs: 5 });
    await attemptLeanFormalization("p", { answer: "1" });
    expect(m.rememberVerifiedProof).toHaveBeenCalledWith(expect.objectContaining({ tactics: "decide +kernel", strategy: "hammer" }));
    m.rememberVerifiedProof.mockClear();
    m.hammerTheorem.mockResolvedValue(undefined);
    m.proveWholeTheorem.mockResolvedValue({ ok: false, samples: 2, rounds: 1, candidates: [] });
    const a = await attemptLeanFormalization("p", { answer: "1" });
    expect(a.success).toBe(false);
    expect(m.rememberVerifiedProof).not.toHaveBeenCalled();
  });
});

describe("attemptLeanFormalization", () => {
  it("proves a computation with the automation cascade (decide +kernel)", async () => {
    m.hammerTheorem.mockResolvedValue({ tactic: "decide +kernel", attempts: [], durationMs: 5 });
    const a = await attemptLeanFormalization("求 2^2024+1 与 2^3036-1 的最大公因数。", { answer: "1" });
    expect(a).toMatchObject({ attempted: true, success: true, strategy: "hammer", statement_locked: true, verifier: "repl" });
    expect(a.proof_code).toContain("decide +kernel");
    expect(m.autoformalize.mock.calls[0][0].problemText).toContain("The answer found by solving is: 1");
    expect(m.verifyLeanSource.mock.calls[0][2]).toMatchObject({ theoremName: "gcd_two_powers", expectedSignature: GCD.formal_signature });
    expect(m.proveWholeTheorem).not.toHaveBeenCalled();
  });

  it("writes the order proof itself for \"smallest n with m ∣ 2^n - 1\", before any model call", async () => {
    const type = ": (3 ^ 4 * 5 ^ 2 * 127 : ℕ) ∣ (2 ^ 3780 - 1) ∧ ∀ n : ℕ, 0 < n → (3 ^ 4 * 5 ^ 2 * 127 : ℕ) ∣ (2 ^ n - 1) → 3780 ≤ n";
    m.autoformalize.mockResolvedValue({ ...GCD, theorem_name: "smallest_n", theorem_type: type, formal_statement: `theorem smallest_n ${type} := by sorry` });
    m.verifyLeanSource.mockResolvedValue(okVerify);
    const a = await attemptLeanFormalization("求最小的正整数 $n$，使得 $3^4\\cdot 5^2\\cdot 127\\mid 2^n-1$。", { answer: "3780" });
    expect(a).toMatchObject({ success: true, strategy: "order", attempts: 1 });
    expect(a.proof_code).toContain("ord 2 127 7 n");
    expect(m.proveWholeTheorem).not.toHaveBeenCalled();
    expect(m.rememberVerifiedProof).toHaveBeenCalledWith(expect.objectContaining({ strategy: "order" }));
  });

  it("falls back to the whole-proof loop with the solution as sketch", async () => {
    m.proveWholeTheorem.mockResolvedValue({ ok: true, source: "theorem … := by norm_num", verification: okVerify, samples: 2, rounds: 1, candidates: [] });
    const a = await attemptLeanFormalization("p", { answer: "1", solution: { summary: "gcd is 1", steps: [{ title: "Euclid", content: "reduce" }] as never } });
    expect(a).toMatchObject({ success: true, strategy: "whole_proof", attempts: 2, rounds: 1 });
    expect(m.proveWholeTheorem.mock.calls[0][0].sketch).toContain("1. Euclid: reduce");
  });

  it("says what was tried and where the closest proof failed", async () => {
    m.proveWholeTheorem.mockResolvedValue({
      ok: false, samples: 2, rounds: 1, gaveUpEarly: false,
      candidates: [
        { round: 0, tactics: "simp", ok: false, errors: 2, summary: "simp made no progress", progress: 0 },
        { round: 1, tactics: "norm_num [Nat.gcd_comm]", ok: false, errors: 1, summary: "unsolved goals ⊢ False", progress: 3 },
      ],
    });
    const a = await attemptLeanFormalization("p");
    expect(a.success).toBe(false);
    const text = [a.failure_reason, ...(a.limitations ?? [])].join("\n");
    expect(text).toContain("unsolved goals ⊢ False");
    expect(text).toMatch(/decide \+kernel/);
    expect(text).not.toMatch(/根号|radical/);
  });

  it("an unaccepted formalization reports the failed checks only", async () => {
    m.autoformalize.mockResolvedValue({ ...GCD, accepted: false, validation_results: [{ layer: 4, pass: false, detail: "back-translation differs" }] });
    const a = await attemptLeanFormalization("p");
    expect(a.limitations).toEqual(["L4: back-translation differs"]);
    expect(m.hammerTheorem).not.toHaveBeenCalled();
  });

  it("says when Lean is not available", async () => {
    m.checkLeanAvailable.mockResolvedValue({ ok: false, message: "lake not found" });
    const a = await attemptLeanFormalization("p");
    expect(a).toMatchObject({ success: false, verifier: "none", limitations: ["lake not found"] });
  });

  it("a failed attempt may be run again, a proof is kept", () => {
    expect(leanAttemptRetryable(undefined)).toBe(true);
    expect(leanAttemptRetryable({ attempted: true, success: false })).toBe(true);
    expect(leanAttemptRetryable({ attempted: true, success: true })).toBe(false);
  });
});

describe("statements too big to compute", () => {
  const STMT =
    "theorem count_pow_eq_one_residue_classes : (Finset.filter (fun x : ℕ => x ^ (2 ^ 8 * 3 ^ 4 * 5 ^ 2) % (2 ^ 8 * 3 ^ 6 * 5 ^ 3 * 7 ^ 2 * 13 * 19) = 1 % (2 ^ 8 * 3 ^ 6 * 5 ^ 3 * 7 ^ 2 * 13 * 19)) (Finset.range (2 ^ 8 * 3 ^ 6 * 5 ^ 3 * 7 ^ 2 * 13 * 19))).card = 2687385600 := by sorry";

  it("measures the range a statement enumerates", async () => {
    const { enumerationSize, evalNatExpr } = await import("@/lib/pipeline/lean-attempt");
    expect(evalNatExpr("2 ^ 8 * 3 ^ 6 * 5 ^ 3 * 7 ^ 2 * 13 * 19")).toBe(282338784000n);
    expect(evalNatExpr("(10 : ℕ) - 3")).toBe(7n);
    expect(evalNatExpr("n + 1")).toBeUndefined();
    expect(enumerationSize(STMT)).toBe(282338784000n);
    expect(enumerationSize("theorem t : (Finset.filter (fun n => 3 ∣ n) (Finset.Icc 1 100)).card = 33 := by sorry")).toBe(100n);
    expect(enumerationSize("theorem t : Nat.gcd 4 6 = 2 := by sorry")).toBeUndefined();
  });

  it("explains why, and tells the prover not to compute", async () => {
    m.autoformalize.mockResolvedValue({ ...GCD, theorem_name: "count_pow_eq_one_residue_classes", formal_statement: STMT });
    m.proveWholeTheorem.mockResolvedValue({ ok: false, samples: 2, rounds: 1, candidates: [{ round: 0, tactics: "decide", ok: false, errors: 1, summary: "maximum recursion depth has been reached", progress: 0 }] });
    const a = await attemptLeanFormalization("p");
    expect(a.limitations?.join("\n")).toMatch(/2\.8×10\^11/);
    expect(m.proveWholeTheorem.mock.calls[0][0].sketch).toMatch(/Do NOT try decide/);
  });
});

describe("hints for the prover and the sorry report", () => {
  const DODECAGON =
    ": let rot : Fin 12 → Fin 12 → Fin 12 := fun k i => ⟨(i.val + k.val) % 12, Nat.mod_lt _ (by decide)⟩; let Valid : Finset (Fin 12) → Prop := fun s => s.card = 4; ∃ reps : Fin 8 → Finset (Fin 12), ∀ j, Valid (reps j)";

  it("says to introduce the lets and to use witnesses + decide +kernel on finite statements", async () => {

    const h = proofHints(DODECAGON).join("\n");
    expect(h).toContain("intro rot Valid");
    expect(h).toContain("decide +kernel");
    expect(proofHints(": ∀ x : ℝ, x ^ 2 ≥ 0").join("\n")).not.toContain("finite types");
    const sq = proofHints(": ∀ (px py : ℝ), px = 0 → Real.sqrt ((px - 4) ^ 2 + py ^ 2) = 20 / 3").join("\n");
    expect(sq).toContain("Real.sqrt_eq_iff_eq_sq");
    expect(proofHints(": ∀ x : ℝ, x ^ 2 ≥ 0").join("\n")).not.toContain("Square roots");
    const fermat = proofHints(
      ": (341 = 11 * 31 ∧ 341 ∣ 2 ^ (341 - 1) - 1) ∧ ∀ n p q : ℕ, 0 < n → n < 341 → n = p * q → Nat.Prime p → Nat.Prime q → p < q → ¬ n ∣ 2 ^ (n - 1) - 1",
    ).join("\n");
    expect(proofHints(": ∀ E : ℝ × ℝ, (∃ t : ℝ, E = (-3 * t, 4 - 4 * t) ∧ E ≠ (0, 4)) → E.1 = -48 / 25").join("\n")).toContain("mul_eq_zero");
    expect(proofHints(": ∀ D T O : ℝ × ℝ, Real.sqrt ((D.1 - O.1) ^ 2) = 1 → D.1 = 1").join("\n")).toContain("linarith only");
    expect(fermat).toContain("exponent 340");
    expect(fermat).toContain("decide +kernel");
    expect(fermat).toContain("Smallest n");
    expect(proofHints(": 2 ^ 10 = 1024").join("\n")).not.toContain("above 256");
    expect(proofHints(": ∀ n : ℕ, n + 0 = n").join("\n")).not.toContain("finite types");
  });

  it("turns \"smallest n with m ∣ 2^n - 1\" into multiplicative orders instead of a search", () => {
    const T =
      ": let P : ℕ → Prop := fun n => ((3 : ℕ) ^ 5 ∣ (2 : ℕ) ^ n - 1 ∧ ¬((3 : ℕ) ^ 6 ∣ (2 : ℕ) ^ n - 1) ∧ (5 : ℕ) ^ 3 ∣ (2 : ℕ) ^ n - 1 ∧ ¬((5 : ℕ) ^ 4 ∣ (2 : ℕ) ^ n - 1) ∧ (7 : ℕ) ^ 2 ∣ (2 : ℕ) ^ n - 1 ∧ ¬((7 : ℕ) ^ 3 ∣ (2 : ℕ) ^ n - 1)); P 56700 ∧ ∀ n : ℕ, 0 < n → P n → 56700 ≤ n";
    expect(orderConditions(T)?.map((o) => [o.modulus, o.base, o.order])).toEqual([
      [243, 2, 162],
      [125, 2, 100],
      [49, 2, 21],
    ]);
    const h = proofHints(T).join("\n");
    expect(h).toContain("lcm 56700");
    expect(h).toContain("Nat.modEq_iff_dvd'");
    expect(orderConditions(": ∀ n : ℕ, 0 < n → 49 ∣ 3 ^ n - 1 → 11 ∣ 3 ^ n - 1 → 210 ≤ n")?.map((o) => o.order)).toEqual([42, 5]);
    // no minimality clause, or nothing of the form m ∣ a ^ n - 1: no hint
    expect(orderConditions(": ∀ n : ℕ, 243 ∣ 2 ^ n - 1 → 162 ∣ n")).toBeUndefined();
    expect(orderConditions(": ∀ n : ℕ, 0 < n → n ^ 2 ≥ 1 → 1 ≤ n")).toBeUndefined();
    // the same problem formalized with a valuation helper and "m < B → ¬ …"
    const T2 =
      ": (let ExactValuation : ℕ → ℕ → ℕ → Prop := fun p m e => p ^ e ∣ m ∧ ¬ (p ^ (e + 1) ∣ m); ExactValuation 3 (2 ^ 56700 - 1) 5 ∧ ExactValuation 5 (2 ^ 56700 - 1) 3 ∧ ExactValuation 7 (2 ^ 56700 - 1) 2 ∧ ∀ m : ℕ, 0 < m → m < 56700 → ¬ (ExactValuation 3 (2 ^ m - 1) 5 ∧ ExactValuation 5 (2 ^ m - 1) 3 ∧ ExactValuation 7 (2 ^ m - 1) 2))";
    expect(orderConditions(T2)?.map((o) => [o.modulus, o.order])).toEqual([
      [243, 162],
      [125, 100],
      [49, 21],
    ]);
    expect(proofHints(T2).join("\n")).toContain("Nat.not_le.mpr hlt");
    expect(orderConditions(": IsLeast {n : ℕ | 0 < n ∧ padicValNat 3 (2 ^ n - 1) = 5} 162")?.map((o) => o.order)).toEqual([162]);
    // a product modulus is split into prime powers (Lean-checked: 81 → 54, 25 → 20, 127 → 7, lcm 3780)
    const T3 = ": (3 ^ 4 * 5 ^ 2 * 127 : ℕ) ∣ (2 ^ 3780 - 1) ∧ ∀ m : ℕ, 0 < m → (3 ^ 4 * 5 ^ 2 * 127 : ℕ) ∣ (2 ^ m - 1) → 3780 ≤ m";
    expect(orderConditions(T3)?.map((o) => [o.modulus, o.order, o.partOf])).toEqual([
      [81, 54, "257175"],
      [25, 20, "257175"],
      [127, 7, "257175"],
    ]);
    expect(proofHints(T3).join("\n")).toContain("lcm 3780");
    expect(orderConditions(": ∀ n : ℕ, 0 < n → 257175 ∣ 2 ^ n - 1 → 3780 ≤ n")?.map((o) => o.order)).toEqual([54, 20, 7]);
    expect(primePowers(257175n)).toEqual([81n, 25n, 127n]);
    // the proof the program writes (all four shapes checked in Lean 4.33.1 + Mathlib; the first candidate fits T3)
    const scripts = orderProofScripts(T3);
    expect(scripts[0]).toContain("have o0 : 54 ∣ n := ord 2 81 54 n");
    expect(scripts[0]).toContain("rwa [show Nat.lcm (Nat.lcm (54) 20) 7 = 3780 by norm_num] at this");
    expect(scripts[0]).toMatch(/^have ord/);
    expect(orderProofScripts(T2)[0]).toMatch(/^intro ExactValuation\n/);
    expect(orderProofScripts(T2)[0]).toContain("Nat.not_le.mpr hlt");
    expect(orderProofScripts(": ∀ n : ℕ, n + 0 = n")).toEqual([]);
    // congruence forms, two bases, and closed facts with an exponent above 2^24 (all checked in Lean)
    const T29 =
      ": Nat.ModEq ((3 : ℕ)^6 * 5^3 * 7^2) (2^35380800) 1 ∧ Nat.ModEq ((2 : ℕ)^8 * 13^2) (3^35380800) 1 ∧ ∀ m : ℕ, 0 < m → (Nat.ModEq ((3 : ℕ)^6 * 5^3 * 7^2) (2^m) 1 ∧ Nat.ModEq ((2 : ℕ)^8 * 13^2) (3^m) 1) → 35380800 ≤ m";
    expect(orderConditions(T29)?.map((o) => `${o.base}:${o.modulus}:${o.order}`)).toEqual(["2:729:486", "2:125:100", "2:49:21", "3:256:64", "3:169:39"]);
    expect(orderProofScripts(T29)[0]).toContain("rw [show (35380800 : ℕ) = 5948 * 5948 + 2096 by norm_num, pow_add, pow_mul]");
    expect(orderProofScripts(T29)[0]).toContain("have o4 : 39 ∣ n := ord 3 169 39 n");
    expect(orderConditions(": (2 ^ 907200 : ℕ) % (3 ^ 5 * 5 ^ 3) = 1 % (3 ^ 5 * 5 ^ 3) ∧ ∀ n : ℕ, 0 < n → (3 ^ n : ℕ) % (2 ^ 8 * 7 ^ 2) = 1 % (2 ^ 8 * 7 ^ 2) → 1344 ≤ n")?.map((o) => o.order)).toEqual([64, 42]);
    expect(orderConditions(": ∀ n : ℕ, 0 < n → 2 ^ n ≡ 1 [MOD 3 ^ 5 * 5 ^ 3] → 8100 ≤ n")?.map((o) => o.order)).toEqual([162, 100]);
    // review cases: an "exactly" half is not a condition; things applied to the power are not the power
    const ords = (t: string) => orderConditions(t)?.map((o) => `${o.base}:${o.modulus}:${o.order}`);
    expect(ords(": ∀ n : ℕ, 0 < n → 2 ^ n ≡ 1 [MOD 3 ^ 5] ∧ ¬ 2 ^ n ≡ 1 [MOD 3 ^ 6] → 162 ≤ n")).toEqual(["2:243:162"]);
    for (const bad of [
      ": ∀ n : ℕ, 0 < n → 3 * 2 ^ n % 7 = 1 → 3 ≤ n",
      ": ∀ n : ℕ, 0 < n → 3 * 2 ^ n ≡ 1 [MOD 7] → 3 ≤ n",
      ": ∀ n : ℕ, 0 < n → f 2 ^ n % 7 = 1 → 3 ≤ n",
      ": ∀ n : ℕ, 0 < n → 2 ^ n % 3 ^ 5 * 5 ^ 3 = 1 → 3 ≤ n",
      ": ∀ n : ℕ, 0 < n → 2 ^ n % 7 = 1 + k → 3 ≤ n",
      ": ∀ n : ℕ, 0 < n → (2 ^ n : ℤ) % 7 = 1 → 3 ≤ n",
    ])
      expect(ords(bad), bad).toBeUndefined();
    // only conditions on the minimised variable
    expect(ords(": ∀ n k : ℕ, 0 < n → 2 ^ n % 7 = 1 % 7 → 3 ≤ n ∧ 4 ^ k % 15 = 1 % 15")).toEqual(["2:7:3"]);
    // orders too large to check in a script: a hint, no script
    expect(orderProofScripts(": ∀ n : ℕ, 0 < n → 2 ^ n ≡ 1 [MOD 1000003] → 1000002 ≤ n")).toEqual([]);
    // huge powers: split only when safe
    expect(bigExponents("Nat.ModEq M (2^35380800) 1")).toEqual([{ n: "35380800", d: "5948", e: "5948", r: "2096" }]);
    expect(bigExponents("2 ^ (35380800 * 2) % 7")).toBeUndefined();
    expect(bigExponents("2 ^ 1099511627776 % 7 = 2")).toBeUndefined();
    expect(bigExponents("2 ^ 35380800 ^ 2")).toBeUndefined();
    expect(bigExponents("2 ^ 100 = 5")).toEqual([]);
    expect(multiplicativeOrder(2, 243)).toBe(162);
    expect(multiplicativeOrder(2, 6)).toBeUndefined();
  });

  it("reports a proof left with sorry in words, and passes the hints on", async () => {
    m.autoformalize.mockResolvedValue({ ...GCD, theorem_type: DODECAGON });
    m.proveWholeTheorem.mockResolvedValue({ ok: false, samples: 2, rounds: 1, candidates: [{ round: 0, tactics: "sorry", ok: false, errors: 0, summary: "source contains `sorry`; final verify requires a complete proof" }] });
    const a = await attemptLeanFormalization("p");
    expect(a.limitations?.join("\n")).toMatch(/sorry/);
    expect(a.limitations?.join("\n")).not.toContain("final verify requires");
    expect(m.proveWholeTheorem.mock.calls[0][0].sketch).toContain("intro rot Valid");
  });
});

describe("when solving produced two answers", () => {
  it("prefers the written solution's answer unless the computation was cross-validated", async () => {
    const { answerCandidates, plainAnswer } = await import("@/lib/pipeline/lean-attempt");
    expect(plainAnswer("$$\\boxed{907200}$$")).toBe("907200");
    const s = { computation_result: { answer: "1814400", cross_validated: false }, nl_solution: { final_answer: "$$\\boxed{907200}$$" } };
    expect(answerCandidates(s)).toEqual(["907200", "1814400"]);
    expect(answerCandidates({ ...s, computation_result: { answer: "1814400", cross_validated: true } })).toEqual(["1814400", "907200"]);
    expect(answerCandidates({ computation_result: { answer: "8" }, nl_solution: { final_answer: "$8$" } })).toEqual(["8"]);
  });

  it("formalizes again with the other answer when the numeric check refutes the first", async () => {
    m.autoformalize
      .mockResolvedValueOnce({ ...GCD, accepted: false, validation_results: [{ layer: 4, pass: false, detail: "Inconsistent instances: n = 907200" }] })
      .mockResolvedValueOnce(GCD);
    m.hammerTheorem.mockResolvedValue({ tactic: "decide +kernel", attempts: [], durationMs: 5 });
    const a = await attemptLeanFormalization("p", { answers: ["1814400", "907200"] });
    expect(m.autoformalize).toHaveBeenCalledTimes(2);
    expect(m.autoformalize.mock.calls[1][0].problemText).toContain("is: 907200");
    expect(a.success).toBe(true);
    expect(a.limitations?.[0]).toMatch(/1814400.*907200/);
  });

  it("formalizes again with the other answer when the first statement fails any check", async () => {
    // A wrong answer (2 for a figure with 18 triangles) forced a figure encoding built to fit; L2 caught it.
    m.autoformalize
      .mockResolvedValueOnce({ ...GCD, accepted: false, validation_results: [{ layer: 2, pass: false, detail: "该形式化是退化的" }] })
      .mockResolvedValueOnce(GCD);
    m.hammerTheorem.mockResolvedValue({ tactic: "decide", attempts: [], durationMs: 5 });
    const a = await attemptLeanFormalization("p", { answers: ["2", "18"] });
    expect(m.autoformalize).toHaveBeenCalledTimes(2);
    expect(m.autoformalize.mock.calls[1][0].problemText).toContain("is: 18");
    expect(a.success).toBe(true);
    expect(a.limitations?.[0]).toMatch(/2.*L2.*18/);
  });

  it("says the answer may be wrong when its statement is refuted and nothing else is left", async () => {
    m.autoformalize.mockResolvedValue({ ...GCD, accepted: false, validation_results: [{ layer: 4, pass: false, detail: "Inconsistent instances" }] });
    const a = await attemptLeanFormalization("p", { answers: ["1814400"] });
    expect(a.failure_reason).toMatch(/1814400/);
    expect(m.autoformalize).toHaveBeenCalledTimes(1);
  });
});

describe("statements with numbers too big to compute", () => {
  // 2025 ^ (2024 ^ 2024): Lean refuses exponents above 2^24 ("Nat.pow exponent is too big").
  const HUGE = "(let N : ℕ := 2025 ^ (2024 ^ 2024) - 1; ∀ e : ℕ, ((2024 : ℕ) ^ e ∣ N ↔ e ≤ 2025))";

  it("finds the power and estimates its size; small powers are not flagged", () => {
    expect(hugePower(HUGE)).toEqual({ text: "2025 ^ (2024 ^ 2024)", exponentDigits: 6692 });
    expect(hugePower("Nat.gcd (2^2024 + 1) (2^3036 - 1) = 1")).toBeUndefined();
    expect(hugePower("x ^ 2 + 2 ^ 30000000 = y")?.text).toBe("2 ^ 30000000");
  });

  it("skips the computing automation, gives the prover the LTE lemmas and explains the failure", async () => {
    m.autoformalize.mockResolvedValue({ ...GCD, theorem_type: `: ${HUGE}`, formal_statement: `theorem t : ${HUGE} := by sorry` });
    m.proveWholeTheorem.mockResolvedValue({ ok: false, samples: 4, rounds: 1, candidates: [{ errors: 1, progress: 0, summary: "INTERNAL PANIC: Nat.pow exponent is too big" }] });
    const a = await attemptLeanFormalization("p", { answer: "2025" });
    expect(m.hammerTheorem).not.toHaveBeenCalled();
    expect(m.tryTrivialProof).not.toHaveBeenCalled();
    const sketch = m.proveWholeTheorem.mock.calls[0][0].sketch as string;
    expect(sketch).toContain("padicValNat.pow_sub_pow");
    expect(sketch).toContain("padicValNat_dvd_iff_le");
    expect(sketch).toMatch(/Never let a tactic evaluate it/);
    const text = (a.limitations ?? []).join("\n");
    expect(text).toMatch(/2025 \^ \(2024 \^ 2024\)/);
    expect(text).toMatch(/6692/);
    expect(text).not.toMatch(/INTERNAL PANIC/);
  });
});

describe("coordinate geometry", () => {
  const GEO = ": let area : (ℝ × ℝ) → (ℝ × ℝ) → (ℝ × ℝ) → ℝ := fun X Y Z => 0; ∀ (A B C : ℝ × ℝ), A = B → area A B C = 0";

  it("gives the prover componentwise advice and explains a heartbeat timeout in words", async () => {
    expect(proofHints(GEO).join("\n")).toMatch(/Coordinate geometry/);
    m.autoformalize.mockResolvedValue({ ...GCD, theorem_type: GEO, formal_statement: `theorem t ${GEO} := by sorry` });
    m.hammerTheorem.mockResolvedValue(undefined);
    m.tryTrivialProof.mockResolvedValue(undefined);
    m.proveWholeTheorem.mockResolvedValue({ ok: false, samples: 2, rounds: 1, candidates: [{ errors: 1, progress: 3, summary: "(deterministic) timeout at `whnf`, maximum number of heartbeats (200000) has been reached" }] });
    const a = await attemptLeanFormalization("p", { answer: "0" });
    expect((m.proveWholeTheorem.mock.calls[0][0].sketch as string)).toMatch(/Coordinate geometry/);
    expect((a.limitations ?? []).join("\n")).toMatch(/计算步数上限|computation budget/);
  });
});

describe("divisibility, find all n", () => {
  it("tells the prover to bound n through a ∣ constant, then interval_cases", () => {
    const h = proofHints("(n : ℕ) : (0 < n ∧ n + 5 ∣ n ^ 2 + 14 ∧ 2 * n + 1 ∣ n ^ 2 + 4) ↔ n = 8").join("\n");
    expect(h).toMatch(/Nat\.dvd_add_right/);
    expect(h).toMatch(/interval_cases n/);
    expect(proofHints("(a b : ℕ) (h : a ∣ b) : a ≤ b + a").join("\n")).not.toMatch(/interval_cases/);
  });
});
