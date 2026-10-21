/**
 * `npm run expert:iterate` — run expert iteration rounds end to end (lib/prover/expert-iteration.ts):
 *
 *   prove → export → train → eval → promote
 *
 *   npm run expert:iterate                          # one round, every step
 *   npm run expert:iterate -- --rounds 3
 *   npm run expert:iterate -- --steps prove,export  # just grow the memory and the dataset
 *   npm run expert:iterate -- --dry-run             # print what would run, change nothing
 *   npm run expert:iterate -- --apply               # also point .env.local at a promoted prover
 *
 * Options:
 *   --train-files a.json,b.json  theorems to learn from (default bench/minif2f-valid.json — fetched
 *                                when missing — and bench/theorems.json); never a test split
 *   --eval-file f.json           held-out theorems (default bench/minif2f-test.json)
 *   --eval-limit n               held-out sample size, every k-th theorem (default 60)
 *   --budget low|normal|high     proving budget (default normal), --samples k, --concurrency n
 *   --max-cost usd               spend cap of each proving / eval run (default 10)
 *   --base-model id              model to fine-tune (EXPERT_BASE_MODEL, default Goedel-LM/Goedel-Prover-V2-8B)
 *   --no-quantize                train on the full-precision base (default: a 4-bit copy, QLoRA)
 *   --iters n                    LoRA iterations (default 600), --batch-size (1), --num-layers (16),
 *                                --learning-rate (1e-5), --max-seq-length (4096)
 *   --port p                     port of the local model server (default 8089)
 *
 * Needs: Lean sandbox + LLM key (as `npm run bench`), and for training/eval of a fine-tuned model
 * Apple silicon with `pip3 install mlx-lm` (EXPERT_PYTHON picks the interpreter). Spends real money
 * on the proving and eval runs (the --max-cost caps them); training is local.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { allProofs as cachedProofs, readRepairs, resetProofMemoryCache } from "../lib/lean/proof-memory";
import { repairRecords, sftRecords } from "../lib/prover/dataset";
import {
  applyEnv,
  decidePromotion,
  evalKey,
  evalSummary,
  fusedName,
  MIN_TRAIN_RECORDS,
  mlxChatData,
  mlxConvertArgs,
  mlxFuseArgs,
  mlxLoraArgs,
  mlxServeArgs,
  proverEnv,
  readRegistry,
  reportMarkdown,
  sampleIds,
  unprovedIds,
  withoutStatements,
  writeRegistry,
  type EiRegistry,
  type EiRound,
  type ProverRef,
} from "../lib/prover/expert-iteration";
import { fixStatement } from "./fetch-benchmark";
import { heldOutStatements } from "./proofs-export";

/** The proof memory as the file holds it now (the bench child processes write to it). */
async function allProofs() {
  resetProofMemoryCache();
  return cachedProofs();
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const num = (name: string, dflt: number) => (arg(name) !== undefined ? Number(arg(name)) : dflt);

for (const f of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(path.resolve(f));
  } catch {
    // optional
  }
}

const DRY = flag("dry-run");
const STEPS = new Set((arg("steps") ?? "prove,export,train,eval,promote").split(",").map((s) => s.trim()));
const ROUNDS = Math.max(1, num("rounds", 1));
const TRAIN_FILES = (arg("train-files") ?? "bench/minif2f-valid.json,bench/theorems.json").split(",").map((s) => s.trim()).filter(Boolean);
const EVAL_FILE = arg("eval-file") ?? "bench/minif2f-test.json";
const EVAL_LIMIT = num("eval-limit", 60);
const BUDGET = arg("budget") ?? "normal";
const CONCURRENCY = arg("concurrency") ?? "2";
const MAX_COST = arg("max-cost") ?? "10";
const PORT = num("port", 8089);
const PYTHON = process.env.EXPERT_PYTHON ?? "python3";
const BASE = arg("base-model") ?? process.env.EXPERT_BASE_MODEL ?? "Goedel-LM/Goedel-Prover-V2-8B";
const PROVERS = ".data/provers";
const RESULTS = "bench/results";
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

function say(s: string): void {
  console.log(`\n=== ${s}`);
}

