import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enumerateMethods } from "@/lib/llm/enumerate";
import { LlmError } from "@/lib/llm/client";

const validPayload = {
  comparison_summary: "归纳最稳；rewrite 最短。",
  out_of_domain_warning: null,
  methods: [
    {
      id: "m1",
      category: "induction",
      title: "对 n 归纳",
      inspiration: "目标对全体自然数成立，结构上适合归纳。",
      pros: "覆盖所有 n，证明完整。",
      cons: "比 simp 啰嗦。",
      lean_sketch: "induction n <;> simp",
      confidence: 0.9,
    },
    {
      id: "m2",
      category: "rewrite",
      title: "改写等式",
      inspiration: "两边可直接改写到同一形式。",
      pros: "简短。",
      cons: "依赖合适引理。",
      lean_sketch: "rw [Nat.add_comm]",
      confidence: 0.7,
    },
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

  it("returns 1+ methods for valid JSON", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(chatResponse(JSON.stringify(validPayload)));

    const result = await enumerateMethods("prove n + 0 = n");

    expect(result.methods.length).toBeGreaterThanOrEqual(1);
    expect(result.comparison_summary).toBe(validPayload.comparison_summary);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries once on invalid JSON then succeeds", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(chatResponse("{not-json"))
      .mockResolvedValueOnce(chatResponse(JSON.stringify(validPayload)));

    const result = await enumerateMethods("prove n + 0 = n");

    expect(result.methods.length).toBeGreaterThanOrEqual(1);
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
