import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatRecalledProofs,
  proofMemorySize,
  recallProofs,
  rememberProof,
  resetProofMemoryCache,
} from "@/lib/lean/proof-memory";
import { buildProverContext, rememberVerifiedProof } from "@/lib/prover/context";

let dir: string;
const saved = { memory: process.env.PROOF_MEMORY_PATH, index: process.env.PREMISE_INDEX_PATH };

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "proof-memory-"));
  process.env.PROOF_MEMORY_PATH = path.join(dir, "memory.json");
  process.env.PREMISE_INDEX_PATH = path.join(dir, "no-index.json");
  delete process.env.PROOF_MEMORY_ENABLED;
  resetProofMemoryCache();
});

afterEach(async () => {
  if (saved.memory === undefined) delete process.env.PROOF_MEMORY_PATH;
  else process.env.PROOF_MEMORY_PATH = saved.memory;
  if (saved.index === undefined) delete process.env.PREMISE_INDEX_PATH;
  else process.env.PREMISE_INDEX_PATH = saved.index;
  delete process.env.PROOF_MEMORY_ENABLED;
  delete process.env.PROOF_MEMORY_MAX;
  resetProofMemoryCache();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("proof memory", () => {
  it("stores verified proofs and recalls the most similar ones", async () => {
    await rememberProof({ theoremName: "t1", theoremType: "(a b : ℝ) : a * b ≤ (a ^ 2 + b ^ 2) / 2", tactics: "nlinarith [sq_nonneg (a - b)]", strategy: "whole_proof" });
    await rememberProof({ theoremName: "t2", theoremType: "(n : ℕ) : Even (n * (n + 1))", tactics: "exact Nat.even_mul_succ_self n", strategy: "hammer" });
    await rememberProof({ theoremName: "t3", theoremType: "(p : ℕ) (hp : Nat.Prime p) : 2 ≤ p", tactics: "exact hp.two_le" });
    expect(await proofMemorySize()).toBe(3);

    // A fresh process would read the file: drop the cache first.
    resetProofMemoryCache();
    const hits = await recallProofs({ theoremType: "(x y : ℝ) : x * y ≤ (x ^ 2 + y ^ 2) / 2", k: 2 });
    expect(hits[0].theorem_name).toBe("t1");
    expect(hits.length).toBeLessThanOrEqual(2);
    const block = formatRecalledProofs(hits);
    expect(block).toContain("theorem t1 (a b : ℝ)");
    expect(block).toContain("  nlinarith [sq_nonneg (a - b)]");
  });

  it("replaces a proof of the same statement, keeping the shorter script", async () => {
    await rememberProof({ theoremName: "t", theoremType: "(n : ℕ) : n + 0 = n", tactics: "simp only [Nat.add_zero]" });
    await rememberProof({ theoremName: "t", theoremType: "(n : ℕ) :  n + 0 = n", tactics: "rfl" });
    await rememberProof({ theoremName: "t", theoremType: "(n : ℕ) : n + 0 = n", tactics: "simp; rfl; trivial" });
    expect(await proofMemorySize()).toBe(1);
    const [only] = await recallProofs({ theoremType: "(m : ℕ) : m + 0 = m" });
    expect(only.tactics).toBe("rfl");
  });

  it("ignores empty or sorry scripts and honours the size cap", async () => {
    expect(await rememberProof({ theoremName: "a", theoremType: "True", tactics: "  " })).toBeUndefined();
    expect(await rememberProof({ theoremName: "a", theoremType: "True", tactics: "sorry" })).toBeUndefined();
    process.env.PROOF_MEMORY_MAX = "2";
    for (let i = 0; i < 4; i++) {
      await rememberProof({ theoremName: `t${i}`, theoremType: `(n : ℕ) : n + ${i} = ${i} + n`, tactics: "omega" });
    }
    expect(await proofMemorySize()).toBe(2);
  });

  it("excludes the theorem being proved and can be disabled", async () => {
    await rememberProof({ theoremName: "same", theoremType: "(n : ℕ) : n ≤ n + 1", tactics: "omega" });
    expect(await recallProofs({ theoremType: "(n : ℕ) : n ≤ n + 1", excludeType: "(n : ℕ) : n ≤ n + 1" })).toEqual([]);
    process.env.PROOF_MEMORY_ENABLED = "false";
    expect(await recallProofs({ theoremType: "(n : ℕ) : n ≤ n + 1" })).toEqual([]);
    expect(await rememberProof({ theoremName: "x", theoremType: "(n : ℕ) : n ≤ n + 2", tactics: "omega" })).toBeUndefined();
  });

  it("survives a corrupt file", async () => {
    await fs.writeFile(process.env.PROOF_MEMORY_PATH!, "{not json");
    expect(await proofMemorySize()).toBe(0);
    expect(await rememberProof({ theoremName: "x", theoremType: "(n : ℕ) : n ≤ n + 2", tactics: "omega" })).toBeDefined();
    expect(await proofMemorySize()).toBe(1);
  });
});

describe("buildProverContext", () => {
  it("combines retrieved premises and recalled proofs into one block", async () => {
    await rememberVerifiedProof({ theoremName: "prev", theoremType: "(x : ℝ) (hx : 0 < x) : Real.log x ≤ x - 1", tactics: "exact Real.log_le_sub_one_of_pos hx", strategy: "hammer" });
    const ctx = await buildProverContext({
      theoremType: "(y : ℝ) (hy : 0 < y) : Real.log y < y",
      initialGoal: "y : ℝ\nhy : 0 < y\n⊢ Real.log y < y",
      useMathlib: true,
    });
    expect(ctx.premises.some((p) => p.name.startsWith("Real.log_"))).toBe(true);
    expect(ctx.recalled.map((r) => r.theorem_name)).toEqual(["prev"]);
    expect(ctx.block).toContain("Possibly relevant Mathlib lemmas");
    expect(ctx.block).toContain("Verified proofs of similar theorems");
    expect(ctx.block).toContain("theorem prev (x : ℝ)");
  });

  it("is empty without Mathlib and with retrieval disabled", async () => {
    process.env.PREMISES_ENABLED = "false";
    process.env.PROOF_MEMORY_ENABLED = "false";
    try {
      const ctx = await buildProverContext({ theoremType: "(n : ℕ) : n = n", useMathlib: false });
      expect(ctx).toEqual({ block: "", premises: [], recalled: [] });
    } finally {
      delete process.env.PREMISES_ENABLED;
    }
  });
});
