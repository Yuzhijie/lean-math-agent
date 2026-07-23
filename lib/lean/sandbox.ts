import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { BuildStatus } from "../types";
import { parseLeanLog } from "./parse-log";

const DEFAULT_TIMEOUT = Number(process.env.LEAN_BUILD_TIMEOUT_MS ?? 60_000);

export function sandboxRoot(): string {
  return path.resolve(process.env.LEAN_SANDBOX_PATH ?? "lean-sandbox");
}

export async function checkLeanAvailable(): Promise<
  { ok: true } | { ok: false; message: string }
> {
  try {
    await runCmd("lake", ["--version"], sandboxRoot(), 10_000);
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      message:
        "未检测到可用的 lake/Lean。请安装 elan（https://lean-lang.org/install/），确保 `lake --version` 可用，并检查 LEAN_SANDBOX_PATH。",
    };
  }
}

export async function verifyLeanSource(
  sessionId: string,
  source: string,
): Promise<{ ok: boolean; log: string; status: BuildStatus }> {
  const avail = await checkLeanAvailable();
  if (!avail.ok) {
    return { ok: false, log: avail.message, status: "unavailable" };
  }
  const root = sandboxRoot();
  const scratchDir = path.join(root, "Scratch");
  await fs.mkdir(scratchDir, { recursive: true });
  const filePath = path.join(scratchDir, `Session_${sessionId}.lean`);
  await fs.writeFile(filePath, source, "utf8");
  try {
    const log = await runCmd(
      "lake",
      ["env", "lean", filePath],
      root,
      DEFAULT_TIMEOUT,
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
