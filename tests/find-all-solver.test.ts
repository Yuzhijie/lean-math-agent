import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ComputeEngine,
  isPerfectSquareBigInt,
  convertToBigIntExpr,
} from "@/lib/compute/engine";

// ── Pure utility tests ────────────────────────────────────────────────

describe("isPerfectSquareBigInt", () => {
  it("identifies 0 as a perfect square", () => {
    expect(isPerfectSquareBigInt(BigInt(0))).toEqual({ isSquare: true, sqrt: "0" });
  });

  it("identifies 1 as a perfect square", () => {
    expect(isPerfectSquareBigInt(BigInt(1))).toEqual({ isSquare: true, sqrt: "1" });
  });

  it("identifies small perfect squares", () => {
    for (const [n, root] of [[4, 2], [9, 3], [16, 4], [25, 5], [49, 7], [144, 12]]) {
      expect(isPerfectSquareBigInt(BigInt(n))).toEqual({ isSquare: true, sqrt: String(root) });
    }
  });

  it("rejects non-squares", () => {
    for (const n of [2, 3, 5, 6, 7, 8, 10, 59]) {
      const result = isPerfectSquareBigInt(BigInt(n));
      expect(result.isSquare).toBe(false);
    }
  });

  it("rejects negative numbers", () => {
    expect(isPerfectSquareBigInt(BigInt(-4))).toEqual({ isSquare: false, sqrt: "N/A" });
  });

  it("handles large perfect squares", () => {
    // 529 = 23^2
    expect(isPerfectSquareBigInt(BigInt(529))).toEqual({ isSquare: true, sqrt: "23" });
    // 5776 = 76^2
    expect(isPerfectSquareBigInt(BigInt(5776))).toEqual({ isSquare: true, sqrt: "76" });
    // 63001 = 251^2
    expect(isPerfectSquareBigInt(BigInt(63001))).toEqual({ isSquare: true, sqrt: "251" });
    // 687241 = 829^2
    expect(isPerfectSquareBigInt(BigInt(687241))).toEqual({ isSquare: true, sqrt: "829" });
  });

  it("rejects large non-squares", () => {
    // 530 is not a square (23^2=529, 24^2=576)
    expect(isPerfectSquareBigInt(BigInt(530)).isSquare).toBe(false);
  });
});

describe("convertToBigIntExpr", () => {
  it("converts integer literals to BigInt calls", () => {
    expect(convertToBigIntExpr("m * (a1 + a2) - a3")).toBe(
      'm * (a1 + a2) - a3',
    );
    expect(convertToBigIntExpr("2 * a1 + 3")).toBe(
      'BigInt("2") * a1 + BigInt("3")',
    );
  });

  it("does not convert digits inside variable names", () => {
    expect(convertToBigIntExpr("a1 + a2 + a3")).toBe("a1 + a2 + a3");
    expect(convertToBigIntExpr("a10 + b2")).toBe("a10 + b2");
  });

  it("handles parenthesized expressions", () => {
    expect(convertToBigIntExpr("m * (a1 + a2) - a3")).toBe(
      "m * (a1 + a2) - a3",
    );
  });

  it("converts multi-digit numbers", () => {
    expect(convertToBigIntExpr("10 * a1 - a2")).toBe(
      'BigInt("10") * a1 - a2',
    );
  });
});

// ── ComputeEngine.computeSequenceTerms tests ──────────────────────────

