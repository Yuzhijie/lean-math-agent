import { afterAll, describe, expect, it } from "vitest";
import { refuteStatement } from "@/lib/lean/refute";
import { shutdownReplPool } from "@/lib/lean/repl";
import { leanStatus } from "./helpers/lean-env";

const lean = await leanStatus();
const describeLean = lean.canVerify ? describe : describe.skip;
const LEAN_TEST_TIMEOUT = Number(process.env.LEAN_BUILD_TIMEOUT_MS ?? 120_000) + 30_000;

afterAll(() => shutdownReplPool());

describeLean("refuteStatement (real Lean, decide probe)", { timeout: LEAN_TEST_TIMEOUT }, () => {
  const opts = { useMathlib: false, probes: ["decide" as const] };

  it("refutes a false bounded statement", async () => {
    const r = await refuteStatement("t", ": ∀ n < 5, n * n < 16", opts);
    expect(r.verdict).toBe("refuted");
    expect(r.method).toBe("decide");
  });

  it("refutes a false closed arithmetic claim", async () => {
    const r = await refuteStatement("t", ": 2 + 2 = 5", opts);
    expect(r.verdict).toBe("refuted");
  });

  it("confirms a true decidable statement, with binders as hypotheses", async () => {
    const r = await refuteStatement("t", "(n : Nat) (h : n < 5) : n * n < 20", opts);
    expect(r.verdict).toBe("confirmed");
  });

  it("is inconclusive on an unbounded quantifier", async () => {
    const r = await refuteStatement("t", "(n : Nat) : n - 1 + 1 = n", opts);
    expect(r.verdict).toBe("inconclusive");
    expect(r.detail).toContain("decide");
  });
});
