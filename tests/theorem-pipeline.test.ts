import { describe, it, expect, vi, beforeEach } from "vitest";
import { _resetStoreForTests, getSession } from "@/lib/session-store";
import type { LeanVerifyResult } from "@/lib/lean/sandbox";

// /api/solve and /api/solve-stream through the shared theorem pipeline with
// every LLM / Lean boundary mocked: whole-proof first, stepwise fallback,
// optional multi-agent method evaluation, and per-run metrics.

const { TYPE, SIG, wholeMock, orchestratorMock, verifyMock } = vi.hoisted(() => ({
  TYPE: ": ∀ (n : Nat), n + 0 = n",
  SIG: "∀ (n : Nat), n + 0 = n",
  wholeMock: vi.fn(),
  orchestratorMock: vi.fn(),
  verifyMock: vi.fn(),
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
      theorem_type: TYPE,
      domain: "nat_arithmetic",
      formal_statement: `theorem problem ${TYPE} := by sorry`,
      formal_signature: SIG,
      validation_results: [{ layer: 1, pass: true, detail: "ok" }],
      accepted: true,
    }),
  };
});
vi.mock("@/lib/lean/trivial-proof", () => ({
  tryTrivialProof: vi.fn().mockResolvedValue(null),
  tryTrivialTactic: vi.fn().mockResolvedValue(null),
}));
// The REPL-backed stages (hammer, sketch-and-fill) have their own real-Lean tests.
vi.mock("@/lib/lean/hammer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lean/hammer")>();
  return { ...actual, hammerTheorem: vi.fn().mockResolvedValue(undefined) };
});
vi.mock("@/lib/prover/sketch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/prover/sketch")>();
  return {
    ...actual,
    proveBySketch: vi.fn().mockResolvedValue({ ok: false, unavailable: true, sketches: 0, holes: 0, holesSolved: 0, llmCalls: 0, log: "", durationMs: 0 }),
  };
});
vi.mock("@/lib/prover/whole-proof", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/prover/whole-proof")>();
  return { ...actual, proveWholeTheorem: wholeMock };
});
vi.mock("@/lib/agents/orchestrator", () => ({ runMultiAgentEvaluation: orchestratorMock }));
vi.mock("@/lib/llm/enumerate", () => ({
  enumerateMethods: vi.fn().mockResolvedValue({
    methods: [{ id: "m1", category: "rewrite", title: "simp", inspiration: "", pros: "", cons: "", lean_sketch: "simp", confidence: 0.9 }],
    comparison_summary: "",
    out_of_domain_warning: null,
  }),
}));
vi.mock("@/lib/llm/plan", () => ({
  planSteps: vi.fn().mockResolvedValue({
    theorem_name: "problem",
    theorem_type: TYPE,
    steps: [{ index: 0, plain_goal: "化简", lean_goal: "simp" }],
  }),
}));
vi.mock("@/lib/search/proof-search", () => ({
  proofSearch: vi.fn().mockImplementation(async (args: { session: { steps: unknown[] } }) => ({
    steps: (args.session.steps as Array<Record<string, unknown>>).map((s) => ({ ...s, lean_code: "simp", status: "ok" })),
    sorryLabels: [],
    fullyVerified: true,
    totalAttempts: 2,
    bestScore: 0,
    expansions: 1,
  })),
}));
vi.mock("@/lib/lean/sandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lean/sandbox")>();
  return { ...actual, verifyLeanSource: verifyMock };
});
vi.mock("@/lib/llm/nl-solution", () => ({
  generateNLSolution: vi.fn().mockResolvedValue({
    summary: "对任意 n，n + 0 = n",
    steps: [{ title: "化简", content: "由加法定义 $n+0=n$" }],
    final_answer: "$n+0=n$",
    verification: "",
  }),
  generateNLTheoremSolution: vi.fn().mockResolvedValue(null),
}));

import { POST } from "@/app/api/solve/route";
import { POST as STREAM } from "@/app/api/solve-stream/route";
import { recordUsage } from "@/lib/llm/usage-tracker";

