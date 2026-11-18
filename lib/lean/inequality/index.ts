/**
 * Inequality proofs the program writes (strategy "inequality"; a stage of lib/lean/prover-stages.ts).
 * Two routes, each a script written from the goal after the intros and verified as a whole:
 *   – symmetric.ts: symmetric inequalities in three positive reals with x · y · z = 1, with or
 *     without an equality case (the pqr substitution, the algebra by scripts/sym_inequality.py);
 *   – squares.ts: inequalities between polynomials or fractions in up to four real variables that
 *     are sums of AM–GM steps between two monomials, with or without an equality case between the
 *     variables (the squares found by scripts/squares_inequality.py).
 * A statement with x · y · z = 1 gets the first, then the second (which does not use the product).
 */
import { CancelledError } from "../../jobs";
import { summarizeFailure } from "../feedback";
import type { LeanVerifyResult } from "../sandbox";
import { openRunner, scriptSource } from "../tactic-runner";
import { introAll } from "../combinatorics/finite";
import { parseGoal, type GoalState } from "../geometry/goal";
import * as squares from "./squares";
import * as symmetric from "./symmetric";

const ID = "[A-Za-z_][\\w'₀-₉]*";

/**
 * Is this the kind of statement the symmetric route was written for? Read off the text: three
 * reals with `0 < x` each, `x * y * z = 1`, and a `≤` / `≥` between them.
 */
export function looksSymmetricInequality(theoremType: string): boolean {
  const t = theoremType.replace(/\s+/g, " ");
  if (!/ℝ/.test(t) || !/[≤≥]/.test(t)) return false;
  const m = new RegExp(`\\(?(${ID}) \\* (${ID})\\)? \\* (${ID}) = 1(?![\\w.])`).exec(t);
  if (!m || new Set([m[1], m[2], m[3]]).size !== 3) return false;
  return [m[1], m[2], m[3]].every((v) => new RegExp(`(?<![\\w.'])(0 < ${v}|${v} > 0)(?![\\w.'])`).test(t));
}

/** What a statement of plain arithmetic in real variables does not contain: other types, functions, binders, sets. */
const NOT_ARITHMETIC = /[ℕℤℚℂ∑∏∃√|⌊⌈∈∉⊆∪∩∣%!]|Real\.|Nat\.|Int\.|Finset|Set\.|Polynomial|Matrix|\bfun\b|\bIs(Least|Greatest)\b|\b(max|min|deriv|log|exp|sin|cos|tan|sqrt)\b|→ ℝ|ℝ ×/;

/**
 * An inequality between arithmetic expressions in real variables, or when two of them are equal
 * (the squares route's kind of statement), read off the text: 2 = at least one variable is stated
 * positive, 1 = none is (the automation usually has those), 0 = not this kind.
 */
export function polynomialInequalityFit(theoremType: string): 0 | 1 | 2 {
  const t = theoremType.replace(/\s+/g, " ");
  if (!/ℝ/.test(t) || !/[≤≥↔]/.test(t) || NOT_ARITHMETIC.test(t)) return 0;
  return new RegExp(`(?<![\\w.'])(0 < ${ID}|${ID} > 0)(?![\\w.'])`).test(t) ? 2 : 1;
}

export function inequalityFit(theoremType: string): 0 | 1 | 2 {
  return looksSymmetricInequality(theoremType) ? 2 : polynomialInequalityFit(theoremType);
}

export type InequalityMethod = "symmetric" | "squares";

export interface InequalityProof {
  verification: LeanVerifyResult;
  source: string;
  tactics: string;
  method: InequalityMethod;
}

/** The routes for a statement, in the order they are tried. */
export function inequalityMethods(theoremType: string): InequalityMethod[] {
  const fits = polynomialInequalityFit(theoremType) > 0;
  return looksSymmetricInequality(theoremType) ? (fits ? ["symmetric", "squares"] : ["symmetric"]) : fits ? ["squares"] : [];
}

/** One route's script for the goal, or why it has none. */
async function written(method: InequalityMethod, st: GoalState, timeoutMs: number): Promise<string | { reason: string; counterexample?: string }> {
  if (method === "symmetric") {
    const pl = await symmetric.plan(st, timeoutMs);
    return "reason" in pl ? pl : symmetric.script(pl);
  }
  const pl = await squares.plan(st, timeoutMs);
  return "reason" in pl ? pl : squares.script(pl);
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
  const methods = inequalityMethods(theoremType);
  if (!methods.length) return { reason: "not an inequality between arithmetic expressions in real variables" };
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
    const reasons: string[] = [];
    // with two routes each reason says whose it is
    const said = (method: InequalityMethod, reason: string) => reasons.push(methods.length > 1 ? `${method}: ${reason}` : reason);
    for (const method of methods) {
      const left = limit - (Date.now() - started);
      if (left < 15_000) {
        said(method, "no time left");
        break;
      }
      const script = await written(method, st, Math.max(5_000, Math.min(45_000, left - 10_000)));
      if (typeof script !== "string") {
        // a point where the statement is false: the other route need not look
        if (script.counterexample) return { reason: script.reason, counterexample: script.counterexample };
        said(method, script.reason);
        continue;
      }
      const tactics = [...applied, script].join("\n");
      const source = scriptSource({ theoremName, theoremType, tactics, useMathlib, heartbeats: Number(process.env.INEQUALITY_MAX_HEARTBEATS ?? 4_000_000) });
      const verification = await session.verify(sessionId, source, { theoremName, expectedSignature });
      if (verification.ok) return { proof: { verification, source, tactics, method }, reason: "" };
      if (process.env.INEQUALITY_DEBUG) console.error(`[inequality] the written proof (${method}) did not verify:\n${source}\n${verification.log}`);
      said(method, `the written proof did not verify (${summarizeFailure(verification, 160)})`);
    }
    return { reason: reasons.join("; ") };
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    return { reason: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  } finally {
    session.close();
  }
}
