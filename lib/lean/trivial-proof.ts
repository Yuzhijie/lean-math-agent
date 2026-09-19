import { assembleLeanSource } from "./assemble";
import { verifyLeanSource, type LeanVerifyResult } from "./sandbox";

/**
 * Single-tactic proofs to try for trivial theorems.
 * Ordered by likelihood of success for common math statements.
 */
const TRIVIAL_TACTICS = [
  "rfl",
  "simp",
  "norm_num",
  "omega",
  "trivial",
  "decide",
  "aesop",
  "simp_all",
  "ring",
  "linarith",
] as const;

/** Subset of tactics to try as fallback for individual steps during proof search. */
const FALLBACK_TACTICS = [
  "rfl",
  "simp",
  "omega",
  "norm_num",
  "decide",
  "aesop",
  "ring",
  "linarith",
] as const;

/**
 * Try trivial tactics for a specific step position, given prior step codes.
 *
 * Used as a fallback in proof-search after the LLM repair loop fails:
 * before degrading a step to `sorry`, we try single-tactic proofs that
 * might close the goal (e.g. `rfl` for `n + 0 = n`).
 *
 * Returns the winning tactic and its lean_code, or null if none succeeded.
 */
export async function tryTrivialTactic(
  sessionId: string,
  theoremName: string,
  theoremType: string,
  priorStepCodes: string[],
  useMathlib: boolean,
): Promise<{ tactic: string; lean_code: string } | null> {
  for (const tactic of FALLBACK_TACTICS) {
    const stepCodes = [...priorStepCodes, tactic];
    const source = assembleLeanSource({
      theoremName,
      theoremType,
      stepCodes,
      useMathlib,
    });
    const result = await verifyLeanSource(sessionId, source, {
      allowSorry: true,
    });
    if (result.ok) {
      return { tactic, lean_code: tactic };
    }
  }
  return null;
}

export interface TrivialProofOptions {
  /**
   * Signature recorded when the statement was validated (statement lock).
   * When given, a tactic only counts as a proof if the proved declaration
   * has exactly this type.
   */
  expectedSignature?: string;
}

/**
 * Attempt to prove a theorem with a single trivial tactic.
 *
 * For theorems like `∀ n : ℕ, n + 0 = n` that are provable by `rfl`,
 * this avoids the full pipeline (planner → per-step LLM → repair loop)
 * which tends to over-decompose and produce `sorry` for trivial goals.
 *
 * Each candidate is a COMPLETE proof, so it goes through the full
 * verification (no sorry, only standard axioms, statement lock).
 *
 * Returns the winning tactic, assembled source, log and verification
 * result on success, or null.
 */
export async function tryTrivialProof(
  sessionId: string,
  theoremName: string,
  theoremType: string,
  useMathlib: boolean,
  options: TrivialProofOptions = {},
): Promise<{ tactic: string; source: string; log: string; verification: LeanVerifyResult } | null> {
  for (const tactic of TRIVIAL_TACTICS) {
    const source = assembleLeanSource({
      theoremName,
      theoremType,
      stepCodes: [tactic],
      useMathlib,
    });

    const result = await verifyLeanSource(sessionId, source, {
      theoremName,
      expectedSignature: options.expectedSignature,
    });
    if (result.status === "unavailable") return null;
    if (result.ok) {
      return { tactic, source, log: result.log, verification: result };
    }
  }
  return null;
}