/** Run a command to completion (inherits stdio); throws on failure. Under caffeinate on macOS. */
function run(bin: string, args: string[], env: Record<string, string> = {}): void {
  console.log(`$ ${Object.entries(env).map(([k, v]) => `${k}=${v} `).join("")}${bin} ${args.join(" ")}`);
  if (DRY) return;
  const [b, ...rest] = process.platform === "darwin" && existsSync("/usr/bin/caffeinate") ? ["/usr/bin/caffeinate", "-i", bin, ...args] : [bin, ...args];
  const r = spawnSync(b, rest, { stdio: "inherit", env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${path.basename(bin)} ${args.slice(0, 3).join(" ")} failed (exit ${r.status ?? r.signal})`);
}

const tsx = (script: string, args: string[], env: Record<string, string> = {}) =>
  run(process.execPath, [path.join("node_modules", "tsx", "dist", "cli.mjs"), script, ...args], env);

/** A bench file's theorems with their statements as bench.ts runs and remembers them (fixStatement). */
function benchTheorems(file: string): { id: string; type: string }[] {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { theorems?: { id: string; type: string }[] } | { id: string; type: string }[];
  return (Array.isArray(parsed) ? parsed : (parsed.theorems ?? [])).map((t) => ({ ...t, type: fixStatement(t.type) }));
}

/** Serve a fused model with mlx_lm while `fn` runs (nothing to serve for the configured prover). */
async function withProver<T>(ref: ProverRef, fn: (env: Record<string, string>) => Promise<T> | T): Promise<T> {
  if (ref.kind === "configured") return fn({});
  const args = mlxServeArgs(ref.path ?? ref.model, PORT);
  console.log(`$ ${PYTHON} ${args.join(" ")} &`);
  if (DRY) return fn(proverEnv(ref, PORT));
  const up = async () => {
    try {
      return (await fetch(`http://127.0.0.1:${PORT}/v1/models`)).ok;
    } catch {
      return false;
    }
  };
  // Something already answering on the port (e.g. npm run prover:serve) would be measured instead.
  if (await up()) throw new Error(`port ${PORT} is already in use (stop npm run prover:serve, or pass --port)`);
  const child: ChildProcess = spawn(PYTHON, args, { stdio: ["ignore", "inherit", "inherit"] });
  let failed: Error | undefined;
  child.on("error", (e) => (failed = e));
  const exited = new Promise<void>((res) => child.once("exit", () => res()));
  try {
    const deadline = Date.now() + 10 * 60_000;
    for (;;) {
      if (failed) throw new Error(`could not start the model server (${PYTHON}): ${failed.message}`);
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`the model server exited (${child.exitCode ?? child.signalCode})`);
      if (await up()) break;
      if (Date.now() > deadline) throw new Error("the model server did not come up within 10 minutes");
      await new Promise((res) => setTimeout(res, 2000));
    }
    return await fn(proverEnv(ref, PORT));
  } finally {
    if (child.exitCode === null && child.signalCode === null && !failed) {
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((res) => setTimeout(res, 15_000))]);
    }
  }
}

/** One bench run → its result JSON (path). */
function bench(file: string, ids: string[], out: string, extra: string[], env: Record<string, string>): string {
  tsx("scripts/bench.ts", ["--file", file, "--only", ids.join(","), "--budget", BUDGET, "--concurrency", CONCURRENCY, "--max-cost", MAX_COST, "--json", out, ...extra], env);
  return out;
}

