/**
 * Lean verification entry point.
 *
 *   verifyLeanSource(sessionId, source, opts) → LeanVerifyResult
 *
 * Pipeline:
 *   1. sanitize   — reject sources with code-executing / kernel-bypassing
 *                   commands (`#eval`, `elab`, `unsafe`, `axiom`, …)
 *   2. sorry gate — when a complete proof is required, reject `sorry` /
 *                   `admit` textually (comments and strings ignored)
 *   3. cache      — LRU on (source, options)
 *   4. REPL       — header env reuse, structured messages + sorry goals,
 *                   `#print axioms` and `#check` appended for the target
 *                   declaration; falls back to `lake env lean <file>`
 *   5. verdict    — ok ⇔ no errors ∧ (allowSorry ∨ (no sorries ∧ only the
 *                   standard axioms)) ∧ (no expectedSignature ∨ match)
 *
 * The `log` string keeps the old `<file>:<line>:<col>: <severity>: <msg>`
 * format consumed by `parse-log.ts`; everything else is structured.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { BuildStatus } from "../types";
import { recordVerification } from "../llm/usage-tracker";
import { parseLeanLog } from "./parse-log";
import { getReplPool, ReplError, replLauncherFromEnv, type ReplCommandResponse, type ReplWorker } from "./repl";
import { sanitizeLeanSource, splitHeader, stripCommentsAndStrings } from "./sanitize";
import {
  classifyAxioms,
  normalizeSignature,
  parseAxiomsMessage,
  parseCheckMessage,
  type AxiomReport,
} from "./axioms";

/** Max concurrent `lake env lean` processes in spawn mode. */
const LAKE_CONCURRENCY = Math.max(
  1,
  Math.min(4, Number(process.env.LEAN_LAKE_CONCURRENCY ?? 1)),
);
const VERIFY_LOG_FILE = "Verify.lean";

/**
 * Commands elaborated in front of every verified body. Lean's default
 * `autoImplicit true` would silently turn a misspelled or undeclared
 * variable in a statement into an implicit binder (`n = m` with no `m`
 * becomes `∀ {m n}, n = m`), so a typo could change what is being proved
 * without any error. Statements must declare everything they use.
 */
export const BODY_PRELUDE = "set_option autoImplicit false\n";
const PRELUDE_LINES = 1;

// Read per call so tests (and a running server whose .env changed) see the
// current values.
const spawnTimeoutMs = () => Number(process.env.LEAN_BUILD_TIMEOUT_MS ?? 120_000);
const serverMode = () => process.env.LEAN_SERVER_MODE ?? "server";
const allowNativeDecide = () => process.env.LEAN_ALLOW_NATIVE_DECIDE === "true";

// ── Public types ──────────────────────────────────────────────────────

export interface LeanDiagnostic {
  severity: "error" | "warning" | "info";
  /** 1-based line in the full source file (imports included). */
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string;
}

export interface LeanSorryInfo {
  line: number;
  column: number;
  /** Pretty-printed goal at the sorry (empty in spawn mode). */
  goal: string;
}

export interface LeanVerifyResult {
  ok: boolean;
  /** Text log in `Verify.lean:L:C: severity: message` form (or "ok"). */
  log: string;
  status: BuildStatus;
  backend: "repl" | "spawn" | "none";
  messages: LeanDiagnostic[];
  sorries: LeanSorryInfo[];
  /** Goals at each sorry, in source order (empty strings in spawn mode). */
  goals: string[];
  /**
   * Info-level output (positions stripped): `#print axioms` / `#check`
   * results, and "Try this: …" suggestions from `exact?`/`apply?`/`simp?`.
   */
  infos: string[];
  /** Axiom report for `theoremName`, when it was checked. */
  axioms?: AxiomReport;
  /** Pretty-printed type of `theoremName` (`#check @name`), when requested. */
  signature?: string;
  /** Whether `signature` equals `expectedSignature`, when both are known. */
  signatureMatch?: boolean;
  /** Set when the source was rejected before Lean ran. */
  rejected?: string;
  /** True when served from the verification cache (durationMs is then 0). */
  cached?: boolean;
  durationMs: number;
}

