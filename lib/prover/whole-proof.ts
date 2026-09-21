/**
 * Whole-proof prover loop (the way specialised provers such as
 * DeepSeek-Prover / Goedel-Prover / Kimina are meant to be used):
 *
 *   round 0:  sample k complete proofs for the statement (prover role)
 *             → verify all of them (REPL, parallel) → done if any passes
 *   round r:  take the most promising failure, show the model Lean's
 *             errors / open goals plus library-search suggestions
 *             (`exact?`, `apply?`, `simp?`) and, when configured, Loogle
 *             hits for unknown identifiers → sample k repairs → verify
 *   stop:     success, `rounds` exhausted, or the time budget is spent
 *
 * The statement is never taken from the model: every candidate is
 * re-assembled from the validated `theoremName`/`theoremType` and checked
 * with the statement lock, so a "proof" of a different theorem cannot pass.
 */
import { assembleLeanSource } from "../lean/assemble";
import { compilingPrefix, formatVerificationFeedback, summarizeFailure, dedent } from "../lean/feedback";
import { loogleHintsForUnknownIdentifiers } from "../lean/loogle";
import { verifyLeanSource, type LeanVerifyResult } from "../lean/sandbox";
import { sanitizeLeanBody } from "../lean/sanitize";
import { formatSuggestions, librarySearchSuggestions } from "../lean/suggest";
import { LlmError, sampleText, type ChatMessage } from "../llm/client";
import { WHOLE_PROOF_SYSTEM, wholeProofRepairMessage, wholeProofUserMessage } from "../llm/prompts";

// ── Configuration ─────────────────────────────────────────────────────

export interface WholeProofConfig {
  /** Proofs sampled per round (WHOLE_PROOF_SAMPLES, default 4). */
  samples: number;
  /** Repair rounds after the first (WHOLE_PROOF_ROUNDS, default 2). */
  rounds: number;
  /** Sampling temperature (WHOLE_PROOF_TEMPERATURE, default 0.8). */
  temperature: number;
  /** Max completion tokens per sample (WHOLE_PROOF_MAX_TOKENS, default 4096). */
  maxTokens: number;
  /** Wall-clock budget for the whole loop (WHOLE_PROOF_BUDGET_MS, default 180 s). */
  timeBudgetMs: number;
  /** Run `exact?`/`apply?`/`simp?` on the best failure before repairing (WHOLE_PROOF_SUGGEST, default true). */
  suggest: boolean;
  useMathlib: boolean;
}

export function loadWholeProofConfig(overrides: Partial<WholeProofConfig> = {}): WholeProofConfig {
  const num = (name: string, dflt: number) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && process.env[name] !== undefined && process.env[name] !== "" ? v : dflt;
  };
  return {
    samples: Math.max(1, Math.floor(overrides.samples ?? num("WHOLE_PROOF_SAMPLES", 4))),
    rounds: Math.max(0, Math.floor(overrides.rounds ?? num("WHOLE_PROOF_ROUNDS", 2))),
    temperature: overrides.temperature ?? num("WHOLE_PROOF_TEMPERATURE", 0.8),
    maxTokens: overrides.maxTokens ?? num("WHOLE_PROOF_MAX_TOKENS", 4096),
    timeBudgetMs: overrides.timeBudgetMs ?? num("WHOLE_PROOF_BUDGET_MS", 180_000),
    suggest: overrides.suggest ?? process.env.WHOLE_PROOF_SUGGEST !== "false",
    useMathlib: overrides.useMathlib ?? true,
  };
}

/** Whether the whole-proof stage is enabled (WHOLE_PROOF_ENABLED, default true). */
export function wholeProofEnabled(): boolean {
  return process.env.WHOLE_PROOF_ENABLED !== "false";
}

// ── Types ─────────────────────────────────────────────────────────────

export interface WholeProofCandidate {
  round: number;
  tactics: string;
  ok: boolean;
  errors: number;
  /** First error, one line (empty when ok). */
  summary: string;
}

export interface WholeProofProgress {
  round: number;
  status: "sampling" | "verifying" | "searching" | "ok" | "fail";
  detail: string;
}

