/**
 * Combinatorial optimization proofs the program writes (strategy "optimize"): "the largest /
 * smallest value is M" as `IsGreatest S M` / `IsLeast S M`, `M ∈ upperBounds S`, or
 * `(∃ attained) ∧ (∀ bound)`. The attained value's witness is found by Lean itself (`#eval` over
 * the finite candidates), the bound by a box the kernel decides (prove.ts). Every script is
 * verified as a whole.
 */
import { CancelledError } from "../../jobs";
import { looksGeometric } from "../geometry";
import { summarizeFailure } from "../feedback";
import type { LeanVerifyResult } from "../sandbox";
import { openRunner, scriptSource } from "../tactic-runner";
import { proveOptimization } from "./prove";
import { colourFamily, familyEvalCommand, familyScript, maxFamily, parseFamily, readFamilyGraph } from "./family";
import type { ProofSession } from "../proof-state";
import { ekrScript, ekrShape, groundEvalCommand, readGround } from "./ekr";
import { oddtownProof, oddtownShape } from "./oddtown";
import { vennOptimize } from "./venn";

/** IsGreatest / IsLeast / bounds, or a conjunction of an ∃ and a ∀ (attained + bound). */
export function looksOptimization(theoremType: string): boolean {
  if (looksGeometric(theoremType) || /ℝ|ℚ|ℂ/.test(theoremType)) return false;
  if (/\b(IsGreatest|IsLeast|upperBounds|lowerBounds)\b/.test(theoremType)) return true;
  return /∃[\s\S]*∧[\s\S]*∀|∀[\s\S]*∧[\s\S]*∃/.test(theoremType) && /[≤≥<>]/.test(theoremType);
}

/** k-sets of D, any two meet: Erdős–Ko–Rado from Mathlib (ekr.ts), with D listed by Lean. */
async function ekrProof(session: ProofSession, fam: NonNullable<ReturnType<typeof parseFamily>>): Promise<{ tactics?: string; reason: string; counterexample?: string } | undefined> {
  const shape = ekrShape(fam);
  if (!shape) return undefined;
  const msgs = await session.evaluate(groundEvalCommand(fam), Number(process.env.OPTIMIZE_EVAL_TIMEOUT_MS ?? 60_000));
  const err = msgs.find((m) => m.severity === "error");
  if (err) return { reason: `the ground set could not be listed: ${err.data.split("\n")[0]}` };
  const ground = msgs.map((m) => readGround(m.data)).find((x) => x);
  if (!ground || ground.length > 200) return { reason: "no ground set from Lean" };
  return ekrScript(fam, shape, ground);
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
  /** Bound for this attempt (a sketch hole gets a share of the sketch's time); default from the environment. */
  timeLimitMs?: number;
}): Promise<{ proof?: OptimizationProof; reason: string; counterexample?: string }> {
  const { sessionId, theoremName, theoremType, expectedSignature, useMathlib } = args;
  if (!looksOptimization(theoremType)) return { reason: "not an optimization statement" };
  const heartbeats = Number(process.env.OPTIMIZE_MAX_HEARTBEATS ?? 4_000_000);
  const opened = await openRunner({
    theoremName,
    theoremType,
    useMathlib,
    timeLimitMs: (args.timeLimitMs ?? Number(process.env.OPTIMIZE_TIME_LIMIT_MS ?? 180_000)),
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
    // Oddtown (odd sizes, even pairwise intersections ⇒ at most |U|): linear algebra over 𝔽₂ (oddtown.ts)
    const odd = oddtownShape(theoremType);
    if (odd) {
      const mark = run.save();
      const o = await oddtownProof(run, odd);
      if (o.ok) {
        const tactics = script.join("\n");
        const source = scriptSource({ theoremName, theoremType, tactics, useMathlib, heartbeats });
        const verification = await session.verify(sessionId, source, { theoremName, expectedSignature, timeoutMs: Number(process.env.OPTIMIZE_VERIFY_TIMEOUT_MS ?? 300_000) });
        if (verification.ok) return { proof: { verification, source, tactics }, reason: "" };
        if (process.env.OPTIMIZE_DEBUG) console.error(`[optimize] Oddtown proof did not verify:\n${source}\n${verification.log}`);
      } else if (process.env.OPTIMIZE_DEBUG) console.error(`[optimize] Oddtown: ${o.reason}`);
      run.restore(mark);
    }
    // "largest family of subsets": a colouring the kernel checks (family.ts), before the generic search
    const fam = parseFamily(theoremType);
    if (fam) {
      const ekr = await ekrProof(session, fam);
      if (ekr?.tactics) {
        const source = scriptSource({ theoremName, theoremType, tactics: ekr.tactics, useMathlib, heartbeats });
        const verification = await session.verify(sessionId, source, { theoremName, expectedSignature, timeoutMs: Number(process.env.OPTIMIZE_VERIFY_TIMEOUT_MS ?? 300_000) });
        if (verification.ok) return { proof: { verification, source, tactics: ekr.tactics }, reason: "" };
        if (process.env.OPTIMIZE_DEBUG) console.error(`[optimize] Erdős–Ko–Rado proof did not verify:\n${source}\n${verification.log}`);
      } else if (ekr?.counterexample) return { reason: ekr.reason, counterexample: ekr.counterexample };
      else if (ekr && process.env.OPTIMIZE_DEBUG) console.error(`[optimize] Erdős–Ko–Rado: ${ekr.reason}`);
    }
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
    // card conditions on a few sets (Venn regions): region sizes as witness, regions + omega as bound
    if (!fam && /∃ (?:[^\s(),:]+ )+: Finset /.test(theoremType) && /\.card\b/.test(theoremType)) {
      const mark = run.save();
      const v = await vennOptimize(run, theoremType);
      if (v.ok) {
        const tactics = script.join("\n");
        const source = scriptSource({ theoremName, theoremType, tactics, useMathlib, heartbeats });
        const verification = await session.verify(sessionId, source, { theoremName, expectedSignature, timeoutMs: Number(process.env.OPTIMIZE_VERIFY_TIMEOUT_MS ?? 300_000) });
        if (verification.ok) return { proof: { verification, source, tactics }, reason: "" };
        if (process.env.OPTIMIZE_DEBUG) console.error(`[optimize] Venn proof did not verify:\n${source}\n${verification.log}`);
      } else if (v.counterexample) return { reason: v.reason, counterexample: v.counterexample };
      else if (process.env.OPTIMIZE_DEBUG) console.error(`[optimize] Venn: ${v.reason}`);
      run.restore(mark);
    }
    const r = await proveOptimization(run, session);
    if (!r.ok) return { reason: r.reason ?? "not proved" };
    const tactics = script.join("\n");
    const source = scriptSource({ theoremName, theoremType, tactics, useMathlib, heartbeats });
    const verification = await session.verify(sessionId, source, { theoremName, expectedSignature, timeoutMs: Number(process.env.OPTIMIZE_VERIFY_TIMEOUT_MS ?? 300_000) });
    if (!verification.ok && process.env.OPTIMIZE_DEBUG) console.error(`[optimize] verify failed:\n${source}\n${verification.log}`);
    if (!verification.ok) return { reason: `the written proof did not verify: ${summarizeFailure(verification, 160)}` };
    return { proof: { verification, source, tactics }, reason: "" };
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    return { reason: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  } finally {
    session.close();
  }
}
