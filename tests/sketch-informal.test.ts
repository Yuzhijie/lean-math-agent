import { beforeEach, describe, expect, it, vi } from "vitest";

const { chatMock, sampleMock, openMock, hammerMock, wholeMock, verifyMock } = vi.hoisted(() => ({
  chatMock: vi.fn(),
  sampleMock: vi.fn(),
  openMock: vi.fn(),
  hammerMock: vi.fn(),
  wholeMock: vi.fn(),
  verifyMock: vi.fn(),
}));
vi.mock("@/lib/llm/client", async (orig) => ({ ...(await orig<typeof import("@/lib/llm/client")>()), chatText: chatMock, sampleText: sampleMock }));
vi.mock("@/lib/lean/proof-state", () => ({ ProofSession: { open: openMock } }));
vi.mock("@/lib/lean/hammer", () => ({ hammer: hammerMock }));
vi.mock("@/lib/lean/sandbox", async (orig) => ({ ...(await orig<typeof import("@/lib/lean/sandbox")>()), verifyLeanSource: verifyMock }));
vi.mock("@/lib/search/goal-search", () => ({ goalSearch: vi.fn().mockResolvedValue({ ok: false, llmCalls: 0 }) }));
vi.mock("@/lib/prover/whole-proof", async (orig) => ({ ...(await orig<typeof import("@/lib/prover/whole-proof")>()), proveWholeTheorem: wholeMock }));

import { proveBySketch } from "@/lib/prover/sketch";

const TYPE = "(a b : ℝ) (ha : 0 < a) (hb : 0 < b) : 2 ≤ a / b + b / a";
const SKETCH = `\`\`\`lean\ntheorem t ${TYPE} := by\n  have key : 2 * (a * b) ≤ a ^ 2 + b ^ 2 := by sorry\n  sorry\n\`\`\``;
const BODY = `theorem t ${TYPE} := by\n  have key : 2 * (a * b) ≤ a ^ 2 + b ^ 2 := by sorry\n  sorry`;
const KEY_COL = BODY.split("\n")[1].indexOf("sorry");

beforeEach(() => {
  for (const m of [chatMock, sampleMock, openMock, hammerMock, wholeMock, verifyMock]) m.mockReset();
  chatMock.mockResolvedValue("1. 2ab ≤ a² + b² since (a − b)² ≥ 0.\n2. Divide by ab > 0.");
  sampleMock.mockResolvedValue([SKETCH]);
  const session = {
    holes: [
      { state: 1, goal: "a b : ℝ\nha : 0 < a\nhb : 0 < b\n⊢ 2 * (a * b) ≤ a ^ 2 + b ^ 2", line: 2, column: KEY_COL, endLine: 2, endColumn: KEY_COL + 5 },
      { state: 2, goal: "a b : ℝ\nha : 0 < a\nhb : 0 < b\nkey : 2 * (a * b) ≤ a ^ 2 + b ^ 2\n⊢ 2 ≤ a / b + b / a", line: 3, column: 2, endLine: 3, endColumn: 7 },
    ],
    body: BODY,
    verify: vi.fn().mockResolvedValue({ ok: true, log: "", status: "ok" }),
    close: vi.fn(),
  };
  openMock.mockResolvedValue(session);
  // The hammer closes the last step, not the key inequality.
  hammerMock.mockImplementation(async (_s: unknown, state: number) => (state === 2 ? { solved: true, tactic: "rw [div_add_div _ _ hb.ne' ha.ne', le_div_iff₀ (by positivity)]; nlinarith [key]" } : { solved: false }));
  verifyMock.mockResolvedValue({ ok: true, log: "", status: "ok" });
  wholeMock.mockResolvedValue({ ok: true, tactics: "nlinarith [sq_nonneg (a - b)]", samples: 2, candidates: [] });
});

describe("sketch-and-fill: informal proof first, holes to the prover", () => {
  it("writes the informal proof, sketches from it and closes the hole with the prover", async () => {
    const r = await proveBySketch({ sessionId: "s", theoremName: "t", theoremType: TYPE, config: { samples: 1, repairs: 0, holeProver: true, useMathlib: false, holeBudgetMs: 60_000, timeBudgetMs: 300_000 } });
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(chatMock.mock.calls[0][0]).toMatchObject({ reasoningEffort: "high", role: "planner" });
    expect(sampleMock.mock.calls[0][0].messages[1].content).toContain("follow it step by step");
    expect(sampleMock.mock.calls[0][0].messages[1].content).toContain("2ab ≤ a² + b²");
    // The hole became a lemma with the same names.
    expect(wholeMock).toHaveBeenCalledTimes(1);
    expect(wholeMock.mock.calls[0][0]).toMatchObject({ theoremName: "t_hole1", theoremType: "(a b : ℝ) (ha : 0 < a) (hb : 0 < b) : 2 * (a * b) ≤ a ^ 2 + b ^ 2" });
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ holes: 2, holesSolved: 2, holesByProver: 1 });
    expect(r.source).toContain("have key : 2 * (a * b) ≤ a ^ 2 + b ^ 2 := by nlinarith [sq_nonneg (a - b)]");
    expect(r.informalProof).toContain("Divide by ab");
  });

  it("uses the caller's hint instead of writing an informal proof, and skips the prover when off", async () => {
    wholeMock.mockClear();
    const r = await proveBySketch({ sessionId: "s", theoremName: "t", theoremType: TYPE, sketchHint: "AM-GM", config: { samples: 1, repairs: 0, holeProver: false, useMathlib: false, goalSearch: { maxNodes: 0 } } });
    expect(chatMock).not.toHaveBeenCalled();
    expect(sampleMock.mock.calls[0][0].messages[1].content).toContain("Informal proof idea (a hint):\nAM-GM");
    expect(wholeMock).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
  });

  it("does not spend prover samples on a hole whose goal does not elaborate as a lemma", async () => {
    // the lemma check runs on the sketch's own session (it holds the worker)
    const session = (await openMock()) as { verify: ReturnType<typeof vi.fn> };
    openMock.mockClear();
    session.verify.mockResolvedValue({ ok: false, log: "unknown identifier", status: "fail" });
    const r = await proveBySketch({ sessionId: "s", theoremName: "t", theoremType: TYPE, config: { samples: 1, repairs: 0, holeProver: true, useMathlib: false, goalSearch: { maxNodes: 0 } } });
    expect(wholeMock).not.toHaveBeenCalled();
    expect(r.log).toContain("does not elaborate as a lemma");
    expect(verifyMock).not.toHaveBeenCalled(); // never a second lease while the session holds a worker
  });
});
