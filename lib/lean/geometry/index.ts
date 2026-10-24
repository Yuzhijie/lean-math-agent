/**
 * Entry point of the geometry prover (see prove.ts): open the statement in REPL tactic mode, let
 * the program write the proof step by step, then verify the whole script like any other proof.
 */
import { CancelledError, throwIfCancelled } from "../../jobs";
import { assembleLeanSource } from "../assemble";
import type { LeanVerifyResult } from "../sandbox";
import { parseGoal } from "./goal";
import { proveGeometryGoals, type TacticRunner } from "./prove";

/** Statements in coordinates: points as ℝ × ℝ, square roots, arccos angles. Synthetic Mathlib geometry is out of scope. */
export function looksGeometric(theoremType: string): boolean {
  if (/EuclideanSpace|EuclideanGeometry|InnerProductGeometry|∠|Affine|Module\b/.test(theoremType)) return false;
  return /ℝ\s*×\s*ℝ|√|Real\.sqrt|Real\.arccos/.test(theoremType);
}

export interface GeometryProof {
  verification: LeanVerifyResult;
  source: string;
  tactics: string;
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
  if (process.env.LEAN_SERVER_MODE === "spawn") return { reason: "needs the Lean REPL" };
  let opened: Awaited<ReturnType<typeof import("../proof-state").openTheorem>>;
  try {
    const { openTheorem } = await import("../proof-state");
    opened = await openTheorem(assembleLeanSource({ theoremName, theoremType, stepCodes: ["sorry"], useMathlib }), {
      tacticTimeoutMs: Number(process.env.GEOMETRY_TACTIC_TIMEOUT_MS ?? 30_000),
    });
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    return { reason: `the statement did not open: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` };
  }
  if (!opened) return { reason: "Lean is not available" };
  const { session, root } = opened;
  let handle = root.state;
  let goals = [root.goal];
  let lastError = "";
  const script: string[] = [];
  let counter = 0;
  // the whole attempt is bounded: a timed-out tactic kills the worker and the next one replays the path
  const deadline = Date.now() + Number(process.env.GEOMETRY_TIME_LIMIT_MS ?? 180_000);
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
