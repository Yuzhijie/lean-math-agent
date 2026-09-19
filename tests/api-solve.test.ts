import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createSession,
  getSession,
  updateSession,
  _resetStoreForTests,
} from "@/lib/session-store";
import type { MethodOption, NaturalLanguageSolution } from "@/lib/types";

// Mock LLM and Lean modules
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

vi.mock("@/lib/llm/classify-problem", () => ({
  classifyProblem: vi.fn().mockResolvedValue({
    problem_type: "computational",
    math_domain: "algebra",
  }),
}));

vi.mock("@/lib/compute/solver", () => ({
  solveComputational: vi.fn().mockResolvedValue({
    answer: "42",
    answer_exact: "42",
    answer_decimal: "42.0",
    cross_validated: true,
    methods_used: ["direct"],
    solution_steps: ["step 1"],
  }),
}));

vi.mock("@/lib/llm/nl-solution", () => ({
  generateNLSolution: vi.fn().mockResolvedValue({
    summary: "答案42",
    steps: [{ title: "计算", content: "得出42" }],
    final_answer: "$42$",
    verification: "验证正确",
  }),
  generateNLTheoremSolution: vi.fn(),
}));

vi.mock("@/lib/lean/sandbox", () => ({
  verifyLeanSource: vi.fn().mockResolvedValue({ ok: true, log: "ok", status: "ok" }),
  clearVerificationCache: vi.fn(),
  verificationCacheSize: vi.fn().mockReturnValue(0),
}));

beforeEach(() => {
  _resetStoreForTests();
  vi.clearAllMocks();
});

describe("solve pipeline — session management", () => {
  it("createSession creates a session for solve", () => {
    const session = createSession("求解 6 * 7 = ?");
    expect(session.id).toBeDefined();
    expect(session.problem_text).toBe("求解 6 * 7 = ?");
    expect(session.pipeline_stage).toBe("idle");
  });

  it("updateSession tracks pipeline stages", () => {
    const session = createSession("test");
    updateSession(session.id, { pipeline_stage: "computing" });
    expect(getSession(session.id)?.pipeline_stage).toBe("computing");

    updateSession(session.id, { pipeline_stage: "complete" });
    expect(getSession(session.id)?.pipeline_stage).toBe("complete");
  });

  it("session stores computation result", () => {
    const session = createSession("test");
    updateSession(session.id, {
      computation_result: {
        answer: "42",
        answer_exact: "42",
        answer_decimal: "42.0",
        cross_validated: true,
        methods_used: ["direct"],
        solution_steps: ["computed"],
      },
    });
    const s = getSession(session.id);
    expect(s?.computation_result?.answer).toBe("42");
    expect(s?.computation_result?.cross_validated).toBe(true);
  });

  it("session stores NL solution", () => {
    const session = createSession("test");
    const nl: NaturalLanguageSolution = {
      summary: "答案",
      steps: [{ title: "s1", content: "c1", substeps: ["sub1"], key_formula: "$$f$$" }],
      final_answer: "$42$",
      verification: "ok",
    };
    updateSession(session.id, { nl_solution: nl });
    const s = getSession(session.id);
    expect(s?.nl_solution?.steps[0].substeps).toEqual(["sub1"]);
    expect(s?.nl_solution?.steps[0].key_formula).toBe("$$f$$");
  });

  it("session stores method scores", () => {
    const session = createSession("test");
    updateSession(session.id, {
      method_scores: [
        {
          method_id: "m1",
          feasibility: 0.8,
          elegance: 0.7,
          lean_difficulty: 0.3,
          mathlib_coverage: 0.9,
          pedagogical_value: 0.6,
          composite: 0.75,
          rationale: "good",
        },
      ],
      recommended_method_id: "m1",
    });
    const s = getSession(session.id);
    expect(s?.method_scores).toHaveLength(1);
    expect(s?.recommended_method_id).toBe("m1");
  });
});

describe("solve pipeline — error handling", () => {
  it("session transitions to failed on error", () => {
    const session = createSession("test");
    updateSession(session.id, { pipeline_stage: "failed" });
    expect(getSession(session.id)?.pipeline_stage).toBe("failed");
  });

  it("session can be retried after failure", () => {
    const session = createSession("test");
    updateSession(session.id, { pipeline_stage: "failed" });
    updateSession(session.id, { pipeline_stage: "idle" });
    expect(getSession(session.id)?.pipeline_stage).toBe("idle");
  });
});
