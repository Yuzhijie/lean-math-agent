import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadConfig } from "@/lib/llm/config";
import { chatJson, chatText, sampleText } from "@/lib/llm/client";
import {
  currentScopeMetrics,
  estimateCost,
  recordVerification,
  resetUsage,
  withUsageScope,
} from "@/lib/llm/usage-tracker";
import { resetGlobalCache } from "@/lib/llm/cache";
import { z } from "zod";

// Role-based routing (general / prover / planner), sampling and the
// per-run usage scope that the solve routes report as `metrics`.

function okResponse(content: string, usage?: { prompt_tokens: number; completion_tokens: number }): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }], ...(usage ? { usage } : {}) }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const MESSAGES = [
  { role: "system" as const, content: "s" },
  { role: "user" as const, content: "u" },
];

const ROLE_VARS = [
  "LLM_PROVER_MODEL", "LLM_PROVER_MODELS", "LLM_PROVER_BASE_URL", "LLM_PROVER_API_KEY", "LLM_PROVER_FALLBACK_TO_GENERAL",
  "LLM_PLANNER_MODEL", "LLM_PLANNER_MODELS", "LLM_PLANNER_BASE_URL", "LLM_PLANNER_API_KEY",
  "LLM_PRICES", "LLM_FALLBACK_MODELS", "LLM_PROVER_STEPWISE",
];

beforeEach(() => {
  process.env.LLM_API_KEY = "general-key";
  process.env.LLM_BASE_URL = "https://general.test/v1";
  process.env.LLM_MODEL = "general-model";
  process.env.LLM_LOG_LEVEL = "silent";
  process.env.LLM_CACHE_ENABLED = "false";
  for (const v of ROLE_VARS) delete process.env[v];
  vi.stubGlobal("fetch", vi.fn());
  resetUsage();
  resetGlobalCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const v of [...ROLE_VARS, "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "LLM_LOG_LEVEL", "LLM_CACHE_ENABLED"]) {
    delete process.env[v];
  }
});

function requestBodies(): Array<Record<string, unknown>> {
  return vi.mocked(fetch).mock.calls.map((c) => JSON.parse(c[1]?.body as string));
}
function requestUrls(): string[] {
  return vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
}

describe("role chains in loadConfig", () => {
  it("every role falls back to the general chain when nothing role-specific is set", () => {
    process.env.LLM_FALLBACK_MODELS = "backup-model";
    const cfg = loadConfig();
    expect(cfg.roles.general.map((e) => e.model)).toEqual(["general-model", "backup-model"]);
    expect(cfg.roles.prover).toEqual(cfg.roles.general);
    expect(cfg.roles.planner).toEqual(cfg.roles.general);
  });

  it("prover chain = prover endpoint(s) then the general chain", () => {
    process.env.LLM_PROVER_MODEL = "goedel-prover-v2";
    process.env.LLM_PROVER_BASE_URL = "http://localhost:8000/v1";
    process.env.LLM_PROVER_API_KEY = "prover-key";
    const cfg = loadConfig();
    expect(cfg.roles.prover.map((e) => e.model)).toEqual(["goedel-prover-v2", "general-model"]);
    expect(cfg.roles.prover[0]).toEqual({ model: "goedel-prover-v2", baseUrl: "http://localhost:8000/v1", apiKey: "prover-key" });
    // The planner is unaffected.
    expect(cfg.roles.planner.map((e) => e.model)).toEqual(["general-model"]);
  });

  it("LLM_PROVER_FALLBACK_TO_GENERAL=false keeps the prover on its own endpoints", () => {
    process.env.LLM_PROVER_MODELS = "prover-a, prover-b";
    process.env.LLM_PROVER_FALLBACK_TO_GENERAL = "false";
    const cfg = loadConfig();
    expect(cfg.roles.prover.map((e) => e.model)).toEqual(["prover-a", "prover-b"]);
    // Base URL / key default to the general ones when not given.
    expect(cfg.roles.prover[0].baseUrl).toBe("https://general.test/v1");
    expect(cfg.roles.prover[0].apiKey).toBe("general-key");
  });

  it("parses the LLM_PRICES table and ignores garbage", () => {
    process.env.LLM_PRICES = JSON.stringify({ "general-model": { input: 1, output: 3 } });
    expect(loadConfig().prices).toEqual({ "general-model": { input: 1, output: 3 } });
    process.env.LLM_PRICES = "{not json";
    expect(loadConfig().prices).toEqual({});
  });
});

