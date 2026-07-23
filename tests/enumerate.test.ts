import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enumerateMethods } from "@/lib/llm/enumerate";
import { LlmError } from "@/lib/llm/client";

const method = (id: string, category: string) => ({
  id,
  category,
  title: `title ${id}`,
  inspiration: "inspiration text",
  pros: "pros text",
  cons: "cons text",
  lean_sketch: "rfl",
  confidence: 0.8,
});

const validInDomainPayload = {
  comparison_summary: "归纳最稳；rewrite 最短；calc 清晰。",
  out_of_domain_warning: null,
  methods: [
    method("m1", "induction"),
    method("m2", "rewrite"),
    method("m3", "calc"),
  ],
};

function chatResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("enumerateMethods", () => {
  beforeEach(() => {
    process.env.LLM_API_KEY = "test-key";
    process.env.LLM_BASE_URL = "https://example.test/v1";
    process.env.LLM_MODEL = "test-model";
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
  });

  it("returns ≥3 methods for valid in-domain JSON", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      chatResponse(JSON.stringify(validInDomainPayload)),
    );

    const result = await enumerateMethods("prove n + 0 = n");

    expect(result.methods.length).toBeGreaterThanOrEqual(3);
    expect(result.comparison_summary).toBe(
      validInDomainPayload.comparison_summary,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries once when in-domain response has fewer than 3 methods", async () => {
    const fetchMock = vi.mocked(fetch);
    const tooFew = {
      ...validInDomainPayload,
      methods: validInDomainPayload.methods.slice(0, 2),
    };
    fetchMock
      .mockResolvedValueOnce(chatResponse(JSON.stringify(tooFew)))
      .mockResolvedValueOnce(
        chatResponse(JSON.stringify(validInDomainPayload)),
      );

    const result = await enumerateMethods("prove n + 0 = n");

    expect(result.methods).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries once on invalid JSON then succeeds", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(chatResponse("{not-json"))
      .mockResolvedValueOnce(
        chatResponse(JSON.stringify(validInDomainPayload)),
      );

    const result = await enumerateMethods("prove n + 0 = n");

    expect(result.methods.length).toBeGreaterThanOrEqual(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(
      (fetchMock.mock.calls[1]![1] as RequestInit).body as string,
    );
    expect(secondBody.messages[1].content).toContain("Return ONLY valid JSON");
  });

  it("throws after one failed resample", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(chatResponse("{not-json"))
      .mockResolvedValueOnce(chatResponse("{still-bad"));

    await expect(enumerateMethods("prove n + 0 = n")).rejects.toBeInstanceOf(
      LlmError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