describe("ComputeEngine.computeSequenceTerms", () => {
  it("computes EGMO sequence for m=2 (Fibonacci squares)", async () => {
    const engine = new ComputeEngine();
    const result = await engine.computeSequenceTerms({
      recurrence: "m * (a1 + a2) - a3",
      initialValues: [1, 1, 4],
      parameterValue: 2,
      parameterName: "m",
      numTerms: 10,
    });

    expect(result.error).toBeUndefined();
    expect(result.allIntegers).toBe(true);
    expect(result.terms).toEqual([
      "1", "1", "4", "9", "25", "64", "169", "441", "1156", "3025",
    ]);

    // All terms should be perfect squares
    for (const t of result.terms) {
      expect(isPerfectSquareBigInt(BigInt(t)).isSquare).toBe(true);
    }
  });

  it("computes EGMO sequence for m=10 (all perfect squares)", async () => {
    const engine = new ComputeEngine();
    const result = await engine.computeSequenceTerms({
      recurrence: "m * (a1 + a2) - a3",
      initialValues: [1, 1, 4],
      parameterValue: 10,
      parameterName: "m",
      numTerms: 8,
    });

    expect(result.error).toBeUndefined();
    expect(result.allIntegers).toBe(true);

    // Verify known terms
    expect(result.terms[0]).toBe("1");
    expect(result.terms[1]).toBe("1");
    expect(result.terms[2]).toBe("4");
    expect(result.terms[3]).toBe("49");     // 7^2
    expect(result.terms[4]).toBe("529");    // 23^2
    expect(result.terms[5]).toBe("5776");   // 76^2
    expect(result.terms[6]).toBe("63001");  // 251^2
    expect(result.terms[7]).toBe("687241"); // 829^2

    // All terms should be perfect squares
    for (const t of result.terms) {
      expect(isPerfectSquareBigInt(BigInt(t)).isSquare).toBe(true);
    }
  });

  it("detects non-square for m=12 at term index 3", async () => {
    const engine = new ComputeEngine();
    const result = await engine.computeSequenceTerms({
      recurrence: "m * (a1 + a2) - a3",
      initialValues: [1, 1, 4],
      parameterValue: 12,
      parameterName: "m",
      numTerms: 5,
    });

    expect(result.error).toBeUndefined();
    expect(result.terms[3]).toBe("59"); // NOT a perfect square
    expect(isPerfectSquareBigInt(BigInt(59)).isSquare).toBe(false);
  });

  it("detects non-square for m=3 at term index 3", async () => {
    const engine = new ComputeEngine();
    const result = await engine.computeSequenceTerms({
      recurrence: "m * (a1 + a2) - a3",
      initialValues: [1, 1, 4],
      parameterValue: 3,
      parameterName: "m",
      numTerms: 5,
    });

    // a4 = 3*(4+1) - 1 = 14, not a square
    expect(result.terms[3]).toBe("14");
    expect(isPerfectSquareBigInt(BigInt(14)).isSquare).toBe(false);
  });

  it("handles simple second-order recurrence", async () => {
    const engine = new ComputeEngine();
    // Fibonacci: a_n = a_{n-1} + a_{n-2}
    const result = await engine.computeSequenceTerms({
      recurrence: "a1 + a2",
      initialValues: [1, 1],
      parameterValue: 0, // not used
      numTerms: 8,
    });

    expect(result.error).toBeUndefined();
    expect(result.terms).toEqual(["1", "1", "2", "3", "5", "8", "13", "21"]);
  });

  it("reports error for invalid formula", async () => {
    const engine = new ComputeEngine();
    const result = await engine.computeSequenceTerms({
      recurrence: "invalid $$$ formula",
      initialValues: [1, 1],
      parameterValue: 2,
      numTerms: 5,
    });

    expect(result.error).toBeDefined();
  });
});

// ── Integration test for solveFindAll ─────────────────────────────────

describe("solveFindAll integration", () => {
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

  it("finds m=2 and m=10 for EGMO 2020 Problem 6", async () => {
    // Mock chatJson responses
    const fetchMock = vi.mocked(fetch);

    // Analysis response
    const analysisPayload = {
      necessary_conditions: ["a4 = 5m-1 must be a perfect square"],
      search_lower_bound: "2",
      search_upper_bound: "50",
      candidate_values: ["2", "10"],
      verification_method: "Compute first 15 terms and check if all are perfect squares",
      completeness_strategy: "Growth rate argument limits m",
      analysis: "分析递推数列，推导必要条件",
      recurrence_formula: "m * (a1 + a2) - a3",
      initial_values: [1, 1, 4],
      recurrence_order: 3,
      condition_type: "all_perfect_squares",
    };

    // Completeness response
    const completenessPayload = {
      completeness_argument: "搜索范围内已穷举验证。",
      key_insight: "递推增长限制",
      bounding_argument: "增长速率论证",
    };

    // First call: analysis
    fetchMock.mockResolvedValueOnce(
      chatResponse(JSON.stringify(analysisPayload)),
    );
    // Second call: completeness
    fetchMock.mockResolvedValueOnce(
      chatResponse(JSON.stringify(completenessPayload)),
    );

    const { solveFindAll } = await import("@/lib/compute/find-all-solver");

    const result = await solveFindAll({
      problemText:
        "Determine all integers m > 1 such that the sequence a_n = m(a_{n-1} + a_{n-2}) - a_{n-3} with a1 = a2 = 1, a3 = 4 consists exclusively of perfect squares.",
      hints: {
        parameter: "m",
        parameter_domain: "integer",
        condition_description: "all terms are perfect squares",
      },
      searchRange: { min: 2, max: 20 },
    });

    // Should find exactly m=2 and m=10
    expect(result.valid_values).toContain("2");
    expect(result.valid_values).toContain("10");
    expect(result.valid_values).toHaveLength(2);
    expect(result.answer).toContain("m = 2");
    expect(result.answer).toContain("m = 10");

    // Verify specific candidate results
    const m10Candidate = result.candidates.find((c) => c.value === "10");
    expect(m10Candidate).toBeDefined();
    expect(m10Candidate!.satisfies).toBe(true);

    const m12Candidate = result.candidates.find((c) => c.value === "12");
    expect(m12Candidate).toBeDefined();
    expect(m12Candidate!.satisfies).toBe(false);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────

function chatResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
