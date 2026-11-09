import { beforeEach, describe, expect, it, vi } from "vitest";

const { geo, ind, opt, comb, auto } = vi.hoisted(() => ({ geo: vi.fn(), ind: vi.fn(), opt: vi.fn(), comb: vi.fn(), auto: vi.fn() }));
vi.mock("@/lib/lean/geometry", async (orig) => ({ ...(await orig<typeof import("@/lib/lean/geometry")>()), geometryProof: geo }));
vi.mock("@/lib/lean/induction", async (orig) => ({ ...(await orig<typeof import("@/lib/lean/induction")>()), inductionProof: ind }));
vi.mock("@/lib/lean/optimize", async (orig) => ({ ...(await orig<typeof import("@/lib/lean/optimize")>()), optimizationProof: opt }));
vi.mock("@/lib/lean/combinatorics", async (orig) => ({ ...(await orig<typeof import("@/lib/lean/combinatorics")>()), combinatoricsProof: comb }));
vi.mock("@/lib/lean/auto", async (orig) => ({ ...(await orig<typeof import("@/lib/lean/auto")>()), autoProof: auto }));

import { holeProversFor, programHoleProof } from "@/lib/prover/program-holes";

beforeEach(() => {
  for (const m of [geo, ind, opt, comb, auto]) m.mockReset().mockResolvedValue({ reason: "no" });
});

describe("program provers on a sketch hole", () => {
  it("routes a plain inequality to the tactic search only", async () => {
    const st = "(a b : ℝ) (ha : 0 < a) (hb : 0 < b) : 2 * (a * b) ≤ a ^ 2 + b ^ 2";
    expect(holeProversFor(st)).toEqual(["auto"]);
    auto.mockResolvedValue({ proof: { tactics: "nlinarith [sq_nonneg (a - b)]" }, reason: "" });
    const r = await programHoleProof({ sessionId: "s", theoremName: "t_hole1", statement: st, useMathlib: true, budgetMs: 60_000, opens: ["Real"] });
    expect(r).toMatchObject({ prover: "auto", tactics: "nlinarith [sq_nonneg (a - b)]" });
    expect(auto.mock.calls[0][0]).toMatchObject({ theoremName: "t_hole1", theoremType: st, opens: ["Real"] });
    expect(auto.mock.calls[0][0].timeLimitMs).toBeLessThanOrEqual(60_000);
    expect(geo).not.toHaveBeenCalled();
  });

  it("tries the provers that fit in order, sharing the budget, and survives one that throws", async () => {
    const st = "(s : Finset ℕ) (h : s = Finset.range 5) : s.card = 5";
    expect(holeProversFor(st)).toEqual(["induction", "combinatorics", "auto"]);
    comb.mockRejectedValue(new Error("boom\nmore"));
    const r = await programHoleProof({ sessionId: "s", theoremName: "t_hole2", statement: st, useMathlib: true, budgetMs: 60_000 });
    expect(r).toBeUndefined();
    expect(ind).toHaveBeenCalledTimes(1);
    expect(comb).toHaveBeenCalledTimes(1);
    expect(ind.mock.invocationCallOrder[0]).toBeLessThan(comb.mock.invocationCallOrder[0]);
    expect(auto).toHaveBeenCalledTimes(1);
  });

  it("gives up when the budget is too small to start a prover", async () => {
    const r = await programHoleProof({ sessionId: "s", theoremName: "t", statement: "(x : ℝ) : 0 ≤ x ^ 2", useMathlib: true, budgetMs: 1_000 });
    expect(r).toBeUndefined();
    expect(auto).not.toHaveBeenCalled();
  });
});
