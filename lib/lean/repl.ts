/**
 * Lean REPL client — a small pool of `leanprover-community/repl` processes.
 *
 * Protocol (see https://github.com/leanprover-community/repl):
 *   → stdin : one JSON object on a single line, followed by a blank line
 *   ← stdout: the JSON response (pretty-printed over several lines),
 *             followed by a blank line
 *
 * Why the REPL instead of the previous hand-written `lean-server`:
 *   - `{"cmd": "import Mathlib"}` is run ONCE per worker; every later
 *     command reuses that environment via `"env": <id>`. The old server
 *     re-imported all of Mathlib on every request (seconds + GBs each time).
 *   - Responses include `sorries` with the goal at every `sorry`, so a
 *     prefix + `sorry` verification hands back the exact remaining goal.
 *   - It is the same backend Kimina Lean Server, LeanDojo-style pipelines
 *     and most prover papers use, and it is versioned with Lean.
 *
 * The worker runs as `lake env <repl-binary>` inside the sandbox project so
 * LEAN_PATH contains Mathlib/Batteries/Aesop. Build it once with
 * `cd lean-sandbox && lake build repl`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

// ── Wire types ────────────────────────────────────────────────────────

export interface ReplPos {
  line: number;
  column: number;
}

export interface ReplMessage {
  severity: "error" | "warning" | "info";
  pos: ReplPos;
  endPos?: ReplPos;
  data: string;
}

export interface ReplSorry {
  pos?: ReplPos;
  endPos?: ReplPos;
  goal: string;
  proofState?: number;
}

export interface ReplCommandResponse {
  env: number;
  messages: ReplMessage[];
  sorries: ReplSorry[];
}

export type ReplFailureKind = "unavailable" | "timeout" | "crashed" | "protocol" | "lean";

export class ReplError extends Error {
  constructor(
    readonly kind: ReplFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "ReplError";
  }
}

// ── Configuration ─────────────────────────────────────────────────────

export interface ReplConfig {
  /** Sandbox (Lake project) directory; `lake env` runs here. */
  cwd: string;
  /** Path to the REPL executable. */
  binPath: string;
  /** Executable used to launch: `lake env <bin>` by default. */
  launcher?: { command: string; args: string[] };
  /** Max workers (processes). */
  workers: number;
  /** Recycle a worker after this many commands (bounds env accumulation). */
  maxUsesPerWorker: number;
  /** Timeout for the header import (`import Mathlib` can take a minute). */
  headerTimeoutMs: number;
  /** Timeout for an ordinary command. */
  commandTimeoutMs: number;
  /** Kill idle workers after this long. */
  idleTimeoutMs: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function defaultReplBinPath(sandboxRoot: string): string {
  return (
    process.env.LEAN_REPL_BIN ??
    path.join(sandboxRoot, ".lake", "packages", "repl", ".lake", "build", "bin", "repl")
  );
}

/**
 * `LEAN_REPL_COMMAND` overrides how a worker is launched (space-separated,
 * e.g. `"/opt/repl/bin/repl"` inside a container whose LEAN_PATH is already
 * set, or `"node tests/fixtures/fake-repl.mjs"` in tests). Default:
 * `lake env <binPath>` run in the sandbox directory.
 */
export function replLauncherFromEnv(): { command: string; args: string[] } | undefined {
  const raw = process.env.LEAN_REPL_COMMAND?.trim();
  if (!raw) return undefined;
  const [command, ...args] = raw.split(/\s+/);
  return { command, args };
}

export function loadReplConfig(sandboxRoot: string): ReplConfig {
  const launcher = replLauncherFromEnv();
  return {
    cwd: sandboxRoot,
    binPath: launcher ? launcher.args[launcher.args.length - 1] ?? launcher.command : defaultReplBinPath(sandboxRoot),
    launcher,
    workers: Math.min(8, envInt("LEAN_REPL_WORKERS", 1)),
    maxUsesPerWorker: envInt("LEAN_REPL_MAX_USES", 100),
    headerTimeoutMs: envInt("LEAN_SERVER_STARTUP_MS", 180_000),
    commandTimeoutMs: envInt("LEAN_BUILD_TIMEOUT_MS", 120_000),
    idleTimeoutMs: envInt("LEAN_SERVER_IDLE_TIMEOUT_MS", 300_000),
  };
}

