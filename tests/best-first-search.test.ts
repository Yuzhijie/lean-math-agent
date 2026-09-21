import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LeanVerifyResult } from "@/lib/lean/sandbox";
import type { MethodOption, ProofStep, Session } from "@/lib/types";
import { PriorityQueue } from "@/lib/search/priority-queue";

const { candidatesMock, oneStepMock, verifyMock, trivialMock } = vi.hoisted(() => ({
  candidatesMock: vi.fn(),
  oneStepMock: vi.fn(),
  verifyMock: vi.fn(),
  trivialMock: vi.fn(),
}));

vi.mock("@/lib/llm/prove-step", () => ({
  proveStepCandidates: candidatesMock,
  proveOneStep: oneStepMock,
}));
vi.mock("@/lib/lean/sandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lean/sandbox")>();
  return { ...actual, verifyLeanSource: verifyMock };
});
vi.mock("@/lib/lean/trivial-proof", () => ({
  tryTrivialTactic: trivialMock,
}));

import { proofSearch } from "@/lib/search/proof-search";
import { proofLayout } from "@/lib/lean/feedback";

function result(partial: Partial<LeanVerifyResult>): LeanVerifyResult {
  return { ok: false, log: "fail", status: "fail", backend: "repl", messages: [], sorries: [], goals: [], infos: [], durationMs: 1, ...partial };
}
const okWithGoal = (goal?: string) => result({ ok: true, status: "ok", log: "ok", goals: goal ? [goal] : [], sorries: goal ? [{ line: 1, column: 0, goal }] : [] });
const failAt = (line: number, msg = "tactic failed") => result({ messages: [{ severity: "error", line, column: 2, message: msg }] });

function tactics(source: string): string[] {
  return proofLayout(source)!.bodyLines.map((l) => l.trim()).filter(Boolean);
}

const METHOD: MethodOption = { id: "m", category: "rewrite", title: "t", inspiration: "", pros: "", cons: "", lean_sketch: "", confidence: 0.9 };
function session(nSteps: number): Session {
  const steps: ProofStep[] = Array.from({ length: nSteps }, (_, i) => ({
    index: i,
    plain_goal: `g${i}`,
    lean_goal: `l${i}`,
    plain_explanation: "",
    lean_code: "",
    status: "pending",
  }));
  return {
    id: "s",
    problem_text: "p",
    pipeline_stage: "solving",
    formal_validated: true,
    validation_results: [],
    methods: [METHOD],
    theorem_name: "thm",
    theorem_type: "(n : ℕ) : n + 0 = n",
    steps,
    assembled_lean: "",
    build_status: "idle",
    sorry_labels: [],
    created_at: 0,
    updated_at: 0,
  };
}

beforeEach(() => {
  candidatesMock.mockReset();
  oneStepMock.mockReset();
  verifyMock.mockReset();
  trivialMock.mockReset();
  trivialMock.mockResolvedValue(null);
});

describe("PriorityQueue.prune", () => {
  it("keeps the best items and stays a valid heap", () => {
    const pq = new PriorityQueue<number>((a, b) => a - b);
    for (const n of [9, 2, 7, 4, 1, 8]) pq.push(n);
    pq.prune(3);
    expect(pq.size).toBe(3);
    expect([pq.pop(), pq.pop(), pq.pop()]).toEqual([1, 2, 4]);
    pq.prune(0);
    expect(pq.size).toBe(0);
  });
});

