// ── Token Usage Tracker ────────────────────────────────────────────────
//
// In-memory accumulator for LLM token usage, plus a per-request *scope*
// (AsyncLocalStorage) so that everything a pipeline run spends — LLM calls
// by role/model, Lean verifications, wall-clock — can be attributed to that
// run and reported back to the user (`metrics` in the solve response and
// `session.metrics`). Cost is estimated from the LLM_PRICES table when set.

import { AsyncLocalStorage } from "node:async_hooks";
import type { ModelPrices, ModelRole } from "./config";

export interface UsageRecord {
  model: string;
  role: ModelRole;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  timestamp: number;
}

export interface ModelUsageBreakdown {
  requests: number;
  promptTokens: number;
  completionTokens: number;
}

export interface UsageSummary {
  totalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  byModel: Record<string, ModelUsageBreakdown>;
}

/** Raw usage field from OpenAI-compatible API response. */
export interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** What one pipeline run consumed. Serialisable; stored on the session. */
export interface RunMetrics {
  llm_calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  llm_latency_ms: number;
  by_model: Record<string, ModelUsageBreakdown>;
  by_role: Record<string, ModelUsageBreakdown>;
  /** Estimated cost from LLM_PRICES (undefined when no price is known for any model used). */
  estimated_cost?: number;
  lean_verifications: number;
  lean_verify_ms: number;
  lean_by_backend: Record<string, number>;
  wall_ms: number;
}

// ── Module-level singleton store ──────────────────────────────────────

const records: UsageRecord[] = [];

/**
 * Record a single LLM call's token usage.
 */
export function recordUsage(record: UsageRecord): void {
  records.push(record);
  if (record.latencyMs > 0) recordLatency(record.role, record.latencyMs);
  const scope = scopeStorage.getStore();
  if (scope) scope.llm.push(record);
}

// ── Latency estimate per role ─────────────────────────────────────────
//
// Reasoning models answer in tens of seconds to minutes. Search stages use
// this estimate to skip calls that cannot finish inside their remaining
// budget (an aborted call still bills the tokens it generated) and to size
// per-call timeouts. Exponential moving average of observed latencies; a
// timeout counts as "at least the timeout".

const latencyEma = new Map<ModelRole, number>();
const DEFAULT_LATENCY_MS = 30_000;

export function recordLatency(role: ModelRole, ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const prev = latencyEma.get(role);
  latencyEma.set(role, prev === undefined ? ms : 0.6 * prev + 0.4 * ms);
}

/** Expected latency of one call for `role` (ms); `dflt` until something was observed. */
export function expectedLatencyMs(role: ModelRole, dflt = DEFAULT_LATENCY_MS): number {
  return latencyEma.get(role) ?? dflt;
}

/** Forget observed latencies (tests). */
export function resetLatencyEstimates(): void {
  latencyEma.clear();
}

/**
 * Parse raw usage field from API response and record it.
 * Always records the request, even when usage data is missing (tokens default to 0).
 */
export function parseAndRecordUsage(
  model: string,
  raw: RawUsage | undefined,
  extra: { role?: ModelRole; latencyMs?: number } = {},
): UsageRecord {
  const promptTokens = raw?.prompt_tokens ?? 0;
  const completionTokens = raw?.completion_tokens ?? 0;
  const totalTokens = raw?.total_tokens ?? promptTokens + completionTokens;

  const record: UsageRecord = {
    model,
    role: extra.role ?? "general",
    promptTokens,
    completionTokens,
    totalTokens,
    latencyMs: extra.latencyMs ?? 0,
    timestamp: Date.now(),
  };
  recordUsage(record);
  return record;
}

/**
 * Get an aggregate summary of all recorded usage.
 */
export function getUsageSummary(): UsageSummary {
  const byModel: Record<string, ModelUsageBreakdown> = {};
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTokens = 0;

  for (const r of records) {
    totalPromptTokens += r.promptTokens;
    totalCompletionTokens += r.completionTokens;
    totalTokens += r.totalTokens;
    addTo(byModel, r.model, r);
  }

  return {
    totalRequests: records.length,
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens,
    byModel,
  };
}

/**
 * Reset all recorded usage (for testing).
 */
export function resetUsage(): void {
  records.length = 0;
}

// ── Per-run scope ─────────────────────────────────────────────────────

interface Scope {
  startedAt: number;
  llm: UsageRecord[];
  verifications: Array<{ backend: string; durationMs: number }>;
}

const scopeStorage = new AsyncLocalStorage<Scope>();

/**
 * Run `fn` in a fresh usage scope. All LLM calls and Lean verifications
 * that happen (asynchronously) inside it are attributed to the scope;
 * `metrics()` returns the totals at any point, e.g. when the run finishes.
 */
export async function withUsageScope<T>(
  fn: (metrics: () => RunMetrics) => Promise<T>,
): Promise<T> {
  const scope: Scope = { startedAt: Date.now(), llm: [], verifications: [] };
  return scopeStorage.run(scope, () => fn(() => summarizeScope(scope)));
}

/** Attribute a Lean verification to the current scope (no-op outside one). */
export function recordVerification(backend: string, durationMs: number): void {
  const scope = scopeStorage.getStore();
  if (scope) scope.verifications.push({ backend, durationMs });
}

/** Metrics of the current scope, or undefined outside one. */
export function currentScopeMetrics(): RunMetrics | undefined {
  const scope = scopeStorage.getStore();
  return scope ? summarizeScope(scope) : undefined;
}

let priceTable: ModelPrices = {};

/** Install the price table used for cost estimates (from LlmConfig.prices). */
export function setPriceTable(prices: ModelPrices): void {
  priceTable = prices;
}

/** Cost of a set of records in the price table's currency, or undefined if none is priced. */
export function estimateCost(usage: UsageRecord[], prices: ModelPrices = priceTable): number | undefined {
  let cost = 0;
  let priced = false;
  for (const r of usage) {
    const p = prices[r.model];
    if (!p) continue;
    priced = true;
    cost += (r.promptTokens * p.input + r.completionTokens * p.output) / 1_000_000;
  }
  return priced ? Number(cost.toFixed(6)) : undefined;
}

function summarizeScope(scope: Scope): RunMetrics {
  const byModel: Record<string, ModelUsageBreakdown> = {};
  const byRole: Record<string, ModelUsageBreakdown> = {};
  let prompt = 0;
  let completion = 0;
  let latency = 0;
  for (const r of scope.llm) {
    prompt += r.promptTokens;
    completion += r.completionTokens;
    latency += r.latencyMs;
    addTo(byModel, r.model, r);
    addTo(byRole, r.role, r);
  }
  const byBackend: Record<string, number> = {};
  let verifyMs = 0;
  for (const v of scope.verifications) {
    byBackend[v.backend] = (byBackend[v.backend] ?? 0) + 1;
    verifyMs += v.durationMs;
  }
  return {
    llm_calls: scope.llm.length,
    prompt_tokens: prompt,
    completion_tokens: completion,
    llm_latency_ms: latency,
    by_model: byModel,
    by_role: byRole,
    estimated_cost: estimateCost(scope.llm),
    lean_verifications: scope.verifications.length,
    lean_verify_ms: verifyMs,
    lean_by_backend: byBackend,
    wall_ms: Date.now() - scope.startedAt,
  };
}

function addTo(map: Record<string, ModelUsageBreakdown>, key: string, r: UsageRecord): void {
  if (!map[key]) map[key] = { requests: 0, promptTokens: 0, completionTokens: 0 };
  map[key].requests += 1;
  map[key].promptTokens += r.promptTokens;
  map[key].completionTokens += r.completionTokens;
}
