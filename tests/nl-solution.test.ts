import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NaturalLanguageSolution } from "@/lib/types";

// Mock chatJson before importing nl-solution
vi.mock("@/lib/llm/client", () => ({
  chatJson: vi.fn(),
  chatText: vi.fn(),
  LlmError: class LlmError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "LlmError";
    }
  },
}));

import { chatJson } from "@/lib/llm/client";
import {
  generateNLSolution,
  generateNLTheoremSolution,
} from "@/lib/llm/nl-solution";

const mockChatJson = vi.mocked(chatJson);

const MOCK_NL_SOLUTION: NaturalLanguageSolution = {
  summary: "测试摘要",
  steps: [
    { title: "第一步", content: "测试内容 $x = 1$" },
    { title: "第二步", content: "验证" },
  ],
  final_answer: "$1$",
  verification: "代回验证正确",
};

const MOCK_NL_WITH_SUBSTEPS: NaturalLanguageSolution = {
  summary: "带子步骤的测试",
  steps: [
    {
      title: "建立方程",
      content: "设变量",
      substeps: ["设 $x$ 为未知数", "列方程"],
      key_formula: "$$2x + 3 = 7$$",
    },
    { title: "求解", content: "$x = 2$" },
  ],
  final_answer: "$2$",
  verification: "验证正确",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("generateNLSolution", () => {
  it("calls chatJson and returns structured solution", async () => {
    mockChatJson.mockResolvedValueOnce(MOCK_NL_SOLUTION);

    const result = await generateNLSolution({
      problemText: "求解 x + 1 = 2",
      problemType: "computational",
    });

    expect(mockChatJson).toHaveBeenCalledTimes(1);
    expect(result.summary).toBe("测试摘要");
    expect(result.steps).toHaveLength(2);
    expect(result.final_answer).toBe("$1$");
  });

  it("includes compute result context when provided", async () => {
    mockChatJson.mockResolvedValueOnce(MOCK_NL_SOLUTION);

    await generateNLSolution({
      problemText: "求解",
      problemType: "computational",
      computeResult: {
        answer: "1",
        answer_decimal: "1.0",
        solution_steps: ["step 1", "step 2"],
      },
    });

    const call = mockChatJson.mock.calls[0][0];
    expect(call.user).toContain("答案: 1");
    expect(call.user).toContain("step 1");
  });

  it("uses find_all system prompt for find-all problems", async () => {
    mockChatJson.mockResolvedValueOnce(MOCK_NL_SOLUTION);

    await generateNLSolution({
      problemText: "求所有满足条件的正整数",
      problemType: "find_all_values",
    });

    const call = mockChatJson.mock.calls[0][0];
    expect(call.system).toContain("完备性");
  });

  it("returns solution with substeps and key_formula", async () => {
    mockChatJson.mockResolvedValueOnce(MOCK_NL_WITH_SUBSTEPS);

    const result = await generateNLSolution({
      problemText: "解方程 2x + 3 = 7",
    });

    expect(result.steps[0].substeps).toHaveLength(2);
    expect(result.steps[0].key_formula).toBe("$$2x + 3 = 7$$");
  });
});

describe("generateNLTheoremSolution", () => {
  it("includes proof steps context when provided", async () => {
    mockChatJson.mockResolvedValueOnce(MOCK_NL_SOLUTION);

    await generateNLTheoremSolution({
      problemText: "证明 n + 0 = n",
      methodTitle: "数学归纳法",
      proofSteps: [
        { plain_goal: "base case", plain_explanation: "n=0 时成立" },
        { plain_goal: "inductive step", plain_explanation: "假设 n 成立推 n+1" },
      ],
    });

    const call = mockChatJson.mock.calls[0][0];
    expect(call.user).toContain("数学归纳法");
    expect(call.user).toContain("base case");
  });
});
