import type { HammerAttempt } from "./hammer";

/** A tactic stopped by a limit (time, heartbeats, memory): a longer limit may still prove with it. ("maximum recursion depth" is no such limit: a whole proof has the same depth.) */
const HIT_A_LIMIT = /timed out|timeout|heartbeats|died|memory|stack overflow/i;

/**
 * The plain tactics the cascade tried on the root goal that Lean rejected outright — not ones a
 * limit stopped. Running one of them again as a whole proof gives the same error, so the single
 * tactics skip them (they were a second run of the cascade on every statement it had not
 * proved: 6 of the 30 minutes the regression list spent in stages that proved nothing).
 */
export function rejectedTactics(attempts: HammerAttempt[]): Set<string> {
  const out = new Set<string>();
  for (const a of attempts) {
    if (a.ok || !a.error || HIT_A_LIMIT.test(a.error)) continue;
    const plain = a.tactic.match(/^\(intros; ([^;()]+)\)$/)?.[1] ?? a.tactic;
    if (/^[\w+ ]+$/.test(plain)) out.add(plain.trim());
  }
  return out;
}
