/**
 * Entry points of the geometry prover (see prove.ts) and of the numeric refuter (refute.ts): open
 * the statement in REPL tactic mode and drive it step by step. A proof is verified as a whole like
 * any other; a counterexample is checked against the statement evaluated numerically.
 */
import { CancelledError } from "../../jobs";
import type { LeanVerifyResult } from "../sandbox";
import { openRunner, scriptSource } from "../tactic-runner";
import { proveGeometryGoals } from "./prove";
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

function open(theoremName: string, theoremType: string, useMathlib: boolean, timeLimitMs: number) {
  return openRunner({
    theoremName,
    theoremType,
    useMathlib,
    timeLimitMs,
    tacticTimeoutMs: Number(process.env.GEOMETRY_TACTIC_TIMEOUT_MS ?? 60_000),
    label: "geometry",
    debugEnv: "GEOMETRY_DEBUG",
  });
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
  const opened = await open(theoremName, theoremType, useMathlib, Number(process.env.GEOMETRY_TIME_LIMIT_MS ?? 600_000));
  if (typeof opened === "string") return { reason: opened };
  const { run, script, session } = opened;
  try {
    const out = await proveGeometryGoals(run);
    if (!out.ok) return { reason: out.reason ?? "not proved" };
    const tactics = script.join("\n");
    // The proof is checked as one declaration: its heartbeat budget covers every step (each step had
    // its own in tactic mode), so the declaration gets a larger one (never 0, which the sanitizer refuses).
    const source = scriptSource({ theoremName, theoremType, tactics, useMathlib, heartbeats: Number(process.env.GEOMETRY_MAX_HEARTBEATS ?? 1_000_000) * 4 });
    // the whole script at once (an angle-mode proof with case splits takes minutes on a slow machine)
    const verifyMs = Number(process.env.GEOMETRY_VERIFY_TIMEOUT_MS ?? 300_000);
    const verification = await session.verify(sessionId, source, { theoremName, expectedSignature, timeoutMs: Number.isFinite(verifyMs) && verifyMs > 0 ? verifyMs : 300_000 });
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
