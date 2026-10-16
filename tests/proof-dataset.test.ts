import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proof-dataset-"));
process.env.PROOF_MEMORY_PATH = path.join(dir, "memory.json");
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const verifyMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/lean/sandbox", async (orig) => ({ ...(await orig<typeof import("@/lib/lean/sandbox")>()), verifyLeanSource: verifyMock }));

const mem = await import("@/lib/lean/proof-memory");
const ds = await import("@/lib/prover/dataset");
const { replayRecalled } = await import("@/lib/prover/replay");

beforeEach(() => {
  fs.rmSync(process.env.PROOF_MEMORY_PATH!, { force: true });
  fs.rmSync(path.join(dir, "proof-repairs.jsonl"), { force: true });
  mem.resetProofMemoryCache();
  verifyMock.mockReset();
});

const P = (i: number, tactics = "nlinarith [sq_nonneg (a - b)]") => ({
  theoremName: `t${i}`,
  theoremType: `(a b : ℝ) (h${i} : 0 < a) : a * b ≤ (a ^ 2 + b ^ 2) / 2 + ${i}`,
  tactics,
  strategy: "whole_proof",
  source: "bench:minif2f-valid.json",
});

describe("proof memory as a dataset", () => {
  it("stores many proofs in one write, keeping source and opens; a shorter proof replaces a longer one", async () => {
    const r = await mem.rememberProofs([P(1), P(2), { ...P(3), opens: ["Real"] }, { ...P(1, "nlinarith [sq_nonneg (a - b), sq_nonneg (a + b)]") }]);
    expect(r).toEqual({ added: 3, updated: 1, skipped: 0 });
    const all = await mem.allProofs();
    expect(all).toHaveLength(3);
    expect(all[0]).toMatchObject({ source: "bench:minif2f-valid.json", tactics: "nlinarith [sq_nonneg (a - b)]" });
    expect(all[2].opens).toEqual(["Real"]);
    expect((await mem.rememberProofs([{ ...P(9), tactics: "sorry" }])).skipped).toBe(1);
  });

  it("harvests verified bench rows with their statements", () => {
    const theorems = new Map([["a", { id: "a", name: "a", type: ": 1 + 1 = 2", informal: "one plus one" }]]);
    const { proofs, missing } = ds.harvestRows(
      [
        { id: "a", ok: true, proved_by: "hammer", tactics: "norm_num" },
        { id: "b", ok: true, tactics: "simp" },
        { id: "a", ok: false },
      ],
      theorems,
      { source: "bench:minif2f-test.json", opens: ["Real"] },
    );
    expect(proofs).toEqual([{ theoremName: "a", theoremType: ": 1 + 1 = 2", tactics: "norm_num", strategy: "hammer", problemText: "one plus one", source: "bench:minif2f-test.json", opens: ["Real"] }]);
    expect(missing).toEqual(["b"]);
  });

  it("exports fine-tuning records in the native prover format, test sets left out, split stable", async () => {
    await mem.rememberProofs([P(1), P(2), { ...P(3), source: "bench:minif2f-test.json" }, { ...P(4), source: "solve" }]);
    const all = await mem.allProofs();
    const r = ds.sftRecords(all, { evalShare: 0 });
    expect(r.excludedTest).toBe(1);
    expect(r.train).toHaveLength(3);
    expect(r.train[0].messages[0].content).toContain("Complete the following Lean 4 code");
    expect(r.train[0].messages[1].content).toBe("```lean4\ntheorem t1 " + P(1).theoremType + " := by\n  nlinarith [sq_nonneg (a - b)]\n```");
    expect(ds.sftRecords(all, { includeTest: true, evalShare: 0 }).train).toHaveLength(4);
    expect(ds.splitOf("x = x", 1)).toBe("eval");
    expect(ds.splitOf("x = x")).toBe(ds.splitOf("x  =  x"));
    expect(ds.isTestSource("bench:minif2f-test.json")).toBe(true);
    expect(ds.isTestSource("solve")).toBe(false);
  });

  it("keeps repair pairs and turns them into repair records", async () => {
    expect(await mem.rememberRepair({ theorem_name: "t", theorem_type: ": True", failed_tactics: "exact foo", feedback: "unknown identifier 'foo'", fixed_tactics: "trivial", source: "solve" })).toBe(true);
    expect(await mem.rememberRepair({ theorem_name: "t", theorem_type: ": True", failed_tactics: "x", feedback: "", fixed_tactics: "sorry" })).toBe(false);
    const pairs = await mem.readRepairs();
    expect(pairs).toHaveLength(1);
    const r = ds.repairRecords(pairs, { evalShare: 0 });
    expect(r.train[0].messages[0].content).toContain("unknown identifier 'foo'");
    expect(r.train[0].messages[1].content).toContain("trivial");
  });

  it("measures the similar-theorem hit rate leave-one-out", async () => {
    await mem.rememberProofs([P(1), P(2), P(3), { theoremName: "c", theoremType: "(n : ℕ) (h : n % 4 = 3) : n % 2 = 1", tactics: "omega", source: "solve" }]);
    expect(ds.tacticNames("intro x\nnlinarith [sq_nonneg x] <;> simp at h\n· exact h")).toEqual(new Set(["intro", "nlinarith", "simp", "exact"]));
    const s = await ds.memoryHitStats(await mem.allProofs(), { k: 2 });
    expect(s.entries).toBe(4);
    expect(s.hits).toBe(3); // the three nlinarith inequalities recall each other; the omega fact does not match them
    expect(s.bySource["minif2f-valid.json"]).toEqual({ entries: 3, hits: 3 });
    // Evaluation does not count as use.
    expect((await mem.allProofs()).every((e) => e.uses === 0)).toBe(true);
  });
});

