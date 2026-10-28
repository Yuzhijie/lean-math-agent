import { z } from "zod";
import { isOpenAiReasoningModel, loadConfig, LlmConfigError, type LlmConfig, type ModelEndpoint, type ModelRole, type ReasoningEffort } from "./config";
import { buildCacheKey, getGlobalCache } from "./cache";
import { billingCapReached, costCapReached, parseAndRecordUsage, recordLatency, scopeCostCap, setPriceTable, type RawUsage } from "./usage-tracker";
import { CancelledError, currentSignal, throwIfCancelled } from "../jobs";
import { logLlm, logDebug, type LlmLogEntry } from "./logger";
import { localizeMessages, lt, outputLocale } from "./output-locale";

export class LlmError extends Error {}
/** The usage scope spent its cost cap (PROOF_COST_CAP_USD); not retried, not a fault of the model. */
export class CostCapError extends LlmError {}

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
  /** Reasoning effort for this call (reasoning models only; overrides LLM_*_REASONING_EFFORT). */
  reasoningEffort?: ReasoningEffort;
  /**
   * Leave the prompt as written regardless of the UI language (no English
   * switch): for transcription, where the output must be in the source's language.
   */
  keepLanguage?: boolean;
}

// ── Message types for multi-turn conversations ────────────────────────
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /** Images sent with a user message, as data URLs (data:image/png;base64,…). Needs a vision model. */
  images?: string[];
}

/** OpenAI chat format: a message with images becomes text + image_url parts. */
function wireMessage(m: ChatMessage): Record<string, unknown> {
  if (!m.images?.length) return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: [{ type: "text", text: m.content }, ...m.images.map((url) => ({ type: "image_url", image_url: { url } }))],
  };
}

// ── Single-turn convenience (backward compatible) ─────────────────────
export async function chatJson<T>(args: CallOptions & {
  system: string;
  user: string;
  /** Images sent with the user message (data URLs); needs a model that reads images (role "vision"). */
  images?: string[];
  schema: z.ZodType<T>;
  schemaName: string;
  /** Max Zod-validation retries (default 1). Set 0 for time-sensitive calls. */
  maxRetries?: number;
}): Promise<T> {
  const { system, user, images, ...rest } = args;
  return chatJsonMultiTurn({
    ...rest,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user, ...(images?.length ? { images } : {}) },
    ],
  });
}

