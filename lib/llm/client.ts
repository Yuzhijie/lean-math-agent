import { z } from "zod";
import { isOpenAiReasoningModel, loadConfig, type LlmConfig, type ModelEndpoint, type ModelRole } from "./config";
import { buildCacheKey, getGlobalCache } from "./cache";
import { parseAndRecordUsage, setPriceTable, type RawUsage } from "./usage-tracker";
import { logLlm, logDebug, type LlmLogEntry } from "./logger";

export class LlmError extends Error {}

/** Sampling / routing options shared by every entry point. */
export interface CallOptions {
  /** Which endpoint chain to use (default "general"). See ModelRole. */
  role?: ModelRole;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** Stop sequences (useful for completion-style prover models). */
  stop?: string[];
  /** Per-call timeout override (ms). Falls back to config LLM_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Send `response_format: json_object`. Default: config LLM_JSON_MODE for JSON calls, off for text. */
  jsonMode?: boolean;
  /** Bypass the response cache (sampling at temperature > 0 must not be served from it). */
  noCache?: boolean;
}

// ── Message types for multi-turn conversations ────────────────────────
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ── Single-turn convenience (backward compatible) ─────────────────────
export async function chatJson<T>(args: CallOptions & {
  system: string;
  user: string;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  schemaName: string;
  /** Max Zod-validation retries (default 1). Set 0 for time-sensitive calls. */
  maxRetries?: number;
}): Promise<T> {
  const { system, user, ...rest } = args;
  return chatJsonMultiTurn({
    ...rest,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
}

// ── Multi-turn with Zod validation + retry ────────────────────────────
export async function chatJsonMultiTurn<T>(args: CallOptions & {
  messages: ChatMessage[];
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  schemaName: string;
  maxRetries?: number;
}): Promise<T> {
  const maxRetries = args.maxRetries ?? 1;
  const messages = [...args.messages];
  let lastError = "";

  // Overall deadline for all Zod-validation attempts combined
  const perCallTimeout = args.timeoutMs ?? loadConfig().timeoutMs;
  const deadline = Date.now() + Math.max(perCallTimeout * 2.5, 150_000);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < 5_000) break;
    const raw = await rawChatMessages(messages, {
      ...args,
      timeoutMs: Math.min(remaining, perCallTimeout),
      jsonMode: args.jsonMode ?? loadConfig().jsonMode,
    });
    const parsed = tryParse(args.schema, raw);
    if (parsed.ok) return parsed.value;

    lastError = parsed.error;

    // Append error feedback for next attempt (but not after last)
    if (attempt < maxRetries) {
      // Find the last user message and append error feedback to it
      // This preserves the [system, user] structure for backward compat
      const lastUserIdx = messages.findLastIndex(
        (m) => m.role === "user",
      );
      if (lastUserIdx >= 0) {
        messages[lastUserIdx] = {
          ...messages[lastUserIdx],
          content: `${messages[lastUserIdx].content}\n\nYour previous JSON was invalid for ${args.schemaName}: ${parsed.error}\nReturn ONLY valid JSON.`,
        };
      }
    }
  }

  throw new LlmError(
    `Invalid LLM JSON for ${args.schemaName}: ${lastError}`,
  );
}

// ── Raw text chat (no JSON validation) ────────────────────────────────
export async function chatText(args: CallOptions & {
  messages: ChatMessage[];
}): Promise<string> {
  // Free text must not be forced into JSON mode (Lean code, prose).
  return rawChatMessages(args.messages, { ...args, jsonMode: args.jsonMode ?? false });
}

// ── Sampling: n independent completions ───────────────────────────────

/**
 * Draw `n` independent samples (parallel requests at `temperature`, default
 * 0.8). Providers differ in `n` support, so this issues separate requests.
 * Resolves with the successful samples (duplicates removed) as long as at
 * least one succeeded; throws the last error when all failed.
 */
