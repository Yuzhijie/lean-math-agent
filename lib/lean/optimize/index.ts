/**
 * Combinatorial optimization proofs the program writes (strategy "optimize"): "the largest /
 * smallest value is M" as `IsGreatest S M` / `IsLeast S M`, `M ∈ upperBounds S`, or
 * `(∃ attained) ∧ (∀ bound)`. The attained value's witness is found by Lean itself (`#eval` over
 * the finite candidates), the bound by a box the kernel decides (prove.ts). Every script is
 * verified as a whole.
 */
import { CancelledError } from "../../jobs";
import { looksGeometric } from "../geometry";
import type { LeanVerifyResult } from "../sandbox";
import { openRunner, scriptSource } from "../tactic-runner";
import { proveOptimization } from "./prove";

/** IsGreatest / IsLeast / bounds, or a conjunction of an ∃ and a ∀ (attained + bound). */
export function looksOptimization(theoremType: string): boolean {
  if (looksGeometric(theoremType) || /ℝ|ℚ|ℂ/.test(theoremType)) return false;
  if (/\b(IsGreatest|IsLeast|upperBounds|lowerBounds)\b/.test(theoremType)) return true;
  return /∃[\s\S]*∧[\s\S]*∀|∀[\s\S]*∧[\s\S]*∃/.test(theoremType) && /[≤≥<>]/.test(theoremType);
}

export interface OptimizationProof {
  verification: LeanVerifyResult;
  source: string;
  tactics: string;
}

export async function optimizationProof(args: {
  sessionId: string;
  theoremName: string;
  theoremType: string;
  expectedSignature?: string;
  useMathlib: boolean;
}): Promise<{ proof?: OptimizationProof; reason: string }> {
  const { sessionId, theoremName, theoremType, expectedSignature, useMathlib } = args;
  if (!looksOptimization(theoremType)) return { reason: "not an optimization statement" };
  const heartbeats = Number(process.env.OPTIMIZE_MAX_HEARTBEATS ?? 4_000_000);
  const opened = await openRunner({
    theoremName,
    theoremType,
    useMathlib,
    timeLimitMs: Number(process.env.OPTIMIZE_TIME_LIMIT_MS ?? 180_000),
    tacticTimeoutMs: Number(process.env.OPTIMIZE_TACTIC_TIMEOUT_MS ?? 120_000),
    label: "optimize",
    debugEnv: "OPTIMIZE_DEBUG",
    heartbeats,
    // numbers print with their type (`(12 : ℕ)`), so the witness search elaborates the conditions as the statement does
    options: ["pp.numericTypes true"],
  });
  if (typeof opened === "string") return { reason: opened };
  const { run, script, session } = opened;
  try {
    const r = await proveOptimization(run, session);
    if (!r.ok) return { reason: r.reason ?? "not proved" };
    const tactics = script.join("\n");
    const source = scriptSource({ theoremName, theoremType, tactics, useMathlib, heartbeats });
    const verification = await session.verify(sessionId, source, { theoremName, expectedSignature, timeoutMs: Number(process.env.OPTIMIZE_VERIFY_TIMEOUT_MS ?? 300_000) });
    if (!verification.ok && process.env.OPTIMIZE_DEBUG) console.error(`[optimize] verify failed:\n${source}\n${verification.log}`);
    if (!verification.ok) return { reason: `the written proof did not verify: ${verification.log.split("\n")[0]?.slice(0, 160) ?? ""}` };
    return { proof: { verification, source, tactics }, reason: "" };
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    return { reason: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  } finally {
    session.close();
  }
}
