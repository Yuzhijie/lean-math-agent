import { describe, it, expect, beforeEach } from "vitest";
import {
  clearVerificationCache,
  verificationCacheSize,
} from "@/lib/lean/sandbox";

// The verification cache is module-level in sandbox.ts.
// We test its exports directly — cache hits avoid Lean compilation.

describe("verification cache", () => {
  beforeEach(() => {
    clearVerificationCache();
  });

  it("starts empty", () => {
    expect(verificationCacheSize()).toBe(0);
  });

  it("clear resets cache to zero", () => {
    clearVerificationCache();
    expect(verificationCacheSize()).toBe(0);
  });

  it("clear is idempotent", () => {
    clearVerificationCache();
    clearVerificationCache();
    expect(verificationCacheSize()).toBe(0);
  });
});
