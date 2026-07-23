import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { BuildStatus } from "../types";
import { parseLeanLog } from "./parse-log";

const DEFAULT_TIMEOUT = Number(process.env.LEAN_BUILD_TIMEOUT_MS ?? 60_000);
/** Max concurrent `lake` / lean processes (in-process queue). */
const LAKE_CONCURRENCY = Math.max(
  1,
  Math.min(2, Number(process.env.LEAN_LAKE_CONCURRENCY ?? 1)),
);

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
  const avail = await checkLeanAvailable();
  if (!avail.ok) {
    return { ok: false, log: avail.message, status: "unavailable" };
  }
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
