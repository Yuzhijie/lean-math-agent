// ── Token Usage Tracker ────────────────────────────────────────────────
//
// In-memory accumulator for LLM token usage.
// Parses the `usage` field from OpenAI-compatible API responses.
// Provides per-model breakdowns and aggregate summaries.

export interface UsageRecord {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
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

// ── Module-level singleton store ──────────────────────────────────────

const records: UsageRecord[] = [];

/**
 * Record a single LLM call's token usage.
 */
export function recordUsage(record: UsageRecord): void {
  records.push(record);
}

/**
 * Parse raw usage field from API response and record it.
 * Always records the request, even when usage data is missing (tokens default to 0).
 */
export function parseAndRecordUsage(
  model: string,
  raw: RawUsage | undefined,
): UsageRecord {
  const promptTokens = raw?.prompt_tokens ?? 0;
  const completionTokens = raw?.completion_tokens ?? 0;
  const totalTokens = raw?.total_tokens ?? promptTokens + completionTokens;

  const record: UsageRecord = {
    model,
    promptTokens,
    completionTokens,
    totalTokens,
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

    if (!byModel[r.model]) {
      byModel[r.model] = { requests: 0, promptTokens: 0, completionTokens: 0 };
    }
    byModel[r.model].requests += 1;
    byModel[r.model].promptTokens += r.promptTokens;
    byModel[r.model].completionTokens += r.completionTokens;
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