describe("best-first proof search", () => {
  it("samples k candidates per step, verifies them in parallel and branches on distinct goal states", async () => {
    // Step 0: two candidates leading to different goals; step 1: `omega` closes.
    candidatesMock.mockImplementation(async (args: { stepIndex: number; goalState?: string }) => {
      if (args.stepIndex === 0) {
        return [
          { plain_explanation: "a", lean_code: "intro n" },
          { plain_explanation: "b", lean_code: "simp only [Nat.add_zero]" },
          { plain_explanation: "c", lean_code: "intro n" }, // duplicate code
        ];
      }
      return [{ plain_explanation: "d", lean_code: "omega" }];
    });
    verifyMock.mockImplementation(async (_id: string, source: string, opts?: { allowSorry?: boolean }) => {
      const t = tactics(source);
      if (!opts?.allowSorry) return okWithGoal(); // final assembly
      if (t[0] === "intro n") return t.length > 2 ? okWithGoal() : okWithGoal("n : ℕ\n⊢ n + 0 = n");
      if (t[0] === "simp only [Nat.add_zero]") return t.length > 2 ? okWithGoal() : okWithGoal("⊢ ∀ (n : ℕ), n + 0 = n");
      return failAt(7);
    });

    const out = await proofSearch({
      session: session(2),
      method: METHOD,
      theoremType: "(n : ℕ) : n + 0 = n",
      config: { samplesPerStep: 3, maxQueueSize: 5, useMathlib: true },
      initialGoal: "⊢ ∀ (n : ℕ), n + 0 = n",
    });

    expect(out.fullyVerified).toBe(true);
    expect(out.steps.map((s) => s.status)).toEqual(["ok", "ok"]);
    expect(out.steps[1].lean_code).toBe("omega");
    // First expansion: one sampler call with n=3 and the initial goal state in the prompt args.
    expect(candidatesMock.mock.calls[0][0]).toMatchObject({ stepIndex: 0, n: 3, goalState: "⊢ ∀ (n : ℕ), n + 0 = n" });
    // Both distinct candidates were verified (parallel), the duplicate was not.
    const step0Sources = verifyMock.mock.calls.map((c) => tactics(c[1] as string)).filter((t) => t.length === 2 && t[1] === "sorry");
    expect(step0Sources.map((t) => t[0]).sort()).toEqual(["intro n", "simp only [Nat.add_zero]"]);
    // The child expanded next carried the goal state reported at its trailing sorry.
    const step1Call = candidatesMock.mock.calls.find((c) => c[0].stepIndex === 1)![0];
    expect(["n : ℕ\n⊢ n + 0 = n", "⊢ ∀ (n : ℕ), n + 0 = n"]).toContain(step1Call.goalState);
    expect(out.expansions).toBeGreaterThanOrEqual(2);
  });

  it("repairs sequentially from the best failure when no candidate verifies, feeding back the log", async () => {
    candidatesMock.mockResolvedValue([
      { plain_explanation: "a", lean_code: "rw [foo]" },
      { plain_explanation: "b", lean_code: "exact bar" },
    ]);
    oneStepMock.mockImplementation(async (args: { buildLog?: string; classifiedErrors?: unknown[] }) => {
      expect(args.buildLog).toBeDefined();
      expect(args.classifiedErrors).toBeDefined();
      return { plain_explanation: "fixed", lean_code: "simp" };
    });
    verifyMock.mockImplementation(async (_id: string, source: string) => {
      const t = tactics(source);
      if (t[0] === "simp") return okWithGoal();
      if (t[0] === "rw [foo]") return result({ log: "Verify.lean:7:2: error: unknown identifier 'foo'", messages: [{ severity: "error", line: 7, column: 2, message: "unknown identifier 'foo'" }] });
      return result({ log: "Verify.lean:7:2: error: type mismatch\nVerify.lean:7:8: error: x", messages: [{ severity: "error", line: 7, column: 2, message: "type mismatch" }, { severity: "error", line: 7, column: 8, message: "x" }] });
    });

    const out = await proofSearch({ session: session(1), method: METHOD, theoremType: "(n : ℕ) : n + 0 = n", config: { samplesPerStep: 2 } });
    expect(out.fullyVerified).toBe(true);
    expect(out.steps[0].lean_code).toBe("simp");
    expect(oneStepMock).toHaveBeenCalledTimes(1);
    // The repair started from the candidate with fewer errors (`rw [foo]`, one error).
    expect(oneStepMock.mock.calls[0][0].buildLog).toContain("unknown identifier 'foo'");
    expect(out.totalAttempts).toBe(3);
  });

  it("degrades to sorry within the budget and keeps the beam bounded", async () => {
    candidatesMock.mockResolvedValue([{ plain_explanation: "a", lean_code: "nope" }]);
    oneStepMock.mockResolvedValue({ plain_explanation: "a", lean_code: "nope" });
    verifyMock.mockImplementation(async (_id: string, source: string, opts?: { allowSorry?: boolean }) => {
      const t = tactics(source);
      // Final assembly containing a sorry step is rejected textually; step prefixes fail.
      if (!opts?.allowSorry) return result({ rejected: "source contains `sorry`", log: "sorry" });
      return t.some((x) => x === "sorry" && t.indexOf(x) < t.length - 1) ? okWithGoal("⊢ q") : failAt(7);
    });

    const out = await proofSearch({
      session: session(2),
      method: METHOD,
      theoremType: "(n : ℕ) : n + 0 = n",
      config: { samplesPerStep: 1, maxRetriesPerStep: 1, maxSorry: 2, maxQueueSize: 2, maxExpansions: 10 },
    });
    expect(out.fullyVerified).toBe(false);
    expect(out.sorryLabels.length).toBeGreaterThan(0);
    expect(out.steps.some((s) => s.status === "sorry")).toBe(true);
    expect(out.expansions).toBeLessThanOrEqual(10);
  });

  it("accepts candidates unverified when Lean is unavailable", async () => {
    candidatesMock.mockResolvedValue([{ plain_explanation: "a", lean_code: "simp" }]);
    verifyMock.mockResolvedValue(result({ status: "unavailable", log: "no lake" }));
    const out = await proofSearch({ session: session(1), method: METHOD, theoremType: "(n : ℕ) : n + 0 = n", config: { samplesPerStep: 1 } });
    expect(out.steps[0].status).toBe("ok");
    expect(out.steps[0].lean_code).toBe("simp");
    // No sorry was needed; the pipeline's final verification (unavailable) decides the verdict.
    expect(out.fullyVerified).toBe(true);
    expect(out.sorryLabels).toEqual([]);
  });
});
