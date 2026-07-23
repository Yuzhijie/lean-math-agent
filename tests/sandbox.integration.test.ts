import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { checkLeanAvailable, verifyLeanSource } from "@/lib/lean/sandbox";
import { assembleLeanSource } from "@/lib/lean/assemble";

const lean = await checkLeanAvailable();
const describeLean = lean.ok ? describe : describe.skip;

describe("verifyLeanSource sorry gate", () => {
  it("fails before lake when source contains sorry (final verify)", async () => {
    const src = assembleLeanSource({
      theoremName: "problem",
      theoremType: "(n : Nat) : n + 0 = n",
      stepCodes: ["intro n"],
      appendSorry: true,
    });
    const res = await verifyLeanSource("sorry-gate", src);
    expect(res.ok).toBe(false);
    expect(res.status).toBe("fail");
    expect(res.log).toMatch(/sorry/i);
  });

  it("allows sorry when allowSorry is set (repair path)", async () => {
    if (!lean.ok) return;
    const src = assembleLeanSource({
      theoremName: "problem",
      theoremType: "(n : Nat) : n + 0 = n",
      stepCodes: [],
      appendSorry: true,
    });
    const res = await verifyLeanSource("sorry-allowed", src, {
      allowSorry: true,
    });
    expect(res.status).not.toBe("unavailable");
    expect(res.ok).toBe(true);
  });
});

describeLean("LeanSandbox integration", () => {
  it("accepts gold nat_add_zero proof", async () => {
    const gold = await fs.readFile(
      path.resolve("gold/nat_add_zero.lean"),
      "utf8",
    );
    const res = await verifyLeanSource("gold", gold);
    expect(res.status).toBe("ok");
    expect(res.ok).toBe(true);
  });

  it("rejects sorry-free bad proof", async () => {
    const src = assembleLeanSource({
      theoremName: "bad",
      theoremType: "(n : Nat) : n + 0 = n",
      stepCodes: ["exact absurd"],
    });
    const res = await verifyLeanSource("bad", src);
    expect(res.ok).toBe(false);
    expect(res.status).toBe("fail");
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
});
