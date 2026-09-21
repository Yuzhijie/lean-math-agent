import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";
import { chatJson, chatText, LlmError } from "@/lib/llm/client";
import { getUsageSummary, resetUsage } from "@/lib/llm/usage-tracker";
import { resetGlobalCache, LruCache, buildCacheKey } from "@/lib/llm/cache";
import { loadConfig } from "@/lib/llm/config";

// ── Helpers ───────────────────────────────────────────────────────────

function okResponse(
  content: string,
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
  headers?: Record<string, string>,
): Response {
  const body: Record<string, unknown> = {
    choices: [{ message: { content } }],
  };
  if (usage) body.usage = usage;
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function errorResponse(status: number, body = "error", headers?: Record<string, string>): Response {
  return new Response(body, { status, headers });
}

const TEST_MESSAGES = [
  { role: "system" as const, content: "You are a test assistant." },
  { role: "user" as const, content: "Hello" },
];

const TEST_JSON_CONTENT = JSON.stringify({ answer: 42 });

// ── Setup / Teardown ─────────────────────────────────────────────────

beforeEach(() => {
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_BASE_URL = "https://example.test/v1";
  process.env.LLM_MODEL = "test-model";
  process.env.LLM_LOG_LEVEL = "silent";
  process.env.LLM_CACHE_ENABLED = "false";
  delete process.env.LLM_FALLBACK_MODELS;
  delete process.env.LLM_FALLBACK_BASE_URL;
  delete process.env.LLM_FALLBACK_API_KEY;
  delete process.env.LLM_MAX_HTTP_RETRIES;
  delete process.env.LLM_BASE_RETRY_DELAY_MS;
  delete process.env.LLM_CACHE_MAX_SIZE;
  delete process.env.LLM_ENABLE_THINKING;
  vi.stubGlobal("fetch", vi.fn());
  resetUsage();
  resetGlobalCache();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MODEL;
  delete process.env.LLM_LOG_LEVEL;
  delete process.env.LLM_CACHE_ENABLED;
  delete process.env.LLM_ENABLE_THINKING;
});

// ══════════════════════════════════════════════════════════════════════
// ── Config ────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

describe("loadConfig", () => {
  it("loads defaults", () => {
    const config = loadConfig();
    expect(config.primary.model).toBe("test-model");
    expect(config.primary.baseUrl).toBe("https://example.test/v1");
    expect(config.maxHttpRetries).toBe(3);
    expect(config.baseRetryDelayMs).toBe(500);
    expect(config.cacheEnabled).toBe(false);
    expect(config.logLevel).toBe("silent");
    expect(config.fallbacks).toEqual([]);
  });

  it("parses fallback models", () => {
    process.env.LLM_FALLBACK_MODELS = "model-a, model-b, model-c";
    process.env.LLM_FALLBACK_API_KEY = "fallback-key";
    const config = loadConfig();
    expect(config.fallbacks).toHaveLength(3);
    expect(config.fallbacks[0].model).toBe("model-a");
    expect(config.fallbacks[2].model).toBe("model-c");
    expect(config.fallbacks[0].apiKey).toBe("fallback-key");
  });

  it("parses log level", () => {
    process.env.LLM_LOG_LEVEL = "debug";
    expect(loadConfig().logLevel).toBe("debug");
  });

  it("falls back to error on invalid log level", () => {
    process.env.LLM_LOG_LEVEL = "verbose";
    expect(loadConfig().logLevel).toBe("error");
  });
});

// ══════════════════════════════════════════════════════════════════════
// ── Cache ─────────────────────────════════════════════════════────────
// ══════════════════════════════════════════════════════════════════════

describe("LruCache", () => {
  it("get/set basic operations", () => {
    const cache = new LruCache(10);
    cache.set("a", "hello");
    expect(cache.get("a")).toBe("hello");
    expect(cache.get("b")).toBeUndefined();
  });

  it("evicts oldest when at capacity", () => {
    const cache = new LruCache(3);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    cache.set("d", "4"); // should evict "a"
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("2");
    expect(cache.size).toBe(3);
  });

  it("access refreshes LRU position", () => {
    const cache = new LruCache(3);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    cache.get("a"); // refresh "a"
    cache.set("d", "4"); // should evict "b" (now oldest)
    expect(cache.get("a")).toBe("1");
    expect(cache.get("b")).toBeUndefined();
  });

  it("clear removes all entries", () => {
    const cache = new LruCache(10);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });
});

describe("buildCacheKey", () => {
  it("produces deterministic keys", () => {
    const key1 = buildCacheKey("model", TEST_MESSAGES, 0.2);
    const key2 = buildCacheKey("model", TEST_MESSAGES, 0.2);
    expect(key1).toBe(key2);
  });

  it("different inputs produce different keys", () => {
    const key1 = buildCacheKey("model", TEST_MESSAGES, 0.2);
    const key2 = buildCacheKey("model", TEST_MESSAGES, 0.5);
    expect(key1).not.toBe(key2);
  });
});

// ══════════════════════════════════════════════════════════════════════
// ── HTTP Retry ────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

describe("HTTP retry with backoff", () => {
  it("retries on 429 and succeeds", async () => {
    const fetchMock = vi.mocked(fetch);
    process.env.LLM_MAX_HTTP_RETRIES = "3";
    process.env.LLM_BASE_RETRY_DELAY_MS = "10"; // fast for tests

    fetchMock
      .mockResolvedValueOnce(errorResponse(429, "rate limited"))
      .mockResolvedValueOnce(errorResponse(429, "rate limited"))
      .mockResolvedValueOnce(okResponse(TEST_JSON_CONTENT));

    const result = await chatText({ messages: TEST_MESSAGES });
    expect(result).toBe(TEST_JSON_CONTENT);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries on 500 and succeeds", async () => {
    const fetchMock = vi.mocked(fetch);
    process.env.LLM_MAX_HTTP_RETRIES = "2";
    process.env.LLM_BASE_RETRY_DELAY_MS = "10";

    fetchMock
      .mockResolvedValueOnce(errorResponse(500, "server error"))
      .mockResolvedValueOnce(okResponse(TEST_JSON_CONTENT));

    const result = await chatText({ messages: TEST_MESSAGES });
    expect(result).toBe(TEST_JSON_CONTENT);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on 502, 503, 529", async () => {
    const fetchMock = vi.mocked(fetch);
    process.env.LLM_MAX_HTTP_RETRIES = "3";
    process.env.LLM_BASE_RETRY_DELAY_MS = "10";

    fetchMock
      .mockResolvedValueOnce(errorResponse(502))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(529))
      .mockResolvedValueOnce(okResponse(TEST_JSON_CONTENT));

    const result = await chatText({ messages: TEST_MESSAGES });
    expect(result).toBe(TEST_JSON_CONTENT);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("throws after max retries exhausted", async () => {
    const fetchMock = vi.mocked(fetch);
    process.env.LLM_MAX_HTTP_RETRIES = "2";
    process.env.LLM_BASE_RETRY_DELAY_MS = "10";

    fetchMock
      .mockResolvedValueOnce(errorResponse(429))
      .mockResolvedValueOnce(errorResponse(429))
      .mockResolvedValueOnce(errorResponse(429));

    await expect(chatText({ messages: TEST_MESSAGES })).rejects.toThrow(
      LlmError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-retryable errors (400, 401, 403)", async () => {
    const fetchMock = vi.mocked(fetch);
    process.env.LLM_MAX_HTTP_RETRIES = "3";
    process.env.LLM_BASE_RETRY_DELAY_MS = "10";

    fetchMock.mockResolvedValueOnce(errorResponse(401, "unauthorized"));

    await expect(chatText({ messages: TEST_MESSAGES })).rejects.toThrow(
      LlmError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ══════════════════════════════════════════════════════════════════════
// ── Model Fallback ────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

describe("model fallback chain", () => {
  it("falls back to secondary model when primary fails", async () => {
    const fetchMock = vi.mocked(fetch);
    process.env.LLM_MAX_HTTP_RETRIES = "1";
    process.env.LLM_BASE_RETRY_DELAY_MS = "10";
    process.env.LLM_FALLBACK_MODELS = "fallback-model";

    fetchMock
      .mockResolvedValueOnce(errorResponse(500)) // primary attempt 1
      .mockResolvedValueOnce(errorResponse(500)) // primary attempt 2 (retry)
      .mockResolvedValueOnce(okResponse(TEST_JSON_CONTENT)); // fallback attempt

    const result = await chatText({ messages: TEST_MESSAGES });
    expect(result).toBe(TEST_JSON_CONTENT);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Verify fallback model was used in the last call
    const lastCallBody = JSON.parse(
      fetchMock.mock.calls[2][1]?.body as string,
    );
    expect(lastCallBody.model).toBe("fallback-model");
  });

  it("throws when all endpoints fail", async () => {
    const fetchMock = vi.mocked(fetch);
    process.env.LLM_MAX_HTTP_RETRIES = "0";
    process.env.LLM_BASE_RETRY_DELAY_MS = "10";
    process.env.LLM_FALLBACK_MODELS = "fallback-model";

    fetchMock
      .mockResolvedValueOnce(errorResponse(500)) // primary
      .mockResolvedValueOnce(errorResponse(500)); // fallback

    await expect(chatText({ messages: TEST_MESSAGES })).rejects.toThrow(
      LlmError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses fallback API key when configured", async () => {
    const fetchMock = vi.mocked(fetch);
    process.env.LLM_MAX_HTTP_RETRIES = "0";
    process.env.LLM_BASE_RETRY_DELAY_MS = "10";
    process.env.LLM_FALLBACK_MODELS = "fallback-model";
    process.env.LLM_FALLBACK_API_KEY = "fallback-secret";

    fetchMock
      .mockResolvedValueOnce(errorResponse(500)) // primary fails
      .mockResolvedValueOnce(okResponse(TEST_JSON_CONTENT)); // fallback succeeds

    await chatText({ messages: TEST_MESSAGES });

    // The second call should be to the fallback endpoint with fallback key
    const fallbackCallHeaders = fetchMock.mock.calls[1][1]?.headers as Record<string, string>;
    expect(fallbackCallHeaders.Authorization).toBe("Bearer fallback-secret");
  });
});

// ══════════════════════════════════════════════════════════════════════
// ── Timeout Failover ──────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

describe("timeout failover", () => {
  it("fails over immediately on timeout without same-endpoint retry", async () => {
    const fetchMock = vi.mocked(fetch);
    process.env.LLM_MAX_HTTP_RETRIES = "3";
    process.env.LLM_BASE_RETRY_DELAY_MS = "10";
    process.env.LLM_FALLBACK_MODELS = "fallback-model";

    fetchMock
      .mockRejectedValueOnce(
        new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        ),
      )
      .mockResolvedValueOnce(okResponse(TEST_JSON_CONTENT));

    const result = await chatText({ messages: TEST_MESSAGES });
    expect(result).toBe(TEST_JSON_CONTENT);
    // Primary timed out once → straight to fallback, no 180s-style re-burn
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const fallbackBody = JSON.parse(
      fetchMock.mock.calls[1][1]?.body as string,
    );
    expect(fallbackBody.model).toBe("fallback-model");
  });

  it("reports timeout error when no fallback is configured", async () => {
    const fetchMock = vi.mocked(fetch);
    process.env.LLM_MAX_HTTP_RETRIES = "3";

    fetchMock.mockRejectedValue(
      new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      ),
    );

    await expect(chatText({ messages: TEST_MESSAGES })).rejects.toThrow(
      LlmError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry after timeout
  });

  it("still retries generic network errors on the same endpoint", async () => {
    const fetchMock = vi.mocked(fetch);
    process.env.LLM_MAX_HTTP_RETRIES = "1";
    process.env.LLM_BASE_RETRY_DELAY_MS = "10";

    fetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(okResponse(TEST_JSON_CONTENT));

    const result = await chatText({ messages: TEST_MESSAGES });
    expect(result).toBe(TEST_JSON_CONTENT);
    expect(fetchMock).toHaveBeenCalledTimes(2); // retried once, same endpoint
  });
});

// ══════════════════════════════════════════════════════════════════════
// ── Cache Integration ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

describe("response caching", () => {
  it("caches responses and returns cached on second call", async () => {
    const fetchMock = vi.mocked(fetch);
    process.env.LLM_CACHE_ENABLED = "true";
    process.env.LLM_CACHE_MAX_SIZE = "10";

    fetchMock.mockResolvedValueOnce(okResponse(TEST_JSON_CONTENT));

    const result1 = await chatText({ messages: TEST_MESSAGES });
    const result2 = await chatText({ messages: TEST_MESSAGES });

    expect(result1).toBe(TEST_JSON_CONTENT);
    expect(result2).toBe(TEST_JSON_CONTENT);
    expect(fetchMock).toHaveBeenCalledTimes(1); // only one actual fetch
  });

  it("cache miss on different messages", async () => {
    const fetchMock = vi.mocked(fetch);
    process.env.LLM_CACHE_ENABLED = "true";

    fetchMock
      .mockResolvedValueOnce(okResponse("response-1"))
      .mockResolvedValueOnce(okResponse("response-2"));

    const r1 = await chatText({ messages: TEST_MESSAGES });
    const r2 = await chatText({
      messages: [{ role: "user", content: "Different question" }],
    });

    expect(r1).toBe("response-1");
    expect(r2).toBe("response-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("cache disabled by default", async () => {
    const fetchMock = vi.mocked(fetch);
    // LLM_CACHE_ENABLED not set → defaults to false

    fetchMock
      .mockResolvedValueOnce(okResponse(TEST_JSON_CONTENT))
      .mockResolvedValueOnce(okResponse(TEST_JSON_CONTENT));

    await chatText({ messages: TEST_MESSAGES });
    await chatText({ messages: TEST_MESSAGES });

    expect(fetchMock).toHaveBeenCalledTimes(2); // no caching
  });
});

// ══════════════════════════════════════════════════════════════════════
// ── Usage Tracking ────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

describe("usage tracking", () => {
  it("records token usage from API response", async () => {
    const fetchMock = vi.mocked(fetch);

    fetchMock.mockResolvedValueOnce(
      okResponse(TEST_JSON_CONTENT, {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      }),
    );

    await chatText({ messages: TEST_MESSAGES });

    const summary = getUsageSummary();
    expect(summary.totalRequests).toBe(1);
    expect(summary.totalPromptTokens).toBe(100);
    expect(summary.totalCompletionTokens).toBe(50);
    expect(summary.totalTokens).toBe(150);
  });

  it("accumulates across multiple calls", async () => {
    const fetchMock = vi.mocked(fetch);

    fetchMock
      .mockResolvedValueOnce(
        okResponse("r1", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
      )
      .mockResolvedValueOnce(
        okResponse("r2", { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }),
      );

    await chatText({ messages: TEST_MESSAGES });
    await chatText({
      messages: [{ role: "user", content: "different" }],
    });

    const summary = getUsageSummary();
    expect(summary.totalRequests).toBe(2);
    expect(summary.totalPromptTokens).toBe(30);
    expect(summary.totalCompletionTokens).toBe(15);
    expect(summary.totalTokens).toBe(45);
  });

  it("tracks per-model breakdown", async () => {
    const fetchMock = vi.mocked(fetch);
    process.env.LLM_MAX_HTTP_RETRIES = "0";
    process.env.LLM_FALLBACK_MODELS = "model-b";

    fetchMock
      .mockResolvedValueOnce(
        okResponse("r1", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
      )
      .mockResolvedValueOnce(errorResponse(500))
      .mockResolvedValueOnce(
        okResponse("r2", { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }),
      );

    // Call 1: primary model succeeds
    await chatText({ messages: TEST_MESSAGES });
    // Call 2: primary fails, fallback succeeds
    await chatText({
      messages: [{ role: "user", content: "different" }],
    });

    const summary = getUsageSummary();
    expect(summary.byModel["test-model"]).toBeDefined();
    expect(summary.byModel["test-model"].requests).toBe(1);
    expect(summary.byModel["model-b"]).toBeDefined();
    expect(summary.byModel["model-b"].requests).toBe(1);
  });

  it("handles missing usage field gracefully", async () => {
    const fetchMock = vi.mocked(fetch);

    // Response without usage field
    fetchMock.mockResolvedValueOnce(okResponse(TEST_JSON_CONTENT));

    await chatText({ messages: TEST_MESSAGES });

    const summary = getUsageSummary();
    expect(summary.totalRequests).toBe(1);
    expect(summary.totalTokens).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// ── Structured Logging ────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

describe("structured logging", () => {
  it("logs to console.error at info level", async () => {
    const fetchMock = vi.mocked(fetch);
    process.env.LLM_LOG_LEVEL = "info";
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    fetchMock.mockResolvedValueOnce(okResponse(TEST_JSON_CONTENT));

    await chatText({ messages: TEST_MESSAGES });

    expect(consoleSpy).toHaveBeenCalled();
    const logEntry = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(logEntry.level).toBe("info");
    expect(logEntry.model).toBe("test-model");
    expect(logEntry.cacheHit).toBe(false);
    expect(typeof logEntry.latencyMs).toBe("number");

    consoleSpy.mockRestore();
  });

  it("silent mode produces no logs", async () => {
    const fetchMock = vi.mocked(fetch);
    process.env.LLM_LOG_LEVEL = "silent";
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    fetchMock.mockResolvedValueOnce(okResponse(TEST_JSON_CONTENT));

    await chatText({ messages: TEST_MESSAGES });

    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// ══════════════════════════════════════════════════════════════════════
// ── Backward Compatibility ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

describe("backward compatibility", () => {
  it("chatJson parses and validates Zod schema", async () => {
    const fetchMock = vi.mocked(fetch);
    const schema = z.object({ answer: z.number() });

    fetchMock.mockResolvedValueOnce(
      okResponse(JSON.stringify({ answer: 42 })),
    );

    const result = await chatJson({
      system: "test",
      user: "test",
      schema,
      schemaName: "testSchema",
    });

    expect(result.answer).toBe(42);
  });

  it("chatJson throws LlmError on invalid JSON after retries", async () => {
    const fetchMock = vi.mocked(fetch);
    const schema = z.object({ answer: z.number() });

    fetchMock
      .mockResolvedValueOnce(okResponse("not valid json"))
      .mockResolvedValueOnce(okResponse("still not valid"));

    await expect(
      chatJson({
        system: "test",
        user: "test",
        schema,
        schemaName: "testSchema",
      }),
    ).rejects.toThrow(LlmError);
  });

  it("chatText returns raw text", async () => {
    const fetchMock = vi.mocked(fetch);

    fetchMock.mockResolvedValueOnce(
      okResponse("This is raw text, not JSON."),
    );

    const result = await chatText({ messages: TEST_MESSAGES });
    expect(result).toBe("This is raw text, not JSON.");
  });

  it("throws LlmError when API key is missing", async () => {
    delete process.env.LLM_API_KEY;

    await expect(chatText({ messages: TEST_MESSAGES })).rejects.toThrow(
      "LLM_API_KEY is not set",
    );
  });

  it("omits enable_thinking by default", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(okResponse(TEST_JSON_CONTENT));

    await chatText({ messages: TEST_MESSAGES });

    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.enable_thinking).toBeUndefined();
  });

  it("sends enable_thinking: true when LLM_ENABLE_THINKING=true", async () => {
    process.env.LLM_ENABLE_THINKING = "true";
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(okResponse(TEST_JSON_CONTENT));

    await chatText({ messages: TEST_MESSAGES });

    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.enable_thinking).toBe(true);
  });

  it("sends response_format: json_object by default for JSON calls", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(okResponse(TEST_JSON_CONTENT));

    await chatJson({
      system: "s",
      user: "u",
      schema: z.object({ answer: z.number() }),
      schemaName: "answer",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("never forces JSON mode on free-text calls (chatText)", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(okResponse("theorem t : True := trivial"));

    await chatText({ messages: TEST_MESSAGES });

    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.response_format).toBeUndefined();
  });

  it("omits response_format when LLM_JSON_MODE=false", async () => {
    process.env.LLM_JSON_MODE = "false";
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(okResponse(TEST_JSON_CONTENT));

    await chatText({ messages: TEST_MESSAGES });

    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.response_format).toBeUndefined();
    delete process.env.LLM_JSON_MODE;
  });

  it("auto-wraps bare array into expected object key", async () => {
    const fetchMock = vi.mocked(fetch);
    const schema = z.object({
      problems: z.array(z.object({ name: z.string() })),
    });

    // LLM returns a bare array instead of { problems: [...] }
    fetchMock.mockResolvedValueOnce(
      okResponse(JSON.stringify([{ name: "test" }])),
    );

    const result = await chatJson({
      system: "test",
      user: "test",
      schema,
      schemaName: "testSchema",
    });

    expect(result.problems).toHaveLength(1);
    expect(result.problems[0].name).toBe("test");
  });

  it("auto-wraps mismatched array key name", async () => {
    const fetchMock = vi.mocked(fetch);
    const schema = z.object({
      problems: z.array(z.object({ name: z.string() })),
      notes: z.string().optional(),
    });

    // LLM returns { problem_list: [...] } instead of { problems: [...] }
    fetchMock.mockResolvedValueOnce(
      okResponse(
        JSON.stringify({ problem_list: [{ name: "test" }], notes: "ok" }),
      ),
    );

    const result = await chatJson({
      system: "test",
      user: "test",
      schema,
      schemaName: "testSchema",
    });

    expect(result.problems).toHaveLength(1);
    expect(result.problems[0].name).toBe("test");
    expect(result.notes).toBe("ok");
  });
});
