// ── Structured JSON Logger ─────────────────────────────────────────────
//
// Outputs structured log entries for LLM requests to console.error (stderr).
// This avoids polluting stdout, which may be used for API responses or CLI output.
//
// Level hierarchy: silent < error < info < debug

import type { LogLevel } from "./config";

export interface LlmLogEntry {
  /** Model that served the response */
  model: string;
  /** API endpoint URL */
  endpoint: string;
  /** Number of messages in the request */
  messageCount: number;
  /** Sampling temperature */
  temperature: number;
  /** Total wall-clock latency in ms */
  latencyMs: number;
  /** Prompt tokens consumed */
  promptTokens?: number;
  /** Completion tokens consumed */
  completionTokens?: number;
  /** Whether the response was served from cache */
  cacheHit: boolean;
  /** Whether a fallback model was used */
  fallbackUsed: boolean;
  /** Number of HTTP retries attempted on this endpoint */
  httpRetries: number;
  /** Error message (only for error-level entries) */
  error?: string;
}

// ── Level ordering ────────────────────────────────────────────────────

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  info: 2,
  debug: 3,
};

function shouldLog(entryLevel: LogLevel, configLevel: LogLevel): boolean {
  return LEVEL_ORDER[entryLevel] <= LEVEL_ORDER[configLevel];
}

// ── Main logging function ─────────────────────────────────────────────

/**
 * Log an LLM request entry if the entry's level is within the configured threshold.
 */
export function logLlm(
  entryLevel: LogLevel,
  configLevel: LogLevel,
  entry: LlmLogEntry,
): void {
  if (!shouldLog(entryLevel, configLevel)) return;

  const output = {
    ts: new Date().toISOString(),
    level: entryLevel,
    ...entry,
  };

  console.error(JSON.stringify(output));
}

/**
 * Log a debug-level entry with request/response body excerpts.
 * Only emits when config log level is "debug".
 */
export function logDebug(
  configLevel: LogLevel,
  entry: LlmLogEntry & {
    requestBody?: string;
    responseBody?: string;
  },
): void {
  if (!shouldLog("debug", configLevel)) return;

  const output = {
    ts: new Date().toISOString(),
    level: "debug" as const,
    ...entry,
    // Truncate bodies to avoid log bloat
    requestBody: truncate(entry.requestBody, 500),
    responseBody: truncate(entry.responseBody, 500),
  };

  console.error(JSON.stringify(output));
}

// ── Helpers ───────────────────────────────────────────────────────────

function truncate(s: string | undefined, maxLen: number): string | undefined {
  if (!s) return s;
  return s.length > maxLen ? s.slice(0, maxLen) + "…[truncated]" : s;
}
