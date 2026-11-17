/**
 * Combinatorial arguments the program writes itself, without a model (strategy "combinatorics"):
 *
 *  - orbits (orbit.ts) — "how many choices up to rotation / reflection": Lean lists one
 *    representative per orbit (`#eval`, outside the proof), the program writes the proof; when
 *    Lean's count differs from the statement's, the statement is false and that is reported;
 *  - rows (rows.ts) — "the arrangements of 1, …, n in a row whose neighbours …": the kernel
 *    builds them place by place (a general lemma, written into the proof, says that this counts
 *    the permutations); Lean counts first, and another number than the statement's is reported;
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
import { summarizeFailure } from "../feedback";
import type { LeanVerifyResult } from "../sandbox";
import { openRunner, scriptSource } from "../tactic-runner";
import { closeFinite, introAll } from "./finite";
import { splitLets, squash, stripParens } from "./lets";
import { orbitEvalCommand, orbitScript, orbitShape, parseReps } from "./orbit";
import { circularScript, circularShape } from "./circular";
import { parseLevels, rowEvalCommand, rowScript, rowShape, type RowShape } from "./rows";
import { vennScript } from "./venn";

export type CombinatoricsMethod = "orbits" | "circular" | "rows" | "venn" | "finite";

export function looksCombinatorial(theoremType: string): boolean {
  if (looksGeometric(theoremType)) return false;
  return /\b(card|ncard|Fintype|Finset|Equiv\.Perm|choose|Fin \d+|List\.count|Multiset)\b|\.card\b/.test(theoremType);
}

/** The statement (no binders), after its lets, is a count: `Set.ncard … = N`, `Nat.card …`, `Fintype.card …`, `(…).card = N`, `S.card = N`. */
function assertsCount(theoremType: string): boolean {
  const t = squash(theoremType);
  if (!t.startsWith(":")) return false;
  const body = stripParens(splitLets(t)?.body ?? t.slice(1));
  return /^(Set\.ncard|Nat\.card|Fintype\.card|Finset\.card) /.test(body) || /^(\(.+\)|[A-Za-z_][\w']*)\.card = \(?\d+(?: : ℕ\))?$/.test(body);
}

/**
 * How well this prover fits a statement (the stage table, lib/lean/prover-stages.ts, runs the
 * provers best fit first): 2 = the statement is a count (seatings round a table, choices up to
 * rotation, the card of a filter …), 1 = only the vocabulary of finite sets, 0 = not for it.
 */
export function combinatorialFit(theoremType: string): 0 | 1 | 2 {
  if (!looksCombinatorial(theoremType)) return 0;
  return writtenCount(theoremType) || assertsCount(theoremType) ? 2 : 1;
}

/**
 * A count the program has a proof written for — round a circle, up to rotation / reflection, in
 * a row: Lean counts first (orbits, rows), then the written proof is checked. On these the
 * prover runs before the single tactics (prover-stages.ts), which could only decide the count
 * over every arrangement.
 */
export function writtenCount(theoremType: string): boolean {
  return looksCombinatorial(theoremType) && Boolean(circularShape(theoremType) || orbitShape(theoremType) || rowShape(theoremType));
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

/** The most rows the kernel is given to build for an arrangement count (all places together); 19 184 for "1 … 8, no neighbours differ by 1". */
const rowsCap = () => Number(process.env.ROWS_MAX_LISTS ?? 40_000);

/**
 * Lean's own count of the arrangements in a row (rows.ts): `count` of them, and `built`, the rows
 * the kernel would go through to prove it (the rows after every place together).
 */
async function countRows(session: { evaluate(c: string, t?: number): Promise<{ severity: string; data: string }[]> }, shape: RowShape) {
  const msgs = await session.evaluate(rowEvalCommand(shape), Number(process.env.COMBINATORICS_EVAL_TIMEOUT_MS ?? 60_000));
  const err = msgs.find((m) => m.severity === "error");
  if (err) return { error: err.data.split("\n")[0] };
  const levels = msgs.map((m) => parseLevels(m.data)).find((r) => r !== undefined);
  if (!levels || levels.length !== shape.n) return { error: "no count in Lean's output" };
  return { count: levels[levels.length - 1], built: levels.reduce((a, b) => a + b, 0) };
}

/**
 * A wrong count in a counting statement Lean can count itself — orbits up to rotation / reflection
 * (orbit.ts), arrangements in a row (rows.ts); undefined when the statement is not of such a
 * shape, the count agrees, or nothing could be computed. Never throws except on cancellation.
 */
export async function countRefute(args: { theoremName: string; theoremType: string; useMathlib?: boolean }): Promise<{ counted: number; stated: number; reps: number[][]; kind: "orbits" | "rows" } | undefined> {
  const shape = orbitShape(args.theoremType);
  const rows = shape ? undefined : rowShape(args.theoremType);
  if (!shape && !rows) return undefined;
  const opened = await openRunner({ theoremName: args.theoremName, theoremType: args.theoremType, useMathlib: args.useMathlib ?? true, timeLimitMs: 90_000, tacticTimeoutMs: 30_000, label: "combinatorics" });
  if (typeof opened === "string") return undefined;
  try {
    if (rows) {
      const r = await countRows(opened.session, rows);
      return r.count === undefined || r.count === rows.total ? undefined : { counted: r.count, stated: rows.total, reps: [], kind: "rows" };
    }
    if (!shape) return undefined;
    const r = await countOrbits(opened.session, shape);
    if (!r.reps || r.reps.length === shape.total) return undefined;
    return { counted: r.reps.length, stated: shape.total, reps: r.reps, kind: "orbits" };
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
  /** Bound for this attempt (a sketch hole gets a share of the sketch's time); default from the environment. */
  timeLimitMs?: number;
}): Promise<{ proof?: CombinatoricsProof; reason: string; counterexample?: string }> {
  const { sessionId, theoremName, theoremType, expectedSignature, useMathlib } = args;
  if (!looksCombinatorial(theoremType)) return { reason: "not a finite / counting statement" };
  const opened = await openRunner({
    theoremName,
    theoremType,
    useMathlib,
    timeLimitMs: (args.timeLimitMs ?? Number(process.env.COMBINATORICS_TIME_LIMIT_MS ?? 180_000)),
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
    reasons.push(`${method}: the written proof did not verify (${summarizeFailure(verification, 120)})`);
    return undefined;
  };
  try {
    // 0. seatings round a table up to rotation (circular.ts)
    const circ = circularShape(theoremType);
    if (circ) {
      const p = await verify(circularScript(circ), "circular");
      if (p) return { proof: p, reason: "" };
    }
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
          const tactics = orbitScript(shape, r.reps);
          if (!tactics) reasons.push("orbits: the statement names a let the way the written proof names its own steps");
          else {
            const p = await verify(tactics, "orbits");
            if (p) return { proof: p, reason: "" };
          }
        }
      } catch (e) {
        if (e instanceof CancelledError) throw e;
        reasons.push(`orbits: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
      }
    }
    // 2. arrangements in a row (rows.ts)
    const rows = rowShape(theoremType);
    if (rows) {
      try {
        const r = await countRows(session, rows);
        if (r.count === undefined) reasons.push(`rows: Lean did not count the arrangements (${r.error})`);
        else if (r.count !== rows.total) {
          return { reason: `Lean counts ${r.count} arrangements, the statement says ${rows.total}`, counterexample: `${r.count} ≠ ${rows.total}` };
        } else if (r.built > rowsCap()) {
          // the number is right as Lean computes it, which is not a proof; the permutations themselves —
          // what the finite route would go through — are no fewer than a third of these rows
          return { reason: `rows: Lean counts ${r.count} arrangements too, but a proof would have the kernel build ${r.built} rows (ROWS_MAX_LISTS ${rowsCap()})` };
        } else {
          const p = await verify(rowScript(rows), "rows");
          if (p) return { proof: p, reason: "" };
        }
      } catch (e) {
        if (e instanceof CancelledError) throw e;
        reasons.push(`rows: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
      }
    }
    // 3. Venn regions, 4. finite decision — after the intros
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
