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
}));

vi.mock("@/lib/llm/autoformalize", () => ({ autoformalize: m.autoformalize }));
vi.mock("@/lib/lean/hammer", () => ({ hammerTheorem: m.hammerTheorem }));
vi.mock("@/lib/lean/sandbox", () => ({ verifyLeanSource: m.verifyLeanSource, checkLeanAvailable: m.checkLeanAvailable }));
vi.mock("@/lib/lean/trivial-proof", () => ({ tryTrivialProof: m.tryTrivialProof }));
vi.mock("@/lib/prover/whole-proof", () => ({ proveWholeTheorem: m.proveWholeTheorem, wholeProofEnabled: () => true }));

const { attemptLeanFormalization, leanAttemptRetryable } = await import("@/lib/pipeline/lean-attempt");

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
    const { proofHints } = await import("@/lib/pipeline/lean-attempt");
    const h = proofHints(DODECAGON).join("\n");
    expect(h).toContain("intro rot Valid");
    expect(h).toContain("decide +kernel");
    expect(proofHints(": ∀ x : ℝ, x ^ 2 ≥ 0").join("\n")).not.toContain("finite types");
    expect(proofHints(": ∀ n : ℕ, n + 0 = n").join("\n")).not.toContain("finite types");
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
