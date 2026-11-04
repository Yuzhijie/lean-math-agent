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
import { colourFamily, familyEvalCommand, familyScript, maxFamily, parseFamily, readFamilyGraph } from "./family";
import type { ProofSession } from "../proof-state";

/** IsGreatest / IsLeast / bounds, or a conjunction of an ∃ and a ∀ (attained + bound). */
export function looksOptimization(theoremType: string): boolean {
  if (looksGeometric(theoremType) || /ℝ|ℚ|ℂ/.test(theoremType)) return false;
  if (/\b(IsGreatest|IsLeast|upperBounds|lowerBounds)\b/.test(theoremType)) return true;
  return /∃[\s\S]*∧[\s\S]*∀|∀[\s\S]*∧[\s\S]*∃/.test(theoremType) && /[≤≥<>]/.test(theoremType);
}

/** The family route: the compatibility graph from Lean, a largest family, a colouring with M colours. */
async function familyProof(session: ProofSession, fam: NonNullable<ReturnType<typeof parseFamily>>): Promise<{ tactics?: string; reason: string; counterexample?: string }> {
  const msgs = await session.evaluate(familyEvalCommand(fam), Number(process.env.OPTIMIZE_EVAL_TIMEOUT_MS ?? 60_000));
  const err = msgs.find((m) => m.severity === "error");
  if (err) return { reason: `the family's subsets could not be listed: ${err.data.split("\n")[0]}` };
  const g = msgs.map((m) => readFamilyGraph(m.data)).find((x) => x);
  if (!g) return { reason: "no subset table from Lean" };
  if (g.sets.length > 128) return { reason: "more than 7 elements in the ground set" };
  const best = maxFamily(g, fam.M + 1);
  if (best.length > fam.M) {
    const text = best.map((i) => `{${g.sets[i].join(", ")}}`).join(", ");
    return { reason: `a family of ${best.length} members fits: ${text}`, counterexample: `${best.length} > ${fam.M}: ${text}` };
  }
  if (best.length < fam.M) return { reason: `the largest family found has ${best.length} members, not ${fam.M}` };
  const colours = colourFamily(g, fam.M);
  if (!colours) return { reason: `no colouring of the subsets with ${fam.M} colours (the bound needs another argument)` };
  return { tactics: familyScript(fam, g, best, colours), reason: "" };
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
}): Promise<{ proof?: OptimizationProof; reason: string; counterexample?: string }> {
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
    // "largest family of subsets": a colouring the kernel checks (family.ts), before the generic search
    const fam = parseFamily(theoremType);
    if (fam) {
      const f = await familyProof(session, fam);
      if (f.tactics) {
        const source = scriptSource({ theoremName, theoremType, tactics: f.tactics, useMathlib, heartbeats });
        const verification = await session.verify(sessionId, source, { theoremName, expectedSignature, timeoutMs: Number(process.env.OPTIMIZE_VERIFY_TIMEOUT_MS ?? 300_000) });
        if (verification.ok) return { proof: { verification, source, tactics: f.tactics }, reason: "" };
        if (process.env.OPTIMIZE_DEBUG) console.error(`[optimize] family proof did not verify:\n${source}\n${verification.log}`);
      } else if (f.counterexample) return { reason: f.reason, counterexample: f.counterexample };
      else if (process.env.OPTIMIZE_DEBUG) console.error(`[optimize] family: ${f.reason}`);
    }
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
