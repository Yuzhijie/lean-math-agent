import { describe, it, expect, vi, beforeEach } from "vitest";
import { _resetStoreForTests, getSession } from "@/lib/session-store";
import type { LeanVerifyResult } from "@/lib/lean/sandbox";

// End-to-end through the /api/solve handler with every LLM / Lean boundary
// mocked: the planner tries to change the theorem statement, and the final
// verification must still be run against the validated one.

// vi.mock factories are hoisted above these, so use vi.hoisted for shared values.
const { VALIDATED_TYPE, VALIDATED_SIG, verifyCalls } = vi.hoisted(() => ({
  VALIDATED_TYPE: ": ∀ (n : Nat), n + 0 = n",
  VALIDATED_SIG: "∀ (n : Nat), n + 0 = n",
  verifyCalls: [] as Array<{ source: string; opts: Record<string, unknown> | undefined }>,
}));

vi.mock("@/lib/llm/classify-problem", () => ({
  classifyProblem: vi.fn().mockResolvedValue({ problem_type: "theorem", confidence: 1, reasoning: "" }),
}));

vi.mock("@/lib/llm/autoformalize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/autoformalize")>();
  return {
    ...actual,
    autoformalize: vi.fn().mockResolvedValue({
      theorem_name: "problem",
      theorem_type: VALIDATED_TYPE,
      domain: "nat_arithmetic",
      formal_statement: `theorem problem ${VALIDATED_TYPE} := by sorry`,
      formal_signature: VALIDATED_SIG,
      validation_results: [{ layer: 1, pass: true, detail: "ok" }],
      accepted: true,
    }),
  };
});

vi.mock("@/lib/lean/trivial-proof", () => ({
  tryTrivialProof: vi.fn().mockResolvedValue(null),
  tryTrivialTactic: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/llm/enumerate", () => ({
  enumerateMethods: vi.fn().mockResolvedValue({
    methods: [
      { id: "m1", category: "rewrite", title: "simp", inspiration: "", pros: "", cons: "", lean_sketch: "simp", confidence: 0.9 },
    ],
    comparison_summary: "",
    out_of_domain_warning: null,
  }),
}));

vi.mock("@/lib/llm/plan", () => ({
  planSteps: vi.fn().mockResolvedValue({
    // The planner "helpfully" rewrites the theorem into a different one.
    theorem_name: "problem",
    theorem_type: "(n : Nat) : 0 + n = n",
    steps: [{ index: 0, plain_goal: "化简", lean_goal: "simp" }],
  }),
}));

vi.mock("@/lib/search/proof-search", () => ({
  proofSearch: vi.fn().mockImplementation(async (args: { session: { steps: unknown[] } }) => ({
    steps: (args.session.steps as Array<Record<string, unknown>>).map((s) => ({ ...s, lean_code: "simp", status: "ok" })),
    sorryLabels: [],
    fullyVerified: true,
    totalAttempts: 1,
    bestScore: 0,
  })),
}));

vi.mock("@/lib/lean/sandbox", () => ({
  verifyLeanSource: vi.fn(async (_id: string, source: string, opts?: Record<string, unknown>): Promise<LeanVerifyResult> => {
    verifyCalls.push({ source, opts });
    const complete = !opts?.allowSorry;
    return {
      ok: true,
      log: "ok",
      status: "ok",
      backend: "repl",
      messages: [],
      sorries: [],
      infos: [],
      goals: opts?.allowSorry ? ["n : Nat\n⊢ n + 0 = n"] : [],
      axioms: complete ? { axioms: ["propext"], disallowed: [], usesSorry: false, usesNative: false } : undefined,
      signature: VALIDATED_SIG,
      signatureMatch: opts?.expectedSignature !== undefined ? opts.expectedSignature === VALIDATED_SIG : undefined,
      durationMs: 1,
    };
  }),
  clearVerificationCache: vi.fn(),
  verificationCacheSize: vi.fn().mockReturnValue(0),
}));

vi.mock("@/lib/llm/nl-solution", () => ({
  generateNLSolution: vi.fn().mockResolvedValue(null),
  generateNLTheoremSolution: vi.fn().mockResolvedValue(null),
}));

import { POST } from "@/app/api/solve/route";

beforeEach(() => {
  _resetStoreForTests();
  verifyCalls.length = 0;
});

describe("statement lock in /api/solve", () => {
  it("proves and verifies the validated statement, not the planner's rewrite", async () => {
    const req = new Request("http://localhost/api/solve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ problem_text: "证明 n + 0 = n", options: { skip_nl_solution: true } }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // The session keeps the validated statement and its signature.
    const session = getSession(body.session_id as string)!;
    expect(session.theorem_type).toBe(VALIDATED_TYPE);
    expect(session.formal_signature).toBe(VALIDATED_SIG);
    expect(body.theorem_type).toBe(VALIDATED_TYPE);

    // Every assembled source uses the validated statement; none uses 0 + n.
    expect(verifyCalls.length).toBeGreaterThan(0);
    for (const c of verifyCalls) {
      expect(c.source).toContain("n + 0 = n");
      expect(c.source).not.toContain("0 + n = n");
    }

    // The final (complete-proof) verification carries the statement lock.
    const finalCall = verifyCalls[verifyCalls.length - 1];
    expect(finalCall.opts).toMatchObject({ theoremName: "problem", expectedSignature: VALIDATED_SIG });
    expect(finalCall.opts?.allowSorry).toBeFalsy();

    const attempt = body.lean_proof_attempt as Record<string, unknown>;
    expect(attempt.success).toBe(true);
    expect(attempt.statement_locked).toBe(true);
    expect(attempt.axioms).toEqual(["propext"]);
    expect(attempt.verifier).toBe("repl");
    expect(body.fully_verified).toBe(true);
  });
});