export type VerifyLeanOpts = {
  /**
   * When true, allow `sorry` in source (prove-step repair prefixes).
   * Final `/api/verify` must leave this false/undefined.
   */
  allowSorry?: boolean;
  /** Target declaration; enables the axiom check and `#check` signature. */
  theoremName?: string;
  /** Check axioms of `theoremName` (default: when theoremName is given). */
  checkAxioms?: boolean;
  /** Return the `#check @theoremName` signature (default: when theoremName is given). */
  wantSignature?: boolean;
  /** Fail unless the signature equals this (normalised) string. */
  expectedSignature?: string;
  /**
   * Internal: run on this already-leased REPL worker instead of taking one
   * from the pool (a ProofSession verifying its own result must not wait
   * for the worker it is holding).
   */
  worker?: ReplWorker;
  /** Per-call timeout (default: LEAN_REPL_TIMEOUT_MS / LEAN_BUILD_TIMEOUT_MS). */
  timeoutMs?: number;
};

// ── Verification result cache ─────────────────────────────────────────

const VERIFY_CACHE_MAX = 256;
const verificationCache = new Map<string, LeanVerifyResult>();

function buildVerifyCacheKey(source: string, opts: VerifyLeanOpts): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        source,
        allowSorry: !!opts.allowSorry,
        theoremName: opts.theoremName ?? null,
        checkAxioms: opts.checkAxioms ?? null,
        wantSignature: opts.wantSignature ?? null,
        expectedSignature: opts.expectedSignature ?? null,
      }),
    )
    .digest("hex");
}

function cacheGet(key: string): LeanVerifyResult | undefined {
  const v = verificationCache.get(key);
  if (v === undefined) return undefined;
  verificationCache.delete(key);
  verificationCache.set(key, v);
  return v;
}

function cacheSet(key: string, value: LeanVerifyResult): void {
  if (verificationCache.has(key)) {
    verificationCache.delete(key);
  } else if (verificationCache.size >= VERIFY_CACHE_MAX) {
    const oldest = verificationCache.keys().next().value;
    if (oldest !== undefined) verificationCache.delete(oldest);
  }
  verificationCache.set(key, value);
}

/** Clear the verification cache (for testing). */
export function clearVerificationCache(): void {
  verificationCache.clear();
}

/** Current verification cache size (for testing/monitoring). */
export function verificationCacheSize(): number {
  return verificationCache.size;
}

// ── Availability (cached) ─────────────────────────────────────────────

let lakeActive = 0;
const lakeWaiters: Array<() => void> = [];

async function withLakeSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (lakeActive >= LAKE_CONCURRENCY) {
    await new Promise<void>((resolve) => lakeWaiters.push(resolve));
  }
  lakeActive += 1;
  try {
    return await fn();
  } finally {
    lakeActive -= 1;
    const next = lakeWaiters.shift();
    if (next) next();
  }
}

export function sandboxRoot(): string {
  return path.resolve(process.env.LEAN_SANDBOX_PATH ?? "lean-sandbox");
}

const AVAILABILITY_TTL_MS = 60_000;
let availability: { at: number; result: { ok: true } | { ok: false; message: string } } | null = null;

export async function checkLeanAvailable(): Promise<
  { ok: true } | { ok: false; message: string }
> {
  if (availability && Date.now() - availability.at < AVAILABILITY_TTL_MS) {
    return availability.result;
  }
  let result: { ok: true } | { ok: false; message: string };
  if (replLauncherFromEnv()) {
    // A custom REPL launcher was configured: Lean lives wherever that
    // command points, so `lake` need not be on PATH.
    result = { ok: true };
    availability = { at: Date.now(), result };
    return result;
  }
  try {
    await withLakeSlot(() => runCmd("lake", ["--version"], sandboxRoot(), 10_000));
    result = { ok: true };
  } catch {
    result = {
      ok: false,
      message:
        "未检测到可用的 lake/Lean。请安装 elan（https://lean-lang.org/install/），确保 `lake --version` 可用，并检查 LEAN_SANDBOX_PATH。",
    };
  }
  availability = { at: Date.now(), result };
  return result;
}

/** Forget the cached availability result (for testing). */
export function resetLeanAvailability(): void {
  availability = null;
}

// ── Main entry point ──────────────────────────────────────────────────

const SORRY_TOKEN_RE = /\b(sorry|admit|sorryAx)\b/;

export async function verifyLeanSource(
  sessionId: string,
  source: string,
  opts: VerifyLeanOpts = {},
): Promise<LeanVerifyResult> {
  const started = Date.now();
  const result = await verifyLeanSourceUncounted(sessionId, source, opts, started);
  // Attribute the verification to the running pipeline (usage scope), so
  // the solve response can report how much Lean work a run needed.
  recordVerification(result.cached ? "cache" : result.backend, Date.now() - started);
  return result;
}

