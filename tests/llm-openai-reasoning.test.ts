import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isOpenAiReasoningModel, loadConfig } from "@/lib/llm/config";
import { buildRequestBody, chatJson, chatText, sampleText } from "@/lib/llm/client";
import { resetUsage } from "@/lib/llm/usage-tracker";
import { resetGlobalCache } from "@/lib/llm/cache";
import { z } from "zod";

// OpenAI reasoning models (GPT-5.x such as gpt-5.6-luna, GPT-6, o-series)
// reject temperature/top_p/max_tokens and take reasoning_effort +
// max_completion_tokens. The client must speak that dialect automatically.

function okResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
const MESSAGES = [
  { role: "system" as const, content: "s" },
  { role: "user" as const, content: "u" },
];
const VARS = [
  "LLM_REASONING_EFFORT", "LLM_PROVER_REASONING_EFFORT", "LLM_PLANNER_REASONING_EFFORT",
  "LLM_SAMPLING_PARAMS", "LLM_MAX_TOKENS_PARAM", "LLM_REASONING_TOKEN_BUDGET",
  "LLM_PROVER_MODEL", "LLM_PROVER_BASE_URL", "LLM_ENABLE_THINKING",
];

beforeEach(() => {
  process.env.LLM_API_KEY = "sk-test";
  process.env.LLM_BASE_URL = "https://api.openai.com/v1";
  process.env.LLM_MODEL = "gpt-5.6-luna";
  process.env.LLM_LOG_LEVEL = "silent";
  process.env.LLM_CACHE_ENABLED = "false";
  for (const v of VARS) delete process.env[v];
  vi.stubGlobal("fetch", vi.fn(async () => okResponse('{"a":1}')));
  resetUsage();
  resetGlobalCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const v of [...VARS, "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "LLM_LOG_LEVEL", "LLM_CACHE_ENABLED"]) {
    delete process.env[v];
  }
});

function bodies(): Array<Record<string, unknown>> {
  return vi.mocked(fetch).mock.calls.map((c) => JSON.parse(c[1]?.body as string));
}

describe("isOpenAiReasoningModel", () => {
  it("recognises the GPT-5.x / GPT-6 / o-series families, with provider prefixes", () => {
    for (const m of ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.1", "gpt-5", "gpt-5-mini", "gpt-6-astra", "o3", "o4-mini", "o1", "openai/gpt-5.6-luna"]) {
      expect(isOpenAiReasoningModel(m), m).toBe(true);
    }
    for (const m of ["gpt-4.1", "gpt-4o", "gpt-5-chat-latest", "qwen3.8-max", "deepseek-chat", "Goedel-LM/Goedel-Prover-V2-8B", "olmo-2"]) {
      expect(isOpenAiReasoningModel(m), m).toBe(false);
    }
  });
});

