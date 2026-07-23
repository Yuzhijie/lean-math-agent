import { describe, it, expect } from "vitest";
import { parseLeanLog } from "@/lib/lean/parse-log";

describe("parseLeanLog", () => {
  it("keeps error lines and drops noise", () => {
    const log = [
      "compiling...",
      "Scratch/Session_x.lean:12:4: error: unknown identifier 'rflf'",
      "warning: something mild",
    ].join("\n");
    const out = parseLeanLog(log);
    expect(out).toContain("error:");
    expect(out).toContain("rflf");
  });
});