export async function sampleText(args: CallOptions & {
  messages: ChatMessage[];
  n: number;
}): Promise<string[]> {
  const n = Math.max(1, Math.floor(args.n));
  const opts: CallOptions = {
    ...args,
    temperature: args.temperature ?? 0.8,
    jsonMode: args.jsonMode ?? false,
    noCache: args.noCache ?? true,
  };
  const settled = await Promise.allSettled(
    Array.from({ length: n }, () => rawChatMessages(args.messages, opts)),
  );
  const ok: string[] = [];
  let lastError: unknown;
  for (const r of settled) {
    if (r.status === "fulfilled") ok.push(r.value);
    else lastError = r.reason;
  }
  if (ok.length === 0) {
    throw lastError instanceof Error ? lastError : new LlmError(String(lastError));
  }
  return [...new Set(ok)];
}

// ── Parsing helpers ───────────────────────────────────────────────────
function tryParse<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  text: string,
): { ok: true; value: T } | { ok: false; error: string } {
  try {
    let json = extractJson(text);

    if (schema instanceof z.ZodObject) {
      const shape = schema.shape as Record<string, z.ZodTypeAny>;

      // Find the expected array-typed field in the schema
      let expectedArrayKey: string | null = null;
      for (const [key, fieldSchema] of Object.entries(shape)) {
        if (
          fieldSchema instanceof z.ZodArray ||
          (fieldSchema instanceof z.ZodEffects &&
            fieldSchema._def.schema instanceof z.ZodArray)
        ) {
          expectedArrayKey = key;
          break;
        }
      }

      // Case 1: LLM returned a bare array — wrap it
      if (Array.isArray(json) && expectedArrayKey) {
        json = { [expectedArrayKey]: json };
      }
      // Case 2: LLM returned an object with a different array key name
      else if (
        json &&
        typeof json === "object" &&
        !Array.isArray(json) &&
        expectedArrayKey
      ) {
        const obj = json as Record<string, unknown>;
        // If the expected key is missing, find any array-valued property
        if (!(expectedArrayKey in obj)) {
          for (const [key, value] of Object.entries(obj)) {
            if (Array.isArray(value)) {
              obj[expectedArrayKey] = value;
              delete obj[key];
              break;
            }
          }
        }
        json = obj;
      }
    }

    return { ok: true, value: schema.parse(json) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : trimmed;
  return JSON.parse(raw);
}

// ══════════════════════════════════════════════════════════════════════
// ── Request body (provider dialects) ─────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

/**
 * Chat Completions body for one endpoint. OpenAI reasoning models
 * (GPT-5.x incl. gpt-5.6-luna, GPT-6, o-series) speak a different dialect:
 * they reject `temperature`/`top_p` unless reasoning is "none", reject
 * `max_tokens` in favour of `max_completion_tokens` (which also counts the
 * hidden reasoning tokens), and take `reasoning_effort`. Everything is
 * overridable from the environment (see LlmConfig).
 */
export function buildRequestBody(
  config: LlmConfig,
  endpoint: ModelEndpoint,
  role: ModelRole,
  messages: ChatMessage[],
  options: CallOptions,
): Record<string, unknown> {
  const byName = isOpenAiReasoningModel(endpoint.model);
  const effort = config.roleReasoningEffort[role] ?? config.reasoningEffort;
  const reasoningOn = effort !== undefined ? effort !== "none" : byName;

  const sendSampling =
    config.samplingParams === "always" ||
    (config.samplingParams === "auto" && (effort === "none" || (!byName && effort === undefined)));

  const openAiHost = /api\.openai\.com|openai\.azure\.com/i.test(endpoint.baseUrl);
  const maxTokensKey =
    config.maxTokensParam === "auto"
      ? byName || openAiHost
        ? "max_completion_tokens"
        : "max_tokens"
      : config.maxTokensParam;
  const maxTokens =
    options.maxTokens === undefined
      ? undefined
      : reasoningOn
        ? options.maxTokens + config.reasoningTokenBudget
        : options.maxTokens;

  return {
    model: endpoint.model,
    messages,
    ...(sendSampling && options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(sendSampling && options.topP !== undefined ? { top_p: options.topP } : {}),
    ...(maxTokens !== undefined ? { [maxTokensKey]: maxTokens } : {}),
    ...(options.stop && options.stop.length ? { stop: options.stop } : {}),
    ...(effort !== undefined ? { reasoning_effort: effort } : {}),
    ...(config.enableThinking ? { enable_thinking: true } : {}),
    ...(options.jsonMode ? { response_format: { type: "json_object" } } : {}),
  };
}

// ══════════════════════════════════════════════════════════════════════
// ── Core API call — enhanced with retry, fallback, cache, tracking ───
// ══════════════════════════════════════════════════════════════════════

async function rawChatMessages(
  messages: ChatMessage[],
  options: CallOptions = {},
): Promise<string> {
  const config = loadConfig();
  setPriceTable(config.prices);
  const role: ModelRole = options.role ?? "general";
  const temp = options.temperature ?? 0.2;
  const requestTimeout = options.timeoutMs ?? config.timeoutMs;
  const jsonMode = options.jsonMode ?? config.jsonMode;
  // Identity of the sampling configuration, for the cache key.
  const paramsKey = JSON.stringify({
    role,
    topP: options.topP ?? null,
    maxTokens: options.maxTokens ?? null,
    stop: options.stop ?? null,
    jsonMode,
  });

  // Overall deadline: allows ~2.5 sequential request attempts within the
  // per-request timeout budget, preventing unbounded retry/fallback loops
  // from exceeding the caller's time window.
  const deadline = Date.now() + Math.max(requestTimeout * 2.5, 150_000);

  // ── Build endpoint chain for the role ────────────────────────────
  const endpoints: ModelEndpoint[] = config.roles[role] ?? config.roles.general;
  if (!endpoints.some((e) => e.apiKey)) {
    throw new LlmError("LLM_API_KEY is not set");
  }

  // ── Check cache ──────────────────────────────────────────────────
  const useCache = config.cacheEnabled && !options.noCache;
  if (useCache) {
    const cache = getGlobalCache(config.cacheMaxSize);
    const cacheKey = buildCacheKey(
      `${endpoints[0].model}|${paramsKey}`,
      messages,
      temp,
    );
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      logLlm("info", config.logLevel, {
        model: config.primary.model,
        endpoint: config.primary.baseUrl,
        messageCount: messages.length,
        temperature: temp,
        latencyMs: 0,
        cacheHit: true,
        fallbackUsed: false,
        httpRetries: 0,
      });
      return cached;
    }
  }

  let lastError = "";

  for (let epIdx = 0; epIdx < endpoints.length; epIdx++) {
    const endpoint = endpoints[epIdx];
    const isFallback = epIdx > 0;
    const startTime = Date.now();
    let retriesUsed = 0;
    let endpointSucceeded = false;
    let retryAfterHeader: string | null = null;

    for (let attempt = 0; attempt <= config.maxHttpRetries; attempt++) {
      if (attempt > 0) {
        // Wait before retry
        const delay =
          parseRetryAfter(retryAfterHeader) ||
          backoffDelay(attempt - 1, config.baseRetryDelayMs);
        retryAfterHeader = null;
        await sleep(delay);
      }

      // Check overall deadline before each attempt
      const remaining = deadline - Date.now();
      if (remaining < 5_000) break;

      try {
        const res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${endpoint.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(
            buildRequestBody(config, endpoint, role, messages, { ...options, temperature: temp, jsonMode }),
          ),
          signal: AbortSignal.timeout(Math.min(remaining, requestTimeout)),
        });

        if (res.ok) {
          const latencyMs = Date.now() - startTime;
          const data = (await res.json()) as {
            choices?: { message?: { content?: string } }[];
            usage?: RawUsage;
          };
          const content = data.choices?.[0]?.message?.content;
          if (!content) {
            lastError = "LLM returned empty content";
            if (attempt < config.maxHttpRetries) {
              retriesUsed = attempt + 1;
              continue;
            }
            break;
          }

          // ── Track usage ─────────────────────────────────────
          const usage = parseAndRecordUsage(endpoint.model, data.usage, { role, latencyMs });

          // ── Log ─────────────────────────────────────────────
          const logEntry: LlmLogEntry = {
            model: endpoint.model,
            endpoint: endpoint.baseUrl,
            messageCount: messages.length,
            temperature: temp,
            latencyMs,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            cacheHit: false,
            fallbackUsed: isFallback,
            httpRetries: retriesUsed,
          };
          logLlm("info", config.logLevel, logEntry);
          logDebug(config.logLevel, {
            ...logEntry,
            responseBody: content,
          });

          // ── Cache ───────────────────────────────────────────
          if (useCache) {
            const cache = getGlobalCache(config.cacheMaxSize);
            const cacheKey = buildCacheKey(
              `${endpoints[0].model}|${paramsKey}`,
              messages,
              temp,
            );
            cache.set(cacheKey, content);
          }

          endpointSucceeded = true;
          return content;
        }

        // ── HTTP error — decide whether to retry ─────────────
        const status = res.status;
        const body = await res.text().catch(() => "");
        lastError = `LLM HTTP ${status}: ${body}`;

        // Track retry-after header for 429 responses
        if (status === 429) {
          retryAfterHeader = res.headers.get("retry-after");
        }

        const retryable =
          status === 429 ||
          status === 500 ||
          status === 502 ||
          status === 503 ||
          status === 529;

        if (!retryable || attempt >= config.maxHttpRetries) {
          retriesUsed = attempt;
          break;
        }

        retriesUsed = attempt + 1;
      } catch (networkError) {
        // Network/timeout error
        lastError =
          networkError instanceof Error
            ? networkError.message
            : String(networkError);

        // Timeouts get no same-endpoint retry: the server already had the
        // full requestTimeout window, so an identical retry just doubles the
        // worst-case wait with low odds of success. Fail over to the next
        // endpoint immediately instead.
        if (isTimeoutError(networkError, lastError)) {
          retriesUsed = attempt;
          break;
        }

        if (attempt < config.maxHttpRetries) {
          retriesUsed = attempt + 1;
          continue;
        }
        // Exhausted retries on this endpoint
        break;
      }
    }

    // ── Log endpoint failure before trying next fallback ─────────
    if (!endpointSucceeded) {
      const latencyMs = Date.now() - startTime;
      logLlm("error", config.logLevel, {
        model: endpoint.model,
        endpoint: endpoint.baseUrl,
        messageCount: messages.length,
        temperature: temp,
        latencyMs,
        cacheHit: false,
        fallbackUsed: isFallback,
        httpRetries: retriesUsed,
        error: lastError,
      });
    }
  }

  // ── All endpoints exhausted ──────────────────────────────────────
  throw new LlmError(lastError);
}

// ── Backoff & timing helpers ──────────────────────────────────────────

/**
 * True when a fetch failure is an AbortSignal.timeout abort.
 * undici surfaces these as DOMException with name "TimeoutError"
 * ("AbortError" on older runtimes); DOMException is not reliably an
 * instanceof Error across Node versions, so inspect .name structurally.
 */
function isTimeoutError(error: unknown, message: string): boolean {
  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name: unknown }).name)
      : "";
  return (
    name === "TimeoutError" ||
    name === "AbortError" ||
    message.includes("aborted due to timeout")
  );
}

/**
 * Compute exponential backoff delay with jitter.
 * Caps at 30 seconds.
 */
function backoffDelay(attempt: number, baseDelayMs: number): number {
  const exponential = baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * baseDelayMs;
  return Math.min(exponential + jitter, 30_000);
}

/**
 * Parse Retry-After header value.
 * Supports both seconds (number) and HTTP-date formats.
 * Returns delay in milliseconds, or 0 if unparseable.
 */
function parseRetryAfter(header: string | null): number {
  if (!header) return 0;
  const seconds = Number(header);
  if (!isNaN(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (!isNaN(date)) return Math.max(0, date - Date.now());
  return 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