describe("stepwise role selection", () => {
  it("uses the prover role only when it is the general chain or LLM_PROVER_STEPWISE=true", async () => {
    const { stepwiseRole } = await import("@/lib/llm/prove-step");
    expect(stepwiseRole()).toBe("prover"); // no dedicated prover → same chain, role kept for metrics
    process.env.LLM_PROVER_MODEL = "goedel";
    expect(stepwiseRole()).toBe("general");
    process.env.LLM_PROVER_STEPWISE = "true";
    expect(stepwiseRole()).toBe("prover");
    delete process.env.LLM_PROVER_STEPWISE;
  });
});

describe("routing by role", () => {
  it("sends prover-role calls to the prover endpoint and general calls to the default", async () => {
    process.env.LLM_PROVER_MODEL = "prover-model";
    process.env.LLM_PROVER_BASE_URL = "http://prover.test/v1";
    process.env.LLM_PROVER_API_KEY = "prover-key";
    vi.mocked(fetch).mockImplementation(async () => okResponse('{"a":1}'));

    const schema = z.object({ a: z.number() });
    await chatJson({ system: "s", user: "u", schema, schemaName: "x", role: "prover" });
    await chatJson({ system: "s", user: "u", schema, schemaName: "x" });

    expect(requestUrls()).toEqual(["http://prover.test/v1/chat/completions", "https://general.test/v1/chat/completions"]);
    const [prover, general] = requestBodies();
    expect(prover.model).toBe("prover-model");
    expect(general.model).toBe("general-model");
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer prover-key" });
  });

  it("falls over from a failing prover endpoint to the general model", async () => {
    process.env.LLM_PROVER_MODEL = "prover-model";
    process.env.LLM_PROVER_BASE_URL = "http://prover.test/v1";
    process.env.LLM_MAX_HTTP_RETRIES = "0";
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("down", { status: 500 }))
      .mockResolvedValueOnce(okResponse("theorem t : True := trivial"));

    const text = await chatText({ messages: MESSAGES, role: "prover" });
    expect(text).toContain("trivial");
    expect(requestBodies().map((b) => b.model)).toEqual(["prover-model", "general-model"]);
    delete process.env.LLM_MAX_HTTP_RETRIES;
  });

  it("passes sampling parameters through to the request body", async () => {
    vi.mocked(fetch).mockImplementation(async () => okResponse("ok"));
    await chatText({ messages: MESSAGES, temperature: 0.9, topP: 0.95, maxTokens: 512, stop: ["```"] });
    const [body] = requestBodies();
    expect(body).toMatchObject({ temperature: 0.9, top_p: 0.95, max_tokens: 512, stop: ["```"] });
    expect(body.response_format).toBeUndefined();
  });
});

