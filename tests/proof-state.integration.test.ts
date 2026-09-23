import { describe, it, expect, afterAll } from "vitest";
import { assembleLeanSource } from "@/lib/lean/assemble";
import { openTheorem, ProofSession } from "@/lib/lean/proof-state";
import { ReplError, shutdownReplPool } from "@/lib/lean/repl";
import { leanStatus } from "./helpers/lean-env";

// Tactic-mode sessions against the real REPL (core Lean, no Mathlib).
const lean = await leanStatus();
const describeLean = lean.canVerify && lean.repl ? describe : describe.skip;
const LEAN_TEST_TIMEOUT = Number(process.env.LEAN_BUILD_TIMEOUT_MS ?? 120_000) + 30_000;

afterAll(() => shutdownReplPool());

describeLean("ProofSession (real REPL)", { timeout: LEAN_TEST_TIMEOUT }, () => {
  it("opens a theorem, applies tactics incrementally and reports goals / completion", async () => {
    const source = assembleLeanSource({
      theoremName: "t",
      theoremType: "(p q : Prop) (hp : p) (hq : q) : p ∧ q",
      stepCodes: ["sorry"],
    });
    const opened = await openTheorem(source);
    expect(opened).toBeDefined();
    const { session, root } = opened!;
    try {
      expect(root.goal).toContain("⊢ p ∧ q");
      expect(root.line).toBe(2); // body line: theorem (1), sorry (2)

      const split = await session.apply(root.state, "constructor");
      expect(split.ok).toBe(true);
      if (!split.ok) return;
      expect(split.goals).toHaveLength(2);
      expect(split.solved).toBe(false);

      const wrong = await session.apply(split.state, "exact hq");
      expect(wrong.ok).toBe(false);
      if (wrong.ok) return;
      expect(wrong.error).toMatch(/type mismatch/i);

      const left = await session.apply(split.state, "exact hp");
      expect(left.ok && left.goals.length === 1).toBe(true);
      if (!left.ok) return;
      const done = await session.apply(left.state, "exact hq");
      expect(done.ok && done.solved).toBe(true);
      expect(session.path(done.ok ? done.state : 0)).toEqual(["constructor", "exact hp", "exact hq"]);
      // Branching from an earlier state still works (states are immutable).
      const alt = await session.apply(root.state, "exact ⟨hp, hq⟩");
      expect(alt.ok && alt.solved).toBe(true);
      // An admitted proof is not "solved".
      const admitted = await session.apply(root.state, "sorry");
      expect(admitted.ok && !admitted.solved).toBe(true);
      expect(session.tacticCount).toBe(6);
    } finally {
      session.close();
    }
  });

  it("exposes every hole of a sketch with its goal and position, and `exact?` suggestions", async () => {
    const source = assembleLeanSource({
      theoremName: "t",
      theoremType: "(n : Nat) : n + 0 = n ∧ 0 + n = n",
      stepCodes: ["constructor\n· sorry\n· sorry"],
    });
    const session = await ProofSession.open(source);
    try {
      expect(session.holes).toHaveLength(2);
      expect(session.holes[0].goal).toContain("⊢ n + 0 = n");
      expect(session.holes[1].goal).toContain("⊢ 0 + n = n");
      expect(session.holes[1].line).toBe(4);
      expect(session.holes[1].column).toBe(4);
      const r = await session.apply(session.holes[0].state, "exact?");
      expect(r.ok && r.solved).toBe(true);
      if (r.ok) expect(r.infos.join("\n")).toMatch(/Try this/);
      const r2 = await session.apply(session.holes[1].state, "simp");
      expect(r2.ok && r2.solved).toBe(true);
    } finally {
      session.close();
    }
  });

  it("rejects forbidden tactics without touching Lean and reports statement errors on open", async () => {
    const source = assembleLeanSource({ theoremName: "t", theoremType: "(n : Nat) : n = n", stepCodes: ["sorry"] });
    const { session, root } = (await openTheorem(source))!;
    try {
      const r = await session.apply(root.state, "run_tac evil");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/run_tac/);
    } finally {
      session.close();
    }
    // `m` is undeclared: with autoImplicit disabled this is an error, not a silent binder.
    const bad = assembleLeanSource({ theoremName: "t", theoremType: "(n : Nat) : n = m", stepCodes: ["sorry"] });
    await expect(ProofSession.open(bad)).rejects.toThrow(/unknown identifier 'm'|1:/);
  });
});
