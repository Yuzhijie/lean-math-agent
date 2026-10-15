import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CostCapError, chatText } from "@/lib/llm/client";
import { costCapReached, proofCostCapUsd, resetUsage, withUsageScope } from "@/lib/llm/usage-tracker";
import { resetGlobalCache } from "@/lib/llm/cache";

// PROOF_COST_CAP_USD: a run (one solve, one benchmark theorem) stops making model calls once its
// estimated cost reaches the cap.

const reply = () =>
  new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1000, completion_tokens: 1000 } }), { status: 200 });

beforeEach(() => {
  process.env.LLM_API_KEY = "k";
  process.env.LLM_BASE_URL = "https://llm.test/v1";
  process.env.LLM_MODEL = "m";
  process.env.LLM_LOG_LEVEL = "silent";
  process.env.LLM_CACHE_ENABLED = "false";
  // $1 + $1 per million tokens: one call = 2000 tokens = $0.002.
  process.env.LLM_PRICES = JSON.stringify({ m: { input: 1, output: 1 } });
  vi.stubGlobal("fetch", vi.fn(async () => reply()));
  resetUsage();
  resetGlobalCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const v of ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "LLM_LOG_LEVEL", "LLM_CACHE_ENABLED", "LLM_PRICES", "PROOF_COST_CAP_USD"]) delete process.env[v];
});

describe("per-run cost cap", () => {
  it("refuses new calls once the scope has spent its cap", async () => {
    await withUsageScope(
      async (metrics) => {
        await chatText({ messages: [{ role: "user", content: "1" }] });
        await chatText({ messages: [{ role: "user", content: "2" }] });
        expect(costCapReached()).toBe(false); // $0.004 < $0.005
        await chatText({ messages: [{ role: "user", content: "3" }] });
        expect(costCapReached()).toBe(true); // $0.006
        await expect(chatText({ messages: [{ role: "user", content: "4" }] })).rejects.toBeInstanceOf(CostCapError);
        expect(metrics().llm_calls).toBe(3);
      },
      { costCapUsd: 0.005 },
    );
    // A new scope starts from zero; outside a scope there is no cap.
    await withUsageScope(async () => expect(costCapReached()).toBe(false), { costCapUsd: 0.005 });
    expect(costCapReached()).toBe(false);
  });

  it("takes the default from PROOF_COST_CAP_USD and needs prices to act", async () => {
    expect(proofCostCapUsd()).toBeUndefined();
    process.env.PROOF_COST_CAP_USD = "0.001";
    expect(proofCostCapUsd()).toBe(0.001);
    await withUsageScope(async () => {
      await chatText({ messages: [{ role: "user", content: "1" }] });
      expect(costCapReached()).toBe(true);
    });
    // Unpriced model: nothing to measure, never capped.
    process.env.LLM_PRICES = "{}";
    await withUsageScope(async () => {
      await chatText({ messages: [{ role: "user", content: "1" }] });
      await chatText({ messages: [{ role: "user", content: "2" }] });
      expect(costCapReached()).toBe(false);
    });
    process.env.PROOF_COST_CAP_USD = "0";
    expect(proofCostCapUsd()).toBeUndefined();
  });
});