describe("request body for gpt-5.6-luna", () => {
  it("omits temperature/top_p, uses max_completion_tokens with a reasoning budget, no reasoning_effort unless set", async () => {
    await chatText({ messages: MESSAGES, temperature: 0.3, topP: 0.9, maxTokens: 4096 });
    const [body] = bodies();
    expect(body.model).toBe("gpt-5.6-luna");
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
    expect(body.max_completion_tokens).toBe(4096 + 16_384);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.enable_thinking).toBeUndefined();
  });

  it("sends reasoning_effort from LLM_REASONING_EFFORT and keeps JSON mode for chatJson", async () => {
    process.env.LLM_REASONING_EFFORT = "high";
    process.env.LLM_REASONING_TOKEN_BUDGET = "32000";
    await chatJson({ system: "s", user: "u", schema: z.object({ a: z.number() }), schemaName: "x", maxTokens: 1000 });
    const [body] = bodies();
    expect(body.reasoning_effort).toBe("high");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.temperature).toBeUndefined();
    expect(body.max_completion_tokens).toBe(33_000);
  });

  it("with reasoning_effort none the sampling parameters are sent again and no reasoning budget is added", async () => {
    process.env.LLM_REASONING_EFFORT = "none";
    await chatText({ messages: MESSAGES, temperature: 0.7, maxTokens: 512 });
    const [body] = bodies();
    expect(body).toMatchObject({ reasoning_effort: "none", temperature: 0.7, max_completion_tokens: 512 });
    expect(body.max_tokens).toBeUndefined();
  });

  it("per-role effort overrides the global one (prover high, planner/general medium)", async () => {
    process.env.LLM_REASONING_EFFORT = "medium";
    process.env.LLM_PROVER_REASONING_EFFORT = "high";
    await chatText({ messages: MESSAGES, role: "prover" });
    await chatText({ messages: MESSAGES, role: "planner" });
    await chatText({ messages: MESSAGES });
    expect(bodies().map((b) => b.reasoning_effort)).toEqual(["high", "medium", "medium"]);
  });

  it("sampleText still issues n uncached requests, without temperature", async () => {
    const out = await sampleText({ messages: MESSAGES, n: 3, role: "prover", maxTokens: 4096 });
    expect(out).toEqual(['{"a":1}']);
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const b of bodies()) {
      expect(b.temperature).toBeUndefined();
      expect(b.max_completion_tokens).toBe(4096 + 16_384);
    }
  });

  it("LLM_SAMPLING_PARAMS=always and LLM_MAX_TOKENS_PARAM=max_tokens force the classic dialect", async () => {
    process.env.LLM_SAMPLING_PARAMS = "always";
    process.env.LLM_MAX_TOKENS_PARAM = "max_tokens";
    await chatText({ messages: MESSAGES, temperature: 0.2, maxTokens: 100 });
    const [body] = bodies();
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(100 + 16_384);
    expect(body.max_completion_tokens).toBeUndefined();
  });
});

describe("request body for non-OpenAI models", () => {
  it("keeps temperature and max_tokens for a DashScope/Qwen endpoint", async () => {
    process.env.LLM_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
    process.env.LLM_MODEL = "qwen3.8-max";
    await chatText({ messages: MESSAGES, temperature: 0.2, maxTokens: 2048 });
    const [body] = bodies();
    expect(body).toMatchObject({ model: "qwen3.8-max", temperature: 0.2, max_tokens: 2048 });
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("an explicit LLM_REASONING_EFFORT turns any model into a reasoning call (no sampling params, budget added)", async () => {
    process.env.LLM_BASE_URL = "https://openrouter.ai/api/v1";
    process.env.LLM_MODEL = "deepseek/deepseek-r1";
    process.env.LLM_REASONING_EFFORT = "low";
    await chatText({ messages: MESSAGES, temperature: 0.8, maxTokens: 1000 });
    const [body] = bodies();
    expect(body.reasoning_effort).toBe("low");
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBe(1000 + 16_384);
  });

  it("a plain OpenAI chat model on api.openai.com keeps temperature but uses max_completion_tokens", async () => {
    process.env.LLM_MODEL = "gpt-4.1";
    await chatText({ messages: MESSAGES, temperature: 0.2, maxTokens: 300 });
    const [body] = bodies();
    expect(body).toMatchObject({ temperature: 0.2, max_completion_tokens: 300 });
    expect(body.max_tokens).toBeUndefined();
  });

  it("mixed chains: a Qwen general model with a gpt-5.6-luna prover each get their own dialect", async () => {
    process.env.LLM_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
    process.env.LLM_MODEL = "qwen3.8-max";
    process.env.LLM_PROVER_MODEL = "gpt-5.6-luna";
    process.env.LLM_PROVER_BASE_URL = "https://api.openai.com/v1";
    process.env.LLM_PROVER_REASONING_EFFORT = "high";
    const cfg = loadConfig();
    const prover = buildRequestBody(cfg, cfg.roles.prover[0], "prover", MESSAGES, { temperature: 0.8, maxTokens: 4096 });
    const general = buildRequestBody(cfg, cfg.roles.general[0], "general", MESSAGES, { temperature: 0.2, maxTokens: 4096 });
    expect(prover).toMatchObject({ model: "gpt-5.6-luna", reasoning_effort: "high", max_completion_tokens: 4096 + 16_384 });
    expect(prover.temperature).toBeUndefined();
    expect(general).toMatchObject({ model: "qwen3.8-max", temperature: 0.2, max_tokens: 4096 });
    expect(general.reasoning_effort).toBeUndefined();
  });
});