export interface WholeProofResult {
  ok: boolean;
  /** Lean was not available — the loop could not verify anything. */
  unavailable: boolean;
  /** Complete verified source (when ok). */
  source?: string;
  /** Tactic block of the verified proof (when ok). */
  tactics?: string;
  verification?: LeanVerifyResult;
  candidates: WholeProofCandidate[];
  /** Rounds actually run (1 = sampling only). */
  rounds: number;
  /** Proofs sampled in total. */
  samples: number;
  /** Library-search suggestions that were fed back to the model. */
  suggestions: string[];
  log: string;
  durationMs: number;
}

export interface WholeProofArgs {
  sessionId: string;
  theoremName: string;
  theoremType: string;
  /** Statement lock: `#check` signature the proved theorem must reproduce. */
  expectedSignature?: string;
  problemText?: string;
  /** Informal proof sketch (e.g. the NL solution's steps). */
  sketch?: string;
  /** Goal state at the initial `sorry`, when known. */
  initialGoal?: string;
  config?: Partial<WholeProofConfig>;
  onProgress?: (p: WholeProofProgress) => void;
}

// ── Main loop ─────────────────────────────────────────────────────────

export async function proveWholeTheorem(args: WholeProofArgs): Promise<WholeProofResult> {
  const started = Date.now();
  const cfg = loadWholeProofConfig(args.config);
  const candidates: WholeProofCandidate[] = [];
  const suggestionsUsed: string[] = [];
  const log: string[] = [];
  const progress = (p: WholeProofProgress) => args.onProgress?.(p);
  const timeLeft = () => cfg.timeBudgetMs - (Date.now() - started);

  const assemble = (tactics: string) =>
    assembleLeanSource({
      theoremName: args.theoremName,
      theoremType: args.theoremType,
      stepCodes: [tactics],
      useMathlib: cfg.useMathlib,
    });

  const done = (partial: Partial<WholeProofResult>): WholeProofResult => ({
    ok: false,
    unavailable: false,
    candidates,
    rounds: 0,
    samples: 0,
    suggestions: suggestionsUsed,
    log: log.join("\n"),
    durationMs: Date.now() - started,
    ...partial,
  });

  const messages: ChatMessage[] = [
    { role: "system", content: WHOLE_PROOF_SYSTEM },
    {
      role: "user",
      content: wholeProofUserMessage({
        theoremName: args.theoremName,
        theoremType: args.theoremType,
        goalState: args.initialGoal,
        problemText: args.problemText,
        sketch: args.sketch,
      }),
    },
  ];

  let totalSamples = 0;
  let roundsRun = 0;
  const seenTactics = new Set<string>();

  for (let round = 0; round <= cfg.rounds; round++) {
    if (round > 0 && timeLeft() <= 0) {
      log.push(`round ${round}: time budget exhausted`);
      break;
    }
    roundsRun = round + 1;

    // ── Sample ────────────────────────────────────────────────────
    progress({ round, status: "sampling", detail: `采样 ${cfg.samples} 个完整证明…` });
    let samples: string[];
    try {
      samples = await sampleText({
        messages,
        n: cfg.samples,
        role: "prover",
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens,
        timeoutMs: round === 0 ? undefined : Math.max(30_000, Math.min(timeLeft(), 120_000)),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.push(`round ${round}: sampling failed: ${msg}`);
      if (e instanceof LlmError && /LLM_API_KEY/.test(msg)) throw e;
      break;
    }
    totalSamples += samples.length;

    const tacticBlocks = [...new Set(samples.map((s) => extractTactics(s)).filter((t): t is string => !!t))]
      .filter((t) => !seenTactics.has(t));
    tacticBlocks.forEach((t) => seenTactics.add(t));
    if (tacticBlocks.length === 0) {
      log.push(`round ${round}: no usable proof in ${samples.length} samples`);
      continue;
    }

    // ── Verify (strict: no sorry, standard axioms, statement lock) ───
    progress({ round, status: "verifying", detail: `验证 ${tacticBlocks.length} 个候选…` });
    const verified = await Promise.all(
      tacticBlocks.map(async (tactics) => {
        const source = assemble(tactics);
        const verification = await verifyLeanSource(args.sessionId, source, {
          theoremName: args.theoremName,
          expectedSignature: args.expectedSignature,
        });
        return { tactics, source, verification };
      }),
    );

    for (const v of verified) {
      candidates.push({
        round,
        tactics: v.tactics,
        ok: v.verification.ok,
        errors: v.verification.messages.filter((m) => m.severity === "error").length,
        summary: v.verification.ok ? "" : summarizeFailure(v.verification),
      });
    }

    const winner = verified.find((v) => v.verification.ok);
    if (winner) {
      log.push(`round ${round}: verified (${tacticBlocks.length} candidates)`);
      progress({ round, status: "ok", detail: `✅ 第 ${round + 1} 轮验证通过` });
      return done({
        ok: true,
        source: winner.source,
        tactics: winner.tactics,
        verification: winner.verification,
        rounds: roundsRun,
        samples: totalSamples,
      });
    }
    if (verified.every((v) => v.verification.status === "unavailable")) {
      log.push(`round ${round}: Lean unavailable`);
      return done({ unavailable: true, rounds: roundsRun, samples: totalSamples });
    }
    log.push(
      `round ${round}: ${verified.length} candidates failed — ` +
        verified.map((v) => summarizeFailure(v.verification, 80)).join(" | "),
    );
    progress({ round, status: "fail", detail: `第 ${round + 1} 轮 ${verified.length} 个候选均未通过` });

    if (round === cfg.rounds) break;

    // ── Pick the most promising failure and build feedback ──────────
    const best = await pickBestFailure(args.sessionId, verified, assemble);
    let feedback = formatVerificationFeedback(best.verification, best.source);
    if (!feedback) feedback = best.verification.log || "verification failed";

    let suggestionBlock = "";
    if (cfg.suggest && best.verification.backend !== "none" && timeLeft() > 10_000) {
      const prefix = compilingPrefix(best.verification, best.source);
      if (prefix !== undefined) {
        progress({ round, status: "searching", detail: "在失败目标处运行 exact?/apply?/simp? 检索引理…" });
        const found = await librarySearchSuggestions({
          sessionId: args.sessionId,
          theoremName: args.theoremName,
          theoremType: args.theoremType,
          prefixTactics: prefix,
          useMathlib: cfg.useMathlib,
          timeoutMs: Math.min(60_000, Math.max(5_000, timeLeft() / 2)),
        });
        if (found.suggestions.length > 0) {
          suggestionBlock = formatSuggestions(found.suggestions, found.goal);
          suggestionsUsed.push(...found.suggestions.map((s) => s.tactic));
          log.push(`round ${round}: ${found.suggestions.length} library-search suggestion(s)`);
        }
      }
    }
    const loogle = await loogleHintsForUnknownIdentifiers(best.verification.messages.map((m) => m.message));
    if (loogle) suggestionBlock = suggestionBlock ? `${suggestionBlock}\n\n${loogle}` : loogle;

    // Keep the conversation short: system + original request + one repair
    // turn (replacing any previous repair turn), so context does not grow
    // with every round.
    messages.splice(2);
    messages.push({
      role: "user",
      content: wholeProofRepairMessage({
        theoremName: args.theoremName,
        theoremType: args.theoremType,
        previousTactics: best.tactics,
        feedback,
        suggestions: suggestionBlock || undefined,
        round: round + 1,
      }),
    });
  }

  return done({ rounds: roundsRun, samples: totalSamples });
}

// ── Candidate ranking ─────────────────────────────────────────────────

interface Verified {
  tactics: string;
  source: string;
  verification: LeanVerifyResult;
}

/**
 * The failure to repair: fewest errors first, then the one whose first
 * error is furthest into the proof. A candidate rejected textually for
 * `sorry` is re-verified with `allowSorry` so its open goals are visible.
 */
async function pickBestFailure(
  sessionId: string,
  verified: Verified[],
  assemble: (t: string) => string,
): Promise<Verified> {
  const scored = await Promise.all(
    verified.map(async (v) => {
      let verification = v.verification;
      if (verification.rejected && /sorry/.test(verification.rejected)) {
        try {
          verification = await verifyLeanSource(sessionId, assemble(v.tactics), { allowSorry: true });
        } catch {
          // keep the textual rejection
        }
      }
      const errors = verification.messages.filter((m) => m.severity === "error");
      const openGoals = verification.sorries.length;
      const firstLine = errors.length ? Math.min(...errors.map((m) => m.line)) : Number.MAX_SAFE_INTEGER;
      return { v: { ...v, verification }, score: errors.length + openGoals, firstLine };
    }),
  );
  scored.sort((a, b) => a.score - b.score || b.firstLine - a.firstLine);
  return scored[0].v;
}

// ── Response parsing ──────────────────────────────────────────────────

/**
 * The code block to read the proof from. Models often emit several fenced
 * blocks (a restated goal, then the proof, then an "explanation" block):
 * prefer the last block that contains a declaration with `:=`, else the
 * last fenced block, else the whole text.
 */
function pickCodeBlock(text: string): string {
  // Line-based fence scan: a tagged opener (```lean) always starts a new
  // block, even inside an unterminated one; a bare ``` closes or opens.
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of text.split("\n")) {
    const fence = line.match(/^\s*```\s*([\w][\w -]*)?\s*$/);
    if (fence) {
      const tagged = fence[1] !== undefined;
      if (current !== null && !tagged) {
        blocks.push(current.join("\n"));
        current = null;
      } else {
        if (current !== null) blocks.push(current.join("\n"));
        current = [];
      }
      continue;
    }
    if (current !== null) current.push(line);
  }
  if (current !== null) blocks.push(current.join("\n"));
  if (blocks.length === 0) return text;
  const withProof = blocks.filter((b) => /^\s*(theorem|lemma|example)\b[\s\S]*:=/m.test(b));
  const pool = withProof.length ? withProof : blocks;
  return pool[pool.length - 1];
}

/**
 * Extract the tactic block from a model response. Accepts a fenced
 * ```lean block (preferred), a bare `theorem … := by` declaration, a
 * term-mode proof (`:= term`, wrapped in `exact`), or raw tactics.
 * Returns undefined when nothing usable is found or the block contains
 * commands the sanitizer forbids.
 */
export function extractTactics(text: string): string | undefined {
  let body = pickCodeBlock(text).replace(/\r/g, "");

  // Drop imports / options; keep `open … in` usable as a tactic.
  const lines = body.split("\n");
  const opens: string[] = [];
  const kept: string[] = [];
  let inPreamble = true;
  for (const line of lines) {
    const t = line.trim();
    if (inPreamble && (t === "" || /^(import|set_option|namespace|section|end|noncomputable|universe|variable)\b/.test(t))) continue;
    if (inPreamble && /^open\s+/.test(t) && !/\bin\b/.test(t)) {
      opens.push(t.replace(/^open\s+/, "").trim());
      continue;
    }
    inPreamble = false;
    kept.push(line);
  }
  body = kept.join("\n");

  let tactics: string;
  const byIdx = body.search(/:=\s*by\b/);
  if (/^\s*(theorem|lemma|example)\b/m.test(body) && byIdx >= 0) {
    tactics = body.slice(byIdx).replace(/^:=\s*by[ \t]*/, "");
    // `:= by tac` on the same line → keep the tactic; otherwise drop the newline.
    tactics = tactics.startsWith("\n") ? tactics.slice(1) : tactics;
  } else if (/^\s*(theorem|lemma|example)\b/m.test(body) && /:=/.test(body)) {
    const term = body.slice(body.indexOf(":=") + 2).trim();
    if (!term) return undefined;
    tactics = term.includes("\n") ? `exact (\n${term}\n)` : `exact ${term}`;
  } else {
    // Raw tactics, possibly introduced by a lone `by`.
    tactics = body.replace(/^\s*by[ \t]*\n/, "");
  }

  // Cut anything after the proof (a second declaration, prose, `#check`).
  const stop = tactics.search(/^\s*(theorem|lemma|example|def|#check|#eval|#print)\b/m);
  if (stop > 0) tactics = tactics.slice(0, stop);

  const cleaned = dedent(tactics.split("\n"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!cleaned) return undefined;
  const withOpens = opens.length ? `open ${opens.join(" ")} in\n${cleaned}` : cleaned;
  return sanitizeLeanBody(withOpens).ok ? withOpens : undefined;
}
