import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { BuildStatus } from "../types";
import { parseLeanLog } from "./parse-log";
import { getLeanServer } from "./server";

const DEFAULT_TIMEOUT = Number(process.env.LEAN_BUILD_TIMEOUT_MS ?? 120_000);
/** Max concurrent `lake` / lean processes (in-process queue). */
const LAKE_CONCURRENCY = Math.max(
  1,
  Math.min(2, Number(process.env.LEAN_LAKE_CONCURRENCY ?? 1)),
);

// ── Verification Result Cache ──────────────────────────────────────────
//
// LRU cache for Lean verification results keyed by SHA-256(source + allowSorry).
// Avoids redundant `lake env lean` / server calls during repair loops.

const VERIFY_CACHE_MAX = 256;

interface VerifyResult {
  ok: boolean;
  log: string;
  status: BuildStatus;
}

const verificationCache = new Map<string, VerifyResult>();

function buildVerifyCacheKey(source: string, allowSorry: boolean): string {
  return createHash("sha256")
    .update(JSON.stringify({ source, allowSorry }))
    .digest("hex");
}

function cacheGet(key: string): VerifyResult | undefined {
  const v = verificationCache.get(key);
  if (v === undefined) return undefined;
  // LRU: move to most-recent position
  verificationCache.delete(key);
  verificationCache.set(key, v);
  return v;
}

function cacheSet(key: string, value: VerifyResult): void {
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

const SORRY_RE = /\bsorry\b/;

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

export async function checkLeanAvailable(): Promise<
  { ok: true } | { ok: false; message: string }
> {
  try {
    await withLakeSlot(() =>
      runCmd("lake", ["--version"], sandboxRoot(), 10_000),
    );
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      message:
        "未检测到可用的 lake/Lean。请安装 elan（https://lean-lang.org/install/），确保 `lake --version` 可用，并检查 LEAN_SANDBOX_PATH。",
    };
  }
}

export type VerifyLeanOpts = {
  /**
   * When true, allow `sorry` in source (prove-step repair prefixes).
   * Final `/api/verify` must leave this false/undefined.
   */
  allowSorry?: boolean;
};

export async function verifyLeanSource(
  sessionId: string,
  source: string,
  opts?: VerifyLeanOpts,
): Promise<{ ok: boolean; log: string; status: BuildStatus }> {
  if (!opts?.allowSorry && SORRY_RE.test(source)) {
    return {
      ok: false,
      log: "source contains `sorry`; final verify requires a complete proof",
      status: "fail",
    };
  }

  // ── Check verification cache ──────────────────────────────────
  const cacheKey = buildVerifyCacheKey(source, !!opts?.allowSorry);
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached };

  const avail = await checkLeanAvailable();
  if (!avail.ok) {
    return { ok: false, log: avail.message, status: "unavailable" };
  }

  let result: VerifyResult;

  // ── Try server mode first (fast path) ──────────────────────────
  const server = getLeanServer();
  if (server) {
    try {
      if (!server.isRunning) {
        await server.start();
      }
      const srvResult = await server.verify(sessionId, source);
      if (srvResult.ok) {
        result = { ok: true, log: srvResult.log || "ok", status: "ok" };
        cacheSet(cacheKey, result);
        return { ...result };
      }
      // Server said fail — check for infrastructure errors (e.g. missing
      // Init.olean due to search-path misconfiguration). If detected, fall
      // through to spawn which uses the standard `lean` binary and handles
      // search paths correctly.
      if (/IO error|could not resolve|unknown package/i.test(srvResult.log)) {
        result = await verifyViaSpawn(sessionId, source);
        cacheSet(cacheKey, result);
        return { ...result };
      }
      result = { ok: false, log: srvResult.log, status: "fail" };
      cacheSet(cacheKey, result);
      return { ...result };
    } catch {
      // Server mode failed — fall through to spawn mode
    }
  }

  // ── Spawn fallback (slow path) ─────────────────────────────────
  result = await verifyViaSpawn(sessionId, source);
  cacheSet(cacheKey, result);
  return { ...result };
}

/** Original spawn-based verification (fallback when server mode is unavailable). */
async function verifyViaSpawn(
  sessionId: string,
  source: string,
): Promise<{ ok: boolean; log: string; status: BuildStatus }> {
  const root = sandboxRoot();
  const scratchDir = path.join(root, "Scratch");
  await fs.mkdir(scratchDir, { recursive: true });
  const safeId = path.basename(sessionId.replace(/\\/g, "/"));
  const filePath = path.join(scratchDir, `Session_${safeId}.lean`);
  await fs.writeFile(filePath, source, "utf8");
  try {
    const log = await withLakeSlot(() =>
      runCmd("lake", ["env", "lean", filePath], root, DEFAULT_TIMEOUT),
    );
    return { ok: true, log: parseLeanLog(log) || "ok", status: "ok" };
  } catch (e) {
    const log = e instanceof Error ? e.message : String(e);
    return { ok: false, log: parseLeanLog(log), status: "fail" };
  }
}

function runCmd(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<string> {
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
