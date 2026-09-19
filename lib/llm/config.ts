// ── Centralized LLM Configuration ─────────────────────────────────────
//
// Parses all LLM-related environment variables into a typed config object.
// Single source of truth — consumed by client.ts on every request.

export interface ModelEndpoint {
  model: string;
  baseUrl: string;
  apiKey: string;
}

export type LogLevel = "silent" | "error" | "info" | "debug";

export interface LlmConfig {
  /** Primary model endpoint */
  primary: ModelEndpoint;
  /** Fallback chain — tried in order after primary is exhausted */
  fallbacks: ModelEndpoint[];
  /** Max HTTP retries per endpoint for 429/5xx (default 3) */
  maxHttpRetries: number;
  /** Base delay for exponential backoff in ms (default 500) */
  baseRetryDelayMs: number;
  /** Per-request timeout in ms (default 120000) */
  timeoutMs: number;
  /** Whether to send response_format: json_object (default true) */
  jsonMode: boolean;
  /** Whether to enable thinking mode for thinking-capable models (default false) */
  enableThinking: boolean;
  /** Enable in-memory LRU response cache (default false) */
  cacheEnabled: boolean;
  /** Max entries in the LRU cache (default 100) */
  cacheMaxSize: number;
  /** Log verbosity (default "error") */
  logLevel: LogLevel;
}

const VALID_LOG_LEVELS = new Set<LogLevel>([
  "silent",
  "error",
  "info",
  "debug",
]);

/**
 * Load LLM configuration from environment variables.
 * Called per-request so env changes take effect without restart.
 */
export function loadConfig(): LlmConfig {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    // Defer the error — client.ts will throw LlmError when it actually needs the key
    // This allows config to be loaded in contexts that don't make API calls.
  }

  const baseUrl = (
    process.env.LLM_BASE_URL ?? "https://api.openai.com/v1"
  ).replace(/\/$/, "");
  const model = process.env.LLM_MODEL ?? "gpt-4.1";

  // Parse fallback models
  const fallbackModels = parseFallbackModels(
    process.env.LLM_FALLBACK_MODELS,
  );
  const fallbackBaseUrl = (
    process.env.LLM_FALLBACK_BASE_URL ?? baseUrl
  ).replace(/\/$/, "");
  const fallbackApiKey = process.env.LLM_FALLBACK_API_KEY ?? apiKey ?? "";

  const fallbacks: ModelEndpoint[] = fallbackModels.map((m) => ({
    model: m,
    baseUrl: fallbackBaseUrl,
    apiKey: fallbackApiKey,
  }));

  // Parse log level
  const rawLogLevel = (process.env.LLM_LOG_LEVEL ?? "error").toLowerCase();
  const logLevel: LogLevel = VALID_LOG_LEVELS.has(rawLogLevel as LogLevel)
    ? (rawLogLevel as LogLevel)
    : "error";

  return {
    primary: { model, baseUrl, apiKey: apiKey ?? "" },
    fallbacks,
    maxHttpRetries: parseNonNegativeInt(process.env.LLM_MAX_HTTP_RETRIES, 3),
    baseRetryDelayMs: parsePositiveInt(
      process.env.LLM_BASE_RETRY_DELAY_MS,
      500,
    ),
    timeoutMs: parsePositiveInt(process.env.LLM_TIMEOUT_MS, 120_000),
    jsonMode: process.env.LLM_JSON_MODE !== "false",
    enableThinking: process.env.LLM_ENABLE_THINKING === "true",
    cacheEnabled: process.env.LLM_CACHE_ENABLED === "true",
    cacheMaxSize: parsePositiveInt(process.env.LLM_CACHE_MAX_SIZE, 100),
    logLevel,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────

function parseFallbackModels(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
