/**
 * Expert iteration, the whole loop (plan 7b P3):
 *
 *   1. prove   — the current prover attempts the training theorems no stored proof covers yet;
 *                every proof Lean accepts goes into the proof memory (and repaired proofs into
 *                the repair pairs). Solving in the app and the Lean tab add proofs the same way.
 *   2. export  — the memory and the repair pairs become chat fine-tuning data (dataset.ts);
 *                benchmark test sets stay out.
 *   3. train   — LoRA fine-tuning of the base prover on all data so far (MLX on Apple silicon:
 *                `python3 -m mlx_lm.lora`, then `mlx_lm.fuse`), always from the base model, so rounds
 *                do not drift.
 *   4. eval    — the candidate and the incumbent prover on the same held-out theorems
 *                (miniF2F test sample), proof memory off, so the score measures the model.
 *   5. promote — the candidate replaces the incumbent only when it proves more; the registry
 *                (.data/expert-iteration.json) records every round and which prover is current,
 *                and `npm run prover:serve` serves it.
 *
 * This module holds the decisions and formats (pure, tested); scripts/expert-iterate.ts runs the
 * steps (bench runs, mlx_lm, model server).
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { SftRecord } from "./dataset";

// ── Registry ─────────────────────────────────────────────────────────

/** A prover the app can call: the one configured in .env.local, or a fine-tuned local model. */
export interface ProverRef {
  /** "configured" = whatever LLM_PROVER_* says; "mlx" = a fused model served by mlx_lm. */
  kind: "configured" | "mlx";
  /** Model name as the endpoint knows it (for mlx: the fused model's directory). */
  model: string;
  /** For mlx: where the fused weights are. */
  path?: string;
  base_model?: string;
  round?: number;
  /** Port the fused model is served on (what --apply wrote into .env.local). */
  port?: number;
}

export interface EvalSummary {
  file: string;
  /** Theorem ids that were attempted (the same set for incumbent and candidate). */
  ids: string[];
  proved: number;
  total: number;
  proved_ids: string[];
  /** Theorems the run never started (its --max-cost was spent). */
  skipped: string[];
  cost?: number;
  result_file?: string;
  at: string;
}

export interface EiRound {
  round: number;
  started_at: string;
  finished_at?: string;
  /** Proofs found while proving the training theorems, per training file. */
  prove?: { file: string; attempted: number; proved: number; result_file?: string }[];
  dataset?: { dir: string; proofs: number; sft_train: number; sft_eval: number; repair_train: number; repair_eval: number; mlx_train: number; mlx_valid: number };
  train?: { base_model: string; adapter_path: string; fused_path: string; iters: number; seconds?: number };
  eval?: { incumbent: EvalSummary; candidate?: EvalSummary };
  promoted?: boolean;
  decision?: string;
  error?: string;
}

export interface EiRegistry {
  current: ProverRef;
  /** Eval results of the current prover, by eval-set key, so it is not re-run every round. */
  incumbent_evals: Record<string, EvalSummary>;
  rounds: EiRound[];
}

export function registryPath(): string {
  return process.env.EXPERT_ITERATION_PATH ?? ".data/expert-iteration.json";
}

export function emptyRegistry(): EiRegistry {
  return { current: { kind: "configured", model: process.env.LLM_PROVER_MODEL ?? "(LLM_PROVER_MODEL)" }, incumbent_evals: {}, rounds: [] };
}

export async function readRegistry(file = registryPath()): Promise<EiRegistry> {
  try {
    const r = JSON.parse(await fs.readFile(file, "utf8")) as EiRegistry;
    return { ...emptyRegistry(), ...r, incumbent_evals: r.incumbent_evals ?? {}, rounds: r.rounds ?? [] };
  } catch {
    return emptyRegistry();
  }
}

export async function writeRegistry(reg: EiRegistry, file = registryPath()): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(reg, null, 2));
  await fs.rename(tmp, file);
}

// ── Step 1: what still needs proving ─────────────────────────────────

export const normaliseStatement = (t: string) => t.replace(/\s+/g, " ").trim();

/** Training theorems no stored proof covers yet (by statement, whitespace-insensitive). */
export function unprovedIds(theorems: { id: string; type: string }[], memory: { theorem_type: string }[]): string[] {
  const proved = new Set(memory.map((e) => normaliseStatement(e.theorem_type)));
  return theorems.filter((t) => !proved.has(normaliseStatement(t.type))).map((t) => t.id);
}

/** Every k-th theorem id so that about `n` remain (deterministic held-out sample). */
export function sampleIds(ids: string[], n: number | undefined): string[] {
  if (!n || n >= ids.length) return [...ids];
  const step = ids.length / n;
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(ids[Math.floor(i * step)]);
  return out;
}

// ── Step 3: training data and commands ───────────────────────────────

function stableKey(r: SftRecord): string {
  return createHash("sha256").update(JSON.stringify(r.messages)).digest("hex");
}