describe("memory replay", () => {
  it("proves a near-duplicate with a recalled proof verbatim and counts the hit", async () => {
    await mem.rememberProofs([P(1, "nlinarith [bad]"), P(2)]);
    const recalled = await mem.allProofs();
    verifyMock.mockImplementation(async (_id: string, source: string) => ({ ok: /sq_nonneg/.test(source), status: /sq_nonneg/.test(source) ? "ok" : "fail", backend: "repl", log: "", messages: [], sorries: [], goals: [], infos: [], durationMs: 1 }));
    const r = await replayRecalled({ sessionId: "s", theoremName: "new", theoremType: P(7).theoremType, recalled, useMathlib: true });
    expect(r?.tactics).toBe("nlinarith [sq_nonneg (a - b)]");
    expect(r?.tried).toBe(2);
    expect(verifyMock.mock.calls[1][1]).toContain("theorem new");
    await new Promise((res) => setTimeout(res, 20));
    expect((await mem.allProofs()).find((e) => e.theorem_name === "t2")?.replay_hits).toBe(1);
  });

  it("is off with PROOF_MEMORY_REPLAY=false", async () => {
    process.env.PROOF_MEMORY_REPLAY = "false";
    try {
      expect(await replayRecalled({ sessionId: "s", theoremName: "n", theoremType: ": True", recalled: [{ ...(await mem.rememberProof(P(1)))! }], useMathlib: true })).toBeUndefined();
      expect(verifyMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.PROOF_MEMORY_REPLAY;
    }
  });
});

describe("harvest and export scripts", () => {
  it("harvest a bench result into memory, then export the dataset", () => {
    const work = fs.mkdtempSync(path.join(dir, "scripts-"));
    fs.mkdirSync(path.join(work, "bench"));
    fs.writeFileSync(
      path.join(work, "bench", "minif2f-test.json"),
      JSON.stringify({ opens: ["Real"], theorems: [{ id: "x1", name: "x1", type: ": (2 : ℕ) + 2 = 4", informal: "2+2" }, { id: "x2", name: "x2", type: "(n : ℕ) : n + 0 = n" }] }),
    );
    fs.writeFileSync(path.join(work, "r.json"), JSON.stringify({ file: "minif2f-test.json", rows: [{ id: "x1", ok: true, proved_by: "hammer", tactics: "norm_num" }, { id: "x2", ok: false }] }));
    const env = { ...process.env, PROOF_MEMORY_PATH: path.join(work, "mem.json") };
    const tsx = path.resolve("node_modules/.bin/tsx");
    const harvest = execFileSync(tsx, [path.resolve("scripts/proofs-harvest.ts"), "r.json", "--bench-dir", "bench"], { cwd: work, env, encoding: "utf8" });
    expect(harvest).toContain("0 → 1 proofs");
    const mem1 = JSON.parse(fs.readFileSync(path.join(work, "mem.json"), "utf8"));
    expect(mem1.entries[0]).toMatchObject({ theorem_type: ": (2 : ℕ) + 2 = 4", source: "bench:minif2f-test.json", opens: ["Real"] });
    const exp = execFileSync(tsx, [path.resolve("scripts/proofs-export.ts"), "--out", "ds"], { cwd: work, env, encoding: "utf8" });
    expect(exp).toContain("1 test-set proofs left out");
    expect(fs.readFileSync(path.join(work, "ds", "proofs.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(fs.readFileSync(path.join(work, "ds", "sft-train.jsonl"), "utf8")).toBe("");
    expect(fs.readFileSync(path.join(work, "ds", "README.md"), "utf8")).toContain("bench:minif2f-test.json 1");
  }, 60_000);
});

describe("importing published proofs", () => {
  it("reads full declarations and statement + proof pairs", async () => {
    const { parseExternalRow } = await import("../scripts/proofs-import");
    expect(
      parseExternalRow({
        full_proof: "import Mathlib\nopen Real\n\n/-- x -/\ntheorem lean_workbook_1 (a b : ℝ) (ha : 0 < a) : a * b ≤ (a ^ 2 + b ^ 2) / 2 := by\n  nlinarith [sq_nonneg (a - b)]",
        informal: "AM-GM",
      }),
    ).toEqual({ name: "lean_workbook_1", type: "(a b : ℝ) (ha : 0 < a) : a * b ≤ (a ^ 2 + b ^ 2) / 2", tactics: "nlinarith [sq_nonneg (a - b)]", informal: "AM-GM", opens: ["Real"] });
    expect(
      parseExternalRow({ formal_statement: "theorem t (n : ℕ) : ∑ i in Finset.range n, (0 : ℕ) = 0 := by sorry", proof: "by simp", header: "import Mathlib\nopen BigOperators" }),
    ).toMatchObject({ name: "t", type: "(n : ℕ) : ∑ i ∈ Finset.range n, (0 : ℕ) = 0", tactics: "simp", opens: ["BigOperators"] });
    expect(parseExternalRow({ formal_statement: "theorem t : True := by sorry", proof: "sorry" })).toEqual({ error: "no complete proof" });
    expect(parseExternalRow({ foo: 1 })).toHaveProperty("error");
  });
});
