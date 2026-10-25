/**
 * Memory replay: before any model is asked, try the recalled proofs of similar theorems verbatim
 * on the new statement. Near-duplicate problems (the same inequality with other constants, the
 * same `norm_num [..]` computation, the same `nlinarith [sq_nonneg …]` pattern) are often closed by
 * the old script unchanged. It costs a few Lean checks and no model calls, and every hit is verified
 * like any other proof (statement lock, axioms, no sorry).
 */
import { assembleLeanSource } from "../lean/assemble";
import { noteReplayHit, type ProofMemoryEntry } from "../lean/proof-memory";
import { verifyLeanSource, type LeanVerifyResult } from "../lean/sandbox";

export interface ReplayResult {
  tactics: string;
  source: string;
  verification: LeanVerifyResult;
  /** The remembered proof that was replayed. */
  entry: ProofMemoryEntry;
  /** Lean checks spent (hits and misses). */
  tried: number;
}

/** Same statement up to whitespace and a leading `:`. */
function sameStatement(a: string, b: string): boolean {
  const norm = (t: string) => t.replace(/^\s*:\s*/, "").replace(/\s+/g, " ").trim();
  return norm(a) === norm(b);
}

/** Whether the replay stage runs (PROOF_MEMORY_REPLAY, default on). */
export function replayEnabled(): boolean {
  return process.env.PROOF_MEMORY_REPLAY !== "false";
}

/**
 * Replay up to `max` recalled proofs (in recall order) on the theorem; the first that verifies wins.
 * Scripts longer than 40 lines are skipped (a long script is specific to its theorem) — unless
 * the remembered statement is this one (the same problem asked again).
 */
export async function replayRecalled(args: {
  sessionId: string;
  theoremName: string;
  theoremType: string;
  recalled: ProofMemoryEntry[];
  expectedSignature?: string;
  useMathlib: boolean;
  opens?: string[];
  max?: number;
  /** Count the hit on the remembered entry (default true; evaluation passes false). */
  count?: boolean;
}): Promise<ReplayResult | undefined> {
  if (!replayEnabled()) return undefined;
  const seen = new Set<string>();
  let tried = 0;
  for (const entry of args.recalled) {
    if (tried >= (args.max ?? 3)) break;
    const tactics = entry.tactics.trim();
    const same = sameStatement(entry.theorem_type, args.theoremType);
    if (!tactics || seen.has(tactics) || (!same && tactics.split("\n").length > 40)) continue;
    seen.add(tactics);
    tried++;
    const source = assembleLeanSource({ theoremName: args.theoremName, theoremType: args.theoremType, stepCodes: [tactics], useMathlib: args.useMathlib, opens: args.opens });
    const verification = await verifyLeanSource(args.sessionId, source, { theoremName: args.theoremName, expectedSignature: args.expectedSignature });
    if (verification.status === "unavailable") return undefined;
    if (verification.ok) {
      if (args.count !== false) void noteReplayHit(entry.id).catch(() => undefined);
      return { tactics, source, verification, entry, tried };
    }
  }
  return undefined;
}
