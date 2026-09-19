import { describe, it, expect } from "vitest";
import { ComputeEngine } from "@/lib/compute/engine";

describe("ComputeEngine", () => {
  it("creates engine without COMPUTE_ENGINE_URL", () => {
    const engine = new ComputeEngine();
    expect(engine).toBeTruthy();
  });

  it("reports unavailable when no URL set", async () => {
    const engine = new ComputeEngine();
    const available = await engine.isAvailable();
    expect(available).toBe(false);
  });

  it("returns fallback result when unavailable", async () => {
    const engine = new ComputeEngine();
    const result = await engine.evaluate("1 + 1");
    expect(result.engine).toBe("llm_fallback");
  });

  it("returns original expression when simplify unavailable", async () => {
    const engine = new ComputeEngine();
    const result = await engine.simplify("x^2 + 2x + 1");
    expect(result).toBe("x^2 + 2x + 1");
  });

  it("returns null when verify unavailable", async () => {
    const engine = new ComputeEngine();
    const result = await engine.verify("1 + 1 = 2");
    expect(result).toBeNull();
  });
});
