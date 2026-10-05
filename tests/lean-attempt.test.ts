import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetStoreForTests, getSession } from "@/lib/session-store";
import { shouldAutoAttemptLean } from "@/lib/pipeline/lean-attempt";

// The last solving step (Lean formalization of a solved computational
// problem) is no longer run automatically; it is started by hand.

const { autoformalize } = vi.hoisted(() => ({
  autoformalize: vi.fn(),
}));

vi.mock("@/lib/llm/classify-problem", () => ({
  classifyProblem: vi.fn().mockResolvedValue({ problem_type: "computational", confidence: 1, reasoning: "" }),
}));
vi.mock("@/lib/compute/solver", () => ({
  solveComputational: vi.fn().mockResolvedValue({
    answer: "4",
    answer_exact: "4",
    answer_decimal: 4,
    cross_validated: true,
    confidence: 1,
    methods_used: ["sympy"],
    solution_steps: ["2 + 2 = 4"],
    method_results: [],
  }),
}));
vi.mock("@/lib/llm/nl-solution", () => ({
  generateNLSolution: vi.fn().mockResolvedValue({ summary: "4", steps: [{ title: "Add", content: "2 + 2 = 4" }], answer: "4" }),
}));
vi.mock("@/lib/llm/autoformalize", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm/autoformalize")>()),
  autoformalize,
}));

const { POST: solveStream } = await import("@/app/api/solve-stream/route");
const { POST: solve } = await import("@/app/api/solve/route");
const { POST: leanAttempt } = await import("@/app/api/lean-attempt/route");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lean-attempt-"));
process.env.SESSION_STORE_PATH = dir;
afterAll(() => {
  delete process.env.SESSION_STORE_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  _resetStoreForTests();
  autoformalize.mockReset();
  autoformalize.mockResolvedValue({
    theorem_name: "problem",
    theorem_type: ": 2 + 2 = 4",
    formal_statement: "theorem problem : 2 + 2 = 4 := by sorry",
    validation_results: [{ layer: 1, pass: false, detail: "trivial" }],
    accepted: false,
  });
});

const post = (body: unknown) => new Request("http://t/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function readStream(res: Response) {
  const text = await res.text();
  const frames = text
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice(6)) as { type: string; stage?: string; data?: Record<string, unknown> });
  return { stages: frames.filter((f) => f.type === "progress").map((f) => f.stage), result: frames.find((f) => f.type === "result")?.data };
}

describe("Lean formalization is started by hand", () => {
  it("is off unless requested", () => {
    expect(shouldAutoAttemptLean({})).toBe(false);
    expect(shouldAutoAttemptLean({ lean_attempt: true })).toBe(true);
    expect(shouldAutoAttemptLean({ lean_attempt: true, skip_lean_attempt: true })).toBe(false);
  });

  it("solve-stream ends without the Lean step; /api/lean-attempt runs it once", async () => {
    const { stages, result } = await readStream(await solveStream(post({ problem_text: "What is 2 + 2?" })));
    expect(stages).not.toContain("lean_attempting");
    expect(stages[stages.length - 1]).toBe("complete");
    expect(result?.lean_proof_attempt).toEqual({ attempted: false, success: false });
    expect(autoformalize).not.toHaveBeenCalled();

    const sessionId = result!.session_id as string;
    const res = await leanAttempt(post({ session_id: sessionId }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lean_proof_attempt: { attempted: boolean; success: boolean; failure_reason?: string } };
    expect(body.lean_proof_attempt).toMatchObject({ attempted: true, success: false });
    expect(body.lean_proof_attempt.failure_reason).toBeTruthy();
    expect(autoformalize).toHaveBeenCalledTimes(1);
    expect(getSession(sessionId)?.lean_proof_attempt?.attempted).toBe(true);

    // Already attempted: returned as stored, not run again.
    await leanAttempt(post({ session_id: sessionId }));
    expect(autoformalize).toHaveBeenCalledTimes(1);
  });

  it("still runs automatically when the caller asks for it", async () => {
    const { stages } = await readStream(await solveStream(post({ problem_text: "What is 2 + 2?", options: { lean_attempt: true } })));
    expect(stages).toContain("lean_attempting");
    expect(autoformalize).toHaveBeenCalledTimes(1);
  });

  it("/api/solve also leaves it to the user", async () => {
    const res = await solve(post({ problem_text: "What is 2 + 2?" }));
    const body = (await res.json()) as { lean_proof_attempt: unknown };
    expect(body.lean_proof_attempt).toEqual({ attempted: false, success: false });
    expect(autoformalize).not.toHaveBeenCalled();
  });

  it("rejects a missing or unknown session", async () => {
    expect((await leanAttempt(post({}))).status).toBe(400);
    expect((await leanAttempt(post({ session_id: "nope" }))).status).toBe(404);
  });
});
