/**
 * Lean Server Manager — persistent Lean process for fast verification.
 *
 * Communicates with `lean-sandbox/.lake/build/bin/lean-server` via JSON-line protocol:
 *   → stdin:  {"cmd": "verify", "path": "/path/to/file.lean"}
 *   ← stdout: {"ok": bool, "messages": [{severity, line, column, data}, ...]}
 *
 * Falls back to spawn mode if the server fails to start or crashes.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sandboxRoot } from "./sandbox";
import { parseLeanLog } from "./parse-log";

const SERVER_STARTUP_MS = Number(
  process.env.LEAN_SERVER_STARTUP_MS ?? 30_000,
);
const SERVER_IDLE_TIMEOUT_MS = Number(
  process.env.LEAN_SERVER_IDLE_TIMEOUT_MS ?? 300_000,
);
const SERVER_MODE = process.env.LEAN_SERVER_MODE ?? "server";

interface ServerResponse {
  ok?: boolean;
  status?: string;
  error?: string;
  messages?: Array<{
    severity: string;
    line: number;
    column: number;
    endLine?: number;
    endColumn?: number;
    data: string;
  }>;
}

export interface VerifyResult {
  ok: boolean;
  log: string;
}

class LeanServer {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private resolveQueue: Array<(resp: ServerResponse) => void> = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private starting: Promise<void> | null = null;
  private crashCount = 0;
  private readonly maxCrashes = 3;

  /** Whether the server process is currently running. */
  get isRunning(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  /** Start the Lean server process. Idempotent — returns existing start promise. */
  async start(): Promise<void> {
    if (this.isRunning) return;
    if (this.starting) return this.starting;

    this.starting = this._doStart();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async _doStart(): Promise<void> {
    const root = sandboxRoot();
    const binPath = path.join(root, ".lake", "build", "bin", "lean-server");

    // Check if binary exists
    try {
      await fs.access(binPath);
    } catch {
      throw new Error(
        `Lean server binary not found at ${binPath}. ` +
          `Run \`cd lean-sandbox && lake build lean-server\` first.`,
      );
    }

    // Start via `lake env` so LEAN_PATH includes all package build dirs
    // (Mathlib, Batteries, Aesop, etc.). Without this, the server can't
    // resolve imports like `Mathlib` or even `Init`.
    return new Promise<void>((resolve, reject) => {
      const child = spawn("lake", ["env", binPath], {
        cwd: root,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stderrBuf = "";
      let readyReceived = false;

      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          new Error(
            `Lean server did not become ready within ${SERVER_STARTUP_MS}ms.\nstderr: ${stderrBuf}`,
          ),
        );
      }, SERVER_STARTUP_MS);

      child.stderr?.on("data", (d: Buffer) => {
        stderrBuf += d.toString();
      });

      child.stdout?.on("data", (d: Buffer) => {
        this.buffer += d.toString();
        this.processBuffer();

        // Check if the first message is the "ready" signal
        if (!readyReceived && this.buffer === "" && this.resolveQueue.length === 0) {
          // The ready message was already processed by processBuffer
          readyReceived = true;
          clearTimeout(timeout);
          this.proc = child;
          this.crashCount = 0;
          this.resetIdleTimer();
          resolve();
        }
      });

      child.on("error", (err) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to spawn Lean server: ${err.message}`));
      });

      child.on("exit", (code, signal) => {
        this.proc = null;
        clearTimeout(timeout);
        this.clearIdleTimer();

        // Reject any pending requests
        for (const resolve of this.resolveQueue) {
          resolve({ error: `Server exited (code=${code}, signal=${signal})` });
        }
        this.resolveQueue = [];

        if (!readyReceived) {
          reject(
            new Error(
              `Lean server exited before becoming ready (code=${code}).\nstderr: ${stderrBuf}`,
            ),
          );
        }
      });
    });
  }

  /** Process accumulated buffer, extracting complete JSON objects. */
  private processBuffer(): void {
    // The Lean server may output pretty-printed (multi-line) JSON.
    // We need to accumulate lines until we have a complete JSON object.
    // Strategy: try parsing the accumulated non-empty lines as JSON.
    // If it parses, deliver it. If not, keep accumulating.

    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    let accumulator = "";

    for (const line of lines) {
      accumulator += (accumulator ? "\n" : "") + line;
      const trimmed = accumulator.trim();
      if (!trimmed) {
        accumulator = "";
        continue;
      }

      try {
        const resp = JSON.parse(trimmed) as ServerResponse;
        accumulator = ""; // Reset after successful parse

        // Skip the "ready" signal — it's consumed during startup
        if (resp.status === "ready") continue;

        // Deliver to the next waiting request
        const resolve = this.resolveQueue.shift();
        if (resolve) {
          resolve(resp);
        }
      } catch {
        // Incomplete JSON — keep accumulating
        // But guard against infinite accumulation (e.g., non-JSON output)
        if (accumulator.length > 100_000) {
          const resolve = this.resolveQueue.shift();
          if (resolve) {
            resolve({ ok: false, messages: [{ severity: "error", line: 0, column: 0, data: accumulator.slice(0, 1000) }] });
          }
          accumulator = "";
        }
      }
    }

    // Put remaining accumulator back into buffer for next data event
    if (accumulator) {
      this.buffer = accumulator + (this.buffer ? "\n" + this.buffer : "");
    }
  }

  /** Send a verify command and wait for the response. */
  async verify(sessionId: string, source: string): Promise<VerifyResult> {
    if (!this.isRunning) {
      await this.start();
    }
    this.resetIdleTimer();

    // Write source to a temp file
    const root = sandboxRoot();
    const scratchDir = path.join(root, "Scratch");
    await fs.mkdir(scratchDir, { recursive: true });
    const safeId = path.basename(sessionId.replace(/\\/g, "/"));
    const filePath = path.join(scratchDir, `Session_${safeId}.lean`);
    await fs.writeFile(filePath, source, "utf8");

    // Send verify command
    const response = await this.sendCommand({ cmd: "verify", path: filePath });

    if (response.error) {
      throw new Error(response.error);
    }

    // Format messages into a log string compatible with parseLeanLog
    const log = this.formatMessages(response, filePath);
    return { ok: response.ok ?? false, log };
  }

  /** Send a JSON command to the server's stdin and wait for response. */
  private sendCommand(cmd: Record<string, string>): Promise<ServerResponse> {
    return new Promise<ServerResponse>((resolve, reject) => {
      if (!this.proc?.stdin?.writable) {
        reject(new Error("Lean server stdin not available"));
        return;
      }

      const line = JSON.stringify(cmd) + "\n";
      this.resolveQueue.push(resolve);

      const timer = setTimeout(() => {
        // Remove from queue
        const idx = this.resolveQueue.indexOf(resolve);
        if (idx >= 0) this.resolveQueue.splice(idx, 1);
        reject(new Error(`Server response timeout after ${SERVER_STARTUP_MS}ms`));
        // Kill and restart on next call
        this.kill();
      }, SERVER_STARTUP_MS);

      // Wrap resolve to clear timer
      const wrappedResolve = (resp: ServerResponse) => {
        clearTimeout(timer);
        resolve(resp);
      };
      // Replace the last entry in the queue
      const idx = this.resolveQueue.indexOf(resolve);
      if (idx >= 0) this.resolveQueue[idx] = wrappedResolve;

      this.proc.stdin.write(line, (err) => {
        if (err) {
          clearTimeout(timer);
          const qIdx = this.resolveQueue.indexOf(wrappedResolve);
          if (qIdx >= 0) this.resolveQueue.splice(qIdx, 1);
          reject(new Error(`Failed to write to server stdin: ${err.message}`));
        }
      });
    });
  }

  /** Format server response messages into a log string. */
  private formatMessages(resp: ServerResponse, filePath: string): string {
    if (!resp.messages || resp.messages.length === 0) {
      return resp.ok ? "ok" : "verification failed (no messages)";
    }
    const basename = path.basename(filePath);
    return resp.messages
      .map((m) => {
        const loc = `${basename}:${m.line}:${m.column}`;
        return `${loc}: ${m.severity}: ${m.data}`;
      })
      .join("\n");
  }

  /** Reset the idle shutdown timer. */
  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.kill();
    }, SERVER_IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** Kill the server process. */
  kill(): void {
    this.clearIdleTimer();
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.stdin?.write(JSON.stringify({ cmd: "quit" }) + "\n");
      } catch {
        // stdin may already be closed
      }
      // Give it a moment to exit gracefully, then force-kill
      setTimeout(() => {
        if (this.proc && !this.proc.killed) {
          this.proc.kill("SIGKILL");
        }
      }, 3000);
    }
  }

  /** Force-kill the server immediately. */
  forceKill(): void {
    this.clearIdleTimer();
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGKILL");
    }
    this.proc = null;
  }
}

// ── Singleton ─────────────────────────────────────────────────────────

let _server: LeanServer | null = null;

/**
 * Get or create the singleton Lean server instance.
 * Returns null if server mode is disabled via LEAN_SERVER_MODE=spawn.
 */
export function getLeanServer(): LeanServer | null {
  if (SERVER_MODE === "spawn") return null;
  if (!_server) _server = new LeanServer();
  return _server;
}

/**
 * Shutdown the server. Call during process cleanup.
 */
export function shutdownLeanServer(): void {
  if (_server) {
    _server.forceKill();
    _server = null;
  }
}
