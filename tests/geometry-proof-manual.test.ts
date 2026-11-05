import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, getSession, _resetStoreForTests } from "@/lib/session-store";

vi.mock("@/lib/llm/nl-solution", () => ({
  generateNLSolution: vi.fn().mockResolvedValue({ summary: "证毕", steps: [{ title: "设坐标", content: "…" }], final_answer: "证毕" }),
  generateNLTheoremSolution: vi.fn(),
}));
const autoformalize = vi.fn();
vi.mock("@/lib/llm/autoformalize", () => ({ autoformalize: (...a: unknown[]) => autoformalize(...a), normalizeTheoremType: (t: string) => t }));

import { looksGeometryProblem, runTheoremPipeline } from "@/lib/pipeline/theorem-pipeline";

beforeEach(() => {
  _resetStoreForTests();
  autoformalize.mockReset();
});

const ALTITUDE = "设 $ABC$ 是锐角三角形，$AD\\perp BC$，垂足为 $D$。以 $AD$ 为直径作圆，证明 $PB/PC=(BD/DC)^2$。";

describe("geometry proofs: the Lean proof is a separate step", () => {
  it("tells geometry problems from others by their wording", () => {
    expect(looksGeometryProblem(ALTITUDE)).toBe(true);
    expect(looksGeometryProblem("In triangle ABC, prove that the medians meet at one point.")).toBe(true);
    expect(looksGeometryProblem("直线 l 与线段 AB 垂直，证明 …")).toBe(true);
    expect(looksGeometryProblem("证明：对任意正整数 n，n^3 - n 能被 6 整除。")).toBe(false);
    expect(looksGeometryProblem("证明 a^2 + b^2 ≥ 2ab，并说明等号何时成立。")).toBe(false);
  });

  it("one-click stops after the natural-language proof; the Lean tab starts the rest", async () => {
    const s = createSession(ALTITUDE);
    const events: string[] = [];
    const out = await runTheoremPipeline({ session: s, opts: {}, useMathlib: true, onEvent: (e) => events.push(e.stage) });
    expect(out.status).toBe(200);
    expect(out.body.nl_solution).toBeDefined();
    expect(out.body.lean_proof_attempt).toEqual({ attempted: false, success: false });
    expect(autoformalize).not.toHaveBeenCalled();
    const saved = getSession(s.id)!;
    expect(saved.proof_problem).toBe(true);
    expect(saved.pipeline_stage).toBe("complete");
    expect(events).toContain("complete");
  });

  it("asked for explicitly (lean_attempt), the whole pipeline runs", async () => {
    autoformalize.mockResolvedValue({ accepted: false, validation_results: [{ layer: 1, pass: false, detail: "x" }], theorem_name: "t", theorem_type: ": True" });
    const s = createSession(ALTITUDE);
    const out = await runTheoremPipeline({ session: s, opts: { lean_attempt: true }, useMathlib: true, onEvent: () => undefined });
    expect(autoformalize).toHaveBeenCalled();
    expect(out.status).toBe(422);
  });
});
