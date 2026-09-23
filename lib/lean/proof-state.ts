/**
 * ProofSession — incremental, goal-level proving on the Lean REPL.
 *
 * A `cmd` with `sorry` holes gives one proof state per hole; tactics are
 * then applied to states one at a time (`{"tactic", "proofState"}`), each
 * in milliseconds, without re-elaborating the file. This is what goal-level
 * search, the automation hammer and sketch/hole solving are built on.
 *
 * Proof states are local to one REPL process, so a session leases a worker
 * for its whole life. States are addressed by session-local handles; each
 * handle remembers the tactic path from its root, so if the worker dies
 * (timeout, crash, recycle) the session re-runs the command on a fresh
 * worker and replays the path transparently.
 *
 * Nothing found here is trusted on its own: a finished tactic script is
 * always re-assembled into a complete source and put through
 * `verifyLeanSource` (sanitizer, axioms, statement lock).
 */
import { recordVerification } from "../llm/usage-tracker";
import { getReplPool, ReplError, type ReplMessage, type ReplWorker } from "./repl";
import { BODY_PRELUDE, sandboxRoot, verifyLeanSource, type LeanVerifyResult, type VerifyLeanOpts } from "./sandbox";
import { sanitizeLeanBody, sanitizeLeanSource, splitHeader } from "./sanitize";

export interface ProofHole {
  /** Session-local state handle. */
  state: number;
  /** Pretty-printed goal at the hole. */
  goal: string;
  /** 1-based line / 0-based column of the `sorry` in the body sent to Lean. */
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export type TacticOutcome =
  | {
      ok: true;
      /** Handle of the resulting state. */
      state: number;
      goals: string[];
      /** No goals remain and nothing was admitted. */
      solved: boolean;
      /** Info messages (e.g. `Try this:` from `exact?`). */
      infos: string[];
      durationMs: number;
    }
  | { ok: false; error: string; durationMs: number };

export interface ProofSessionOptions {
  /** Per-tactic timeout (ms). Default LEAN_TACTIC_TIMEOUT_MS or 60000. */
  tacticTimeoutMs?: number;
}

interface StateRecord {
  root: number;
  tactics: string[];
  /** Worker-local proof state id; undefined after a worker change. */
  remote?: number;
  goals: string[];
}

export class ProofSession {
  private lease: { worker: ReplWorker; release: () => void } | null = null;
  private states: StateRecord[] = [];
  private rootRemote: number[] = [];
  private closed = false;
  readonly holes: ProofHole[] = [];
  /** Non-error diagnostics of the opening command. */
  readonly messages: ReplMessage[] = [];
  /** The tactic body (after `:= by`) and the header line count, for splicing. */
  readonly body: string;
  readonly headerLines: number;
  private readonly imports: string[];
  private readonly tacticTimeoutMs: number;
  /** Tactics applied through this session (for metrics / budgets). */
  tacticCount = 0;

  private constructor(
    readonly source: string,
    opts: ProofSessionOptions,
  ) {
    const { imports, body, headerLines } = splitHeader(source);
    this.imports = imports;
    this.body = body;
    this.headerLines = headerLines;
    this.tacticTimeoutMs = opts.tacticTimeoutMs ?? Number(process.env.LEAN_TACTIC_TIMEOUT_MS ?? 60_000);
  }

  /**
   * Open a session on `source` (a complete file whose proof contains one or
   * more `sorry`). Throws ReplError("lean") when the source has errors,
   * ReplError("unavailable") when no worker can be started.
   */
  static async open(source: string, opts: ProofSessionOptions = {}): Promise<ProofSession> {
    const san = sanitizeLeanSource(source);
    if (!san.ok) throw new ReplError("lean", san.reason);
    const session = new ProofSession(source, opts);
    await session.bootstrap();
    return session;
  }

  private async bootstrap(): Promise<void> {
    const pool = getReplPool(sandboxRoot());
    this.lease = await pool.lease();
    const started = Date.now();
    try {
      const env = await this.lease.worker.headerEnv(this.imports);
      const resp = await this.lease.worker.command({ cmd: BODY_PRELUDE + this.body, env }, pool.config.commandTimeoutMs);
      recordVerification("repl", Date.now() - started);
      const preludeLines = BODY_PRELUDE.split("\n").length - 1;
      const errors = resp.messages.filter((m) => m.severity === "error");
      if (errors.length > 0) {
        throw new ReplError("lean", errors.map((e) => `${e.pos.line - preludeLines}:${e.pos.column}: ${e.data}`).join("\n"));
      }
      this.messages.length = 0;
      this.messages.push(...resp.messages);
      this.rootRemote = [];
      const holes: ProofHole[] = [];
      resp.sorries.forEach((s, i) => {
        if (typeof s.proofState !== "number") return;
        this.rootRemote[i] = s.proofState;
        if (this.holes.length === 0) {
          const state = this.states.push({ root: i, tactics: [], remote: s.proofState, goals: [s.goal] }) - 1;
          holes.push({
            state,
            goal: s.goal,
            line: (s.pos?.line ?? 0) - preludeLines,
            column: s.pos?.column ?? 0,
            endLine: (s.endPos?.line ?? s.pos?.line ?? 0) - preludeLines,
            endColumn: s.endPos?.column ?? (s.pos?.column ?? 0) + 5,
          });
        }
      });
      if (this.holes.length === 0) this.holes.push(...holes);
      // After a replay, every existing handle needs its remote id rebuilt.
      for (const st of this.states) st.remote = st.tactics.length === 0 ? this.rootRemote[st.root] : undefined;
    } catch (e) {
      this.lease.release();
      this.lease = null;
      throw e;
    }
  }