// ── Worker ────────────────────────────────────────────────────────────

interface Pending {
  resolve: (r: ReplCommandResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ReplWorker {
  private proc: ChildProcess | null = null;
  private stdoutBuf = "";
  private frameLines: string[] = [];
  private stderrTail = "";
  private pending: Pending | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly headerEnvs = new Map<string, number>();
  /** Number of commands sent (for recycling). */
  uses = 0;
  dead = false;
  private exitInfo = "";

  constructor(
    private readonly config: ReplConfig,
    private readonly id: number,
  ) {}

  get isRunning(): boolean {
    return this.proc !== null && !this.dead;
  }

  async start(): Promise<void> {
    try {
      await fs.access(this.config.binPath);
    } catch {
      throw new ReplError(
        "unavailable",
        `Lean REPL binary not found at ${this.config.binPath}. Run \`cd lean-sandbox && lake build repl\` (LEAN_REPL_BIN overrides the path).`,
      );
    }
    const launcher = this.config.launcher ?? { command: "lake", args: ["env", this.config.binPath] };
    const child = spawn(launcher.command, launcher.args, {
      cwd: this.config.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = child;

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (err) => {
        this.dead = true;
        reject(new ReplError("unavailable", `Failed to start Lean REPL (${launcher.command}): ${err.message}`));
      });
    });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });
    child.on("exit", (code, signal) => {
      this.dead = true;
      this.exitInfo = `code=${code} signal=${signal}`;
      const p = this.pending;
      this.pending = null;
      if (p) {
        clearTimeout(p.timer);
        p.reject(
          new ReplError(
            "crashed",
            `Lean REPL worker #${this.id} exited (${this.exitInfo}) while a command was pending.\n${this.stderrTail}`,
          ),
        );
      }
    });
  }

  /** Feed stdout and deliver complete frames (JSON followed by a blank line). */
  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).replace(/\r$/, "");
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line.trim() === "") {
        if (this.frameLines.length > 0) {
          const text = this.frameLines.join("\n");
          this.frameLines = [];
          this.deliver(text);
        }
        continue;
      }
      this.frameLines.push(line);
    }
  }

  private deliver(text: string): void {
    const p = this.pending;
    if (!p) return; // stray output (e.g. lake notices) — ignore
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      // Not JSON: could be a lake/toolchain notice printed to stdout before
      // the real response. Keep waiting unless it looks like a Lean panic.
      if (/PANIC|error:|uncaught exception/i.test(text)) {
        this.pending = null;
        clearTimeout(p.timer);
        p.reject(new ReplError("protocol", `Lean REPL returned non-JSON output: ${text.slice(0, 500)}`));
      }
      return;
    }
    this.pending = null;
    clearTimeout(p.timer);
    const obj = json as Record<string, unknown>;
    if (typeof obj.message === "string" && obj.env === undefined) {
      // `{"message": ...}` is the REPL's own error (unparsable command,
      // unknown environment, ...) — an infrastructure problem, never a
      // verdict about the Lean source. Retire this worker.
      this.kill();
      p.reject(new ReplError("protocol", `Lean REPL error: ${obj.message}`));
      return;
    }
    p.resolve({
      env: typeof obj.env === "number" ? obj.env : -1,
      messages: Array.isArray(obj.messages) ? (obj.messages as ReplMessage[]) : [],
      sorries: Array.isArray(obj.sorries) ? (obj.sorries as ReplSorry[]) : [],
    });
  }

  /** Send one JSON command; commands on a worker are strictly serialised. */
  command(cmd: Record<string, unknown>, timeoutMs: number): Promise<ReplCommandResponse> {
    const run = () => this.sendNow(cmd, timeoutMs);
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private sendNow(cmd: Record<string, unknown>, timeoutMs: number): Promise<ReplCommandResponse> {
    return new Promise<ReplCommandResponse>((resolve, reject) => {
      if (!this.proc || this.dead || !this.proc.stdin?.writable) {
        reject(new ReplError("crashed", `Lean REPL worker #${this.id} is not running (${this.exitInfo})`));
        return;
      }
      const timer = setTimeout(() => {
        this.pending = null;
        this.kill();
        reject(
          new ReplError(
            "timeout",
            `Lean REPL command timed out after ${timeoutMs}ms; worker #${this.id} was killed`,
          ),
        );
      }, timeoutMs);
      this.pending = { resolve, reject, timer };
      this.uses += 1;
      const line = JSON.stringify(cmd) + "\n\n";
      this.proc.stdin.write(line, (err) => {
        if (err && this.pending) {
          clearTimeout(timer);
          this.pending = null;
          reject(new ReplError("crashed", `Failed to write to Lean REPL stdin: ${err.message}`));
        }
      });
    });
  }

  /**
   * Environment id for a set of imports, importing them on first use.
   * The key is the import list joined with newlines.
   */
  async headerEnv(imports: string[]): Promise<number> {
    const key = imports.join("\n");
    const cached = this.headerEnvs.get(key);
    if (cached !== undefined) return cached;
    const cmd = imports.length > 0 ? imports.map((m) => `import ${m}`).join("\n") : "-- base environment";
    const resp = await this.command({ cmd }, this.config.headerTimeoutMs);
    const errors = resp.messages.filter((m) => m.severity === "error");
    if (errors.length > 0) {
      // Missing/unbuilt Mathlib etc. — infrastructure, not the caller's source.
      throw new ReplError(
        "unavailable",
        `Importing [${imports.join(", ")}] failed: ${errors.map((e) => e.data).join("; ").slice(0, 500)}`,
      );
    }
    this.headerEnvs.set(key, resp.env);
    return resp.env;
  }

  kill(): void {
    if (this.proc && !this.dead) {
      this.dead = true;
      try {
        this.proc.stdin?.end();
      } catch {
        /* ignore */
      }
      this.proc.kill("SIGKILL");
    }
  }
}

