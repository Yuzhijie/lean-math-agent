/**
 * Combinatorial optimization proofs the program writes (strategy "optimize"): "the largest /
 * smallest value is M" as `IsGreatest S M` / `IsLeast S M`, `M ∈ upperBounds S`, or
 * `(∃ attained) ∧ (∀ bound)`. The attained value's witness is found by Lean itself (`#eval` over
 * the finite candidates), the bound by a box the kernel decides (prove.ts). Every script is
 * verified as a whole.
 */
import { CancelledError } from "../../jobs";
import { looksGeometric } from "../geometry";
import { splitLets, squash, stripParens, topIndex } from "../combinatorics/lets";
import { summarizeFailure } from "../feedback";
import type { LeanVerifyResult } from "../sandbox";
import { splitTopLevelColon } from "../statement-prop";
import { openRunner, scriptSource } from "../tactic-runner";
import { proveOptimization } from "./prove";
import { CLIQUE_MAX_NODES, cliqueScript, cliqueSearch, cliqueTable, maxCoverFamily } from "./clique";
import { colourFamily, familyEvalCommand, familyScript, maxFamily, parseFamily, readFamilyGraph } from "./family";
import type { ProofSession } from "../proof-state";
import { ekrScript, ekrShape, groundEvalCommand, readGround } from "./ekr";
import { oddtownProof, oddtownShape } from "./oddtown";
import { F_TACTICS, findMoves, invariantFault, parityBounds, processEvalCommand, processScript, processShape, readProcessData, type ProcessShape } from "./process";
import { vennOptimize } from "./venn";

/** The statement itself, after its binders and lets, is a conjunction with an `∃ …` part and a `∀ …` part: a value attained and its bound. */
function attainedAndBound(theoremType: string): boolean {
  const goal = splitTopLevelColon(theoremType)?.goal ?? theoremType;
  let rest = stripParens(squash(splitLets(`: ${goal}`)?.body ?? goal));
  const parts: string[] = [];
  for (let i = topIndex(rest, "∧"); i >= 0; i = topIndex(rest, "∧")) {
    parts.push(stripParens(rest.slice(0, i)));
    rest = rest.slice(i + 1);
  }
  parts.push(stripParens(rest));
  return parts.length >= 2 && parts.some((x) => x.startsWith("∃")) && parts.some((x) => x.startsWith("∀"));
}

/**
 * How well this prover fits a statement (the stage table, lib/lean/prover-stages.ts, runs the
 * provers best fit first): 2 = it states an extremum — IsGreatest / IsLeast / upper- or
 * lowerBounds, or the statement is "attained ∧ bounded" itself —, 1 = only an ∃ and a ∀ joined
 * by ∧ somewhere with an inequality (the lets of an orbit count read like that too), 0 = not for
 * it (ℝ / ℚ / ℂ, coordinates).
 */
export function optimizationFit(theoremType: string): 0 | 1 | 2 {
  if (looksGeometric(theoremType) || /ℝ|ℚ|ℂ/.test(theoremType)) return 0;
  if (/\b(IsGreatest|IsLeast|upperBounds|lowerBounds)\b/.test(theoremType)) return 2;
  if (!(/∃[\s\S]*∧[\s\S]*∀|∀[\s\S]*∧[\s\S]*∃/.test(theoremType) && /[≤≥<>]/.test(theoremType))) return 0;
  return attainedAndBound(theoremType) ? 2 : 1;
}

