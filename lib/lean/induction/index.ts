/**
 * Entry point of the induction prover (see prove.ts): open the statement in REPL tactic mode, let
 * the program pick the scheme and close the cases, verify the script as a whole like any other proof.
 */
import { CancelledError } from "../../jobs";
import type { LeanVerifyResult } from "../sandbox";
import { openRunner, scriptSource } from "../tactic-runner";
import { proveByInduction, type InductionScheme } from "./prove";

/**
 * Statements over ℕ an induction (or a residue check) may prove: sums and products up to n,
 * divisibility, powers with n in the exponent, recurrences, bounds from some n on.
 */
export function looksInductive(theoremType: string): boolean {
  // `∀ n ≥ 1, …` has no ℕ written: Lean infers it
  if (!/ℕ|∀/.test(theoremType)) return false;
  if (/EuclideanSpace|ℝ\s*×\s*ℝ|Filter|Tendsto|deriv|∫/.test(theoremType)) return false;
  return /∑|∏|Finset\.(range|Icc)|∣|\^ \(?[a-z]|\([a-z] \+ [1-3]\)|≤ [a-z]\b|[a-z] ≥ \d/.test(theoremType);
}

export interface InductionProof {
  verification: LeanVerifyResult;
  source: string;
  tactics: string;
  scheme?: InductionScheme;
}

export async function inductionProof(args: {
  sessionId: string;
  theoremName: string;
  theoremType: string;
  expectedSignature?: string;
  useMathlib: boolean;
}): Promise<{ proof?: InductionProof; reason: string }> {
  const { sessionId, theoremName, theoremType, expectedSignature, useMathlib } = args;
  if (!looksInductive(theoremType)) return { reason: "not a statement over ℕ for induction" };
  const opened = await openRunner({
    theoremName,
    theoremType,
    useMathlib,
    timeLimitMs: Number(process.env.INDUCTION_TIME_LIMIT_MS ?? 120_000),
    tacticTimeoutMs: Number(process.env.INDUCTION_TACTIC_TIMEOUT_MS ?? 20_000),
    label: "induction",
    debugEnv: "INDUCTION_DEBUG",
  });
  if (typeof opened === "string") return { reason: opened };
  const { run, script, session } = opened;
  try {
    const out = await proveByInduction(run);
    if (!out.ok) return { reason: out.reason ?? "not proved" };
    const tactics = script.join("\n");
    const source = scriptSource({ theoremName, theoremType, tactics, useMathlib, heartbeats: Number(process.env.INDUCTION_MAX_HEARTBEATS ?? 1_000_000) });
    const verification = await session.verify(sessionId, source, { theoremName, expectedSignature });
    if (!verification.ok && process.env.INDUCTION_DEBUG) console.error(`[induction] verify failed:\n${source}\n${verification.log}`);
    if (!verification.ok) return { reason: `the written proof did not verify: ${verification.log.split("\n")[0]?.slice(0, 160) ?? ""}` };
    return { proof: { verification, source, tactics, scheme: out.scheme }, reason: "" };
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    return { reason: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  } finally {
    session.close();
  }
}
