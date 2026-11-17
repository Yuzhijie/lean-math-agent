/**
 * A hole of the model's proof sketch closed by the provers the program writes (no model): the hole's
 * goal as a lemma of its own (goal-statement.ts — same hypothesis names, so the script runs at the
 * hole as written) goes through the prover stages of the table everything else runs
 * (lib/lean/prover-stages.ts): the provers that fit, best fit first — coordinate geometry,
 * induction, optimization, combinatorics — then the tactic-combination search (auto: inequalities,
 * AM–GM, certificates, every value of a bounded variable, …). The quick stages are left out: the
 * sketch has run the automation on the hole. The model decides the steps; what is hard to compute
 * is left to the program.
 *
 * Each prover opens its own REPL worker: the sketch closes its session before calling this (with one
 * worker, a second lease would wait for it forever).
 */
import { planStages, runProverStages, type StagePhase } from "../lean/prover-stages";
import type { ProgramStrategy } from "../types";

export type HoleProver = Extract<ProgramStrategy, "geometry" | "induction" | "optimize" | "inequality" | "combinatorics" | "auto">;

/** The stages a hole goes through. */
const HOLE_PHASES: readonly StagePhase[] = ["prover", "fallback"];

export interface ProgramHoleResult {
  tactics: string;
  prover: HoleProver;
  /** What each prover said when it did not close the hole. */
  tried: string[];
}

const statementOf = (a: { sessionId: string; theoremName: string; statement: string; useMathlib: boolean; opens?: string[] }) => ({
  sessionId: a.sessionId,
  theoremName: a.theoremName,
  theoremType: a.statement,
  useMathlib: a.useMathlib,
  opens: a.opens,
});

/** The provers that would be tried on a statement, in order. */
export function holeProversFor(statement: string): HoleProver[] {
  return planStages(statementOf({ sessionId: "", theoremName: "", statement, useMathlib: true }), HOLE_PHASES).map((p) => p.stage.id as HoleProver);
}

/**
 * The first program prover that proves `statement` within `budgetMs` (shared among the provers
 * that fit, in order — the budget is the only limit: a prover may use all that is left of it),
 * or undefined. A prover that throws counts as not closing it.
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
  const tried: string[] = [];
  const r = await runProverStages(statementOf(args), {
    budgetMs: args.budgetMs,
    budgetOnly: true,
    phases: HOLE_PHASES,
    onStage: (e) => {
      if (e.type === "start") args.onTry?.(e.stage.id as HoleProver);
      else if (e.type === "failed") tried.push(`${e.stage.id}: ${e.reason ?? ""}`);
    },
  });
  return r.proof?.tactics.trim() ? { tactics: r.proof.tactics, prover: r.proof.strategy as HoleProver, tried } : undefined;
}
