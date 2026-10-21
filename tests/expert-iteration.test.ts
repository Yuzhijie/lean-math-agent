import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyEnv,
  decidePromotion,
  evalKey,
  evalSummary,
  fusedName,
  mlxChatData,
  mlxFuseArgs,
  mlxLoraArgs,
  proverEnv,
  readRegistry,
  reportMarkdown,
  sampleIds,
  unprovedIds,
  withoutStatements,
  writeRegistry,
  type EvalSummary,
} from "@/lib/prover/expert-iteration";
import type { SftRecord } from "@/lib/prover/dataset";

const rec = (q: string, a: string, split: "train" | "eval" = "train"): SftRecord => ({
  messages: [
    { role: "user", content: q },
    { role: "assistant", content: a },
  ],
  meta: { split, source: "bench:minif2f-valid.json" },
});

const summary = (proved: string[], ids = ["a", "b", "c", "d"], skipped: string[] = []): EvalSummary => ({
  file: "minif2f-test.json",
  ids,
  proved: proved.length,
  total: ids.length,
  proved_ids: proved,
  skipped,
  at: "2026-10-21",
});

describe("expert iteration: what to prove", () => {
  it("attempts only training theorems no stored proof covers (whitespace-insensitive)", () => {
    const theorems = [
      { id: "t1", type: ": 1 + 1 = 2" },
      { id: "t2", type: ": (x : ℕ) → x + 0 = x" },
      { id: "t3", type: ": 2 * 3 = 6" },
    ];
    expect(unprovedIds(theorems, [{ theorem_type: ":  1 + 1   = 2" }, { theorem_type: ": 2 * 3 = 6" }])).toEqual(["t2"]);
    expect(unprovedIds(theorems, [])).toEqual(["t1", "t2", "t3"]);
  });

  it("samples held-out theorems deterministically", () => {
    const ids = Array.from({ length: 244 }, (_, i) => `m${i}`);
    const s = sampleIds(ids, 60);
    expect(s).toHaveLength(60);
    expect(new Set(s).size).toBe(60);
    expect(sampleIds(ids, 60)).toEqual(s);
    expect(sampleIds(["a", "b"], 60)).toEqual(["a", "b"]);
  });
});

describe("expert iteration: training data and commands", () => {
  it("turns proofs and repair pairs into mlx chat lines without metadata, never with an empty validation file", () => {
    const d = mlxChatData({ train: [rec("p1", "a1"), rec("p2", "a2")], eval: [] }, { train: [rec("r1", "f1")], eval: [] });
    expect(d.train).toHaveLength(2);
    expect(d.valid).toHaveLength(1);
    const line = JSON.parse(d.train[0]);
    expect(Object.keys(line)).toEqual(["messages"]);
    expect(line.messages[0].role).toBe("user");
    // stable order
    expect(mlxChatData({ train: [rec("p2", "a2"), rec("p1", "a1")], eval: [] }, { train: [rec("r1", "f1")], eval: [] })).toEqual(d);
    const withEval = mlxChatData({ train: [rec("p1", "a1")], eval: [rec("e1", "x", "eval")] }, { train: [], eval: [] });
    expect(withEval.valid).toHaveLength(1);
    expect(withEval.train).toHaveLength(1);
  });

  it("builds the mlx_lm LoRA and fuse commands", () => {
    const cfg = {
      python: "python3",
      baseModel: ".data/provers/goedel-prover-v2-8b-4bit",
      dataDir: "data/proof-dataset/round-1/mlx",
      adapterPath: ".data/provers/a",
      fusedPath: ".data/provers/f",
      iters: 600,
      batchSize: 1,
      numLayers: 16,
      learningRate: 1e-5,
      maxSeqLength: 4096,
    };
    const lora = mlxLoraArgs(cfg).join(" ");
    expect(lora).toContain("-m mlx_lm.lora --model .data/provers/goedel-prover-v2-8b-4bit --train --data data/proof-dataset/round-1/mlx");
    expect(lora).toContain("--mask-prompt");
    expect(lora).toContain("--iters 600");
    expect(mlxFuseArgs(cfg)).toEqual(["-m", "mlx_lm.fuse", "--model", cfg.baseModel, "--adapter-path", ".data/provers/a", "--save-path", ".data/provers/f"]);
    expect(fusedName("Goedel-LM/Goedel-Prover-V2-8B", 2)).toBe("goedel-prover-v2-8b-ei-r2");
    // the app speaks the native prover prompt to a model whose name contains "prover"
    expect(fusedName("Qwen/Qwen3-8B", 1)).toBe("qwen3-8b-prover-ei-r1");
  });
});

