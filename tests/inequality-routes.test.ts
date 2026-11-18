import { beforeEach, describe, expect, it, vi } from "vitest";

// lib/lean/inequality/index.ts: which route is asked for a script, in which order, and what
// comes back — Lean and the two routes' algebra mocked.

const { openRunner, verify, close, symPlan, sqPlan } = vi.hoisted(() => ({
  openRunner: vi.fn(),
  verify: vi.fn(),
  close: vi.fn(),
  symPlan: vi.fn(),
  sqPlan: vi.fn(),
}));

vi.mock("@/lib/lean/tactic-runner", () => ({
  openRunner,
  scriptSource: (a: { tactics: string }) => `SOURCE\n${a.tactics}`,
}));
vi.mock("@/lib/lean/combinatorics/finite", () => ({ introAll: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/lean/inequality/symmetric", () => ({ plan: symPlan, script: () => "pqr script" }));
vi.mock("@/lib/lean/inequality/squares", () => ({ plan: sqPlan, script: () => "squares script" }));

const { inequalityProof } = await import("@/lib/lean/inequality");

const WITH_PRODUCT = "(a b c : ℝ) (ha : 0 < a) (hb : 0 < b) (hc : 0 < c) (habc : a * b * c = 1) : 3 / 2 ≤ a / (b + c) + b / (c + a) + c / (a + b)";
const PLAIN = "(a b c : ℝ) (ha : 0 < a) (hb : 0 < b) (hc : 0 < c) : 3 / 2 ≤ a / (b + c) + b / (c + a) + c / (a + b)";
const GOAL = "a b c : ℝ\nha : 0 < a\nhb : 0 < b\nhc : 0 < c\n⊢ 3 / 2 ≤ a / (b + c) + b / (c + a) + c / (a + b)";
const prove = (theoremType: string) => inequalityProof({ sessionId: "s", theoremName: "t", theoremType, useMathlib: true });
const PLAN = { setting: {}, parts: [], chosen: [] };

beforeEach(() => {
  for (const f of [openRunner, verify, close, symPlan, sqPlan]) f.mockReset();
  openRunner.mockResolvedValue({ run: { goals: () => [GOAL] }, script: ["intro"], session: { verify, close } });
  verify.mockResolvedValue({ ok: true, log: "" });
});

describe("the inequality stage's two routes", () => {
  it("without a product only the squares are asked; the script is verified as a whole", async () => {
    sqPlan.mockResolvedValue(PLAN);
    const r = await prove(PLAIN);
    expect(r.proof).toMatchObject({ method: "squares", tactics: "intro\nsquares script", source: "SOURCE\nintro\nsquares script" });
    expect(symPlan).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("with a product of 1 the pqr route is first; what it does not take goes to the squares", async () => {
    symPlan.mockResolvedValue({ reason: "a factor needs more than the four facts" });
    sqPlan.mockResolvedValue(PLAN);
    const r = await prove(WITH_PRODUCT);
    expect(r.proof?.method).toBe("squares");
    expect(symPlan).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("a pqr script that does not verify is followed by the squares' script", async () => {
    symPlan.mockResolvedValue(PLAN);
    sqPlan.mockResolvedValue(PLAN);
    verify.mockResolvedValueOnce({ ok: false, log: "error: linarith failed", messages: [] }).mockResolvedValueOnce({ ok: true, log: "" });
    const r = await prove(WITH_PRODUCT);
    expect(r.proof?.method).toBe("squares");
    expect(verify.mock.calls.map((c) => c[1])).toEqual(["SOURCE\nintro\npqr script", "SOURCE\nintro\nsquares script"]);
  });

  it("a point where the statement is false ends the stage: the other route is not asked", async () => {
    symPlan.mockResolvedValue({ reason: "1 ≤ S is false at a = b = c = 1", counterexample: "a = b = c = 1" });
    const r = await prove(WITH_PRODUCT);
    expect(r).toEqual({ reason: "1 ≤ S is false at a = b = c = 1", counterexample: "a = b = c = 1" });
    expect(sqPlan).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("says why: one route's reason as it is, two routes' reasons each with its name", async () => {
    sqPlan.mockResolvedValue({ reason: "not a sum of AM–GM steps between two monomials" });
    expect(await prove(PLAIN)).toEqual({ reason: "not a sum of AM–GM steps between two monomials" });
    symPlan.mockResolvedValue({ reason: "not symmetric" });
    expect(await prove(WITH_PRODUCT)).toEqual({ reason: "symmetric: not symmetric; squares: not a sum of AM–GM steps between two monomials" });
  });

  it("a script Lean rejects is a reason, not a proof", async () => {
    sqPlan.mockResolvedValue(PLAN);
    verify.mockResolvedValue({ ok: false, log: "", messages: [{ severity: "error", message: "ring failed" }] });
    const r = await prove(PLAIN);
    expect(r.proof).toBeUndefined();
    expect(r.reason).toBe("the written proof did not verify (ring failed)");
  });

  it("is not for other statements, and says what the runner says when the statement does not open", async () => {
    expect(await prove("(a b : ℕ) : a ≤ a + b")).toEqual({ reason: "not an inequality between arithmetic expressions in real variables" });
    expect(openRunner).not.toHaveBeenCalled();
    openRunner.mockResolvedValue("needs the Lean REPL");
    expect(await prove(PLAIN)).toEqual({ reason: "needs the Lean REPL" });
  });
});
