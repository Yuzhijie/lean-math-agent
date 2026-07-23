import { describe, it, expect } from "vitest";
import { assembleLeanSource, LEAN_HEADER } from "@/lib/lean/assemble";

describe("assembleLeanSource", () => {
  it("prefixes fixed header and wraps steps in a theorem", () => {
    const src = assembleLeanSource({
      theoremName: "nat_add_zero",
      theoremType: "(n : Nat) : n + 0 = n",
      stepCodes: ["rfl"],
    });
    expect(src.startsWith(LEAN_HEADER)).toBe(true);
    expect(src).toContain("theorem nat_add_zero (n : Nat) : n + 0 = n := by");
    expect(src).toContain("rfl");
  });
});
