import { beforeEach, describe, expect, it, vi } from "vitest";
import { latexNat, multiplicativeOrder, orderCheck, readCongruences } from "@/lib/compute/order-check";

const PROBLEM = "求满足下列同余式的最小正整数 $n$：\n$$\n2^n\\equiv 1\\pmod{3^5\\cdot 5^3},\\qquad 3^n\\equiv 1\\pmod{2^8\\cdot 7^2}.\n$$";

describe("orderCheck", () => {
  it("reads LaTeX moduli and computes orders", () => {
    expect(latexNat("3^5\\cdot 5^3")).toBe(30375n);
    expect(latexNat("2^{8}\\times 7^2")).toBe(12544n);
    expect(multiplicativeOrder(2n, 243n)).toBe(162n);
    expect(multiplicativeOrder(2n, 125n)).toBe(100n);
    expect(multiplicativeOrder(3n, 256n)).toBe(64n);
    expect(multiplicativeOrder(3n, 49n)).toBe(42n);
    expect(multiplicativeOrder(2n, 4n)).toBeUndefined();
  });

  it("gives the smallest n for the congruence problem (907200, not 1814400)", () => {
    const r = orderCheck(PROBLEM)!;
    expect(r.orders).toEqual([8100n, 1344n]);
    expect(r.answer).toBe(907200n);
  });

  it("reads plain-text congruences and leaves other questions alone", () => {
    expect(orderCheck("Find the smallest positive integer n such that 2^n ≡ 1 (mod 7).")?.answer).toBe(3n);
    expect(orderCheck("Find the smallest positive integer n such that 2^n ≡ 3 (mod 7).")).toBeUndefined();
    expect(orderCheck("求 2^n ≡ 1 (mod 7) 的所有正整数解")).toBeUndefined();
    expect(readCongruences("2^n \\equiv 1 \\pmod{7}, 3^m \\equiv 1 \\pmod{5}")).toBeUndefined();
    expect(orderCheck("求最小正整数 n 使 2^n ≡ 1 (mod 6)")?.impossible).toBeTruthy();
  });
});

// ── In the solver: the program's answer wins, conflicts are reported ──

const chatJson = vi.hoisted(() => vi.fn());
vi.mock("@/lib/llm/client", async (orig) => ({ ...(await orig<typeof import("@/lib/llm/client")>()), chatJson }));
vi.mock("@/lib/llm/equation-setup", () => ({
  setupEquations: vi.fn().mockResolvedValue({ variables: [], equations: [], constraints: [], target_expression: "n", target_description: "n", solution_methods: [] }),
}));

const { solveComputational, sameAnswer, boxedAnswer } = await import("@/lib/compute/solver");

beforeEach(() => {
  chatJson.mockReset();
  delete process.env.COMPUTE_ENGINE_URL;
});

describe("solveComputational checks", () => {
  it("corrects a model answer with the exact computation", async () => {
    chatJson.mockImplementation(async (o: { schemaName: string }) =>
      o.schemaName === "llmFallbackSolve"
        ? { valid_roots: [], extraneous_roots: [], final_answer: "1814400", final_answer_decimal: "1814400", verification_details: "x" }
        : { steps: ["lcm = 907200", "$$\\boxed{907200}$$"] },
    );
    const r = await solveComputational({ problemText: PROBLEM });
    expect(r.answer).toBe("907200");
    expect(r.cross_validated).toBe(true);
    expect(r.methods_used).toContain("order_lcm");
    expect(r.checks[0]).toMatch(/1814400/);
  });

  it("re-checks when the explanation ends with a different answer", async () => {
    chatJson.mockImplementation(async (o: { schemaName: string }) =>
      o.schemaName === "llmFallbackSolve"
        ? { valid_roots: [], extraneous_roots: [], final_answer: "12", final_answer_decimal: "12", verification_details: "x" }
        : o.schemaName === "answerConflict"
          ? { answer: "10", reason: "checked" }
          : { steps: ["so the answer is $\\boxed{10}$"] },
    );
    const r = await solveComputational({ problemText: "How many apples are left?" });
    expect(r.answer).toBe("10");
    expect(r.cross_validated).toBe(false);
    expect(r.checks[0]).toMatch(/12.*10/);
  });

  it("treats equal answers in other notation as the same", () => {
    expect(sameAnswer("14/5", "\\frac{14}{5}")).toBe(true);
    expect(sameAnswer("2.8", "\\dfrac{14}{5}")).toBe(true);
    expect(sameAnswer("907,200", "907200")).toBe(true);
    expect(sameAnswer("907200", "1814400")).toBe(false);
    expect(boxedAnswer(["a", "最终答案为 $$\\boxed{\\frac{1}{2}}.$$"])).toBe("\\frac{1}{2}");
  });
});
