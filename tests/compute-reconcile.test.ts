import { describe, expect, it, vi } from "vitest";
import { reconcileWithSolution, writtenAnswer } from "@/lib/compute/reconcile";

// The optimization search answers what the model extracted; the written solution is a second opinion.
describe("reconcileWithSolution", () => {
  it("reads the written answer from \\boxed{…}, or a short final answer", () => {
    expect(writtenAnswer("第二个图形中最多可以描出 $\\boxed{18}$ 个三角形。")).toBe("18");
    expect(writtenAnswer("18")).toBe("18");
    expect(writtenAnswer(undefined)).toBeUndefined();
  });

  it("agrees without a re-check when the answers match", async () => {
    const decide = vi.fn();
    const r = await reconcileWithSolution("p", "18", "答案是 $\\boxed{18}$", decide);
    expect(r).toMatchObject({ answer: "18", agreed: true, solutionStale: false });
    expect(decide).not.toHaveBeenCalled();
  });

  it("a disagreement is re-checked; the search's answer can lose", async () => {
    // "maximum number of triangles in the drawing" was extracted as "2 positive integers summing to 3" → 2.
    const decide = vi.fn(async () => "18");
    const r = await reconcileWithSolution("How many triangles…", "2", "最多可以描出 $\\boxed{18}$ 个三角形", decide);
    expect(decide).toHaveBeenCalledWith("How many triangles…", "2", "18");
    expect(r.answer).toBe("18");
    expect(r.agreed).toBe(false);
    expect(r.solutionStale).toBe(false);
    expect(r.check).toMatch(/2.*18.*18/);
  });

  it("when the re-check keeps the search's answer, the written solution must be rewritten", async () => {
    const r = await reconcileWithSolution("p", "7", "$\\boxed{9}$", async () => "7");
    expect(r).toMatchObject({ answer: "7", agreed: false, solutionStale: true });
  });

  it("keeps the search's answer when the re-check cannot decide", async () => {
    const r = await reconcileWithSolution("p", "7", "$\\boxed{9}$", async () => undefined);
    expect(r).toMatchObject({ answer: "7", agreed: false, solutionStale: true });
  });
});