describe("sampleText", () => {
  it("issues n parallel requests, drops duplicates and failures, keeps the rest", async () => {
    const f = vi.mocked(fetch);
    f.mockResolvedValueOnce(okResponse("proof A"))
      .mockResolvedValueOnce(okResponse("proof B"))
      .mockResolvedValueOnce(okResponse("proof A"))
      .mockResolvedValueOnce(new Response("boom", { status: 400 }));

    const out = await sampleText({ messages: MESSAGES, n: 4, role: "prover" });
    expect(out.sort()).toEqual(["proof A", "proof B"]);
    expect(f).toHaveBeenCalledTimes(4);
    // Sampling defaults to a high temperature and never uses JSON mode.
    for (const body of requestBodies()) {
      expect(body.temperature).toBe(0.8);
      expect(body.response_format).toBeUndefined();
    }
  });

  it("throws when every sample fails", async () => {
    process.env.LLM_MAX_HTTP_RETRIES = "0";
    vi.mocked(fetch).mockImplementation(async () => new Response("boom", { status: 400 }));
    await expect(sampleText({ messages: MESSAGES, n: 2 })).rejects.toThrow(/400/);
    delete process.env.LLM_MAX_HTTP_RETRIES;
  });

  it("bypasses the response cache so repeated sampling gives fresh completions", async () => {
    process.env.LLM_CACHE_ENABLED = "true";
    const f = vi.mocked(fetch);
    f.mockResolvedValueOnce(okResponse("first")).mockResolvedValueOnce(okResponse("second"));
    const a = await sampleText({ messages: MESSAGES, n: 1 });
    const b = await sampleText({ messages: MESSAGES, n: 1 });
    expect(a).toEqual(["first"]);
    expect(b).toEqual(["second"]);
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe("usage scope", () => {
  it("attributes LLM calls by role/model and Lean verifications to the run", async () => {
    process.env.LLM_PROVER_MODEL = "prover-model";
    process.env.LLM_PRICES = JSON.stringify({
      "prover-model": { input: 1, output: 10 },
      "general-model": { input: 2, output: 20 },
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(okResponse("p", { prompt_tokens: 100, completion_tokens: 50 }))
      .mockResolvedValueOnce(okResponse("g", { prompt_tokens: 1000, completion_tokens: 100 }));

    const metrics = await withUsageScope(async (metrics) => {
      await chatText({ messages: MESSAGES, role: "prover" });
      await chatText({ messages: MESSAGES });
      recordVerification("repl", 12);
      recordVerification("repl", 8);
      recordVerification("cache", 0);
      return metrics();
    });

    expect(metrics.llm_calls).toBe(2);
    expect(metrics.prompt_tokens).toBe(1100);
    expect(metrics.completion_tokens).toBe(150);
    expect(metrics.by_role.prover).toMatchObject({ requests: 1, promptTokens: 100, completionTokens: 50 });
    expect(metrics.by_role.general).toMatchObject({ requests: 1, promptTokens: 1000, completionTokens: 100 });
    expect(metrics.by_model["prover-model"].requests).toBe(1);
    // (100*1 + 50*10 + 1000*2 + 100*20) / 1e6
    expect(metrics.estimated_cost).toBeCloseTo(0.0046, 6);
    expect(metrics.lean_verifications).toBe(3);
    expect(metrics.lean_verify_ms).toBe(20);
    expect(metrics.lean_by_backend).toEqual({ repl: 2, cache: 1 });
    expect(metrics.wall_ms).toBeGreaterThanOrEqual(0);
  });

  it("keeps concurrent scopes separate and is a no-op outside a scope", async () => {
    vi.mocked(fetch).mockImplementation(async () => okResponse("x", { prompt_tokens: 1, completion_tokens: 1 }));
    expect(currentScopeMetrics()).toBeUndefined();
    recordVerification("repl", 5); // outside any scope: ignored

    const [a, b] = await Promise.all([
      withUsageScope(async (m) => {
        await chatText({ messages: MESSAGES });
        await new Promise((r) => setTimeout(r, 5));
        recordVerification("repl", 1);
        return m();
      }),
      withUsageScope(async (m) => {
        await chatText({ messages: MESSAGES });
        await chatText({ messages: MESSAGES });
        return m();
      }),
    ]);
    expect(a.llm_calls).toBe(1);
    expect(a.lean_verifications).toBe(1);
    expect(b.llm_calls).toBe(2);
    expect(b.lean_verifications).toBe(0);
  });

  it("estimateCost is undefined when no model is priced", () => {
    expect(estimateCost([{ model: "m", role: "general", promptTokens: 1, completionTokens: 1, totalTokens: 2, latencyMs: 0, timestamp: 0 }], {})).toBeUndefined();
  });
});
