import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { classifyProblem } from "@/lib/llm/classify-problem";
import { problemClassificationSchema } from "@/lib/llm/classify-problem";

// ── Test helpers (matching existing patterns) ───────────────────────

function chatResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

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

// ── Schema tests ────────────────────────────────────────────────────

describe("problemClassificationSchema", () => {
  it("accepts valid computational classification", () => {
    const result = problemClassificationSchema.parse({
      problem_type: "computational",
      confidence: 0.95,
      reasoning: "这是一个求值问题",
      computational_hints: {
        unknowns: ["x"],
        equation_type: "quadratic",
      },
    });
    expect(result.problem_type).toBe("computational");
    expect(result.confidence).toBe(0.95);
  });

  it("accepts valid theorem classification", () => {
    const result = problemClassificationSchema.parse({
      problem_type: "theorem",
      confidence: 0.9,
      reasoning: "这是一个证明问题",
    });
    expect(result.problem_type).toBe("theorem");
  });

  it("rejects invalid problem_type", () => {
    expect(() =>
      problemClassificationSchema.parse({
        problem_type: "unknown",
        confidence: 0.5,
        reasoning: "test",
      }),
    ).toThrow();
  });

  it("rejects confidence out of range", () => {
    expect(() =>
      problemClassificationSchema.parse({
        problem_type: "computational",
        confidence: 1.5,
        reasoning: "test",
      }),
    ).toThrow();
  });

  it("rejects empty reasoning", () => {
    expect(() =>
      problemClassificationSchema.parse({
        problem_type: "computational",
        confidence: 0.5,
        reasoning: "",
      }),
    ).toThrow();
  });
});

// ── Integration tests (mocked fetch) ────────────────────────────────

describe("classifyProblem", () => {
  it("classifies a computational problem", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      chatResponse(
        JSON.stringify({
          problem_type: "computational",
          confidence: 0.95,
          reasoning: "这是一个求距离之和的计算问题",
          computational_hints: {
            unknowns: ["x"],
            equation_type: "quadratic",
          },
        }),
      ),
    );

    const result = await classifyProblem(
      "A person walks along a beach at 3 mi/h and swims at 2 mi/h to an island. Find the sum of distances from A to B.",
    );

    expect(result.problem_type).toBe("computational");
    expect(result.computational_hints?.equation_type).toBe("quadratic");
  });

  it("classifies a theorem problem", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      chatResponse(
        JSON.stringify({
          problem_type: "theorem",
          confidence: 0.98,
          reasoning: "这是一个需要证明的自然数性质",
        }),
      ),
    );

    const result = await classifyProblem("证明对任意自然数 n，n + 0 = n");

    expect(result.problem_type).toBe("theorem");
    expect(result.computational_hints).toBeUndefined();
  });

  it("classifies a Chinese computational problem", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      chatResponse(
        JSON.stringify({
          problem_type: "computational",
          confidence: 0.9,
          reasoning: "求值问题",
          computational_hints: {
            unknowns: ["x"],
            equation_type: "linear",
          },
        }),
      ),
    );

    const result = await classifyProblem("求满足条件的 x 的值");

    expect(result.problem_type).toBe("computational");
  });
});