  /** Goals of a state handle. */
  goals(state: number): string[] {
    return this.states[state]?.goals ?? [];
  }

  /** Tactic path from the root hole to a state handle. */
  path(state: number): string[] {
    return [...(this.states[state]?.tactics ?? [])];
  }

  /** Which hole a state descends from. */
  rootOf(state: number): number {
    return this.states[state]?.root ?? 0;
  }

  /**
   * Apply one tactic to a state. The tactic is sanitized first; a
   * forbidden token is reported as a failed tactic. Worker loss is handled
   * by replaying the state's path on a fresh worker (once).
   */
  async apply(state: number, tactic: string): Promise<TacticOutcome> {
    if (this.closed) throw new ReplError("crashed", "proof session is closed");
    const rec = this.states[state];
    if (!rec) throw new ReplError("protocol", `unknown state handle ${state}`);
    const clean = tactic.trim();
    const started = Date.now();
    if (!clean) return { ok: false, error: "empty tactic", durationMs: 0 };
    const san = sanitizeLeanBody(clean);
    if (!san.ok) return { ok: false, error: san.reason, durationMs: 0 };

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const remote = await this.remoteId(state);
        const resp = await this.lease!.worker.tactic(clean, remote, this.tacticTimeoutMs);
        this.tacticCount++;
        recordVerification("repl-tactic", Date.now() - started);
        if (!resp.ok) return { ok: false, error: resp.error, durationMs: Date.now() - started };
        const handle = this.states.push({ root: rec.root, tactics: [...rec.tactics, clean], remote: resp.proofState, goals: resp.goals }) - 1;
        return {
          ok: true,
          state: handle,
          goals: resp.goals,
          solved: resp.solved,
          infos: resp.messages.filter((m) => m.severity === "info").map((m) => m.data),
          durationMs: Date.now() - started,
        };
      } catch (e) {
        if (attempt === 0 && e instanceof ReplError && (e.kind === "crashed" || e.kind === "timeout" || e.kind === "protocol")) {
          // A timed-out tactic killed the worker (or the state id went
          // stale): move to a fresh worker and replay once. The timed-out
          // tactic itself counts as failed.
          await this.reopen();
          if (e.kind === "timeout") {
            return { ok: false, error: `tactic timed out after ${this.tacticTimeoutMs}ms`, durationMs: Date.now() - started };
          }
          continue;
        }
        throw e;
      }
    }
    return { ok: false, error: "worker lost twice while applying the tactic", durationMs: Date.now() - started };
  }

  /** Worker-local id for a handle, replaying its path when needed. */
  private async remoteId(state: number): Promise<number> {
    const rec = this.states[state];
    if (rec.remote !== undefined && this.lease?.worker.isRunning) return rec.remote;
    if (!this.lease?.worker.isRunning) await this.reopen();
    // Replay from the nearest ancestor that still has a remote id.
    let remote = this.rootRemote[rec.root];
    for (let i = 0; i < rec.tactics.length; i++) {
      const resp = await this.lease!.worker.tactic(rec.tactics[i], remote, this.tacticTimeoutMs);
      if (!resp.ok) throw new ReplError("protocol", `replay failed at step ${i + 1} (${rec.tactics[i]}): ${resp.error}`);
      remote = resp.proofState;
    }
    rec.remote = remote;
    return remote;
  }

  private async reopen(): Promise<void> {
    this.lease?.release();
    this.lease = null;
    await this.bootstrap();
  }

  /**
   * Strict verification of a complete source on this session's own worker
   * (statement lock, axioms, no sorry). Use this instead of
   * `verifyLeanSource` while the session is open: with a one-worker pool
   * the latter would wait for the worker this session holds.
   */
  async verify(sessionId: string, source: string, opts: Omit<VerifyLeanOpts, "worker"> = {}): Promise<LeanVerifyResult> {
    if (this.closed || !this.lease) throw new ReplError("crashed", "proof session is closed");
    return verifyLeanSource(sessionId, source, { ...opts, worker: this.lease.worker });
  }

  /** Release the worker. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lease?.release();
    this.lease = null;
  }
}

/**
 * Open a session for `theorem <name> <type> := by sorry` (optionally with
 * Mathlib imports) and hand back the root hole; returns undefined when Lean
 * is unavailable, throws ReplError("lean") when the statement fails to elaborate.
 */
export async function openTheorem(
  source: string,
  opts: ProofSessionOptions = {},
): Promise<{ session: ProofSession; root: ProofHole } | undefined> {
  try {
    const session = await ProofSession.open(source, opts);
    const root = session.holes[0];
    if (!root) {
      session.close();
      throw new ReplError("lean", "the statement has no `sorry` hole to work on");
    }
    return { session, root };
  } catch (e) {
    if (e instanceof ReplError && e.kind === "unavailable") return undefined;
    throw e;
  }
}
