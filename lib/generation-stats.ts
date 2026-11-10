/**
 * What one generation run (bank same-type or built-in) cost: wall time, time per stage, rounds,
 * questions written and passed, model calls, tokens and the estimated cost. Kept on the bank's
 * generation record (`stats`) and appended to a log (`.data/generation-log.jsonl`) for both kinds,
 * which `npm run gen:report` reads — the stored generations only had the check results, not where
 * the time and money went, and built-in runs left no record at all.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { withUsageScope, type RunMetrics } from "./llm/usage-tracker";

export interface GenerationStats {
  duration_ms: number;
  rounds: number;
  /** Questions the writer produced (every round, passed extras included). */
  written: number;
  /** Of those, how many passed every check (may exceed what was kept). */
  passed: number;
  /** Wall time per stage (writing, solving, checking figures, …); stages of one round may overlap others' bookkeeping only sequentially. */
  stage_ms: Record<string, number>;
  llm_calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  /** Estimated from LLM_PRICES; absent when no model in use is priced. */
  cost_usd?: number;
  /** Model calls and tokens per model. */
  by_model?: Record<string, { calls: number; prompt_tokens: number; completion_tokens: number }>;
  lean_verifications?: number;
  /** Questions the program's own checks rejected before any model checked them (bank runs). */
  early_rejected?: number;
  /** Questions the independent solve and fit review were not run for (bank runs); built-in: Lean proofs not attempted after a failed answer check. */
  model_checks_skipped?: number;
}

/** Times stages that follow one another: enter(stage) closes the previous one. */
export class StageClock {
  private current?: string;
  private since = Date.now();
  readonly ms: Record<string, number> = {};
  enter(stage: string): void {
    const now = Date.now();
    if (this.current) this.ms[this.current] = (this.ms[this.current] ?? 0) + (now - this.since);
    this.current = stage;
    this.since = now;
  }
  stop(): Record<string, number> {
    this.enter("");
    this.current = undefined;
    delete this.ms[""];
    return this.ms;
  }
}

/**
 * Run a generation in its own usage scope (no cost cap of its own: the caller's billing still
 * applies) and return its result with the scope's model usage.
 */
export async function measured<T>(fn: (clock: StageClock) => Promise<T>): Promise<{ result: T; metrics: RunMetrics; clock: StageClock; started: number }> {
  const clock = new StageClock();
  const started = Date.now();
  return withUsageScope(async (metrics) => {
    const result = await fn(clock);
    clock.stop();
    return { result, metrics: metrics(), clock, started };
  }, { costCapUsd: 0 });
}

/** The stats of a measured run. */
export function generationStats(m: { metrics: RunMetrics; clock: StageClock; started: number }, counts: { rounds: number; written: number; passed: number }): GenerationStats {
  const byModel = Object.fromEntries(
    Object.entries(m.metrics.by_model).map(([k, v]) => [
      k,
      { calls: v.requests, prompt_tokens: v.promptTokens, completion_tokens: v.completionTokens },
    ]),
  );
  return {
    duration_ms: Date.now() - m.started,
    ...counts,
    stage_ms: m.clock.ms,
    llm_calls: m.metrics.llm_calls,
    prompt_tokens: m.metrics.prompt_tokens,
    completion_tokens: m.metrics.completion_tokens,
    ...(m.metrics.estimated_cost !== undefined ? { cost_usd: round6(m.metrics.estimated_cost) } : {}),
    ...(Object.keys(byModel).length ? { by_model: byModel } : {}),
    ...(m.metrics.lean_verifications ? { lean_verifications: m.metrics.lean_verifications } : {}),
  };
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** One line of the generation log. */
export interface GenerationLogEntry {
  at: number;
  kind: "bank" | "builtin";
  /** Bank generations: the bank and generation id (their candidates and checks are in the bank). */
  bank_id?: string;
  generation_id?: string;
  /** What was asked: the template label, or grade / difficulty / domain. */
  label: string;
  requested: number;
  stats: GenerationStats;
  /** Per written question: which checks failed (check name → its detail, cut short); empty when it passed. */
  outcomes: { passed: boolean; failed: Record<string, string>; check_ms?: Record<string, number> }[];
}

export function generationLogPath(): string {
  return process.env.GENERATION_LOG_PATH || join(process.cwd(), ".data", "generation-log.jsonl");
}

/** Append one run to the log (GENERATION_LOG=off: nothing); never throws. */
export function logGeneration(entry: GenerationLogEntry): void {
  if (process.env.GENERATION_LOG === "off") return;
  try {
    const path = generationLogPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n");
  } catch {
    // the log is diagnostics only
  }
}