async function verifyLeanSourceUncounted(
  sessionId: string,
  source: string,
  opts: VerifyLeanOpts,
  started: number,
): Promise<LeanVerifyResult> {
  const base = (partial: Partial<LeanVerifyResult>): LeanVerifyResult => ({
    ok: false,
    log: "",
    status: "fail",
    backend: "none",
    messages: [],
    sorries: [],
    goals: [],
    infos: [],
    durationMs: Date.now() - started,
    ...partial,
  });

  // 1. Sanitize — never let code-executing commands reach Lean.
  const san = sanitizeLeanSource(source);
  if (!san.ok) {
    return base({ log: san.reason, rejected: san.reason });
  }

  // 2. Textual sorry gate for complete proofs (comments/strings ignored).
  if (!opts.allowSorry) {
    const { body } = splitHeader(source);
    if (SORRY_TOKEN_RE.test(stripCommentsAndStrings(body))) {
      const msg = "source contains `sorry`; final verify requires a complete proof";
      return base({ log: msg, rejected: msg });
    }
  }

  // 3. Cache.
  const cacheKey = buildVerifyCacheKey(source, opts);
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, durationMs: 0, cached: true };

  const avail = await checkLeanAvailable();
  if (!avail.ok) {
    return base({ log: avail.message, status: "unavailable" });
  }

  const checkAxioms = opts.checkAxioms ?? !!opts.theoremName;
  const wantSignature = opts.wantSignature ?? (!!opts.theoremName && (opts.expectedSignature !== undefined || !opts.allowSorry));
  const probes = buildProbes(opts.theoremName, checkAxioms, wantSignature);

  // 4. REPL (fast path) then spawn fallback.
  let raw: RawVerification | undefined;
  if (serverMode() !== "spawn") {
    try {
      raw = await verifyViaRepl(source, probes, opts.worker, opts.timeoutMs);
    } catch (e) {
      if (e instanceof ReplError && (e.kind === "timeout" || e.kind === "lean")) {
        // A timeout / Lean-level error is a verdict about this source, not
        // an infrastructure failure: report it rather than re-running the
        // same source through the slower spawn path.
        const result = base({
          log: `${VERIFY_LOG_FILE}:1:0: error: ${e.message}`,
          backend: "repl",
          messages: [{ severity: "error", line: 1, column: 0, message: e.message }],
        });
        cacheSet(cacheKey, result);
        return result;
      }
      // unavailable / crashed / protocol → spawn fallback below
    }
  }
  if (!raw) {
    try {
      raw = await verifyViaSpawn(sessionId, source, probes, opts.timeoutMs);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return base({ log: parseLeanLog(msg) || msg, status: "fail" });
    }
    if (looksLikeInfrastructureFailure(raw)) {
      // `lake` exists but the sandbox is not built / a dependency is missing:
      // that is "Lean unavailable", not a verdict about the source.
      const detail = raw.messages.map((m) => m.message).join("\n").slice(0, 1500);
      return base({
        log: `Lean 沙箱不可用（请在 lean-sandbox 中运行 \`lake exe cache get && lake build && lake build repl\`）:\n${detail}`,
        status: "unavailable",
        backend: "spawn",
      });
    }
  }

  // 5. Verdict.
  const result = deriveVerdict(raw, opts, checkAxioms, started);
  cacheSet(cacheKey, result);
  return result;
}

// ── Probes appended after the source (`#print axioms`, `#check`) ─────

interface Probes {
  name?: string;
  axioms: boolean;
  signature: boolean;
  /** Lean text to append (empty when nothing is probed). */
  text: string;
}

function buildProbes(name: string | undefined, axioms: boolean, signature: boolean): Probes {
  if (!name) return { axioms: false, signature: false, text: "" };
  const lines: string[] = [];
  if (axioms) lines.push(`#print axioms ${name}`);
  if (signature) lines.push(`#check @${name}`);
  return { name, axioms, signature, text: lines.length ? "\n" + lines.join("\n") + "\n" : "" };
}

interface RawVerification {
  backend: "repl" | "spawn";
  messages: LeanDiagnostic[];
  sorries: LeanSorryInfo[];
  /** Info lines (with positions stripped) — axioms / check output live here. */
  infos: string[];
  /** True when Lean reported "declaration uses sorry" (spawn mode only needs this). */
  sorryWarning: boolean;
}

// ── REPL path ─────────────────────────────────────────────────────────

