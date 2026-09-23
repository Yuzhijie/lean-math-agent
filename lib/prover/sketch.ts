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
 */
import { assembleLeanSource } from "../lean/assemble";
import { hammer } from "../lean/hammer";
import { ProofSession, type ProofHole } from "../lean/proof-state";
import { ReplError } from "../lean/repl";
import type { LeanVerifyResult } from "../lean/sandbox";
import { splitHeader } from "../lean/sanitize";
import { LlmError, sampleText } from "../llm/client";
import { SKETCH_SYSTEM, sketchUserMessage } from "../llm/prompts";
import { goalSearch, type GoalSearchConfig } from "../search/goal-search";
import { extractTactics } from "./whole-proof";

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
  llmCalls: number;
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
  let unavailable = false;

  const done = (partial: Partial<SketchResult>): SketchResult => ({
    ok: false,
    unavailable,
    sketches,
    holes: holesTotal,
    holesSolved,
    llmCalls,
    log: log.join("\n"),
    durationMs: Date.now() - started,
    ...partial,
  });

  let previousErrors: string | undefined;
  const seen = new Set<string>();

  for (let round = 0; round <= cfg.repairs; round++) {
    if (timeLeft() <= 0) break;
    progress({ stage: "sampling", detail: `采样 ${cfg.samples} 个证明骨架…` });
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
              previousErrors,
              premises: args.premises,
            }),
          },
        ],
        n: cfg.samples,
        role: "prover",
        temperature: 0.7,
        maxTokens: 4096,
        timeoutMs: Math.max(30_000, Math.min(timeLeft(), 180_000)),
      });
      llmCalls += cfg.samples;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.push(`round ${round}: sampling failed: ${msg}`);
      if (e instanceof LlmError && /LLM_API_KEY/.test(msg)) throw e;
      break;
    }
    const blocks = [...new Set(samples.map(extractTactics).filter((t): t is string => !!t))].filter((t) => !seen.has(t));
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
      progress({ stage: "elaborating", detail: "检查骨架结构…" });
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
        log.push(`sketch with ${holes.length} hole(s)`);
        const scripts: string[][] = [];
        let failed = false;
        for (let i = 0; i < holes.length; i++) {
          const hole = holes[i];
          progress({ stage: "hole", detail: `求解子目标 ${i + 1}/${holes.length}: ${lastLine(hole.goal)}` });
          const script = await closeHole(session, hole, args, cfg, Math.min(cfg.holeBudgetMs, timeLeft()));
          if (!script) {
            failed = true;
            log.push(`  hole ${i + 1} unsolved: ${lastLine(hole.goal)}`);
            break;
          }
          holesSolved++;
          llmCalls += script.llmCalls;
          scripts.push(script.tactics);
          log.push(`  hole ${i + 1} closed: ${script.tactics.join(" ; ")}`);
        }
        if (failed) continue;

        // Splice the closing scripts back into the sketch and verify strictly.
        const { header } = splitHeader(source);
        const body = spliceHoles(session.body, holes, scripts);
        if (!body) {
          log.push("  could not splice scripts into the sketch");
          continue;
        }
        const finalSource = header ? `${header}\n${body}` : body;
        progress({ stage: "verifying", detail: "拼接后严格验证…" });
        const verification = await session.verify(args.sessionId, finalSource, {
          theoremName: args.theoremName,
          expectedSignature: args.expectedSignature,
        });
        if (verification.ok) {
          progress({ stage: "ok", detail: `✅ 骨架 + ${holes.length} 个子目标全部通过` });
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
  progress({ stage: "fail", detail: "骨架分解未能完成证明" });
  return done({});
}

/** Hammer first, then goal-level search, on one hole. */
async function closeHole(
  session: ProofSession,
  hole: ProofHole,
  args: SketchArgs,
  cfg: SketchConfig,
  budgetMs: number,
): Promise<{ tactics: string[]; llmCalls: number } | undefined> {
  if (budgetMs <= 0) return undefined;
  const h = await hammer(session, hole.state, { useMathlib: cfg.useMathlib, budgetMs: Math.min(20_000, budgetMs) });
  if (h.solved && h.tactic) return { tactics: [h.tactic], llmCalls: 0 };
  const r = await goalSearch({
    session,
    rootState: hole.state,
    theoremName: args.theoremName,
    theoremType: args.theoremType,
    problemText: args.problemText,
    premises: args.premises,
    config: { ...cfg.goalSearch, useMathlib: cfg.useMathlib, timeBudgetMs: Math.max(1_000, budgetMs - h.durationMs) },
  });
  return r.ok && r.tactics ? { tactics: r.tactics, llmCalls: r.llmCalls } : undefined;
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
