import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// Goal-level search and sketch-and-fill on the real REPL (core Lean),
// with the prover's tactic/sketch samples mocked.
const { sampleMock } = vi.hoisted(() => ({ sampleMock: vi.fn() }));
vi.mock("@/lib/llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/client")>();
  return { ...actual, sampleText: sampleMock };
});

import { assembleLeanSource } from "@/lib/lean/assemble";
import { openTheorem } from "@/lib/lean/proof-state";
import { shutdownReplPool } from "@/lib/lean/repl";
import { goalSearch, extractTactic } from "@/lib/search/goal-search";
import { proveBySketch, spliceHoles } from "@/lib/prover/sketch";
import { leanStatus } from "./helpers/lean-env";

const lean = await leanStatus();
const describeLean = lean.canVerify && lean.repl ? describe : describe.skip;
const LEAN_TEST_TIMEOUT = Number(process.env.LEAN_BUILD_TIMEOUT_MS ?? 120_000) + 60_000;

beforeEach(() => {
  sampleMock.mockReset();
});
afterAll(() => shutdownReplPool());

describe("extractTactic", () => {
  it("takes one tactic per sample, joining plain multi-line answers", () => {
    expect(extractTactic("```lean\nconstructor\n```")).toBe("constructor");
    expect(extractTactic("by exact hp")).toBe("exact hp");
    expect(extractTactic("`omega`")).toBe("omega");
    expect(extractTactic("intro x\nsimp [x]")).toBe("(intro x; simp [x])");
    expect(extractTactic("induction n with\n| zero => simp\n| succ k ih => simp [ih]")).toBe("induction n with");
    expect(extractTactic("sorry")).toBeUndefined();
    expect(extractTactic("-- no idea\n")).toBeUndefined();
  });
});

describe("spliceHoles", () => {
  it("aligns tactic blocks at the hole's column and wraps term-position holes", () => {
    const body = "theorem t : True ∧ True := by\n  constructor\n  · sorry\n  have h : 1 = 1 := by sorry\n  exact ⟨trivial, sorry⟩";
    const holes = [
      { state: 0, goal: "", line: 3, column: 4, endLine: 3, endColumn: 9 },
      { state: 1, goal: "", line: 4, column: 23, endLine: 4, endColumn: 28 },
      { state: 2, goal: "", line: 5, column: 18, endLine: 5, endColumn: 23 },
    ];
    const out = spliceHoles(body, holes, [["constructor", "trivial"], ["rfl"], ["simp", "trivial"]]);
    expect(out).toBe(
      "theorem t : True ∧ True := by\n  constructor\n  · constructor\n    trivial\n  have h : 1 = 1 := by rfl\n  exact ⟨trivial, (by simp; trivial)⟩",
    );
    expect(spliceHoles(body, holes, [["x"], [], ["y"]])).toBeUndefined();
  });
});