async function roundOnce(reg: EiRegistry, n: number): Promise<EiRound> {
  const round: EiRound = { round: n, started_at: new Date().toISOString() };
  reg.rounds.push(round);
  const save = () => (DRY ? Promise.resolve() : writeRegistry(reg));

  // 1. Prove the training theorems the memory does not cover yet, with the current prover.
  if (STEPS.has("prove")) {
    say(`round ${n} · prove (training theorems, prover: ${reg.current.model})`);
    if (TRAIN_FILES.includes("bench/minif2f-valid.json") && !existsSync("bench/minif2f-valid.json")) tsx("scripts/fetch-benchmark.ts", ["--split", "valid"]);
    round.prove = [];
    const memory = await allProofs();
    for (const file of TRAIN_FILES) {
      if (!existsSync(file)) {
        console.log(`(skipping ${file}: not found)`);
        continue;
      }
      if (/test/i.test(path.basename(file))) throw new Error(`${file} looks like a test split; it must not be used for training`);
      const ids = unprovedIds(benchTheorems(file), memory);
      if (!ids.length) {
        round.prove.push({ file, attempted: 0, proved: 0 });
        continue;
      }
      const out = `${RESULTS}/${stamp()}-ei-r${n}-prove-${path.basename(file, ".json")}.json`;
      const samples = arg("samples") ? ["--samples", arg("samples")!] : [];
      await withProver(reg.current, (env) => bench(file, ids, out, ["--memory", "write", ...samples], env));
      const s = DRY ? undefined : evalSummary(JSON.parse(readFileSync(out, "utf8")));
      round.prove.push({ file, attempted: ids.length, proved: s?.proved ?? 0, result_file: out });
    }
    await save();
  }

  // 2. Export the memory + repair pairs, then the mlx chat files.
  const dir = path.resolve("data/proof-dataset", `round-${n}`);
  const mlxDir = path.join(dir, "mlx");
  if (STEPS.has("export")) {
    say(`round ${n} · export`);
    tsx("scripts/proofs-export.ts", ["--out", dir, ...(existsSync(EVAL_FILE) ? ["--exclude-from", EVAL_FILE] : [])]);
    // Held-out theorems stay out of training whatever their source (solving, the Lean tab, …).
    const heldOut = existsSync(EVAL_FILE) ? await heldOutStatements([EVAL_FILE]) : new Set<string>();
    const entries = await allProofs();
    const pairs = await readRepairs();
    const sft = sftRecords(withoutStatements(entries, heldOut));
    const rep = repairRecords(withoutStatements(pairs, heldOut));
    const data = mlxChatData(sft, rep);
    if (!DRY) {
      await fs.mkdir(mlxDir, { recursive: true });
      await fs.writeFile(path.join(mlxDir, "train.jsonl"), data.train.join("\n") + "\n");
      await fs.writeFile(path.join(mlxDir, "valid.jsonl"), data.valid.join("\n") + "\n");
    }
    round.dataset = {
      dir,
      proofs: entries.length,
      sft_train: sft.train.length,
      sft_eval: sft.eval.length,
      repair_train: rep.train.length,
      repair_eval: rep.eval.length,
      mlx_train: data.train.length,
      mlx_valid: data.valid.length,
    };
    console.log(`training records: ${data.train.length} (validation ${data.valid.length}); ${sft.excludedTest} test-set proofs left out`);
    await save();
  }

  // 3. LoRA fine-tune of the base model on everything so far, then fuse.
  let candidate: ProverRef | undefined;
  if (STEPS.has("train")) {
    say(`round ${n} · train (${BASE})`);
    // Without an export this round, train on the latest exported dataset.
    const dataset = round.dataset ?? [...reg.rounds].reverse().find((r) => r.dataset)?.dataset;
    const records = dataset?.mlx_train ?? 0;
    if (!DRY && records < MIN_TRAIN_RECORDS) {
      round.error = `only ${records} training records (need ${MIN_TRAIN_RECORDS}); prove more theorems first`;
      console.log(round.error);
      await save();
      return round;
    }
    let base = BASE;
    if (!flag("no-quantize") && !existsSync(BASE)) {
      const q = path.join(PROVERS, `${BASE.split("/").pop()!.toLowerCase()}-4bit`);
      if (!existsSync(q)) run(PYTHON, mlxConvertArgs(BASE, q));
      base = q;
    }
    const name = fusedName(BASE, n);
    const cfg = {
      python: PYTHON,
      baseModel: base,
      dataDir: dataset ? path.join(dataset.dir, "mlx") : mlxDir,
      adapterPath: path.join(PROVERS, `${name}-adapter`),
      fusedPath: path.join(PROVERS, name),
      iters: num("iters", 600),
      batchSize: num("batch-size", 1),
      numLayers: num("num-layers", 16),
      learningRate: num("learning-rate", 1e-5),
      maxSeqLength: num("max-seq-length", 4096),
    };
    const t0 = Date.now();
    run(PYTHON, mlxLoraArgs(cfg));
    run(PYTHON, mlxFuseArgs(cfg));
    round.train = { base_model: base, adapter_path: cfg.adapterPath, fused_path: cfg.fusedPath, iters: cfg.iters, seconds: Math.round((Date.now() - t0) / 1000) };
    candidate = { kind: "mlx", model: path.resolve(cfg.fusedPath), path: path.resolve(cfg.fusedPath), base_model: BASE, round: n, port: PORT };
    await save();
  }

  // 4. Incumbent and candidate on the same held-out theorems, proof memory off.
  if (STEPS.has("eval")) {
    say(`round ${n} · eval (${EVAL_FILE})`);
    if (EVAL_FILE === "bench/minif2f-test.json" && !existsSync(EVAL_FILE)) tsx("scripts/fetch-benchmark.ts", []);
    if (!existsSync(EVAL_FILE)) {
      console.log(`(no ${EVAL_FILE}${DRY ? " yet — the dry run stops the eval here" : ""})`);
      round.finished_at = new Date().toISOString();
      await save();
      return round;
    }
    const ids = sampleIds(benchTheorems(EVAL_FILE).map((t) => t.id), EVAL_LIMIT);
    const key = evalKey(EVAL_FILE, ids, [reg.current.model, BUDGET, arg("samples") ?? ""].join("|"));
    const evalArgs = ["--memory", "off"];
    let incumbent = reg.incumbent_evals[key];
    if (!incumbent) {
      const out = `${RESULTS}/${stamp()}-ei-r${n}-eval-incumbent.json`;
      await withProver(reg.current, (env) => bench(EVAL_FILE, ids, out, evalArgs, { ...env, LLM_PROVER_FALLBACK_TO_GENERAL: "false" }));
      if (!DRY) {
        incumbent = evalSummary(JSON.parse(readFileSync(out, "utf8")), out);
        // A run cut short by its cost cap is not reused: the next round measures the incumbent again.
        if (!incumbent.skipped.length) reg.incumbent_evals[key] = incumbent;
      }
    }
    round.eval = incumbent ? { incumbent } : undefined;
    if (candidate) {
      const out = `${RESULTS}/${stamp()}-ei-r${n}-eval-candidate.json`;
      await withProver(candidate, (env) => bench(EVAL_FILE, ids, out, evalArgs, env));
      if (!DRY && round.eval) round.eval.candidate = evalSummary(JSON.parse(readFileSync(out, "utf8")), out);
    }
    await save();

    // 5. Promote only a candidate that proves more.
    if (STEPS.has("promote") && candidate && round.eval?.candidate) {
      const d = decidePromotion(round.eval.incumbent, round.eval.candidate);
      round.promoted = d.promote;
      round.decision = d.reason;
      say(`round ${n} · ${d.promote ? "promoted" : "kept the incumbent"}: ${d.reason}`);
      if (d.promote) {
        reg.current = candidate;
        const promotedKey = evalKey(EVAL_FILE, ids, [candidate.model, BUDGET, arg("samples") ?? ""].join("|"));
        reg.incumbent_evals = round.eval.candidate.skipped.length ? {} : { [promotedKey]: round.eval.candidate };
        if (flag("apply")) {
          const envFile = path.resolve(".env.local");
          const before = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
          if (before) await fs.writeFile(`${envFile}.bak-${stamp()}`, before);
          await fs.writeFile(envFile, applyEnv(before, proverEnv(candidate, PORT)));
          console.log(`.env.local now points the prover at ${candidate.model} (served on port ${PORT} by npm run prover:serve); the old file was backed up`);
        }
      }
    }
  }
  round.finished_at = new Date().toISOString();
  await save();
  return round;
}