async function verifyViaRepl(source: string, probes: Probes, leased?: ReplWorker, timeoutMs?: number): Promise<RawVerification> {
  const { imports, body, headerLines: importLines } = splitHeader(source);
  const pool = getReplPool(sandboxRoot());
  const run = async (worker: ReplWorker) => {
    const env = await worker.headerEnv(imports);
    return worker.command({ cmd: BODY_PRELUDE + body + probes.text, env }, timeoutMs ?? pool.config.commandTimeoutMs);
  };
  const resp: ReplCommandResponse = leased ? await run(leased) : await pool.withWorker(run);
  // Positions come back relative to the command; map them onto the source.
  const headerLines = importLines - PRELUDE_LINES;

  const messages: LeanDiagnostic[] = [];
  const infos: string[] = [];
  let sorryWarning = false;
  for (const m of resp.messages) {
    if (m.severity === "info") {
      infos.push(m.data);
      continue;
    }
    if (/declaration uses [`']sorry[`']/.test(m.data)) sorryWarning = true;
    messages.push({
      severity: m.severity,
      line: m.pos.line + headerLines,
      column: m.pos.column,
      endLine: m.endPos ? m.endPos.line + headerLines : undefined,
      endColumn: m.endPos?.column,
      message: m.data,
    });
  }
  const sorries: LeanSorryInfo[] = resp.sorries.map((s) => ({
    line: (s.pos?.line ?? 0) + headerLines,
    column: s.pos?.column ?? 0,
    goal: s.goal,
  }));
  return { backend: "repl", messages, sorries, infos, sorryWarning };
}

// ── Spawn fallback (`lake env lean <file>`) ───────────────────────────

const CLI_MESSAGE_RE = /^(.*?\.lean):(\d+):(\d+): (error|warning|info): ?(.*)$/;

async function verifyViaSpawn(
  sessionId: string,
  source: string,
  probes: Probes,
  timeoutMs?: number,
): Promise<RawVerification> {
  const root = sandboxRoot();
  const scratchDir = path.join(root, "Scratch");
  await fs.mkdir(scratchDir, { recursive: true });
  // Unique file per verification: concurrent calls (and a fixed session id
  // such as the autoformalizer's) must never overwrite each other.
  const safeId = path.basename(sessionId.replace(/\\/g, "/")).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
  const filePath = path.join(scratchDir, `Verify_${safeId}_${randomUUID().slice(0, 8)}.lean`);
  // The prelude goes right after the imports so positions shift by exactly
  // PRELUDE_LINES for everything in the body (mapped back below).
  const { imports, body } = splitHeader(source);
  const preludeAt = imports.length ? source.length - body.length : 0;
  await fs.writeFile(filePath, source.slice(0, preludeAt) + BODY_PRELUDE + source.slice(preludeAt) + probes.text, "utf8");
  const bodyStartLine = source.slice(0, preludeAt).split("\n").length; // 1-based line of the prelude
  let output: string;
  let exitError: string | undefined;
  try {
    output = await withLakeSlot(() => runCmd("lake", ["env", "lean", filePath], root, timeoutMs ?? spawnTimeoutMs()));
  } catch (e) {
    // Non-zero exit: the output is in the error message.
    exitError = e instanceof Error ? e.message : String(e);
    output = exitError;
  } finally {
    await fs.unlink(filePath).catch(() => undefined);
  }

  const messages: LeanDiagnostic[] = [];
  const sorries: LeanSorryInfo[] = [];
  const infos: string[] = [];
  let sorryWarning = false;
  let current: LeanDiagnostic | null = null;
  let lastInfo = -1;
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(CLI_MESSAGE_RE);
    if (m) {
      const severity = m[4] as LeanDiagnostic["severity"];
      const rawLine = parseInt(m[2], 10);
      current = {
        severity,
        line: rawLine >= bodyStartLine ? rawLine - PRELUDE_LINES : rawLine,
        column: parseInt(m[3], 10),
        message: m[5],
      };
      if (severity === "info") {
        lastInfo = infos.push(m[5]) - 1;
        current = null;
      } else {
        if (/declaration uses [`']sorry[`']/.test(m[5])) {
          sorryWarning = true;
          sorries.push({ line: current.line, column: current.column, goal: "" });
        }
        messages.push(current);
        lastInfo = -1;
      }
      continue;
    }
    if (line.trim() === "" || line.startsWith("timeout after")) continue;
    if (current) {
      // continuation (e.g. goals under "unsolved goals")
      current.message += "\n" + line;
      continue;
    }
    if (/^\s/.test(line) && lastInfo >= 0) {
      // continuation of a wrapped `#check` / `#print axioms` line
      infos[lastInfo] += "\n" + line;
      continue;
    }
    // Plain info output (`#print axioms`, `#check` print without a position)
    lastInfo = infos.push(line.trim()) - 1;
  }
  if (exitError?.startsWith("timeout after")) {
    messages.push({ severity: "error", line: 1, column: 0, message: exitError.split("\n")[0] });
  } else if (exitError && messages.every((d) => d.severity !== "error")) {
    // lean exited non-zero without a parsable error line (e.g. crash)
    messages.push({ severity: "error", line: 1, column: 0, message: exitError.slice(0, 2000) });
  }
  return { backend: "spawn", messages, sorries, infos, sorryWarning };
}

/**
 * True when the spawn output has no Lean diagnostic with a real position but
 * mentions lake/toolchain problems — i.e. the environment, not the source,
 * is broken.
 */
function looksLikeInfrastructureFailure(raw: RawVerification): boolean {
  const positioned = raw.messages.some((m) => !(m.line === 1 && m.column === 0));
  if (positioned) return false;
  const text = [...raw.messages.map((m) => m.message), ...raw.infos].join("\n");
  return /\b(lake|manifest|toolchain|elan|no such file|not found|unknown package|could not resolve|missing dependency|dependency)\b/i.test(text);
}

function runCmd(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timeout after ${timeoutMs}ms\n${out}`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(out || `exit ${code}`));
    });
  });
}

// ── Verdict ───────────────────────────────────────────────────────────

function deriveVerdict(
  raw: RawVerification,
  opts: VerifyLeanOpts,
  checkAxioms: boolean,
  started: number,
): LeanVerifyResult {
  const messages = [...raw.messages];
  const errors = messages.filter((m) => m.severity === "error");
  let ok = errors.length === 0;

  // Axioms / signature from the probe output.
  let axioms: AxiomReport | undefined;
  let signature: string | undefined;
  if (opts.theoremName) {
    for (const info of raw.infos) {
      const ax = parseAxiomsMessage(info, opts.theoremName);
      if (ax !== undefined && axioms === undefined) {
        axioms = classifyAxioms(ax, { allowNative: allowNativeDecide() });
        continue;
      }
      const sig = parseCheckMessage(info, opts.theoremName);
      if (sig !== undefined && signature === undefined) signature = sig;
    }
  }

  const sorryPresent = raw.sorries.length > 0 || raw.sorryWarning || axioms?.usesSorry === true;
  if (!opts.allowSorry && sorryPresent) {
    ok = false;
    if (errors.length === 0) {
      messages.push({
        severity: "error",
        line: raw.sorries[0]?.line ?? 1,
        column: raw.sorries[0]?.column ?? 0,
        message: "proof is incomplete: it still depends on `sorry`/`admit` (sorryAx)",
      });
    }
  }

  if (checkAxioms && opts.theoremName && ok) {
    if (!axioms) {
      ok = false;
      messages.push({
        severity: "error",
        line: 1,
        column: 0,
        message: `could not determine the axioms of '${opts.theoremName}' (declaration missing or renamed?)`,
      });
    } else if (axioms.disallowed.length > 0) {
      ok = false;
      messages.push({
        severity: "error",
        line: 1,
        column: 0,
        message: `'${opts.theoremName}' depends on disallowed axioms: [${axioms.disallowed.join(", ")}]` +
          (axioms.usesNative ? " (native_decide trusts the compiler, not the kernel)" : ""),
      });
    }
  }

  let signatureMatch: boolean | undefined;
  if (opts.expectedSignature !== undefined && opts.theoremName) {
    const expected = normalizeSignature(opts.expectedSignature);
    signatureMatch = signature !== undefined && signature === expected;
    if (!signatureMatch) {
      ok = false;
      messages.push({
        severity: "error",
        line: 1,
        column: 0,
        message: signature === undefined
          ? `could not read the statement of '${opts.theoremName}' to compare with the validated one`
          : `statement of '${opts.theoremName}' differs from the validated formalization:\n  proved:    ${signature}\n  validated: ${expected}`,
      });
    }
  }

  const log = formatLog(messages) || (ok ? "ok" : "verification failed (no messages)");
  return {
    ok,
    log,
    status: ok ? "ok" : "fail",
    backend: raw.backend,
    messages,
    sorries: raw.sorries,
    goals: raw.sorries.map((s) => s.goal),
    infos: raw.infos,
    axioms,
    signature,
    signatureMatch,
    durationMs: Date.now() - started,
  };
}

function formatLog(messages: LeanDiagnostic[]): string {
  return messages
    .map((m) => `${VERIFY_LOG_FILE}:${m.line}:${m.column}: ${m.severity}: ${m.message}`)
    .join("\n");
}
