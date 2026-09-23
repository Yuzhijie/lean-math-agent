import { afterEach, describe, expect, it, vi } from "vitest";

// The search stages must not start prover calls that cannot finish in
// their remaining budget. The REPL and the prover are mocked.
const { sampleMock } = vi.hoisted(() => ({ sampleMock: vi.fn() }));
vi.mock("@/lib/llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/client")>();
  return { ...actual, sampleText: sampleMock };
});

import { expectedLatencyMs, recordLatency, recordUsage, resetLatencyEstimates } from "@/lib/llm/usage-tracker";
import { goalSearch } from "@/lib/search/goal-search";
import { proveWholeTheorem } from "@/lib/prover/whole-proof";
import type { ProofSession } from "@/lib/lean/proof-state";

afterEach(() => {
  resetLatencyEstimates();
  sampleMock.mockReset();
});

describe("latency estimate", () => {
  it("is an EMA of observed call latencies per role, fed by usage records", () => {
    expect(expectedLatencyMs("prover")).toBe(30_000);
    recordLatency("prover", 50_000);
    expect(expectedLatencyMs("prover")).toBe(50_000);
    recordLatency("prover", 100_000);
    expect(expectedLatencyMs("prover")).toBe(0.6 * 50_000 + 0.4 * 100_000);
    recordUsage({ model: "m", role: "planner", promptTokens: 1, completionTokens: 1, totalTokens: 2, latencyMs: 8_000, timestamp: 0 });
    expect(expectedLatencyMs("planner")).toBe(8_000);
    expect(expectedLatencyMs("general", 1)).toBe(1);
  });
});

describe("goalSearch budget gating", () => {
  it("stops before sampling when the remaining budget is below the expected call latency", async () => {
    recordLatency("prover", 120_000); // a slow reasoning model
    const session = {
      goals: () => ["⊢ p"],
      path: () => [],
      apply: vi.fn(),
    } as unknown as ProofSession;
    const r = await goalSearch({
      session,
      rootState: 0,
      theoremName: "t",
      theoremType: "(p : Prop) (hp : p) : p",
      config: { timeBudgetMs: 20_000, useHammer: false, retrieve: false, useMathlib: false },
    });
    expect(r.ok).toBe(false);
    expect(r.llmCalls).toBe(0);
    expect(sampleMock).not.toHaveBeenCalled();
    expect(r.log).toMatch(/prover calls take ~120s/);
  });
});

describe("whole-proof repair rounds", () => {
  it("skips a repair round that cannot finish in the remaining budget", async () => {
    recordLatency("prover", 200_000);
    // First round: an empty answer → no usable proof, no Lean needed.
    sampleMock.mockResolvedValue([""]);
    const r = await proveWholeTheorem({
      sessionId: "s",
      theoremName: "t",
      theoremType: "(n : ℕ) : n = n",
      config: { samples: 1, rounds: 2, timeBudgetMs: 60_000, useMathlib: false, suggest: false },
    });
    expect(r.ok).toBe(false);
    expect(sampleMock).toHaveBeenCalledTimes(1);
    expect(r.log).toMatch(/not enough for another prover round/);
  });
});