async function main(): Promise<void> {
  if (TRAIN_FILES.some((f) => path.resolve(f) === path.resolve(EVAL_FILE))) {
    console.error(`${EVAL_FILE} is both a training file and the held-out set`);
    process.exit(2);
  }
  const reg = await readRegistry();
  console.log(`Expert iteration: ${ROUNDS} round(s), steps ${[...STEPS].join(" → ")}; current prover ${reg.current.model}${DRY ? " (dry run)" : ""}`);
  const first = (reg.rounds.at(-1)?.round ?? 0) + 1;
  for (let n = first; n < first + ROUNDS; n++) {
    try {
      await roundOnce(reg, n);
    } catch (e) {
      const r = reg.rounds.find((x) => x.round === n);
      if (r) r.error = e instanceof Error ? e.message : String(e);
      if (!DRY) await writeRegistry(reg);
      console.error(e instanceof Error ? e.message : e);
      break;
    }
  }
  const entries = await allProofs();
  const bySource = [...entries.reduce((m, e) => m.set(e.source ?? "solve", (m.get(e.source ?? "solve") ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]);
  const md = reportMarkdown(reg, { entries: entries.length, bySource });
  if (!DRY) await fs.writeFile("bench/EXPERT-ITERATION.md", md);
  console.log(DRY ? md : "report → bench/EXPERT-ITERATION.md");
}

if (process.argv[1] && /expert-iterate\.(ts|js|mts|mjs)$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
