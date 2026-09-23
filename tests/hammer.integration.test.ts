import { describe, it, expect, afterAll } from "vitest";
import { assembleLeanSource } from "@/lib/lean/assemble";
import { hammer, hammerTheorem } from "@/lib/lean/hammer";
import { openTheorem } from "@/lib/lean/proof-state";
import { shutdownReplPool } from "@/lib/lean/repl";
import { verifyLeanSource } from "@/lib/lean/sandbox";
import { leanStatus } from "./helpers/lean-env";

const lean = await leanStatus();
const describeLean = lean.canVerify && lean.repl ? describe : describe.skip;
const LEAN_TEST_TIMEOUT = Number(process.env.LEAN_BUILD_TIMEOUT_MS ?? 120_000) + 30_000;

afterAll(() => shutdownReplPool());

describeLean("hammer (real REPL, core Lean)", { timeout: LEAN_TEST_TIMEOUT }, () => {
  it("closes an arithmetic goal with a cheap decision procedure and the result verifies strictly", async () => {
    const source = assembleLeanSource({ theoremName: "t", theoremType: "(a b : Nat) (h : a ≤ b) : a ≤ b + 3", stepCodes: ["sorry"] });
    const hit = await hammerTheorem(source, { useMathlib: false });
    expect(hit).toBeDefined();
    expect(["omega", "simp_all", "simp", "(intros; omega)"]).toContain(hit!.tactic);
    const proof = assembleLeanSource({ theoremName: "t", theoremType: "(a b : Nat) (h : a ≤ b) : a ≤ b + 3", stepCodes: [hit!.tactic] });
    const v = await verifyLeanSource("hammer-verify", proof, { theoremName: "t" });
    expect(v.ok).toBe(true);
  });

  it("falls through to exact? and reports the concrete suggestion", async () => {
    const source = assembleLeanSource({
      theoremName: "t",
      theoremType: "(f : Nat → Nat) (a b : Nat) (h : a = b) : f a = f b",
      stepCodes: ["sorry"],
    });
    const opened = (await openTheorem(source))!;
    try {
      const out = await hammer(opened.session, opened.root.state, { useMathlib: false, tactics: ["omega", "exact?"] });
      expect(out.solved).toBe(true);
      expect(out.tactic).not.toBe("exact?");
      expect(out.tactic).toMatch(/^exact /);
      expect(out.attempts[0]).toMatchObject({ tactic: "omega", ok: false });
    } finally {
      opened.session.close();
    }
  });

  it("reports partial progress (fewer goals) when nothing closes everything", async () => {
    const source = assembleLeanSource({
      theoremName: "t",
      theoremType: "(p : Prop) (n : Nat) (hp : p) : n + 0 = n ∧ p",
      stepCodes: ["sorry"],
    });
    const opened = (await openTheorem(source))!;
    try {
      const split = await opened.session.apply(opened.root.state, "constructor");
      expect(split.ok && split.goals.length === 2).toBe(true);
      const out = await hammer(opened.session, split.ok ? split.state : 0, { useMathlib: false, tactics: ["omega", "decide"] });
      expect(out.solved).toBe(false);
      // omega closes the first goal, leaving `p`.
      expect(out.progressed?.tactic).toBe("omega");
      expect(out.progressed?.goals).toHaveLength(1);
    } finally {
      opened.session.close();
    }
  });
});
