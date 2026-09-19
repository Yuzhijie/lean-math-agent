import { describe, it, expect } from "vitest";
import { verifyLeanSource } from "@/lib/lean/sandbox";
import { assembleLeanSource } from "@/lib/lean/assemble";
import { leanStatus } from "./helpers/lean-env";

// Needs a built Mathlib in the sandbox (skipped elsewhere, e.g. CI).
const lean = await leanStatus();
const describeMathlib = lean.canVerify && lean.mathlib ? describe : describe.skip;
/** The first `import Mathlib` in a REPL worker can take a minute or more. */
const LEAN_TEST_TIMEOUT =
  Number(process.env.LEAN_SERVER_STARTUP_MS ?? 180_000) +
  Number(process.env.LEAN_BUILD_TIMEOUT_MS ?? 120_000);

describeMathlib("Mathlib integration", { timeout: LEAN_TEST_TIMEOUT }, () => {
  it("compiles a simple proof with Mathlib import", async () => {
    const src = assembleLeanSource({
      theoremName: "mathlib_smoke",
      theoremType: "(n : ℕ) : n + 0 = n",
      stepCodes: ["rfl"],
      imports: ["Mathlib"],
    });
    // Verify the import line is present
    expect(src).toContain("import Mathlib");
    const res = await verifyLeanSource("mathlib-smoke", src);
    expect(res.status).toBe("ok");
    expect(res.ok).toBe(true);
  });

  it("compiles a proof using Mathlib lemmas", async () => {
    const src = assembleLeanSource({
      theoremName: "mathlib_add_comm",
      theoremType: "(n m : ℕ) : n + m = m + n",
      stepCodes: ["rw [Nat.add_comm]"],
      imports: ["Mathlib"],
    });
    const res = await verifyLeanSource("mathlib-add-comm", src);
    expect(res.status).toBe("ok");
    expect(res.ok).toBe(true);
  });

  it("still works without explicit imports (backward compat)", async () => {
    const src = assembleLeanSource({
      theoremName: "no_mathlib_ok",
      theoremType: "(n : Nat) : n + 0 = n",
      stepCodes: ["rfl"],
    });
    expect(src).not.toMatch(/^import /m);
    const res = await verifyLeanSource("no-mathlib", src);
    expect(res.status).toBe("ok");
  });

  it("compiles with Batteries import via useMathlib", async () => {
    const src = assembleLeanSource({
      theoremName: "batteries_smoke",
      theoremType: "(n : Nat) : n + 0 = n",
      stepCodes: ["rfl"],
      useMathlib: true,
    });
    expect(src).toContain("import Batteries");
    const res = await verifyLeanSource("batteries-smoke", src);
    expect(res.status).toBe("ok");
    expect(res.ok).toBe(true);
  });

  it("compiles with Aesop import via useMathlib", async () => {
    const src = assembleLeanSource({
      theoremName: "aesop_smoke",
      theoremType: "(n : Nat) : n + 0 = n",
      stepCodes: ["rfl"],
      useMathlib: true,
    });
    expect(src).toContain("import Aesop");
    const res = await verifyLeanSource("aesop-smoke", src);
    expect(res.status).toBe("ok");
    expect(res.ok).toBe(true);
  });

  it("includes all three imports when useMathlib is true", async () => {
    const src = assembleLeanSource({
      theoremName: "all_imports",
      theoremType: "(n : Nat) : n + 0 = n",
      stepCodes: ["rfl"],
      useMathlib: true,
    });
    expect(src).toContain("import Mathlib");
    expect(src).toContain("import Batteries");
    expect(src).toContain("import Aesop");
  });
});