// ── Multi-turn with Zod validation + retry ────────────────────────────
export async function chatJsonMultiTurn<T>(args: CallOptions & {
  messages: ChatMessage[];
  schema: z.ZodType<T>;
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
          // Zod 4: .transform()/z.preprocess() wrap the array in a pipe
          (fieldSchema instanceof z.ZodPipe &&
            (fieldSchema.in instanceof z.ZodArray || fieldSchema.out instanceof z.ZodArray))
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
  return JSON.parse(fixLatexEscapes(raw));
}

/**
 * LaTeX commands whose first letter is also a JSON escape (\b \f \n \r \t): a model that writes
 * "\frac" or "\times" with one backslash produces valid JSON with a form feed or a tab in it, and
 * the maths is silently lost ("\angle" and the like, an invalid escape, would fail to parse).
 */
const LATEX_ON_JSON_ESCAPE =
  /^(?:b(?:eta|inom|ar|ig|igg|ox|oxed|egin|ot|ullet|ackslash|mod|f)|f(?:rac|orall|lat|box)|n(?:eq|e|abla|ot|otin|u|eg|i|leq|geq|mid|ewline|ewcommand|parallel|subseteq|ormalsize)|r(?:ight|angle|ceil|floor|ho|ightarrow|Rightarrow|m|aisebox)|t(?:imes|heta|an|ext|extbf|extrm|frac|o|op|riangle|ilde|herefore|au|imes|anh|extit))(?![A-Za-z])/;

/**
 * Doubles backslashes the model meant as LaTeX inside JSON strings: before a LaTeX command that
 * starts with a JSON escape letter (\frac, \times, \neq, \right, \beta), and before any letter
 * that is not a JSON escape (\angle, \sqrt, \le). Real escapes (\n, \", \\, \u00e9) are kept.
 */
export function fixLatexEscapes(raw: string): string {
  if (!raw.includes("\\")) return raw;
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = raw[i + 1] ?? "";
    if (next === "\\" || next === '"' || next === "/") {
      out += c + next;
      i++;
      continue;
    }
    if (next === "u" && /^[0-9a-fA-F]{4}$/.test(raw.slice(i + 2, i + 6))) {
      out += c;
      continue;
    }
    if ("bfnrt".includes(next) && next !== "") {
      out += LATEX_ON_JSON_ESCAPE.test(raw.slice(i + 1)) ? "\\\\" : c;
      continue;
    }
    // Not a JSON escape at all (\angle, \sqrt, \(, \{): keep the backslash as text.
    out += "\\\\";
  }
  return out;
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
  const configuredEffort = config.roleReasoningEffort[role] ?? config.reasoningEffort;
  // A per-call effort only overrides where reasoning is in play (a
  // reasoning model, or an effort configured for it); other models would
  // reject the parameter.
  const effort = options.reasoningEffort !== undefined && (byName || configuredEffort !== undefined) ? options.reasoningEffort : configuredEffort;
  const reasoningOn = effort !== undefined ? effort !== "none" : byName;

  const sendSampling =
    config.samplingParams === "always" ||
    (config.samplingParams === "auto" && (effort === "none" || (!byName && effort === undefined)));

  const openAiHost = /api\.openai\.com|openai\.azure\.com/i.test(endpoint.baseUrl);
  // OpenRouter normalises OpenAI models itself: it documents `max_tokens`
  // and the `reasoning: { effort }` object, and ignores what a model does
  // not support — so it gets the generic dialect plus its reasoning object.
  const openRouter = /openrouter\.ai/i.test(endpoint.baseUrl);
  const maxTokensKey =
    config.maxTokensParam === "auto"
      ? (byName || openAiHost) && !openRouter
        ? "max_completion_tokens"
        : "max_tokens"
      : config.maxTokensParam;
  const reasoningParam =
    config.reasoningParam === "auto" ? (openRouter ? "reasoning" : "reasoning_effort") : config.reasoningParam;
  const maxTokens =
    options.maxTokens === undefined
      ? undefined
      : reasoningOn
        ? options.maxTokens + config.reasoningTokenBudget
        : options.maxTokens;

  return {
    model: endpoint.model,
    messages: messages.map(wireMessage),
    ...(sendSampling && options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(sendSampling && options.topP !== undefined ? { top_p: options.topP } : {}),
    ...(maxTokens !== undefined ? { [maxTokensKey]: maxTokens } : {}),
    ...(options.stop && options.stop.length ? { stop: options.stop } : {}),
    ...(effort !== undefined
      ? reasoningParam === "reasoning"
        ? { reasoning: { effort } }
        : { reasoning_effort: effort }
      : {}),
    ...(config.enableThinking ? { enable_thinking: true } : {}),
    ...(options.jsonMode ? { response_format: { type: "json_object" } } : {}),
  };
}

// ══════════════════════════════════════════════════════════════════════
// ── Core API call — enhanced with retry, fallback, cache, tracking ───
// ══════════════════════════════════════════════════════════════════════

async function rawChatMessages(
  inputMessages: ChatMessage[],
  options: CallOptions = {},
): Promise<string> {
  // Write user-facing text in the UI language (see output-locale.ts).
  const messages = options.keepLanguage ? inputMessages : localizeMessages(inputMessages, await outputLocale(), { minimal: options.role === "prover" });
  let config: LlmConfig;
  try {
    config = loadConfig();
  } catch (e) {
    // A broken .env value is a configuration problem, not a transient error.
    if (e instanceof LlmConfigError) throw new LlmError(e.message);
    throw e;
  }
  setPriceTable(config.prices);
  // A cancelled job makes no new calls (lib/jobs.ts).
  throwIfCancelled();
  if (costCapReached()) throw new CostCapError(`cost cap reached ($${scopeCostCap()} for this run)`);
  if (billingCapReached()) throw new CostCapError("today's spend limit for this account is used up");
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
    // OpenRouter answers 402 "can only afford N" when the balance does not cover max_tokens (with
    // none given it reserves the model's whole output limit): one retry asks for what is affordable.
    let tokenCap: number | undefined;

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
        // Node's fetch gives up when no response headers arrive within 5 minutes, and a server
        // answering without streaming (Ollama) sends them only when the whole answer is ready: a
        // call allowed longer than that streams, so the headers come at once and tokens as they go.
        const stream = Math.min(remaining, requestTimeout) > STREAM_AFTER_MS;
        const reqBody = capMaxTokens(buildRequestBody(config, endpoint, role, messages, { ...options, temperature: temp, jsonMode }), tokenCap);
        const res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${endpoint.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(stream ? { ...reqBody, stream: true, stream_options: { include_usage: true } } : reqBody),
          signal: jobSignal(AbortSignal.timeout(Math.min(remaining, requestTimeout))),
        });

        if (res.ok) {
          const data = (stream ? await readStreamed(res) : await res.json()) as {
            choices?: { message?: { content?: string; reasoning?: string; reasoning_content?: string }; finish_reason?: string }[];
            usage?: RawUsage;
          };
          const latencyMs = Date.now() - startTime;
          const choice = data.choices?.[0];
          // Local servers (Ollama, vLLM with a reasoning parser) put a thinking model's text in
          // `reasoning` and may leave `content` empty; a prover's answer is read from the whole text.
          const reasoningText = choice?.message?.reasoning ?? choice?.message?.reasoning_content;
          const content = choice?.message?.content || (role === "prover" && !jsonMode ? reasoningText : undefined);
          if (!content) {
            lastError =
              "LLM returned empty content" +
              ` (finish_reason ${choice?.finish_reason ?? "none"}, ${data.usage?.completion_tokens ?? "?"} completion tokens` +
              (reasoningText ? `, ${reasoningText.length} characters of reasoning only` : "") +
              ")";
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

        if (status === 402 && tokenCap === undefined) {
          const cap = affordableTokens(body);
          if (cap !== undefined) {
            tokenCap = cap;
            attempt--; // not a retry of the same request
            continue;
          }
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
        // The job was cancelled while the request ran: stop, do not retry or fall back.
        if (currentSignal()?.aborted) throw new CancelledError();
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
          // The model needed longer than the window it was given.
          recordLatency(role, Math.min(remaining, requestTimeout) * 1.5);
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
  if (/^LLM HTTP 402/.test(lastError)) throw new LlmError(creditMessage(lastError));
  throw new LlmError(lastError);
}

/** Smallest output budget worth asking for after a 402: below it answers are cut off anyway. */
const MIN_AFFORDABLE_TOKENS = 4096;

/** The "can only afford N" of an OpenRouter 402 body, less a margin; undefined when absent or too small. */
export function affordableTokens(body: string): number | undefined {
  const m = /can only afford (\d+)/i.exec(body);
  if (!m) return undefined;
  const n = Math.floor(Number(m[1]) * 0.9);
  return n >= MIN_AFFORDABLE_TOKENS ? n : undefined;
}

/** The request body with its output budget at most `cap` (max_tokens added when it had none). */
export function capMaxTokens(body: Record<string, unknown>, cap: number | undefined): Record<string, unknown> {
  if (cap === undefined) return body;
  const key = "max_completion_tokens" in body ? "max_completion_tokens" : "max_tokens";
  const now = typeof body[key] === "number" ? (body[key] as number) : Infinity;
  return { ...body, [key]: Math.min(now, cap) };
}

/** A 402 explained: the model provider's balance or the key's limit is used up. */
function creditMessage(raw: string): string {
  const afford = /can only afford (\d+)/i.exec(raw)?.[1];
  return lt(
    `模型服务的余额不足（HTTP 402${afford ? `，当前余额只够约 ${afford} 个 token` : ""}）：请在 OpenRouter 充值（openrouter.ai/settings/credits），或提高这个 API key 的额度上限。原始信息：${raw}`,
    `The model provider's balance is too low (HTTP 402${afford ? `; it covers about ${afford} tokens` : ""}): add credits on OpenRouter (openrouter.ai/settings/credits) or raise this API key's limit. Raw message: ${raw}`,
  );
}

// ── Backoff & timing helpers ──────────────────────────────────────────

/** The request's timeout combined with the running job's cancel signal, when there is one. */
function jobSignal(timeout: AbortSignal): AbortSignal {
  const job = currentSignal();
  return job ? AbortSignal.any([timeout, job]) : timeout;
}

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
  // "fetch failed" whose cause is undici's own headers / body timeout (5 minutes without a byte)
  const cause = error && typeof error === "object" && "cause" in error ? (error as { cause?: { code?: unknown } }).cause : undefined;
  const code = cause && typeof cause === "object" ? String(cause.code ?? "") : "";
  return (
    name === "TimeoutError" ||
    name === "AbortError" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT" ||
    message.includes("aborted due to timeout")
  );
}

/** Calls allowed longer than this stream (Node's fetch waits at most 5 minutes for the headers). */
const STREAM_AFTER_MS = 240_000;

/**
 * An OpenAI-compatible streamed answer (`data: {…}` lines, `data: [DONE]`) put back together in
 * the shape of a plain answer: content, reasoning (Ollama's `reasoning`, vLLM's
 * `reasoning_content`), finish reason and usage (the last chunk with `include_usage`).
 */
export async function readStreamed(res: Response): Promise<{
  choices: { message: { content: string; reasoning?: string }; finish_reason?: string }[];
  usage?: RawUsage;
}> {
  let content = "";
  let reasoning = "";
  let finish: string | undefined;
  let usage: RawUsage | undefined;
  const take = (line: string) => {
    const t = line.trim();
    if (!t.startsWith("data:")) return;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let chunk: { choices?: { delta?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null }; finish_reason?: string | null }[]; usage?: RawUsage; error?: unknown };
    try {
      chunk = JSON.parse(payload);
    } catch {
      return; // a keep-alive or a partial line
    }
    if (chunk.error) throw new LlmError(`LLM stream error: ${JSON.stringify(chunk.error).slice(0, 300)}`);
    const c = chunk.choices?.[0];
    if (c?.delta?.content) content += c.delta.content;
    const r = c?.delta?.reasoning ?? c?.delta?.reasoning_content;
    if (r) reasoning += r;
    if (c?.finish_reason) finish = c.finish_reason;
    if (chunk.usage) usage = chunk.usage;
  };
  if (!res.body) {
    for (const line of (await res.text()).split("\n")) take(line);
  } else {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        take(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer) take(buffer);
  }
  return { choices: [{ message: { content, ...(reasoning ? { reasoning } : {}) }, ...(finish ? { finish_reason: finish } : {}) }], ...(usage ? { usage } : {}) };
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
