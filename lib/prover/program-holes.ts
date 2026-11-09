/**
 * A hole of the model's proof sketch closed by the provers the program writes (no model): the hole's
 * goal as a lemma of its own (goal-statement.ts — same hypothesis names, so the script runs at the
 * hole as written) goes to whichever of them fits — coordinate geometry, induction, optimization,
 * combinatorics — then the tactic-combination search (auto: inequalities, AM–GM, certificates,
 * every value of a bounded variable, …). The model decides the steps; what is hard to compute is
 * left to the program.
 *
 * Each prover opens its own REPL worker: the sketch closes its session before calling this (with one
 * worker, a second lease would wait for it forever).
 */
import { autoProof } from "../lean/auto";
import { combinatoricsProof, looksCombinatorial } from "../lean/combinatorics";
import { geometryProof, looksGeometric } from "../lean/geometry";
import { inductionProof, looksInductive } from "../lean/induction";
import { looksOptimization, optimizationProof } from "../lean/optimize";

export type HoleProver = "geometry" | "induction" | "optimize" | "combinatorics" | "auto";

export interface ProgramHoleResult {
  tactics: string;
  prover: HoleProver;
  /** What each prover said when it did not close the hole. */
  tried: string[];
}

interface Attempt {
  prover: HoleProver;
  fits: (statement: string) => boolean;
  run: (a: { sessionId: string; theoremName: string; theoremType: string; useMathlib: boolean; timeLimitMs: number; opens?: string[] }) => Promise<{ proof?: { tactics: string }; reason: string }>;
}

const ATTEMPTS: Attempt[] = [
  { prover: "geometry", fits: looksGeometric, run: (a) => geometryProof(a) },
  { prover: "induction", fits: looksInductive, run: (a) => inductionProof(a) },
  { prover: "optimize", fits: looksOptimization, run: (a) => optimizationProof(a) },
  { prover: "combinatorics", fits: looksCombinatorial, run: (a) => combinatoricsProof(a) },
  // the generic search, for anything but coordinate geometry (its own prover handles that)
  { prover: "auto", fits: (s) => !looksGeometric(s), run: (a) => autoProof(a) },
];

/** The provers that would be tried on a statement, in order. */
export function holeProversFor(statement: string): HoleProver[] {
  return ATTEMPTS.filter((a) => a.fits(statement)).map((a) => a.prover);
}

/**
 * The first program prover that proves `statement` within `budgetMs` (shared among the provers
 * that fit, in order), or undefined. A prover that throws counts as not closing it.
 */
export async function programHoleProof(args: {
  sessionId: string;
  theoremName: string;
  statement: string;
  useMathlib: boolean;
  budgetMs: number;
  opens?: string[];
  onTry?: (prover: HoleProver) => void;
}): Promise<ProgramHoleResult | undefined> {
  const deadline = Date.now() + args.budgetMs;
  const tried: string[] = [];
  for (const a of ATTEMPTS) {
    if (!a.fits(args.statement)) continue;
    const left = deadline - Date.now();
    if (left < 5_000) break;
    args.onTry?.(a.prover);
    try {
      const r = await a.run({ sessionId: args.sessionId, theoremName: args.theoremName, theoremType: args.statement, useMathlib: args.useMathlib, timeLimitMs: left, opens: args.opens });
      if (r.proof?.tactics?.trim()) return { tactics: r.proof.tactics, prover: a.prover, tried };
      tried.push(`${a.prover}: ${r.reason}`);
    } catch (e) {
      tried.push(`${a.prover}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
  }
  return undefined;
}
