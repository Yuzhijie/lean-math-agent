import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { checkLeanAvailable, verifyLeanSource } from "@/lib/lean/sandbox";
import { assembleLeanSource } from "@/lib/lean/assemble";

const lean = await checkLeanAvailable();
const describeLean = lean.ok ? describe : describe.skip;

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
});
