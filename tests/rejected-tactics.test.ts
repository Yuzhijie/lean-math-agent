import { describe, expect, it, vi } from "vitest";

const verifyLeanSource = vi.hoisted(() => vi.fn());
vi.mock("@/lib/lean/sandbox", () => ({ verifyLeanSource }));

import { rejectedTactics } from "@/lib/lean/rejected-tactics";
import { tryTrivialProof } from "@/lib/lean/trivial-proof";
import type { HammerAttempt } from "@/lib/lean/hammer";

const failed = (tactic: string, error: string): HammerAttempt => ({ tactic, ok: false, solved: false, goalsLeft: -1, error, ms: 1 });

describe("what the single tactics need not try again", () => {
  it("the plain tactics Lean rejected outright in the cascade — not those a limit stopped, not compound ones", () => {
    const r = rejectedTactics([
      failed("rfl", "Tactic `rfl` failed: The left-hand side"),
      failed("decide", "maximum recursion depth has been reached"),
      failed("decide +kernel", "tactic timed out after 60000ms"),
      failed("(intros; simp)", "`simp` made no progress"),
      failed("(intros; omega)", "omega could not prove the goal:"),
      failed("(intros; norm_num)", "(deterministic) timeout at `whnf`, maximum number of heartbeats (200000) has been reached"),
      failed("(intros; (norm_num; omega))", "omega could not prove the goal:"),
      failed("(intros; nlinarith [sq_nonneg (a - b)])", "linarith failed to find a contradiction"),
      failed("aesop", "the Lean worker died twice while running this tactic (out of memory?)"),
      { tactic: "simp_all", ok: true, solved: false, goalsLeft: 1, ms: 1 },
    ]);
    expect([...r].sort()).toEqual(["decide", "omega", "rfl", "simp"]);
  });

  it("are skipped; the others are still verified as whole proofs", async () => {
    verifyLeanSource.mockResolvedValue({ ok: false, status: "error", log: "" });
    await tryTrivialProof("s", "t", ": 1 = 1", true, { skip: new Set(["rfl", "simp", "omega", "decide", "norm_num", "aesop", "simp_all"]) });
    const tried = verifyLeanSource.mock.calls.map((c) => (c[1] as string).trim().split("\n").pop()!.trim());
    expect(tried).toEqual(["trivial", "decide +kernel", "ring", "linarith"]);
  });
});