// ── Pool ──────────────────────────────────────────────────────────────

export class ReplPool {
  private workers: ReplWorker[] = [];
  private busy = new Set<ReplWorker>();
  private waiters: Array<() => void> = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;

  constructor(readonly config: ReplConfig) {}

  /** Run `fn` with an exclusive worker; recycles crashed/overused workers. */
  async withWorker<T>(fn: (worker: ReplWorker) => Promise<T>): Promise<T> {
    const worker = await this.acquire();
    try {
      return await fn(worker);
    } finally {
      this.release(worker);
    }
  }

  private async acquire(): Promise<ReplWorker> {
    this.clearIdleTimer();
    for (;;) {
      // Drop dead / exhausted workers.
      this.workers = this.workers.filter((w) => {
        if (w.dead) return false;
        if (!this.busy.has(w) && w.uses >= this.config.maxUsesPerWorker) {
          w.kill();
          return false;
        }
        return true;
      });
      const free = this.workers.find((w) => !this.busy.has(w));
      if (free) {
        this.busy.add(free);
        return free;
      }
      if (this.workers.length < this.config.workers) {
        const w = new ReplWorker(this.config, this.nextId++);
        this.workers.push(w);
        this.busy.add(w);
        try {
          await w.start();
        } catch (e) {
          this.busy.delete(w);
          this.workers = this.workers.filter((x) => x !== w);
          throw e;
        }
        return w;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private release(worker: ReplWorker): void {
    this.busy.delete(worker);
    if (worker.dead) this.workers = this.workers.filter((w) => w !== worker);
    const next = this.waiters.shift();
    if (next) next();
    else if (this.busy.size === 0) this.resetIdleTimer();
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    if (this.config.idleTimeoutMs <= 0) return;
    this.idleTimer = setTimeout(() => this.shutdown(), this.config.idleTimeoutMs);
    // Do not keep the Node process alive just for this timer.
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  get size(): number {
    return this.workers.length;
  }

  shutdown(): void {
    this.clearIdleTimer();
    for (const w of this.workers) w.kill();
    this.workers = [];
    this.busy.clear();
    for (const wake of this.waiters.splice(0)) wake();
  }
}

// ── Singleton ─────────────────────────────────────────────────────────

let _pool: ReplPool | null = null;

export function getReplPool(sandboxRoot: string): ReplPool {
  if (!_pool) _pool = new ReplPool(loadReplConfig(sandboxRoot));
  return _pool;
}

export function shutdownReplPool(): void {
  if (_pool) {
    _pool.shutdown();
    _pool = null;
  }
}