function ok(partial: Partial<LeanVerifyResult> = {}): LeanVerifyResult {
  return {
    ok: true, log: "ok", status: "ok", backend: "repl", messages: [], sorries: [], goals: [], infos: [],
    axioms: { axioms: ["propext"], disallowed: [], usesSorry: false, usesNative: false },
    signature: SIG, signatureMatch: true, durationMs: 1, ...partial,
  };
}

const WHOLE_SOURCE = `import Mathlib\n\ntheorem problem ${TYPE} := by\n  intro n\n  simp\n`;

beforeEach(() => {
  _resetStoreForTests();
  wholeMock.mockReset();
  orchestratorMock.mockReset();
  verifyMock.mockReset();
  verifyMock.mockImplementation(async (_id: string, _src: string, opts?: { allowSorry?: boolean }) =>
    ok({ goals: opts?.allowSorry ? ["⊢ ∀ (n : Nat), n + 0 = n"] : [] }),
  );
  delete process.env.WHOLE_PROOF_ENABLED;
  delete process.env.SOLVE_MULTI_AGENT;
});

async function solve(options: Record<string, unknown> = {}) {
  const req = new Request("http://localhost/api/solve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ problem_text: "证明 n + 0 = n", options }),
  });
  const res = await POST(req);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("theorem pipeline: whole-proof stage", () => {
  it("returns the whole-proof result (strategy whole_proof) and skips enumeration", async () => {
    wholeMock.mockImplementation(async (args: { onProgress?: (p: unknown) => void }) => {
      args.onProgress?.({ round: 0, status: "sampling", detail: "采样 4 个完整证明…" });
      return {
        ok: true, unavailable: false, source: WHOLE_SOURCE, tactics: "intro n\nsimp",
        verification: ok(), candidates: [], rounds: 1, samples: 4, suggestions: [], log: "", durationMs: 5,
      };
    });
    const { status, body } = await solve();
    expect(status).toBe(200);
    expect(body.fully_verified).toBe(true);
    expect(body.method).toMatchObject({ id: "whole_proof" });
    const attempt = body.lean_proof_attempt as Record<string, unknown>;
    expect(attempt).toMatchObject({ success: true, strategy: "whole_proof", attempts: 4, rounds: 1, statement_locked: true, verifier: "repl" });
    expect(body.assembled_lean).toBe(WHOLE_SOURCE);
    expect((body.steps as unknown[]).length).toBe(1);
    expect(body.whole_proof).toMatchObject({ rounds: 1, samples: 4 });

    // The prover got the statement lock, the NL sketch and the preflight goal.
    const args = wholeMock.mock.calls[0][0];
    expect(args).toMatchObject({ theoremName: "problem", theoremType: TYPE, expectedSignature: SIG, initialGoal: "⊢ ∀ (n : Nat), n + 0 = n" });
    expect(args.sketch).toContain("n+0=n");

    const events = body.pipeline_events as Array<{ stage: string; detail: string }>;
    expect(events.some((e) => e.stage === "whole_proof" && /采样/.test(e.detail))).toBe(true);
    expect(events.some((e) => e.stage === "enumerating")).toBe(false);

    const session = getSession(body.session_id as string)!;
    expect(session.build_status).toBe("ok");
    expect(session.lean_proof_attempt?.strategy).toBe("whole_proof");
    expect(session.metrics).toBeDefined();
  });

  it("falls back to the stepwise pipeline when the whole-proof loop fails", async () => {
    wholeMock.mockResolvedValue({ ok: false, unavailable: false, candidates: [], rounds: 3, samples: 12, suggestions: ["exact foo"], log: "", durationMs: 5 });
    const { status, body } = await solve();
    expect(status).toBe(200);
    expect(body.method).toMatchObject({ id: "m1" });
    expect(body.fully_verified).toBe(true);
    expect((body.lean_proof_attempt as Record<string, unknown>).strategy).toBe("stepwise");
    expect(body.whole_proof).toMatchObject({ ok: false, summary: "12 个候选 / 3 轮" });
    const events = body.pipeline_events as Array<{ stage: string }>;
    expect(events.map((e) => e.stage)).toEqual(expect.arrayContaining(["whole_proof", "enumerating", "planning", "solving", "complete"]));
  });

  it("can be disabled per request or by WHOLE_PROOF_ENABLED=false", async () => {
    await solve({ whole_proof: false });
    expect(wholeMock).not.toHaveBeenCalled();
    process.env.WHOLE_PROOF_ENABLED = "false";
    await solve();
    expect(wholeMock).not.toHaveBeenCalled();
    delete process.env.WHOLE_PROOF_ENABLED;
    await solve({ whole_proof_samples: 2, whole_proof_rounds: 0 });
    expect(wholeMock).toHaveBeenCalledTimes(1);
    expect(wholeMock.mock.calls[0][0].config).toMatchObject({ samples: 2, rounds: 0 });
  });
});

