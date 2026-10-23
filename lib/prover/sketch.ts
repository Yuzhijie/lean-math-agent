/**
 * Sketch-and-fill (subgoal decomposition).
 *
 * The prover writes the *structure* of the proof — intermediate facts as
 * `have h : … := by sorry` holes plus the real tactics that combine them
 * (Draft-Sketch-Prove; DeepSeek-Prover-V2's decomposition). The sketch is
 * elaborated once; every hole becomes a proof state, and each hole is then
 * closed independently by the automation hammer or goal-level search.
 * Small facts are far easier to prove than the whole theorem in one go,
 * and a failed hole costs only that hole's budget.
 *
 * Closing tactic scripts are spliced back into the sketch text and the
 * result goes through the strict verifier (statement lock, axioms, no
 * sorry) like any other proof.
 *
 * 2026-10 rework (the miniF2F baselines closed 1 hole in 54 sketches): the general model first writes
 * a numbered informal proof (high effort) and the sketch follows it, one `have` per step; a hole the
 * hammer leaves open goes to the dedicated prover as a lemma of its own (its goal state turned back into
 * a statement, see goal-statement.ts) before the goal-level search.
 */
import { chatProverRole } from "../llm/config";
import { goalToStatement } from "../lean/goal-statement";
import { assembleLeanSource } from "../lean/assemble";
import { hammer } from "../lean/hammer";
import { ProofSession, type ProofHole } from "../lean/proof-state";
import { ReplError } from "../lean/repl";
import { verifyLeanSource, type LeanVerifyResult } from "../lean/sandbox";
import { splitHeader } from "../lean/sanitize";
import { chatText, LlmError, sampleText } from "../llm/client";
import { INFORMAL_PROOF_SYSTEM, SKETCH_SYSTEM, informalProofUserMessage, sketchUserMessage } from "../llm/prompts";
import { costCapReached, expectedLatencyMs } from "../llm/usage-tracker";
import { lt } from "../llm/output-locale";
import { goalSearch, type GoalSearchConfig } from "../search/goal-search";
import { extractTactics, proveWholeTheorem } from "./whole-proof";

export interface SketchConfig {
  /** Sketches sampled per round (SKETCH_SAMPLES, default 2). */
  samples: number;
  /** Repair rounds when no sketch elaborates (SKETCH_REPAIRS, default 1). */
  repairs: number;
  /** Max holes a sketch may have (SKETCH_MAX_HOLES, default 8). */
  maxHoles: number;
  /** Wall-clock budget for the whole stage (SKETCH_BUDGET_MS, default 300 s). */
  timeBudgetMs: number;
  /** Per-hole search budget (SKETCH_HOLE_BUDGET_MS, default 60 s). */
  holeBudgetMs: number;
  /**
   * Max holes the hammer leaves open before a sketch is abandoned without
   * LLM search (SKETCH_MAX_LLM_HOLES, default 4): a skeleton whose facts
   * are all hard is the wrong decomposition, and searching each of them
   * would burn the whole stage budget.
   */
  maxLlmHoles: number;
  /** Write a numbered informal proof first and sketch from it (SKETCH_INFORMAL, default true). */
  informalFirst: boolean;
  /**
   * Holes the hammer leaves open go to the whole-proof prover as lemmas before goal search
   * (SKETCH_HOLE_PROVER: "auto" = when a dedicated prover is configured (LLM_PROVER_MODEL), "on", "off").
   */
  holeProver: boolean;
  useMathlib: boolean;
  goalSearch: Partial<GoalSearchConfig>;
}

