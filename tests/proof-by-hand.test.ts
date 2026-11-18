import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, getSession, _resetStoreForTests } from "@/lib/session-store";

// A proof problem's solve is its natural-language proof; the Lean proof is a run of its own,
// started by hand from the Lean tab — for every proof problem, not only the geometry ones.

const { autoformalize, generateNLSolution, runProverStages } = vi.hoisted(() => ({
  autoformalize: vi.fn(),
  generateNLSolution: vi.fn(),
  runProverStages: vi.fn(),
}));

vi.mock("@/lib/llm/classify-problem", () => ({
  classifyProblem: vi.fn().mockResolvedValue({ problem_type: "theorem", confidence: 1, reasoning: "" }),
}));
vi.mock("@/lib/llm/nl-solution", () => ({ generateNLSolution, generateNLTheoremSolution: vi.fn() }));
vi.mock("@/lib/llm/autoformalize", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm/autoformalize")>()),
  autoformalize,
}));
vi.mock("@/lib/lean/prover-stages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/lean/prover-stages")>()),
  runProverStages,
}));

const { runsFormalProof, runTheoremPipeline } = await import("@/lib/pipeline/theorem-pipeline");
const { POST: solveStream } = await import("@/app/api/solve-stream/route");
const { POST: solve } = await import("@/app/api/solve/route");
const { POST: leanAttempt } = await import("@/app/api/lean-attempt/route");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proof-by-hand-"));
process.env.SESSION_STORE_PATH = dir;
afterAll(() => {
  delete process.env.SESSION_STORE_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  _resetStoreForTests();
  autoformalize.mockReset();
  autoformalize.mockResolvedValue({ accepted: false, validation_results: [{ layer: 1, pass: false, detail: "x" }], theorem_name: "t", theorem_type: ": True", formal_statement: "theorem t : True := by sorry" });
  generateNLSolution.mockReset();
  generateNLSolution.mockResolvedValue({ summary: "证毕", steps: [{ title: "放缩", content: "…" }], final_answer: "证毕" });
  runProverStages.mockReset();
});

/** The solve that showed it: 32 minutes, 50 model calls, through the stepwise search — in one click. */
const INEQUALITY = "设 $a,b,c$ 为正数，证明：$$\\frac{a^2}{a^2+ab+b^2}+\\frac{b^2}{b^2+bc+c^2}+\\frac{c^2}{c^2+ca+a^2}\\ge 1.$$ 并求等号成立的条件。";
const ALTITUDE = "设 $ABC$ 是锐角三角形，$AD\\perp BC$，垂足为 $D$。以 $AD$ 为直径作圆，证明 $PB/PC=(BD/DC)^2$。";
const DIVISIBILITY = "证明：对任意正整数 n，n^3 - n 能被 6 整除。";

const post = (body: unknown) => new Request("http://t/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function readStream(res: Response) {
  const frames = (await res.text())
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice(6)) as { type: string; stage?: string; detail?: string; data?: Record<string, unknown> });
  const progress = frames.filter((f) => f.type === "progress");
  return { stages: progress.map((f) => f.stage), details: progress.map((f) => f.detail ?? ""), result: frames.find((f) => f.type === "result")?.data };
}

/** Stages that belong to the formal proof: none of them may run in a solve that was not asked for it. */
const LEAN_STAGES = ["autoformalizing", "budget", "hammer", "trivial_proof", "inequality", "geometry", "auto", "retrieval", "memory", "whole_proof", "sketch", "preflight", "lean_attempting"];

