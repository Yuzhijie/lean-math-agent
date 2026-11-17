/**
 * Inequality proofs the program writes (strategy "inequality"; a stage of lib/lean/prover-stages.ts).
 * One route so far: symmetric inequalities in three positive reals with x · y · z = 1, with or
 * without an equality case (symmetric.ts — the pqr substitution, the algebra by
 * scripts/sym_inequality.py). The script is written from the goal after the intros and verified
 * as a whole.
 */
import { CancelledError } from "../../jobs";
import { summarizeFailure } from "../feedback";
import type { LeanVerifyResult } from "../sandbox";
import { openRunner, scriptSource } from "../tactic-runner";
import { introAll } from "../combinatorics/finite";
import { parseGoal } from "../geometry/goal";
import { plan, script } from "./symmetric";

const ID = "[A-Za-z_][\\w'₀-₉]*";

/**
 * Is this the kind of statement the prover was written for (the stage table's fit)? Read off the
 * text: three reals with `0 < x` each, `x * y * z = 1`, and a `≤` / `≥` between them.
 */
export function looksSymmetricInequality(theoremType: string): boolean {
  const t = theoremType.replace(/\s+/g, " ");
  if (!/ℝ/.test(t) || !/[≤≥]/.test(t)) return false;
  const m = new RegExp(`\\(?(${ID}) \\* (${ID})\\)? \\* (${ID}) = 1(?![\\w.])`).exec(t);
  if (!m || new Set([m[1], m[2], m[3]]).size !== 3) return false;
  return [m[1], m[2], m[3]].every((v) => new RegExp(`(?<![\\w.'])(0 < ${v}|${v} > 0)(?![\\w.'])`).test(t));
}

export function inequalityFit(theoremType: string): 0 | 2 {
  return looksSymmetricInequality(theoremType) ? 2 : 0;
}

export interface InequalityProof {
  verification: LeanVerifyResult;
  source: string;
  tactics: string;
  method: "symmetric";
}

export async function inequalityProof(args: {
  sessionId: string;
  theoremName: string;
  theoremType: string;
  expectedSignature?: string;
  useMathlib: boolean;
  /** Bound for this attempt; default from the environment. */
  timeLimitMs?: number;
}): Promise<{ proof?: InequalityProof; reason: string; counterexample?: string }> {
  const { sessionId, theoremName, theoremType, expectedSignature, useMathlib } = args;
  if (!looksSymmetricInequality(theoremType)) return { reason: "not an inequality in three positive reals with product 1" };
  const limit = args.timeLimitMs ?? Number(process.env.INEQUALITY_TIME_LIMIT_MS ?? 240_000);
  const started = Date.now();
  const opened = await openRunner({
    theoremName,
    theoremType,
    useMathlib,
    timeLimitMs: limit,
    tacticTimeoutMs: Number(process.env.INEQUALITY_TACTIC_TIMEOUT_MS ?? 30_000),
    label: "inequality",
    debugEnv: "INEQUALITY_DEBUG",
  });
  if (typeof opened === "string") return { reason: opened };
  const { run, script: applied, session } = opened;
  try {
    await introAll(run);
    const goal = run.goals()[0];
    const st = goal === undefined ? null : parseGoal(goal);
    if (!st) return { reason: "the goal after the intros could not be read" };
    const pl = await plan(st, Math.max(5_000, Math.min(45_000, limit - (Date.now() - started) - 10_000)));
    if ("reason" in pl) return pl;
    const tactics = [...applied, script(pl)].join("\n");
    const source = scriptSource({ theoremName, theoremType, tactics, useMathlib, heartbeats: Number(process.env.INEQUALITY_MAX_HEARTBEATS ?? 4_000_000) });
    const verification = await session.verify(sessionId, source, { theoremName, expectedSignature });
    if (verification.ok) return { proof: { verification, source, tactics, method: "symmetric" }, reason: "" };
    if (process.env.INEQUALITY_DEBUG) console.error(`[inequality] the written proof did not verify:\n${source}\n${verification.log}`);
    return { reason: `symmetric: the written proof did not verify (${summarizeFailure(verification, 160)})` };
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    return { reason: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  } finally {
    session.close();
  }
}