/**
 * The exported records as mlx-lm chat data (`{"messages": [...]}` per line, metadata dropped):
 * proofs and repair pairs together, in a stable shuffled order. The validation file is never empty
 * (mlx-lm needs one): when the eval split is empty, the last training record moves over.
 */
export function mlxChatData(
  sft: { train: SftRecord[]; eval: SftRecord[] },
  repair: { train: SftRecord[]; eval: SftRecord[] },
): { train: string[]; valid: string[] } {
  const order = (rs: SftRecord[]) => [...rs].sort((a, b) => (stableKey(a) < stableKey(b) ? -1 : 1));
  const line = (r: SftRecord) => JSON.stringify({ messages: r.messages });
  const train = order([...sft.train, ...repair.train]).map(line);
  const valid = order([...sft.eval, ...repair.eval]).map(line);
  if (!valid.length && train.length > 1) valid.push(train.pop()!);
  return { train, valid };
}

/** Fewer training records than this and a fine-tune would only memorise them. */
export const MIN_TRAIN_RECORDS = 32;

export interface TrainConfig {
  python: string;
  baseModel: string;
  dataDir: string;
  adapterPath: string;
  fusedPath: string;
  iters: number;
  batchSize: number;
  numLayers: number;
  learningRate: number;
  maxSeqLength: number;
}

/** argv for `python3 -m mlx_lm.lora` (LoRA on the prompt-masked chat data, gradient checkpointing for 36 GB). */
export function mlxLoraArgs(c: TrainConfig): string[] {
  return [
    "-m", "mlx_lm.lora",
    "--model", c.baseModel,
    "--train",
    "--data", c.dataDir,
    "--adapter-path", c.adapterPath,
    "--iters", String(c.iters),
    "--batch-size", String(c.batchSize),
    "--num-layers", String(c.numLayers),
    "--learning-rate", String(c.learningRate),
    "--max-seq-length", String(c.maxSeqLength),
    "--mask-prompt",
    "--grad-checkpoint",
  ];
}

export function mlxFuseArgs(c: Pick<TrainConfig, "baseModel" | "adapterPath" | "fusedPath">): string[] {
  return ["-m", "mlx_lm.fuse", "--model", c.baseModel, "--adapter-path", c.adapterPath, "--save-path", c.fusedPath];
}

/** argv for a 4-bit copy of the base model (QLoRA keeps an 8B prover inside 36 GB). */
export function mlxConvertArgs(hfModel: string, outPath: string): string[] {
  return ["-m", "mlx_lm.convert", "--hf-path", hfModel, "-q", "--q-bits", "4", "--mlx-path", outPath];
}

export function mlxServeArgs(modelPath: string, port: number): string[] {
  return ["-m", "mlx_lm.server", "--model", modelPath, "--host", "127.0.0.1", "--port", String(port)];
}

/** Directory name of a fused model; contains "prover" so the app speaks the native prover prompt to it. */
export function fusedName(baseModel: string, round: number): string {
  const short = baseModel.split("/").pop()!.replace(/[^A-Za-z0-9._-]+/g, "-").toLowerCase();
  return `${short.includes("prover") ? short : `${short}-prover`}-ei-r${round}`;
}

// ── Step 4/5: evaluation and promotion ───────────────────────────────

/** Summary of a bench result file. */
export function evalSummary(result: { file?: string; rows: { id: string; ok: boolean; skipped?: boolean; cost?: number }[]; skipped?: string[] }, resultFile?: string): EvalSummary {
  const ran = result.rows.filter((r) => !r.skipped);
  const skipped = [...new Set([...(result.skipped ?? []), ...result.rows.filter((r) => r.skipped).map((r) => r.id)])].sort();
  const proved = ran.filter((r) => r.ok);
  return {
    file: result.file ?? "?",
    ids: ran.map((r) => r.id).sort(),
    proved: proved.length,
    total: ran.length,
    proved_ids: proved.map((r) => r.id).sort(),
    skipped,
    cost: ran.some((r) => r.cost !== undefined) ? ran.reduce((s, r) => s + (r.cost ?? 0), 0) : undefined,
    result_file: resultFile,
    at: new Date().toISOString(),
  };
}

/**
 * Key of an eval run: file, the ids meant to be attempted and the settings that change the score
 * (prover model, budget, samples), so an incumbent result is reused only for the same run.
 */
export function evalKey(file: string, ids: string[], settings = ""): string {
  return `${path.basename(file)}#${createHash("sha256").update([...ids].sort().join(",") + "|" + settings).digest("hex").slice(0, 12)}`;
}

/**
 * Promote the candidate only when it proves more of the same held-out theorems than the incumbent.
 * A tie keeps the incumbent (a fine-tune that does not help is not worth serving).
 */