describe("theorem pipeline: multi-agent methods and metrics", () => {
  it("uses the strategists + critic and picks the recommended method when multi_agent is set", async () => {
    wholeMock.mockResolvedValue({ ok: false, unavailable: true, candidates: [], rounds: 1, samples: 1, suggestions: [], log: "", durationMs: 1 });
    orchestratorMock.mockResolvedValue({
      methods: [
        { id: "alg-1", category: "rewrite", title: "A", inspiration: "", pros: "", cons: "", lean_sketch: "", confidence: 0.5 },
        { id: "ind-1", category: "induction", title: "B", inspiration: "", pros: "", cons: "", lean_sketch: "", confidence: 0.9 },
      ],
      scores: [{ method_id: "alg-1", feasibility: 0.9, elegance: 0.5, lean_difficulty: 0.2, mathlib_coverage: 0.9, pedagogical_value: 0.5, composite: 0.8, rationale: "" }],
      recommended_method_id: "alg-1",
      comparison: "A is simpler",
    });
    const { status, body } = await solve({ multi_agent: true });
    expect(status).toBe(200);
    expect(orchestratorMock).toHaveBeenCalledWith(expect.objectContaining({ domain: "nat_arithmetic", formalStatement: `theorem problem ${TYPE}` }));
    // Recommended (not highest-confidence) method was selected and scores are returned.
    expect(body.method).toMatchObject({ id: "alg-1" });
    expect(body.recommended_method_id).toBe("alg-1");
    expect((body.method_scores as unknown[]).length).toBe(1);
    expect((body.methods as unknown[]).length).toBe(2);
    const session = getSession(body.session_id as string)!;
    expect(session.method_scores?.length).toBe(1);
    expect(session.selected_method_id).toBe("alg-1");
  });

  it("reports per-run metrics on the JSON route and the SSE result frame", async () => {
    wholeMock.mockImplementation(async () => {
      recordUsage({ model: "prover-x", role: "prover", promptTokens: 10, completionTokens: 5, totalTokens: 15, latencyMs: 3, timestamp: 1 });
      return { ok: false, unavailable: false, candidates: [], rounds: 1, samples: 1, suggestions: [], log: "", durationMs: 1 };
    });
    const { body } = await solve();
    const metrics = body.metrics as Record<string, unknown>;
    expect(metrics.llm_calls).toBe(1);
    expect(metrics.by_role).toMatchObject({ prover: { requests: 1, promptTokens: 10, completionTokens: 5 } });
    expect(metrics.lean_verifications).toBe(0); // verifier is mocked; only real verifications are counted
    expect(typeof metrics.wall_ms).toBe("number");

    const res = await STREAM(
      new Request("http://localhost/api/solve-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ problem_text: "证明 n + 0 = n" }),
      }),
    );
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const frames = text.split("\n\n").filter(Boolean).map((f) => JSON.parse(f.replace(/^data: /, "")) as Record<string, unknown>);
    const progress = frames.filter((f) => f.type === "progress").map((f) => f.stage);
    expect(progress).toEqual(expect.arrayContaining(["classifying", "nl_solving", "autoformalizing", "whole_proof", "enumerating", "planning", "solving", "complete"]));
    const resultFrame = frames.find((f) => f.type === "result")!;
    const data = resultFrame.data as Record<string, unknown>;
    expect(data.fully_verified).toBe(true);
    expect((data.metrics as Record<string, unknown>).llm_calls).toBe(1);
    expect((data.pipeline_events as unknown[]).length).toBeGreaterThan(3);
  });
});
