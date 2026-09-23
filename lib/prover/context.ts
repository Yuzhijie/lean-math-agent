/**
 * Prover context: what the prover is told besides the statement — premises
 * retrieved for the initial goal (`lib/lean/premises.ts`) and verified
 * proofs of similar theorems from memory (`lib/lean/proof-memory.ts`),
 * formatted as one prompt block shared by the whole-proof, sketch and
 * goal-search stages. Every part is best-effort: failures degrade to an
 * empty block.
 */
import { formatPremises, premisesEnabled, retrievePremises, type Premise } from "../lean/premises";
import { formatRecalledProofs, proofMemoryEnabled, recallProofs, rememberProof, type ProofMemoryEntry } from "../lean/proof-memory";

export interface ProverContext {
  /** Prompt block (may be ""). */
  block: string;
  premises: Premise[];
  recalled: ProofMemoryEntry[];
}

export interface ProverContextArgs {
  theoremType: string;
  /** Goal state at the initial `sorry` when known (better retrieval query than the statement). */
  initialGoal?: string;
  problemText?: string;
  useMathlib: boolean;
  premisesK?: number;
  memoryK?: number;
}

function envNum(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : dflt;
}

export async function buildProverContext(args: ProverContextArgs): Promise<ProverContext> {
  let premises: Premise[] = [];
  let recalled: ProofMemoryEntry[] = [];
  if (args.useMathlib && premisesEnabled()) {
    try {
      premises = await retrievePremises(args.initialGoal ?? args.theoremType, {
        k: args.premisesK ?? envNum("PREMISES_TOP_K", 8),
        context: args.problemText,
      });
    } catch {
      premises = [];
    }
  }
  if (proofMemoryEnabled()) {
    try {
      recalled = await recallProofs({
        theoremType: args.theoremType,
        problemText: args.problemText,
        excludeType: args.theoremType,
        k: args.memoryK ?? envNum("PROOF_MEMORY_TOP_K", 2),
      });
    } catch {
      recalled = [];
    }
  }
  const block = [formatPremises(premises), formatRecalledProofs(recalled)].filter(Boolean).join("\n\n");
  return { block, premises, recalled };
}

/** Store an accepted proof in memory (never throws). */
export async function rememberVerifiedProof(args: {
  theoremName: string;
  theoremType: string;
  tactics: string;
  strategy?: string;
  problemText?: string;
}): Promise<boolean> {
  try {
    return (await rememberProof(args)) !== undefined;
  } catch {
    return false;
  }
}
