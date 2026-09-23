import { beforeEach, describe, expect, it, vi } from "vitest";

// Candidate voting + counterexample layer, with the LLM and Lean mocked.
const { chatJson, sampleText, verifyLeanSource } = vi.hoisted(() => ({
  chatJson: vi.fn(),
  sampleText: vi.fn(),
  verifyLeanSource: vi.fn(),
}));

vi.mock("@/lib/llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/client")>();
  return { ...actual, chatJson, sampleText };
});

vi.mock("@/lib/lean/sandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lean/sandbox")>();
  return { ...actual, verifyLeanSource };
});

import { autoformalize } from "@/lib/llm/autoformalize";
import { statementToProp } from "@/lib/lean/refute";

const A = { theorem_name: "t", theorem_type: "(n : ℕ) : n - 1 + 1 = n", domain: "nat_arithmetic", natural_language_restatement: "对所有自然数 n，n-1+1=n", numerical_instances: [{ variables: { n: "3" }, expected_result: "true" }] };
const B = { ...A, theorem_type: "(n : ℕ) (h : 0 < n) : n - 1 + 1 = n" };
const B2 = { ...A, theorem_type: "(m : ℕ) (hm : 0 < m) : m - 1 + 1 = m" };

function llmAnswers(formalizations: object[]) {
  let calls = 0;
  chatJson.mockImplementation(async (args: { schemaName: string }) => {
    switch (args.schemaName) {
      case "formalizeResponse":
        return structuredClone(formalizations[Math.min(calls++, formalizations.length - 1)]);
      case "nonTrivialityCheck":
        return { is_non_trivial: true, reasoning: "有意义" };
      case "backTranslation":
        return { natural_language: "same", semantic_equivalence: 0.95, discrepancies: [] };
      case "equivalenceCheck":
        return { equivalent: true, score: 0.95, discrepancies: [], analysis: "等价" };
      case "numericalVerification":
        return { all_consistent: true, results: [] };
      case "hypothesisRelevance":
        return { all_relevant: true, suspicious: [], analysis: "相关" };
      default:
        throw new Error(`unexpected schema ${args.schemaName}`);
    }
  });
}

/** Lean stand-in: elaborates everything, signatures from the statement, plausible refutes statements without `0 < n`. */
function leanAnswers() {
  verifyLeanSource.mockImplementation(async (_id: string, source: string, opts: { wantSignature?: boolean }) => {
    const base = { log: "ok", status: "ok", backend: "repl", messages: [], sorries: [], goals: [], infos: [], durationMs: 1 };
    if (/by decide/.test(source)) {
      return { ...base, ok: false, messages: [{ severity: "error", line: 1, column: 0, message: "failed to synthesize\n  Decidable (∀ (n : ℕ), n - 1 + 1 = n)" }] };
    }
    if (/plausible/.test(source)) {
      if (/0 < /.test(source)) return { ...base, ok: true };
      return { ...base, ok: false, messages: [{ severity: "error", line: 1, column: 2, message: "Found a counter-example!\nn := 0\nissue: 0 - 1 + 1 = 0 does not hold" }] };
    }
    const m = source.match(/theorem \S+ (.*) := by sorry/);
    const signature = opts.wantSignature && m ? statementToProp(m[1]) : undefined;
    return { ...base, ok: true, signature };
  });
}

beforeEach(() => {
  chatJson.mockReset();
  sampleText.mockReset();
  verifyLeanSource.mockReset();
  delete process.env.AUTOFORMALIZE_CANDIDATES;
  delete process.env.REFUTE_ENABLED;
});

describe("autoformalize: candidate voting", () => {
  it("picks the statement most sampled candidates agree on (α-equivalent signatures)", async () => {
    llmAnswers([A]);
    sampleText.mockResolvedValue([JSON.stringify(B), "```json\n" + JSON.stringify(B2) + "\n```", "not json at all"]);
    leanAnswers();
    const r = await autoformalize({ problemText: "证明对正整数 n 有 n-1+1=n", candidates: 4, maxRetries: 0 });
    expect(r.accepted).toBe(true);
    expect(r.theorem_type).toBe(B.theorem_type);
    expect(r.vote).toEqual({ candidates: 3, elaborated: 3, agreeing: 2 });
    expect(r.refutation?.verdict).toBe("no_counterexample");
    expect(r.validation_results.map((v) => v.layer)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(r.validation_results[0].detail).toContain("候选投票：3 个候选");
    expect(sampleText).toHaveBeenCalledWith(expect.objectContaining({ n: 3, role: "planner" }));
  });

  it("does not sample when a single candidate is requested", async () => {
    llmAnswers([B]);
    leanAnswers();
    const r = await autoformalize({ problemText: "…", candidates: 1, maxRetries: 0 });
    expect(r.accepted).toBe(true);
    expect(r.vote).toBeUndefined();
    expect(sampleText).not.toHaveBeenCalled();
  });
});

describe("autoformalize: counterexample layer", () => {
  it("rejects a refuted statement and feeds the counterexample into the retry", async () => {
    llmAnswers([A, B]);
    leanAnswers();
    const r = await autoformalize({ problemText: "…", maxRetries: 1 });
    expect(r.accepted).toBe(true);
    expect(r.theorem_type).toBe(B.theorem_type);
    const formalizeCalls = chatJson.mock.calls.filter((c) => (c[0] as { schemaName: string }).schemaName === "formalizeResponse");
    expect(formalizeCalls).toHaveLength(2);
    expect((formalizeCalls[1][0] as { user: string }).user).toContain("Layer 6");
    expect((formalizeCalls[1][0] as { user: string }).user).toContain("n := 0");
    // No LLM validation layers were spent on the refuted candidate.
    const spent = chatJson.mock.calls.filter((c) => (c[0] as { schemaName: string }).schemaName === "nonTrivialityCheck");
    expect(spent).toHaveLength(1);
  });

  it("returns the refuted result when retries are exhausted", async () => {
    llmAnswers([A]);
    leanAnswers();
    const r = await autoformalize({ problemText: "…", maxRetries: 0 });
    expect(r.accepted).toBe(false);
    expect(r.refutation).toEqual({ verdict: "refuted", counterexample: "n := 0; issue: 0 - 1 + 1 = 0 does not hold" });
    const l6 = r.validation_results.find((v) => v.layer === 6)!;
    expect(l6.pass).toBe(false);
    expect(l6.detail).toContain("n := 0");
  });

  it("can be switched off", async () => {
    llmAnswers([A]);
    leanAnswers();
    const r = await autoformalize({ problemText: "…", maxRetries: 0, refute: false });
    expect(r.accepted).toBe(true);
    expect(r.validation_results.map((v) => v.layer)).toEqual([1, 2, 3, 4, 5]);
    expect(verifyLeanSource.mock.calls.some((c) => /plausible/.test(c[1] as string))).toBe(false);
  });
});