/** IsGreatest / IsLeast / bounds, or a conjunction of an ∃ and a ∀ (attained + bound). */
export function looksOptimization(theoremType: string): boolean {
  return optimizationFit(theoremType) > 0;
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
  if (fam.cover) {
    // the family must cover the ground set: a search the kernel runs (clique.ts)
    const points = Number(/Fin (\d+)/.exec(fam.memberType)![1]);
    const table = cliqueTable(g, points);
    const text = (ids: number[]) => ids.map((i) => `{${g.sets[table.verts[i]].join(", ")}}`).join(", ");
    const top = maxCoverFamily(table, fam.M + 1);
    if (top.length > fam.M) return { reason: `a covering family of ${top.length} members fits: ${text(top)}`, counterexample: `${top.length} > ${fam.M}: ${text(top)}` };
    if (top.length < fam.M) return { reason: `the largest covering family found has ${top.length} members, not ${fam.M}` };
    const search = cliqueSearch(table, fam.M + 1);
    if (!search.empty) return { reason: `the search for a covering family of ${fam.M + 1} members takes more than ${CLIQUE_MAX_NODES} nodes: not given to the kernel` };
    return { tactics: cliqueScript(fam, g, table, top), reason: "" };
  }
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

/**
 * A replacement process (process.ts): the numbers at the start and the table of the number
 * written from Lean, the moves from the program; the scripts to verify, one per way of proving
 * the facts about the number written (the first that verifies is the proof).
 */
async function processScripts(session: ProofSession, shape: ProcessShape): Promise<{ scripts?: string[]; reason: string; counterexample?: string }> {
  const msgs = await session.evaluate(processEvalCommand(shape), Number(process.env.OPTIMIZE_EVAL_TIMEOUT_MS ?? 60_000));
  const err = msgs.find((m) => m.severity === "error");
  if (err) return { reason: `the numbers at the start could not be listed: ${err.data.split("\n")[0]}` };
  const data = msgs.map((m) => readProcessData(m.data)).find((x) => x);
  if (!data) return { reason: "no numbers at the start from Lean" };
  const fault = invariantFault(data);
  if (fault) return { reason: fault };
  const allowed = parityBounds(data);
  const best = shape.kind === "greatest" ? allowed.greatest : allowed.least;
  if (shape.M !== best) {
    // the statement's value is not what range and parity give: moves to a better one refute it
    const better = shape.kind === "greatest" ? shape.M < best : shape.M > best;
    const moves = better ? findMoves(data, best) : undefined;
    if (moves) {
      const text = `${moves.map(([x, y]) => `(${x}, ${y})`).join(", ")} leave ${best}`;
      return { reason: `the moves ${text}, not ${shape.M}`, counterexample: `${best} ${shape.kind === "greatest" ? ">" : "<"} ${shape.M}: erasing ${text}` };
    }
    return { reason: `range and parity allow ${best} as the ${shape.kind} last number, the statement says ${shape.M}` };
  }
  const moves = findMoves(data, shape.M);
  if (!moves) return { reason: `no moves found that leave ${shape.M}` };
  const scripts = F_TACTICS(shape.a, shape.b, shape.f).flatMap((t) => processScript(shape, data, moves, t) ?? []);
  return scripts.length ? { scripts, reason: "" } : { reason: "the moves do not end at the statement's value" };
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
    // "two numbers are erased and one is written": an invariant and the moves (process.ts)
    const proc = processShape(theoremType);
    if (proc) {
      const p = await processScripts(session, proc);
      if (p.counterexample) return { reason: p.reason, counterexample: p.counterexample };
      let failure = p.reason;
      for (const tactics of p.scripts ?? []) {
        const source = scriptSource({ theoremName, theoremType, tactics, useMathlib, heartbeats });
        const verification = await session.verify(sessionId, source, { theoremName, expectedSignature, timeoutMs: Number(process.env.OPTIMIZE_VERIFY_TIMEOUT_MS ?? 300_000) });
        if (verification.ok) return { proof: { verification, source, tactics }, reason: "" };
        failure = `the written proof did not verify: ${summarizeFailure(verification, 160)}`;
        if (process.env.OPTIMIZE_DEBUG) console.error(`[optimize] process proof did not verify:\n${source}\n${verification.log}`);
      }
      if (process.env.OPTIMIZE_DEBUG) console.error(`[optimize] process: ${failure}`);
      return { reason: `process: ${failure}` };
    }
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