describe("a proof problem: the Lean proof is a separate run", () => {
  it("goes on to the formal proof only when asked, or when the caller brings the statement", () => {
    expect(runsFormalProof({})).toBe(false);
    expect(runsFormalProof({ lean_attempt: false })).toBe(false);
    expect(runsFormalProof({ lean_attempt: true })).toBe(true);
    expect(runsFormalProof({ skip_autoformalize: true })).toBe(true);
  });

  it.each([
    ["an inequality", INEQUALITY],
    ["a geometry problem", ALTITUDE],
    ["a divisibility claim", DIVISIBILITY],
  ])("one click stops after the natural-language proof: %s", async (_kind, problem) => {
    const s = createSession(problem);
    const events: Array<{ stage: string; detail: string }> = [];
    const out = await runTheoremPipeline({ session: s, opts: {}, useMathlib: true, onEvent: (e) => events.push(e) });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ session_id: s.id, problem_type: "theorem", lean_proof_attempt: { attempted: false, success: false } });
    expect(out.body.nl_solution).toBeDefined();
    expect(autoformalize).not.toHaveBeenCalled();
    expect(runProverStages).not.toHaveBeenCalled();
    expect(events.map((e) => e.stage)).toEqual(["nl_solving", "nl_solving", "complete"]);
    expect(events[events.length - 1].detail).toContain("Lean 标签页");
    const saved = getSession(s.id)!;
    expect(saved.proof_problem).toBe(true);
    expect(saved.pipeline_stage).toBe("complete");
    expect(saved.lean_proof_attempt).toEqual({ attempted: false, success: false });
  });

  it("says so when no natural-language proof was produced", async () => {
    generateNLSolution.mockRejectedValue(new Error("model timeout"));
    const events: Array<{ stage: string; detail: string }> = [];
    const out = await runTheoremPipeline({ session: createSession(INEQUALITY), opts: {}, useMathlib: true, onEvent: (e) => events.push(e) });
    expect(out.status).toBe(200);
    expect(out.body.nl_solution).toBeUndefined();
    const last = events[events.length - 1];
    expect(last.stage).toBe("complete");
    expect(last.detail).toContain("没有生成");
    expect(last.detail).not.toContain("已给出");
    expect(autoformalize).not.toHaveBeenCalled();
  });

  it("asked for explicitly (lean_attempt), the whole pipeline runs in the same call", async () => {
    const s = createSession(INEQUALITY);
    const out = await runTheoremPipeline({ session: s, opts: { lean_attempt: true }, useMathlib: true, onEvent: () => undefined });
    expect(autoformalize).toHaveBeenCalledTimes(1);
    expect(out.status).toBe(422);
    expect(getSession(s.id)!.proof_problem).toBeUndefined();
  });

  it("a caller that brings the statement gets it proved, not the stop", async () => {
    const out = await runTheoremPipeline({ session: createSession(INEQUALITY), opts: { skip_autoformalize: true }, useMathlib: true, onEvent: () => undefined });
    // past the stop: the pipeline asks for the statement it was told to skip formalizing
    expect(out.status).toBe(400);
    expect(out.body.error).toContain("skip_autoformalize");
  });

  it("solve-stream ends without any Lean stage; /api/lean-attempt formalizes the claim itself", async () => {
    const { stages, details, result } = await readStream(await solveStream(post({ problem_text: INEQUALITY })));
    for (const stage of LEAN_STAGES) expect(stages).not.toContain(stage);
    expect(stages[stages.length - 1]).toBe("complete");
    expect(details[details.length - 1]).toContain("Lean 标签页");
    expect(result).toMatchObject({ problem_type: "theorem", lean_proof_attempt: { attempted: false, success: false } });
    expect(result?.nl_solution).toBeDefined();
    expect(autoformalize).not.toHaveBeenCalled();
    expect(runProverStages).not.toHaveBeenCalled();

    const sessionId = result!.session_id as string;
    expect(getSession(sessionId)?.proof_problem).toBe(true);
    const res = await leanAttempt(post({ session_id: sessionId }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lean_proof_attempt: { attempted: boolean; success: boolean; failure_reason?: string } };
    expect(body.lean_proof_attempt).toMatchObject({ attempted: true, success: false });
    expect(body.lean_proof_attempt.failure_reason).toBeTruthy();
    expect(autoformalize).toHaveBeenCalledTimes(1);
    // a claim to prove has no "answer found by solving": the claim itself is formalized
    const sent = autoformalize.mock.calls[0][0].problemText as string;
    expect(sent).toContain("证明");
    expect(sent).not.toContain("The answer found by solving");
    expect(getSession(sessionId)?.lean_proof_attempt?.attempted).toBe(true);
  });

  it("/api/solve leaves it to the user too", async () => {
    const res = await solve(post({ problem_text: DIVISIBILITY }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lean_proof_attempt: unknown; problem_type: string; pipeline_events: Array<{ stage: string }> };
    expect(body.problem_type).toBe("theorem");
    expect(body.lean_proof_attempt).toEqual({ attempted: false, success: false });
    for (const stage of LEAN_STAGES) expect(body.pipeline_events.map((e) => e.stage)).not.toContain(stage);
    expect(autoformalize).not.toHaveBeenCalled();
  });

  it("with options.lean_attempt the solve formalizes in the same call", async () => {
    const { stages } = await readStream(await solveStream(post({ problem_text: INEQUALITY, options: { lean_attempt: true } })));
    expect(stages).toContain("autoformalizing");
    expect(autoformalize).toHaveBeenCalledTimes(1);
  });
});
