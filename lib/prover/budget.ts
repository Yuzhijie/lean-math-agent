/**
 * Proof budget presets. One knob (`PROOF_BUDGET` or `options.budget`)
 * scales how many proofs are sampled, how many repair rounds run and how
 * far the goal-level search explores, so an easy homework problem does not
 * pay for a competition-grade search and a hard one is not starved.
 * Explicit env/option overrides for the individual stages still win.
 */
import type { GoalSearchConfig } from "../search/goal-search";
import type { SketchConfig } from "./sketch";
import type { WholeProofConfig } from "./whole-proof";

export type ProofBudget = "low" | "normal" | "high";

export interface BudgetPreset {
  wholeProof: Partial<WholeProofConfig>;
  sketch: Partial<SketchConfig>;
  goalSearch: Partial<GoalSearchConfig>;
}

const PRESETS: Record<ProofBudget, BudgetPreset> = {
  low: {
    wholeProof: { samples: 2, rounds: 1, timeBudgetMs: 90_000 },
    sketch: { samples: 1, repairs: 0, holeBudgetMs: 30_000, timeBudgetMs: 150_000, maxLlmHoles: 2 },
    goalSearch: { samplesPerNode: 3, maxNodes: 20, beam: 8 },
  },
  normal: {
    wholeProof: { samples: 4, rounds: 2, timeBudgetMs: 180_000 },
    sketch: { samples: 2, repairs: 1, holeBudgetMs: 60_000, timeBudgetMs: 300_000, maxLlmHoles: 4 },
    goalSearch: { samplesPerNode: 4, maxNodes: 60, beam: 16 },
  },
  high: {
    wholeProof: { samples: 8, rounds: 3, timeBudgetMs: 360_000 },
    sketch: { samples: 3, repairs: 2, holeBudgetMs: 120_000, timeBudgetMs: 600_000, maxLlmHoles: 6 },
    goalSearch: { samplesPerNode: 6, maxNodes: 150, beam: 24 },
  },
};

export function parseBudget(raw: string | undefined): ProofBudget | undefined {
  const v = raw?.trim().toLowerCase();
  return v === "low" || v === "normal" || v === "high" ? v : undefined;
}

/** The preset for a request: `options.budget`, else PROOF_BUDGET, else "normal". */
export function budgetPreset(requested?: string): { budget: ProofBudget; preset: BudgetPreset } {
  const budget = parseBudget(requested) ?? parseBudget(process.env.PROOF_BUDGET) ?? "normal";
  return { budget, preset: PRESETS[budget] };
}
