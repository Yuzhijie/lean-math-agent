import { z } from "zod";
import { loadConfig, type ModelEndpoint } from "./config";
import { buildCacheKey, getGlobalCache } from "./cache";
import { parseAndRecordUsage, type RawUsage } from "./usage-tracker";
import { logLlm, logDebug, type LlmLogEntry } from "./logger";

export class LlmError extends Error {}

// ── Message types for multi-turn conversations ────────────────────────
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ── Single-turn convenience (backward compatible) ─────────────────────
export async function chatJson<T>(args: {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  schemaName: string;
  temperature?: number;
  /** Per-call timeout override (ms). Falls back to config LLM_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Max Zod-validation retries (default 1). Set 0 for time-sensitive calls. */
  maxRetries?: number;
}): Promise<T> {
  return chatJsonMultiTurn({
    messages: [
      { role: "system", content: args.system },
      { role: "user", content: args.user },
    ],
    schema: args.schema,
    schemaName: args.schemaName,
    temperature: args.temperature,
    timeoutMs: args.timeoutMs,
    maxRetries: args.maxRetries,
  });
}

// ── Multi-turn with Zod validation + retry ────────────────────────────
export async function chatJsonMultiTurn<T>(args: {
  messages: ChatMessage[];
  schema: z.ZodType<T>;
  schemaName: string;
  temperature?: number;
  maxRetries?: number;
  /** Per-call timeout override (ms). Falls back to config LLM_TIMEOUT_MS. */
  timeoutMs?: number;
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
    const raw = await rawChatMessages(messages, args.temperature, Math.min(remaining, perCallTimeout));
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
export async function chatText(args: {
  messages: ChatMessage[];
  temperature?: number;
  /** Per-call timeout override (ms). Falls back to config LLM_TIMEOUT_MS. */
  timeoutMs?: number;
}): Promise<string> {
  return rawChatMessages(args.messages, args.temperature, args.timeoutMs);
}

// ── Parsing helpers ───────────────────────────────────────────────────
function tryParse<T>(
  schema: z.ZodType<T>,
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
// ── Core API call — enhanced with retry, fallback, cache, tracking ───
// ══════════════════════════════════════════════════════════════════════

async function rawChatMessages(
  messages: ChatMessage[],
  temperature?: number,
  timeoutMs?: number,
): Promise<string> {
  const config = loadConfig();
  const temp = temperature ?? 0.2;
  const requestTimeout = timeoutMs ?? config.timeoutMs;

  // Overall deadline: allows ~2.5 sequential request attempts within the
  // per-request timeout budget, preventing unbounded retry/fallback loops
  // from exceeding the caller's time window.
  const deadline = Date.now() + Math.max(requestTimeout * 2.5, 150_000);

  if (!config.primary.apiKey) {
    throw new LlmError("LLM_API_KEY is not set");
  }

  // ── Check cache ──────────────────────────────────────────────────
  if (config.cacheEnabled) {
    const cache = getGlobalCache(config.cacheMaxSize);
    const cacheKey = buildCacheKey(
      config.primary.model,
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

  // ── Build endpoint chain: primary + fallbacks ────────────────────
  const endpoints: ModelEndpoint[] = [config.primary, ...config.fallbacks];
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
          body: JSON.stringify({
            model: endpoint.model,
            temperature: temp,
            messages,
            ...(config.enableThinking ? { enable_thinking: true } : {}),
            ...(config.jsonMode
              ? { response_format: { type: "json_object" } }
              : {}),
          }),
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
          const usage = parseAndRecordUsage(endpoint.model, data.usage);

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
          if (config.cacheEnabled) {
            const cache = getGlobalCache(config.cacheMaxSize);
            const cacheKey = buildCacheKey(
              endpoint.model,
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
