/**
 * A statement opened in REPL tactic mode with a runner over it, for the provers the program
 * drives itself (lib/lean/geometry, lib/lean/induction): apply a tactic, read the goals, go back
 * to an earlier state. Every attempt is bounded in time; cancellation passes through.
 */
import { CancelledError, throwIfCancelled } from "../jobs";
import { assembleLeanSource } from "./assemble";
import type { ProofSession } from "./proof-state";
import { parseGoal } from "./geometry/goal";

export interface TacticRunner {
  /** Open goals (pretty-printed, with their contexts). */
  goals(): string[];
  /**
   * Apply a tactic to the main goal; false (state unchanged) when Lean rejects it. With `scriptAs`
   * the script records that text instead (a `have … := sorry` stand-in for a step that needs more
   * heartbeats than tactic mode gives, checked for real when the whole script is verified).
   */
  apply(tactic: string, scriptAs?: string): Promise<boolean>;
  lastError(): string;
  /** A fresh hypothesis name `base<n>` (unique within this proof). */
  fresh(base: string): string;
  /** The current state (goals and script so far), to come back to with `restore`. */
  save(): RunnerMark;
  restore(mark: RunnerMark): void;
}

/** Opaque: a state of the runner. */
export interface RunnerMark {
  readonly handle: unknown;
  readonly goals: string[];
  readonly length: number;
}

export interface OpenedRunner {
  run: TacticRunner;
  script: string[];
  session: ProofSession;
}

export async function openRunner(args: {
  theoremName: string;
  theoremType: string;
  useMathlib: boolean;
  timeLimitMs: number;
  tacticTimeoutMs: number;
  /** Shown when the time is up and in debug lines, e.g. "geometry". */
  label: string;
  /** Print every step when this env var is set. */
  debugEnv?: string;
  /** `open … in` before the theorem (miniF2F statements need `Real`, `Nat`, …). */
  opens?: string[];
  /**
   * Heartbeat budget of every tactic: `set_option maxHeartbeats N in` before the theorem (in
   * tactic mode the budget is the opening command's; a `set_option … in` before a tactic does not
   * raise it).
   */
  heartbeats?: number;
}): Promise<OpenedRunner | string> {
  const { theoremName, theoremType, useMathlib, timeLimitMs, tacticTimeoutMs, label, debugEnv, opens, heartbeats } = args;
  if (process.env.LEAN_SERVER_MODE === "spawn") return "needs the Lean REPL";
  let opened: Awaited<ReturnType<typeof import("./proof-state").openTheorem>>;
  try {
    const { openTheorem } = await import("./proof-state");
    const source = heartbeats
      ? scriptSource({ theoremName, theoremType, tactics: "sorry", useMathlib, heartbeats, opens })
      : assembleLeanSource({ theoremName, theoremType, stepCodes: ["sorry"], useMathlib, opens });
    opened = await openTheorem(source, { tacticTimeoutMs });
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    return `the statement did not open: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
  }
  if (!opened) return "Lean is not available";
  const { session, root } = opened;
  let handle = root.state;
  let goals = [root.goal];
  let lastError = "";
  const script: string[] = [];
  let counter = 0;
  const debug = !!(debugEnv && process.env[debugEnv]);
  // the whole attempt is bounded: a timed-out tactic kills the worker and the next one replays the path
  const deadline = Date.now() + timeLimitMs;
  const run: TacticRunner = {
    goals: () => goals,
    lastError: () => lastError,
    fresh: (base) => {
      const taken = new Set(goals.flatMap((g) => parseGoal(g)?.hyps.flatMap((h) => h.names) ?? []));
      let name = `${base}${++counter}`;
      while (taken.has(name)) name = `${base}${++counter}`;
      return name;
    },
    save: () => ({ handle, goals, length: script.length }),
    restore: (mark) => {
      handle = mark.handle as typeof handle;
      goals = mark.goals;
      script.length = mark.length;
    },
    async apply(tactic, scriptAs) {
      throwIfCancelled();
      if (Date.now() > deadline) throw new Error(`the ${label} prover ran out of time`);
      const out = await session.apply(handle, tactic);
      // an error Lean recovered from (the state still comes back) is a failure too
      const r = out.ok && out.errors.length ? { ok: false as const, error: out.errors.join("\n"), durationMs: out.durationMs } : out;
      if (debug) console.error(`[${label}] ${r.ok ? "ok  " : "FAIL"} ${(r.durationMs / 1000).toFixed(1)}s ${tactic}${r.ok ? "" : `\n        ${r.error.split("\n")[0]}`}`);
      if (!r.ok) {
        lastError = r.error;
        return false;
      }
      handle = r.state;
      goals = r.goals;
      script.push(scriptAs ?? tactic);
      return true;
    },
  };
  return { run, script, session };
}

/**
 * The finished script as one declaration, with a heartbeat budget for all of its steps (each step
 * had its own in tactic mode; never 0, which the sanitizer refuses).
 */
export function scriptSource(args: { theoremName: string; theoremType: string; tactics: string; useMathlib: boolean; heartbeats: number; opens?: string[] }): string {
  const { theoremName, theoremType, tactics, useMathlib, heartbeats, opens } = args;
  const beats = Number.isFinite(heartbeats) && heartbeats > 0 ? Math.floor(heartbeats) : 4_000_000;
  return assembleLeanSource({ theoremName, theoremType, stepCodes: [tactics], useMathlib, opens }).replace(/^(open [^\n]* in\n)?theorem /m, (_m, open) => `set_option maxHeartbeats ${beats} in\n${open ?? ""}theorem `);
}