export function decidePromotion(incumbent: EvalSummary, candidate: EvalSummary): { promote: boolean; reason: string } {
  // Compared on the theorems both runs attempted (a run stopped by its cost cap skips the rest).
  const inCand = new Set(candidate.ids);
  const common = incumbent.ids.filter((id) => inCand.has(id));
  const wanted = Math.max(incumbent.ids.length + incumbent.skipped.length, candidate.ids.length + candidate.skipped.length);
  if (!common.length || common.length < 0.8 * wanted) {
    return { promote: false, reason: `only ${common.length} of ${wanted} held-out theorems were attempted by both runs (raise --max-cost)` };
  }
  const c = new Set(common);
  const inc = incumbent.proved_ids.filter((id) => c.has(id));
  const cand = candidate.proved_ids.filter((id) => c.has(id));
  const gained = cand.filter((id) => !inc.includes(id));
  const lost = inc.filter((id) => !cand.includes(id));
  const detail = `${cand.length}/${common.length} vs ${inc.length}/${common.length} (gained ${gained.length}, lost ${lost.length})`;
  if (cand.length > inc.length) return { promote: true, reason: `candidate proves more: ${detail}` };
  return { promote: false, reason: `candidate does not prove more: ${detail}` };
}

/**
 * Proofs and repair pairs whose statement is a held-out theorem, left out of training whatever
 * their source (a held-out problem may also reach the memory through solving or the Lean tab).
 */
export function withoutStatements<T extends { theorem_type: string }>(rows: T[], heldOut: Set<string>): T[] {
  return heldOut.size ? rows.filter((r) => !heldOut.has(normaliseStatement(r.theorem_type))) : rows;
}

/** Environment for calling a prover (what the app reads); the configured one needs nothing. */
export function proverEnv(ref: ProverRef, port: number): Record<string, string> {
  if (ref.kind === "configured") return {};
  return {
    LLM_PROVER_MODEL: ref.model,
    LLM_PROVER_BASE_URL: `http://127.0.0.1:${port}/v1`,
    LLM_PROVER_API_KEY: "local",
    LLM_PROVER_PROMPT: "native",
    // A/B and serving: a failed call to the local prover must not be answered by the general model.
    LLM_PROVER_FALLBACK_TO_GENERAL: "false",
  };
}

/** .env text with the given keys set (replaced in place, or appended under a comment); other lines kept. */
export function applyEnv(text: string, vars: Record<string, string>, note = "# prover promoted by npm run expert:iterate"): string {
  const lines = text.split("\n");
  const missing = new Set(Object.keys(vars));
  const out = lines.map((l) => {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(l);
    if (m && m[1] in vars) {
      missing.delete(m[1]);
      return `${m[1]}=${vars[m[1]]}`;
    }
    return l;
  });
  if (missing.size) {
    if (out.length && out[out.length - 1] !== "") out.push("");
    out.push(note, ...[...missing].map((k) => `${k}=${vars[k]}`), "");
  }
  return out.join("\n");
}

// ── Report ───────────────────────────────────────────────────────────

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "—");

export function reportMarkdown(reg: EiRegistry, memory: { entries: number; bySource: [string, number][] }): string {
  const cur = reg.current;
  const lines = [
    "# Expert iteration",
    "",
    `Generated by \`npm run expert:iterate\` on ${new Date().toISOString().slice(0, 10)}.`,
    "",
    `Current prover: **${cur.kind === "mlx" ? `${cur.model} (fine-tuned, round ${cur.round}, base ${cur.base_model})` : `${cur.model} (as configured)`}**` +
      (cur.kind === "mlx" ? " — serve it with `npm run prover:serve`." : ""),
    "",
    `Proof memory: ${memory.entries} verified proofs (${memory.bySource.map(([k, n]) => `${k} ${n}`).join(", ") || "none"}).`,
    "",
    "| Round | Proved while training (new) | Training records | Held-out: incumbent | Held-out: candidate | Promoted | Note |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of reg.rounds) {
    const prove = r.prove?.length ? r.prove.map((p) => `${p.proved}/${p.attempted} ${p.file}`).join("; ") : "—";
    const data = r.dataset ? `${r.dataset.mlx_train} train / ${r.dataset.mlx_valid} valid` : "—";
    const inc = r.eval?.incumbent ? `${r.eval.incumbent.proved}/${r.eval.incumbent.total} (${pct(r.eval.incumbent.proved, r.eval.incumbent.total)})` : "—";
    const cand = r.eval?.candidate ? `${r.eval.candidate.proved}/${r.eval.candidate.total} (${pct(r.eval.candidate.proved, r.eval.candidate.total)})` : "—";
    const note = (r.error ?? r.decision ?? "").replace(/\|/g, "/");
    lines.push(`| ${r.round} | ${prove} | ${data} | ${inc} | ${cand} | ${r.promoted ? "yes" : "no"} | ${note} |`);
  }
  lines.push(
    "",
    "Each round: the current prover attempts the training theorems no stored proof covers (proof memory on, proofs kept) → the memory and repair pairs are exported (benchmark test sets left out) → LoRA fine-tune of the base model on everything so far → candidate and incumbent on the same held-out theorems with the proof memory off → the candidate is promoted only when it proves more.",
    "",
  );
  return lines.join("\n");
}