export function loadSketchConfig(overrides: Partial<SketchConfig> = {}): SketchConfig {
  const num = (name: string, dflt: number) => {
    const raw = process.env[name];
    const v = Number(raw);
    return raw !== undefined && raw !== "" && Number.isFinite(v) ? v : dflt;
  };
  return {
    samples: Math.max(1, Math.floor(overrides.samples ?? num("SKETCH_SAMPLES", 2))),
    repairs: Math.max(0, Math.floor(overrides.repairs ?? num("SKETCH_REPAIRS", 1))),
    maxHoles: Math.max(1, Math.floor(overrides.maxHoles ?? num("SKETCH_MAX_HOLES", 8))),
    timeBudgetMs: overrides.timeBudgetMs ?? num("SKETCH_BUDGET_MS", 300_000),
    holeBudgetMs: overrides.holeBudgetMs ?? num("SKETCH_HOLE_BUDGET_MS", 60_000),
    maxLlmHoles: Math.max(0, Math.floor(overrides.maxLlmHoles ?? num("SKETCH_MAX_LLM_HOLES", 4))),
    informalFirst: overrides.informalFirst ?? process.env.SKETCH_INFORMAL !== "false",
    holeProver:
      overrides.holeProver ??
      (process.env.SKETCH_HOLE_PROVER === "on" ? true : process.env.SKETCH_HOLE_PROVER === "off" ? false : !!(process.env.LLM_PROVER_MODEL || process.env.LLM_PROVER_MODELS)),
    useMathlib: overrides.useMathlib ?? true,
    goalSearch: overrides.goalSearch ?? {},
  };
}

/** Whether the sketch stage runs in the pipeline (SKETCH_ENABLED, default true). */
export function sketchEnabled(): boolean {
  return process.env.SKETCH_ENABLED !== "false";
}

export interface SketchProgress {
  stage: "sampling" | "elaborating" | "hole" | "verifying" | "ok" | "fail";
  detail: string;
}

export interface SketchResult {
  ok: boolean;
  unavailable: boolean;
  source?: string;
  tactics?: string;
  verification?: LeanVerifyResult;
  sketches: number;
  holes: number;
  holesSolved: number;
  /** Holes closed by the whole-proof prover (the rest by the hammer or goal search). */
  holesByProver: number;
  llmCalls: number;
  /** The informal proof the sketches followed, when one was written. */
  informalProof?: string;
  log: string;
  durationMs: number;
}

export interface SketchArgs {
  sessionId: string;
  theoremName: string;
  theoremType: string;
  expectedSignature?: string;
  problemText?: string;
  sketchHint?: string;
  initialGoal?: string;
  premises?: string;
  /** Namespaces opened for the declaration (benchmarks: `open Real Nat in`). */
  opens?: string[];
  config?: Partial<SketchConfig>;
  onProgress?: (p: SketchProgress) => void;
}