describe("expert iteration: evaluation and promotion", () => {
  it("summarises a bench result (skipped rows left out)", () => {
    const s = evalSummary({ file: "minif2f-test.json", rows: [{ id: "b", ok: true, cost: 0.1 }, { id: "a", ok: false, cost: 0.2 }, { id: "c", ok: false, skipped: true }] });
    expect(s).toMatchObject({ ids: ["a", "b"], proved: 1, total: 2, proved_ids: ["b"], skipped: ["c"] });
    expect(s.cost).toBeCloseTo(0.3);
    expect(evalKey("bench/minif2f-test.json", ["b", "a"])).toBe(evalKey("minif2f-test.json", ["a", "b"]));
    expect(evalKey("x.json", ["a"])).not.toBe(evalKey("x.json", ["a", "b"]));
    // another prover model or budget is another run
    expect(evalKey("x.json", ["a"], "goedel|normal|")).not.toBe(evalKey("x.json", ["a"], "goedel|low|"));
  });

  it("promotes only a candidate that proves more of the same theorems", () => {
    expect(decidePromotion(summary(["a"]), summary(["a", "b"])).promote).toBe(true);
    const tie = decidePromotion(summary(["a"]), summary(["b"]));
    expect(tie.promote).toBe(false);
    expect(tie.reason).toContain("gained 1, lost 1");
    expect(decidePromotion(summary(["a"]), summary(["a", "b"], ["a", "b", "x", "y"])).promote).toBe(false);
  });

  it("compares runs cut short by their cost cap on the theorems both attempted, and refuses when too few", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `t${i}`);
    // the candidate skipped t9 (cost cap): compared on t0..t8
    const inc = summary(["t0", "t9"], ids);
    const cand = summary(["t0", "t1"], ids.slice(0, 9), ["t9"]);
    const d = decidePromotion(inc, cand);
    expect(d.promote).toBe(true);
    expect(d.reason).toContain("2/9 vs 1/9");
    const tooFew = decidePromotion(inc, summary(["t0", "t1", "t2"], ids.slice(0, 5), ids.slice(5)));
    expect(tooFew.promote).toBe(false);
    expect(tooFew.reason).toContain("max-cost");
  });

  it("keeps held-out statements out of training whatever their source", () => {
    const rows = [
      { theorem_type: ": 1 + 1 = 2", source: "lean-attempt" },
      { theorem_type: ": 2 + 2 = 4", source: "solve" },
    ];
    expect(withoutStatements(rows, new Set([": 1 + 1 = 2"]))).toEqual([rows[1]]);
    expect(withoutStatements(rows, new Set())).toEqual(rows);
  });

  it("points the app at a promoted local prover, keeping the rest of .env.local", () => {
    const env = proverEnv({ kind: "mlx", model: "/m/goedel-prover-v2-8b-ei-r1", round: 1 }, 8089);
    expect(env).toMatchObject({ LLM_PROVER_BASE_URL: "http://127.0.0.1:8089/v1", LLM_PROVER_PROMPT: "native", LLM_PROVER_FALLBACK_TO_GENERAL: "false" });
    expect(proverEnv({ kind: "configured", model: "x" }, 8089)).toEqual({});
    const before = "LLM_API_KEY=secret\nLLM_PROVER_MODEL=goedel-prover-v2-8b\nLLM_PROVER_BASE_URL=http://localhost:11434/v1\n";
    const after = applyEnv(before, env);
    expect(after).toContain("LLM_API_KEY=secret");
    expect(after).toContain("LLM_PROVER_MODEL=/m/goedel-prover-v2-8b-ei-r1");
    expect(after).toContain("LLM_PROVER_BASE_URL=http://127.0.0.1:8089/v1");
    expect(after.match(/LLM_PROVER_MODEL=/g)).toHaveLength(1);
    expect(after).toContain("LLM_PROVER_PROMPT=native");
  });

  it("keeps a registry of rounds and reports them", async () => {
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "ei-")), "reg.json");
    const reg = await readRegistry(file);
    expect(reg.current.kind).toBe("configured");
    reg.rounds.push({ round: 1, started_at: "x", prove: [{ file: "bench/minif2f-valid.json", attempted: 200, proved: 61 }], promoted: true, decision: "candidate proves more: 20/60 vs 15/60", eval: { incumbent: summary(["a"]), candidate: summary(["a", "b"]) } });
    reg.current = { kind: "mlx", model: "/m/goedel-prover-v2-8b-ei-r1", base_model: "Goedel-LM/Goedel-Prover-V2-8B", round: 1 };
    await writeRegistry(reg, file);
    const back = await readRegistry(file);
    expect(back.rounds).toHaveLength(1);
    const md = reportMarkdown(back, { entries: 256, bySource: [["bench:minif2f-valid.json", 61]] });
    expect(md).toContain("fine-tuned, round 1");
    expect(md).toContain("61/200 bench/minif2f-valid.json");
    expect(md).toContain("| yes |");
    expect(md).toContain("npm run prover:serve");
  });
});
