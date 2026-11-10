import { beforeEach, describe, expect, it, vi } from "vitest";

// "再试一次": a statement that passed the checks is proved again before anything is formalized
// anew (once), and a new formalization is told what was wrong with the earlier one.

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

const { attemptLeanFormalization, parseFormalStatement, statementWasAccepted, previousAttemptFeedback } = await import("@/lib/pipeline/lean-attempt");

const GCD = {
  theorem_name: "gcd_two_powers",
  theorem_type: ": Nat.gcd (2 ^ (2024 : ℕ) + 1) (2 ^ (3036 : ℕ) - 1) = 1",
  formal_statement: "theorem gcd_two_powers : Nat.gcd (2 ^ (2024 : ℕ) + 1) (2 ^ (3036 : ℕ) - 1) = 1 := by sorry",
  formal_signature: "Nat.gcd (2 ^ 2024 + 1) (2 ^ 3036 - 1) = 1",
  validation_results: [],
  accepted: true,
};
const okVerify = { ok: true, backend: "repl", axioms: { axioms: [] }, signatureMatch: true, messages: [], log: "ok" };
const FAILED_BEFORE = {
  attempted: true,
  success: false,
  formal_statement: GCD.formal_statement,
  failure_reason: "陈述通过了检查，但这次没有找到能通过 Lean 检查的证明",
  limitations: ["已尝试：自动化策略组合", "最接近的一个证明卡在：unsolved goals"],
};

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
  m.proveWholeTheorem.mockResolvedValue({ ok: false, candidates: [], samples: 0, rounds: 0 });
});

describe("the earlier attempt's statement", () => {
  it("reads it back, and knows whether it passed the checks (also from attempts stored before the flag)", () => {
    expect(parseFormalStatement(GCD.formal_statement)).toEqual({ theorem_name: "gcd_two_powers", theorem_type: GCD.theorem_type });
    expect(parseFormalStatement("theorem t : 1 = 1 := by\n  rfl")).toBeUndefined();
    expect(statementWasAccepted(FAILED_BEFORE)).toBe(true);
    expect(statementWasAccepted({ ...FAILED_BEFORE, failure_reason: "没能写出一条通过检查的 Lean 陈述" })).toBe(false);
    expect(statementWasAccepted({ ...FAILED_BEFORE, failure_reason: "x", statement_accepted: true })).toBe(true);
    expect(statementWasAccepted(undefined)).toBe(false);
  });

  it("is proved again (checked by the program only) instead of formalizing anew, and says so", async () => {
    m.autoformalize.mockResolvedValueOnce({ ...GCD, validation_results: [{ layer: 1, pass: true, detail: "" }, { layer: 6, pass: true, detail: "" }] });
    m.hammerTheorem.mockResolvedValue({ tactic: "decide +kernel", attempts: [], durationMs: 5 });
    const a = await attemptLeanFormalization("p", { answer: "1", previous: FAILED_BEFORE });
    expect(m.autoformalize).toHaveBeenCalledTimes(1);
    expect(m.autoformalize.mock.calls[0][0]).toMatchObject({ reuse: { theorem_name: "gcd_two_powers", theorem_type: GCD.theorem_type } });
    expect(a).toMatchObject({ success: true, statement_accepted: true, reused_statement: true });
    expect(a.limitations?.join("\n")).toContain("沿用上次通过检查的陈述");
  });

  it("is reused once only: the next try formalizes anew and tells the formalizer what was tried", async () => {
    const a = await attemptLeanFormalization("p", { answer: "1", previous: { ...FAILED_BEFORE, reused_statement: true, statement_accepted: true } });
    expect(m.autoformalize).toHaveBeenCalledTimes(1);
    const args = m.autoformalize.mock.calls[0][0];
    expect(args.reuse).toBeUndefined();
    expect(args.feedback).toContain(GCD.formal_statement);
    expect(args.feedback).toContain("neither the program's provers nor the model could prove it");
    expect(args.feedback).toContain("最接近的一个证明卡在");
    expect(a).toMatchObject({ success: false, statement_accepted: true });
    expect(a.reused_statement).toBeUndefined();
  });

  it("is formalized anew with the reason when it no longer passes the program's checks", async () => {
    m.autoformalize.mockResolvedValueOnce({ ...GCD, accepted: false, validation_results: [{ layer: 6, pass: false, detail: "陈述为假：Xx = 0.79；结论的第 1/4 部分在这里不成立" }] });
    await attemptLeanFormalization("p", { answer: "1", previous: FAILED_BEFORE });
    expect(m.autoformalize).toHaveBeenCalledTimes(2);
    expect(m.autoformalize.mock.calls[1][0].feedback).toContain("no longer passes the program's checks: L6: 陈述为假");
  });

  it("tells the formalizer why a rejected statement was rejected", () => {
    const f = previousAttemptFeedback({ attempted: true, success: false, failure_reason: "没能写出一条通过检查的 Lean 陈述", limitations: ["L6: 陈述为假"] }, "theorem t : False := by sorry");
    expect(f).toContain("It was rejected");
    expect(f).toContain("L6: 陈述为假");
  });

  it("a first attempt has no earlier statement: plain formalization, no feedback", async () => {
    await attemptLeanFormalization("p", { answer: "1" });
    expect(m.autoformalize.mock.calls[0][0].feedback).toBeUndefined();
    expect(m.autoformalize.mock.calls[0][0].reuse).toBeUndefined();
  });
});