export async function proveBySketch(args: SketchArgs): Promise<SketchResult> {
  const cfg = loadSketchConfig(args.config);
  const started = Date.now();
  const log: string[] = [];
  const progress = (p: SketchProgress) => args.onProgress?.(p);
  const timeLeft = () => cfg.timeBudgetMs - (Date.now() - started);
  let sketches = 0;
  let holesTotal = 0;
  let holesSolved = 0;
  let llmCalls = 0;
  let holesByProver = 0;
  let unavailable = false;
  let informalProof: string | undefined;

  const done = (partial: Partial<SketchResult>): SketchResult => ({
    ok: false,
    unavailable,
    sketches,
    holes: holesTotal,
    holesSolved,
    holesByProver,
    llmCalls,
    ...(informalProof ? { informalProof } : {}),
    log: log.join("\n"),
    durationMs: Date.now() - started,
    ...partial,
  });

  let previousErrors: string | undefined;
  const seen = new Set<string>();

  // Informal proof first (unless the caller gave one, e.g. the pipeline's natural-language solution).
  if (cfg.informalFirst && !args.sketchHint && !costCapReached()) {
    progress({ stage: "sampling", detail: lt("先写自然语言证明…", "Writing an informal proof first…") });
    try {
      informalProof = (
        await chatText({
          messages: [
            { role: "system", content: INFORMAL_PROOF_SYSTEM },
            { role: "user", content: informalProofUserMessage({ theoremType: args.theoremType, problemText: args.problemText, goalState: args.initialGoal }) },
          ],
          role: "planner",
          reasoningEffort: "high",
          temperature: 0.3,
          maxTokens: 6000,
          timeoutMs: Math.max(30_000, Math.min(timeLeft() / 2, 240_000)),
        })
      ).trim().slice(0, 4000);
      llmCalls++;
      log.push(`informal proof: ${informalProof.split("\n").filter((l) => l.trim()).length} line(s)`);
    } catch (e) {
      if (e instanceof LlmError && /LLM_API_KEY/.test(e.message)) throw e;
      log.push(`informal proof failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
    }
  }

  for (let round = 0; round <= cfg.repairs; round++) {
    if (timeLeft() < expectedLatencyMs("prover") * 0.8) {
      log.push(`round ${round}: not enough time left for another sketch round`);
      break;
    }
    if (costCapReached()) {
      log.push(`round ${round}: cost cap reached`);
      break;
    }
    progress({ stage: "sampling", detail: lt(`采样 ${cfg.samples} 个证明骨架…`, `Sampling ${cfg.samples} proof sketches…`) });
    let samples: string[];
    try {
      samples = await sampleText({
        messages: [
          { role: "system", content: SKETCH_SYSTEM },
          {
            role: "user",
            content: sketchUserMessage({
              theoremName: args.theoremName,
              theoremType: args.theoremType,
              goalState: args.initialGoal,
              problemText: args.problemText,
              sketchHint: args.sketchHint,
              informalProof,
              previousErrors,
              premises: args.premises,
            }),
          },
        ],
        n: cfg.samples,
        role: chatProverRole(),
        temperature: 0.7,
        maxTokens: 4096,
        timeoutMs: Math.max(30_000, Math.min(timeLeft(), 300_000)),
      });
      llmCalls += cfg.samples;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.push(`round ${round}: sampling failed: ${msg}`);
      if (e instanceof LlmError && /LLM_API_KEY/.test(msg)) throw e;
      break;
    }
    const blocks = [...new Set(samples.map((t) => extractTactics(t)).filter((t): t is string => !!t))].filter((t) => !seen.has(t));
    blocks.forEach((b) => seen.add(b));
    sketches += blocks.length;
    let firstError: string | undefined;

    for (const tactics of blocks) {
      if (timeLeft() <= 0) break;
      const source = assembleLeanSource({
        theoremName: args.theoremName,
        theoremType: args.theoremType,
        stepCodes: [tactics],
        useMathlib: cfg.useMathlib,
        opens: args.opens,
      });
      progress({ stage: "elaborating", detail: lt("检查骨架结构…", "Checking sketch structure…") });
      let session: ProofSession;
      try {
        session = await ProofSession.open(source);
      } catch (e) {
        if (e instanceof ReplError && e.kind === "unavailable") {
          unavailable = true;
          log.push("Lean unavailable");
          return done({});
        }
        const msg = e instanceof Error ? e.message : String(e);
        log.push(`sketch rejected: ${msg.split("\n")[0].slice(0, 160)}`);
        firstError ??= msg.slice(0, 2000);
        continue;
      }
      try {
        const holes = session.holes;
        if (holes.length > cfg.maxHoles) {
          log.push(`sketch has ${holes.length} holes (> ${cfg.maxHoles}); skipped`);
          continue;
        }
        holesTotal += holes.length;
        const scripts: (string[] | undefined)[] = holes.map(() => undefined);

        // Pass 1: the hammer on every hole (milliseconds each). This also
        // tells us whether the decomposition is any good before the LLM
        // search is paid for.
        for (let i = 0; i < holes.length; i++) {
          if (timeLeft() <= 0) break;
          progress({
            stage: "hole",
            detail: lt(
              `自动化尝试子目标 ${i + 1}/${holes.length}: ${lastLine(holes[i].goal)}`,
              `Trying automation on subgoal ${i + 1}/${holes.length}: ${lastLine(holes[i].goal)}`,
            ),
          });
          const h = await hammer(session, holes[i].state, { useMathlib: cfg.useMathlib, budgetMs: Math.min(20_000, Math.max(1_000, timeLeft())) });
          if (h.solved && h.tactic) {
            scripts[i] = [h.tactic];
            holesSolved++;
          }
        }
        const open = holes.map((_, i) => i).filter((i) => !scripts[i]);
        log.push(`sketch with ${holes.length} hole(s): hammer closed ${holes.length - open.length}`);
        if (open.length > cfg.maxLlmHoles) {
          log.push(`  skipped: ${open.length} holes need search (limit ${cfg.maxLlmHoles})`);
          continue;
        }

        // Pass 2: goal-level search on what is left, sharing the remaining time.
        let failed = false;
        for (let k = 0; k < open.length; k++) {
          const i = open[k];
          const hole = holes[i];
          const budget = Math.min(cfg.holeBudgetMs, Math.floor(timeLeft() / (open.length - k)));
          if (budget < expectedLatencyMs("prover") * 0.8) {
            failed = true;
            log.push(`  hole ${i + 1}: ${Math.round(Math.max(0, budget) / 1000)}s left is not enough for a search`);
            break;
          }
          // The dedicated prover on the hole as a lemma of its own (its tactics see the same names).
          if (cfg.holeProver) {
            const lemma = goalToStatement(hole.goal);
            // The printed goal does not always reparse: check the lemma before paying for samples.
            const elaborates =
              lemma &&
              (
                await verifyLeanSource(
                  args.sessionId,
                  assembleLeanSource({ theoremName: `${args.theoremName}_hole${i + 1}`, theoremType: lemma.statement, stepCodes: ["sorry"], useMathlib: cfg.useMathlib, opens: args.opens }),
                  { allowSorry: true, checkAxioms: false },
                )
              ).ok;
            if (lemma && !elaborates) log.push(`  hole ${i + 1}: its goal does not elaborate as a lemma; goal search only`);
            if (lemma && elaborates) {
              progress({ stage: "hole", detail: lt(`证明模型处理子目标 ${i + 1}/${holes.length}: ${lastLine(hole.goal)}`, `Prover on subgoal ${i + 1}/${holes.length}: ${lastLine(hole.goal)}`) });
              const pr = await proveWholeTheorem({
                sessionId: args.sessionId,
                theoremName: `${args.theoremName}_hole${i + 1}`,
                theoremType: lemma.statement,
                problemText: args.problemText,
                opens: args.opens,
                config: { samples: cfg.samples, rounds: 1, timeBudgetMs: budget, useMathlib: cfg.useMathlib, suggest: false, strictBudget: true },
              });
              llmCalls += pr.samples;
              if (pr.ok && pr.tactics) {
                scripts[i] = pr.tactics.split("\n");
                holesSolved++;
                holesByProver++;
                log.push(`  hole ${i + 1} closed by the prover`);
                continue;
              }
              log.push(`  hole ${i + 1}: prover did not close it${pr.candidates.length ? ` (${pr.candidates[0].summary.slice(0, 80)})` : ""}`);
            } else if (!lemma) log.push(`  hole ${i + 1}: goal state could not be stated as a lemma`);
          }
          const rest = Math.min(cfg.holeBudgetMs, Math.floor(timeLeft() / (open.length - k)));
          if (rest < expectedLatencyMs("prover") * 0.8) {
            failed = true;
            log.push(`  hole ${i + 1}: ${Math.round(Math.max(0, rest) / 1000)}s left is not enough for a search`);
            break;
          }
          progress({
            stage: "hole",
            detail: lt(
              `搜索子目标 ${i + 1}/${holes.length}: ${lastLine(hole.goal)}`,
              `Searching subgoal ${i + 1}/${holes.length}: ${lastLine(hole.goal)}`,
            ),
          });
          const r = await goalSearch({
            session,
            rootState: hole.state,
            theoremName: args.theoremName,
            theoremType: args.theoremType,
            problemText: args.problemText,
            premises: args.premises,
            config: { ...cfg.goalSearch, useMathlib: cfg.useMathlib, timeBudgetMs: rest },
          });
          llmCalls += r.llmCalls;
          if (!r.ok || !r.tactics) {
            failed = true;
            log.push(`  hole ${i + 1} unsolved: ${lastLine(hole.goal)}`);
            break;
          }
          scripts[i] = r.tactics;
          holesSolved++;
          log.push(`  hole ${i + 1} closed: ${r.tactics.join(" ; ")}`);
        }
        if (failed) continue;

        // Splice the closing scripts back into the sketch and verify strictly.
        const { header } = splitHeader(source);
        const body = spliceHoles(session.body, holes, scripts as string[][]);
        if (!body) {
          log.push("  could not splice scripts into the sketch");
          continue;
        }
        const finalSource = header ? `${header}\n${body}` : body;
        progress({ stage: "verifying", detail: lt("拼接后严格验证…", "Assembling and verifying strictly…") });
        const verification = await session.verify(args.sessionId, finalSource, {
          theoremName: args.theoremName,
          expectedSignature: args.expectedSignature,
        });
        if (verification.ok) {
          progress({ stage: "ok", detail: lt(`✅ 骨架 + ${holes.length} 个子目标全部通过`, `✅ Sketch + all ${holes.length} subgoal(s) verified`) });
          const bodyLines = body.split("\n");
          const declIdx = Math.max(0, bodyLines.findIndex((l) => /^\s*(?:theorem|lemma|example)\b/.test(l)));
          const tacticBody = bodyLines.slice(declIdx + 1).map((l) => l.replace(/^ {2}/, "")).join("\n").trim();
          return done({ ok: true, source: finalSource, tactics: tacticBody, verification });
        }
        log.push(`  spliced proof failed strict verification: ${verification.log.split("\n")[0].slice(0, 160)}`);
      } finally {
        session.close();
      }
    }
    if (firstError && blocks.length > 0) previousErrors = firstError;
    else if (!firstError) break; // sketches elaborated but holes could not be closed — repairs will not help
  }
  progress({ stage: "fail", detail: lt("骨架分解未能完成证明", "Sketch decomposition did not complete the proof") });
  return done({});
}

/**
 * Replace each `sorry` hole (1-based line, 0-based column within `body`)
 * with its tactic script. A hole that ends its line becomes a tactic block
 * aligned at the hole's column; a hole inside a term becomes `(by t1; t2)`.
 * Holes are processed bottom-up so positions stay valid.
 */
export function spliceHoles(body: string, holes: ProofHole[], scripts: string[][]): string | undefined {
  const lines = body.split("\n");
  const order = holes.map((h, i) => ({ h, script: scripts[i] })).sort((a, b) => b.h.line - a.h.line || b.h.column - a.h.column);
  for (const { h, script } of order) {
    if (!script || script.length === 0) return undefined;
    const idx = h.line - 1;
    const line = lines[idx];
    if (line === undefined) return undefined;
    const before = line.slice(0, h.column);
    const after = line.slice(h.endColumn);
    if (!/\bsorry\s*$/.test(line.slice(0, h.endColumn))) return undefined;
    if (after.trim() === "") {
      const indent = " ".repeat(h.column);
      lines[idx] = before + script.join("\n" + indent);
    } else {
      lines[idx] = `${before}(by ${script.join("; ")})${after}`;
    }
  }
  return lines.join("\n");
}

function lastLine(goal: string): string {
  return goal.split("\n").pop()?.slice(0, 80) ?? "";
}
