/**
 * Entry points of the geometry prover (see prove.ts) and of the numeric refuter (refute.ts): open
 * the statement in REPL tactic mode and drive it step by step. A proof is verified as a whole like
 * any other; a counterexample is checked against the statement evaluated numerically.
 */
import { CancelledError, throwIfCancelled } from "../../jobs";
import { assembleLeanSource } from "../assemble";
import type { ProofSession } from "../proof-state";
import type { LeanVerifyResult } from "../sandbox";
import { parseGoal } from "./goal";
import { proveGeometryGoals, type TacticRunner } from "./prove";
import { numericCounterexample, type Counterexample } from "./refute";

/** Statements in coordinates: points as ℝ × ℝ, square roots, arccos angles. Synthetic Mathlib geometry is out of scope. */
export function looksGeometric(theoremType: string): boolean {
  if (/EuclideanSpace|EuclideanGeometry|InnerProductGeometry|∠|Affine|Module\b/.test(theoremType)) return false;
  return /ℝ\s*×\s*ℝ|√|Real\.sqrt|Real\.arccos/.test(theoremType);
}

/** Real statements the numeric refuter can evaluate (coordinates, roots, trigonometry). */
export function looksNumeric(theoremType: string): boolean {
  if (/EuclideanSpace|EuclideanGeometry|InnerProductGeometry|∠|Finset|∑|∏|∫|deriv|Filter|Tendsto/.test(theoremType)) return false;
  return looksGeometric(theoremType) || /\bReal\.(cos|sin|tan)\b/.test(theoremType);
}

export interface GeometryProof {
  verification: LeanVerifyResult;
  source: string;
  tactics: string;
}

interface Opened {
  run: TacticRunner;
  script: string[];
  session: ProofSession;
}

/** The statement opened in tactic mode with a runner over it; undefined + reason when it cannot be. */
async function open(theoremName: string, theoremType: string, useMathlib: boolean, timeLimitMs: number): Promise<Opened | string> {
  if (process.env.LEAN_SERVER_MODE === "spawn") return "needs the Lean REPL";
  let opened: Awaited<ReturnType<typeof import("../proof-state").openTheorem>>;
  try {
    const { openTheorem } = await import("../proof-state");
    opened = await openTheorem(assembleLeanSource({ theoremName, theoremType, stepCodes: ["sorry"], useMathlib }), {
      tacticTimeoutMs: Number(process.env.GEOMETRY_TACTIC_TIMEOUT_MS ?? 30_000),
    });
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
    async apply(tactic) {
      throwIfCancelled();
      if (Date.now() > deadline) throw new Error("the geometry prover ran out of time (GEOMETRY_TIME_LIMIT_MS)");
      const out = await session.apply(handle, tactic);
      // an error Lean recovered from (the state still comes back) is a failure too
      const r = out.ok && out.errors.length ? { ok: false as const, error: out.errors.join("\n"), durationMs: out.durationMs } : out;
      if (process.env.GEOMETRY_DEBUG) console.error(`[geometry] ${r.ok ? "ok  " : "FAIL"} ${tactic}${r.ok ? "" : `\n        ${r.error.split("\n")[0]}`}`);
      if (!r.ok) {
        lastError = r.error;
        return false;
      }
      handle = r.state;
      goals = r.goals;
      script.push(tactic);
      return true;
    },
  };
  return { run, script, session };
}

export async function geometryProof(args: {
  sessionId: string;
  theoremName: string;
  theoremType: string;
  expectedSignature?: string;
  useMathlib: boolean;
}): Promise<{ proof?: GeometryProof; reason: string }> {
  const { sessionId, theoremName, theoremType, expectedSignature, useMathlib } = args;
  if (!looksGeometric(theoremType)) return { reason: "not a coordinate statement" };
  const opened = await open(theoremName, theoremType, useMathlib, Number(process.env.GEOMETRY_TIME_LIMIT_MS ?? 180_000));
  if (typeof opened === "string") return { reason: opened };
  const { run, script, session } = opened;
  try {
    const out = await proveGeometryGoals(run);
    if (!out.ok) return { reason: out.reason ?? "not proved" };
    const tactics = script.join("\n");
    // The proof is checked as one declaration: its heartbeat budget covers every step (each step had
    // its own in tactic mode), so the declaration gets a larger one (never 0, which the sanitizer refuses).
    const beats = Number(process.env.GEOMETRY_MAX_HEARTBEATS ?? 1_000_000);
    const source = assembleLeanSource({ theoremName, theoremType, stepCodes: [tactics], useMathlib }).replace(
      /^theorem /m,
      `set_option maxHeartbeats ${Number.isFinite(beats) && beats > 0 ? Math.floor(beats) * 4 : 4_000_000} in\ntheorem `,
    );
    const verification = await session.verify(sessionId, source, { theoremName, expectedSignature });
    if (!verification.ok && process.env.GEOMETRY_DEBUG) console.error(`[geometry] verify failed:\n${source}\n${verification.log}`);
    if (!verification.ok) return { reason: `the written proof did not verify: ${verification.log.split("\n")[0]?.slice(0, 160) ?? ""}` };
    return { proof: { verification, source, tactics }, reason: "" };
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    return { reason: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  } finally {
    session.close();
  }
}

/**
 * A numeric counterexample to a real statement, or undefined (none found — not a proof — or the
 * statement could not be read). Never throws except on cancellation.
 */
export async function geometryRefute(args: { theoremName: string; theoremType: string; useMathlib?: boolean }): Promise<Counterexample | undefined> {
  if (!looksNumeric(args.theoremType)) return undefined;
  const opened = await open(args.theoremName, args.theoremType, args.useMathlib ?? true, Number(process.env.GEOMETRY_REFUTE_TIME_LIMIT_MS ?? 60_000));
  if (typeof opened === "string") return undefined;
  try {
    return await numericCounterexample(opened.run);
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    return undefined;
  } finally {
    opened.session.close();
  }
}

/** "d = 0.8794: 左边 0.8794, 右边 0.8660" style text for a counterexample. */
export function describeCounterexample(c: Counterexample): string {
  const fmt = (x: number) => (Math.abs(x) >= 1e4 || (Math.abs(x) < 1e-3 && x !== 0) ? x.toExponential(4) : Number(x.toPrecision(6)).toString());
  const vals = c.values.map(([k, v]) => `${k} = ${fmt(v)}`).join(", ");
  return c.sides ? `${vals}: ${c.sides[0]} = ${fmt(c.sides[1])}, ${c.sides[2]} = ${fmt(c.sides[3])}` : vals;
}