describeLean("goalSearch (real REPL)", { timeout: LEAN_TEST_TIMEOUT }, () => {
  it("finds a multi-step proof from sampled tactics, deduplicating by goal state", async () => {
    const type = "(p q : Prop) (hp : p) (hq : q) : p ∧ q";
    const source = assembleLeanSource({ theoremName: "t", theoremType: type, stepCodes: ["sorry"] });
    const { session, root } = (await openTheorem(source))!;
    sampleMock.mockImplementation(async (a: { messages: Array<{ content: string }> }) => {
      const user = a.messages[1].content;
      if (/⊢ p ∧ q/.test(user)) return ["constructor", "refine ⟨?_, ?_⟩", "exact hq", "constructor"];
      if (/⊢ p\n/.test(user) || /⊢ p$/.test(user)) return ["exact hp", "assumption"];
      return ["exact hq"];
    });
    try {
      const r = await goalSearch({
        session,
        rootState: root.state,
        theoremName: "t",
        theoremType: type,
        config: { useHammer: false, useMathlib: false, samplesPerNode: 4, maxNodes: 10 },
      });
      expect(r.ok).toBe(true);
      expect(r.tactics!.length).toBe(3);
      expect(r.tactics![0]).toMatch(/constructor|refine/);
      // `constructor` and `refine ⟨?_, ?_⟩` reach the same goals → one child.
      expect(r.log).toMatch(/child via `constructor`/);
      expect(r.log).not.toMatch(/child via `refine/);
      expect(r.expansions).toBeGreaterThanOrEqual(2);
      const proof = assembleLeanSource({ theoremName: "t", theoremType: type, stepCodes: [r.tactics!.join("\n")] });
      // Verify on the session's own worker (a one-worker pool would otherwise wait on itself).
      const v = await session.verify("goal-search", proof, { theoremName: "t" });
      expect(v.ok).toBe(true);
    } finally {
      session.close();
    }
  });

  it("closes a goal with the hammer without calling the model", async () => {
    const type = "(a b : Nat) (h : a ≤ b) : a ≤ b + 3";
    const source = assembleLeanSource({ theoremName: "t", theoremType: type, stepCodes: ["sorry"] });
    const { session, root } = (await openTheorem(source))!;
    try {
      const r = await goalSearch({ session, rootState: root.state, theoremName: "t", theoremType: type, config: { useMathlib: false } });
      expect(r.ok).toBe(true);
      expect(r.llmCalls).toBe(0);
      expect(r.hammerHits).toBe(1);
      expect(sampleMock).not.toHaveBeenCalled();
    } finally {
      session.close();
    }
  });

  it("gives up within the node budget when no tactic works", async () => {
    const type = "(p : Prop) : p";
    const source = assembleLeanSource({ theoremName: "t", theoremType: type, stepCodes: ["sorry"] });
    const { session, root } = (await openTheorem(source))!;
    sampleMock.mockResolvedValue(["exact trivial", "simp", "sorry"]);
    try {
      const r = await goalSearch({ session, rootState: root.state, theoremName: "t", theoremType: type, config: { useHammer: false, useMathlib: false, maxNodes: 3 } });
      expect(r.ok).toBe(false);
      expect(r.expansions).toBe(1); // frontier exhausted: nothing to expand after the root
      expect(r.log).toMatch(/frontier exhausted/);
    } finally {
      session.close();
    }
  });
});

describeLean("proveBySketch (real REPL)", { timeout: LEAN_TEST_TIMEOUT }, () => {
  it("elaborates a sketch, closes every hole and verifies the spliced proof strictly", async () => {
    const type = "(n : Nat) (h : n > 3) : n + 1 > 2 ∧ n * 1 = n";
    sampleMock.mockImplementation(async (a: { messages: Array<{ content: string }> }) => {
      const sys = a.messages[0].content;
      if (/PROOF SKETCH/.test(sys)) {
        return [
          `\`\`\`lean\ntheorem t ${type} := by\n  have h2 : n * 1 = n := by sorry\n  constructor\n  · sorry\n  · exact h2\n\`\`\``,
        ];
      }
      return ["omega"]; // tactic search fallback (not needed: the hammer closes both holes)
    });
    const r = await proveBySketch({
      sessionId: "sketch-test",
      theoremName: "t",
      theoremType: type,
      config: { samples: 1, repairs: 0, useMathlib: false, goalSearch: { useMathlib: false } },
    });
    expect(r.ok).toBe(true);
    expect(r.holes).toBe(2);
    expect(r.holesSolved).toBe(2);
    expect(r.verification?.ok).toBe(true);
    expect(r.source).toContain("have h2 : n * 1 = n := by ");
    expect(r.source).not.toContain("sorry");
    expect(r.tactics).toContain("constructor");
  });

  it("repairs a sketch that does not elaborate, using Lean's errors", async () => {
    const type = "(n : Nat) : n + 0 = n";
    let calls = 0;
    sampleMock.mockImplementation(async (a: { messages: Array<{ content: string }> }) => {
      calls++;
      const user = a.messages[1].content;
      if (/previous sketch did not elaborate/.test(user)) {
        expect(user).toMatch(/unknown identifier 'bogus'|bogus/);
        return [`\`\`\`lean\ntheorem t ${type} := by\n  sorry\n\`\`\``];
      }
      return [`\`\`\`lean\ntheorem t ${type} := by\n  have h : bogus n := by sorry\n  simp\n\`\`\``];
    });
    const r = await proveBySketch({
      sessionId: "sketch-repair",
      theoremName: "t",
      theoremType: type,
      config: { samples: 1, repairs: 1, useMathlib: false, goalSearch: { useMathlib: false } },
    });
    expect(calls).toBe(2);
    expect(r.ok).toBe(true);
    expect(r.sketches).toBe(2);
  });
});
