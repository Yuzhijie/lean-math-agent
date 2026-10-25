/**
 * Combinatorial arguments the program writes itself, without a model (strategy "combinatorics"):
 *
 *  - orbits (orbit.ts) — "how many choices up to rotation / reflection": Lean lists one
 *    representative per orbit (`#eval`, outside the proof), the program writes the proof; when
 *    Lean's count differs from the statement's, the statement is false and that is reported;
 *  - Venn regions (venn.ts) — card facts about A, B, C, …: every expression split into regions,
 *    the region cards solved by omega;
 *  - finite decision (finite.ts) — lets unfolded, lambdas reduced, set cards turned into Finset
 *    cards, then the kernel decides (`decide +kernel`), conjunctions part by part.
 *
 * Every script is verified as a whole like any other proof.
 */
import { CancelledError } from "../../jobs";
import { looksGeometric } from "../geometry";
import { parseGoal } from "../geometry/goal";
import type { LeanVerifyResult } from "../sandbox";
import { openRunner, scriptSource } from "../tactic-runner";
import { closeFinite, introAll } from "./finite";
import { orbitEvalCommand, orbitScript, orbitShape, parseReps } from "./orbit";
import { vennScript } from "./venn";

export type CombinatoricsMethod = "orbits" | "venn" | "finite";

export function looksCombinatorial(theoremType: string): boolean {
  if (looksGeometric(theoremType)) return false;
  return /\b(card|ncard|Fintype|Finset|Equiv\.Perm|choose|Fin \d+|List\.count|Multiset)\b|\.card\b/.test(theoremType);
}

export interface CombinatoricsProof {
  verification: LeanVerifyResult;
  source: string;
  tactics: string;
  method: CombinatoricsMethod;
}

/** Lean's own count of the orbits for an orbit-counting statement (orbit.ts), or undefined. */
async function countOrbits(session: { evaluate(c: string, t?: number): Promise<{ severity: string; data: string }[]> }, shape: NonNullable<ReturnType<typeof orbitShape>>) {
  const msgs = await session.evaluate(orbitEvalCommand(shape), Number(process.env.COMBINATORICS_EVAL_TIMEOUT_MS ?? 60_000));
  const err = msgs.find((m) => m.severity === "error");
  if (err) return { error: err.data.split("\n")[0] };
  const reps = msgs.map((m) => parseReps(m.data)).find((r) => r !== undefined);
  return reps ? { reps } : { error: "no list in Lean's output" };
}

/**
 * A wrong count in an orbit-counting statement: Lean lists the orbits itself; undefined when the
 * statement is not of that shape, the count agrees, or nothing could be computed. Never throws
 * except on cancellation.
 */
export async function countRefute(args: { theoremName: string; theoremType: string; useMathlib?: boolean }): Promise<{ counted: number; stated: number; reps: number[][] } | undefined> {
  const shape = orbitShape(args.theoremType);
  if (!shape) return undefined;
  const opened = await openRunner({ theoremName: args.theoremName, theoremType: args.theoremType, useMathlib: args.useMathlib ?? true, timeLimitMs: 90_000, tacticTimeoutMs: 30_000, label: "combinatorics" });
  if (typeof opened === "string") return undefined;
  try {
    const r = await countOrbits(opened.session, shape);
    if (!r.reps || r.reps.length === shape.total) return undefined;
    return { counted: r.reps.length, stated: shape.total, reps: r.reps };
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    return undefined;
  } finally {
    opened.session.close();
  }
}

export async function combinatoricsProof(args: {
  sessionId: string;
  theoremName: string;
  theoremType: string;
  expectedSignature?: string;
  useMathlib: boolean;
}): Promise<{ proof?: CombinatoricsProof; reason: string; counterexample?: string }> {
  const { sessionId, theoremName, theoremType, expectedSignature, useMathlib } = args;
  if (!looksCombinatorial(theoremType)) return { reason: "not a finite / counting statement" };
  const opened = await openRunner({
    theoremName,
    theoremType,
    useMathlib,
    timeLimitMs: Number(process.env.COMBINATORICS_TIME_LIMIT_MS ?? 180_000),
    tacticTimeoutMs: Number(process.env.COMBINATORICS_TACTIC_TIMEOUT_MS ?? 60_000),
    label: "combinatorics",
    debugEnv: "COMBINATORICS_DEBUG",
  });
  if (typeof opened === "string") return { reason: opened };
  const { run, script, session } = opened;
  const reasons: string[] = [];
  const verify = async (tactics: string, method: CombinatoricsMethod) => {
    const source = scriptSource({ theoremName, theoremType, tactics, useMathlib, heartbeats: Number(process.env.COMBINATORICS_MAX_HEARTBEATS ?? 4_000_000) });
    const verification = await session.verify(sessionId, source, { theoremName, expectedSignature });
    if (!verification.ok && process.env.COMBINATORICS_DEBUG) console.error(`[combinatorics] ${method} did not verify:\n${source}\n${verification.log}`);
    if (verification.ok) return { verification, source, tactics, method };
    reasons.push(`${method}: the written proof did not verify (${verification.log.split("\n")[0]?.slice(0, 120) ?? ""})`);
    return undefined;
  };
  try {
    // 1. orbits
    const shape = orbitShape(theoremType);
    if (shape) {
      try {
        const r = await countOrbits(session, shape);
        if (!r.reps) reasons.push(`orbits: Lean did not list the representatives (${r.error})`);
        else if (r.reps.length !== shape.total) {
          return {
            reason: `Lean counts ${r.reps.length} orbits, the statement says ${shape.total}`,
            counterexample: `${r.reps.length} ≠ ${shape.total}; representatives: ${JSON.stringify(r.reps.slice(0, 20))}`,
          };
        } else {
          const p = await verify(orbitScript(shape, r.reps), "orbits");
          if (p) return { proof: p, reason: "" };
        }
      } catch (e) {
        if (e instanceof CancelledError) throw e;
        reasons.push(`orbits: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
      }
    }
    // 2. Venn regions, 3. finite decision — after the intros
    const lets = await introAll(run);
    if (!run.goals().length) {
      const p = await verify(script.join("\n"), "finite");
      if (p) return { proof: p, reason: "" };
    }
    const mark = run.save();
    const st = run.goals()[0] ? parseGoal(run.goals()[0]) : null;
    const venn = st ? vennScript(st) : undefined;
    if (venn) {
      const p = await verify([...script, ...venn].join("\n"), "venn");
      if (p) return { proof: p, reason: "" };
    }
    run.restore(mark);
    if (await closeFinite(run, lets)) {
      const p = await verify(script.join("\n"), "finite");
      if (p) return { proof: p, reason: "" };
    } else reasons.push("finite: a goal the kernel could not decide");
    return { reason: reasons.join("; ") || "not proved" };
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    return { reason: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  } finally {
    session.close();
  }
}
