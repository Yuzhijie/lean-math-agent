import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { verifyLeanSource } from "@/lib/lean/sandbox";
import { assembleLeanSource } from "@/lib/lean/assemble";
import { leanStatus } from "./helpers/lean-env";

// Core-Lean integration (no Mathlib needed): runs wherever `lake` works.
const lean = await leanStatus();
const describeLean = lean.canVerify ? describe : describe.skip;
const LEAN_TEST_TIMEOUT = Number(process.env.LEAN_BUILD_TIMEOUT_MS ?? 120_000) + 30_000;

describe("verifyLeanSource sorry gate", () => {
  it("fails before Lean when source contains sorry (final verify)", async () => {
    const src = assembleLeanSource({
      theoremName: "problem",
      theoremType: "(n : Nat) : n + 0 = n",
      stepCodes: ["intro n"],
      appendSorry: true,
    });
    const res = await verifyLeanSource("sorry-gate", src);
    expect(res.ok).toBe(false);
    expect(res.status).toBe("fail");
    expect(res.backend).toBe("none");
    expect(res.log).toMatch(/sorry/i);
  });
});

describeLean("LeanSandbox integration (core Lean)", { timeout: LEAN_TEST_TIMEOUT }, () => {
  it("allows sorry when allowSorry is set and reports the remaining goal", async () => {
    const src = assembleLeanSource({
      theoremName: "problem",
      theoremType: "(n : Nat) : n + 0 = n",
      stepCodes: [],
      appendSorry: true,
    });
    const res = await verifyLeanSource("sorry-allowed", src, { allowSorry: true });
    expect(res.status).not.toBe("unavailable");
    expect(res.ok).toBe(true);
    if (res.backend === "repl") {
      expect(res.goals).toHaveLength(1);
      expect(res.goals[0]).toContain("⊢ n + 0 = n");
    }
  });

  it("accepts gold nat_add_zero proof with only standard axioms", async () => {
    const gold = await fs.readFile(path.resolve("gold/nat_add_zero.lean"), "utf8");
    const res = await verifyLeanSource("gold", gold, { theoremName: "nat_add_zero" });
    expect(res.status).toBe("ok");
    expect(res.ok).toBe(true);
    expect(res.axioms?.disallowed).toEqual([]);
    expect(res.signature).toBe("∀ (n : Nat), n + 0 = n");
  });

  it("rejects sorry-free bad proof with a positioned error", async () => {
    const src = assembleLeanSource({
      theoremName: "bad",
      theoremType: "(n : Nat) : n + 0 = n",
      stepCodes: ["exact absurd"],
    });
    const res = await verifyLeanSource("bad", src, { theoremName: "bad" });
    expect(res.ok).toBe(false);
    expect(res.status).toBe("fail");
    expect(res.messages.some((m) => m.severity === "error" && m.line >= 2)).toBe(true);
  });

  it("rejects empty-step final assembly (fail tactic)", async () => {
    const src = assembleLeanSource({
      theoremName: "empty",
      theoremType: "(n : Nat) : n + 0 = n",
      stepCodes: [],
    });
    expect(src).toMatch(/\bfail\b/);
    const res = await verifyLeanSource("empty", src);
    expect(res.ok).toBe(false);
    expect(res.status).toBe("fail");
  });

  it("catches `admit` hidden from the textual gate through the axiom check", async () => {
    // `admit` is rejected textually; simulate a proof term that elaborates
    // to sorry without the token: an error inside the proof also yields
    // sorryAx, so a partially broken proof cannot be reported as verified.
    const src = assembleLeanSource({
      theoremName: "hidden",
      theoremType: "(n : Nat) : n + 0 = n",
      stepCodes: ["exact (id absurd)"],
    });
    const res = await verifyLeanSource("hidden", src, { theoremName: "hidden" });
    expect(res.ok).toBe(false);
  });

  it("flags native_decide as a non-standard axiom", async () => {
    const src = assembleLeanSource({
      theoremName: "nd",
      theoremType: ": (2 : Nat) + 2 = 4",
      stepCodes: ["native_decide"],
    });
    const res = await verifyLeanSource("nd", src, { theoremName: "nd" });
    expect(res.status).toBe("fail");
    expect(res.axioms?.usesNative).toBe(true);
    expect(res.log).toMatch(/disallowed axioms/);
  });

  it("locks the statement against the validated signature", async () => {
    const src = assembleLeanSource({
      theoremName: "lock",
      theoremType: "(n : Nat) : n + 0 = n",
      stepCodes: ["rfl"],
    });
    const wrong = await verifyLeanSource("lock", src, {
      theoremName: "lock",
      expectedSignature: "∀ (n : Nat), 0 + n = n",
    });
    expect(wrong.ok).toBe(false);
    expect(wrong.signatureMatch).toBe(false);
    const right = await verifyLeanSource("lock-ok", src, {
      theoremName: "lock",
      expectedSignature: "∀ (n : Nat), n + 0 = n",
    });
    expect(right.ok).toBe(true);
    expect(right.signatureMatch).toBe(true);
  });

  it("refuses code-executing commands before Lean runs", async () => {
    const res = await verifyLeanSource("eval", 'theorem t : True := trivial\n#eval IO.println "pwned"');
    expect(res.ok).toBe(false);
    expect(res.backend).toBe("none");
    expect(res.rejected).toContain("#eval");
  });

  it("verifies several sources back to back quickly (env reuse)", async () => {
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) {
      const src = assembleLeanSource({
        theoremName: `fast_${i}`,
        theoremType: `(n : Nat) : n + ${i} = ${i} + n`,
        stepCodes: ["omega"],
      });
      const res = await verifyLeanSource(`fast-${i}`, src, { theoremName: `fast_${i}` });
      expect(res.ok).toBe(true);
    }
    // Only meaningful with the REPL; spawn mode pays a process start each time.
    if (lean.repl) expect(Date.now() - t0).toBeLessThan(LEAN_TEST_TIMEOUT);
  });
});
