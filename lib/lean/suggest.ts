/**
 * Library search through Lean itself.
 *
 * Given a tactic prefix that elaborates, run Mathlib's search tactics
 * (`exact?`, `apply?`, `simp?`) at the resulting goal and collect their
 * "Try this: …" suggestions. These are real lemma applications found by
 * Lean, so — unlike names a language model recalls — they exist and
 * type-check at that goal. The prover gets them as hints in the next
 * repair round.
 *
 * Everything goes through `verifyLeanSource`, so probes are sanitized,
 * cached and attributed to the run like any other verification.
 */
import { assembleLeanSource } from "./assemble";
import { proofLayout } from "./feedback";
import { verifyLeanSource, type LeanVerifyResult } from "./sandbox";

export type SearchProbe = "exact?" | "apply?" | "simp?";

export interface Suggestion {
  probe: SearchProbe;
  /** The suggested tactic text, e.g. `exact Nat.le_antisymm h h2`. */
  tactic: string;
  /**
   * True when the probe closed the goal it was run on: no error on the probe
   * line and no `sorry` admitted (a partial `apply?` closes the goal with
   * `sorry` and reports the remaining subgoals instead).
   */
  closesGoal: boolean;
  /** Goals left open by a partial suggestion (from `-- Remaining subgoals:`). */
  remainingGoals?: string;
}

export interface SuggestArgs {
  sessionId: string;
  theoremName: string;
  theoremType: string;
  /** Tactic lines that elaborate; the probes run on the goal after them. */
  prefixTactics: string[];
  useMathlib?: boolean;
  /** Which probes to run (default: exact? first, then apply? + simp? when it fails). */
  probes?: SearchProbe[];
  /** Overall time budget for the probes (default 60 s). */
  timeoutMs?: number;
  /** Namespaces opened for the declaration. */
  opens?: string[];
}

export interface SuggestResult {
  suggestions: Suggestion[];
  /** Goal the probes were run on (from a `sorry` probe), when Lean reports it. */
  goal?: string;
  /** Lean was not available; nothing was searched. */
  unavailable: boolean;
  durationMs: number;
}

const DEFAULT_PROBES: SearchProbe[] = ["exact?", "apply?", "simp?"];
/** `apply?` can emit dozens of partial suggestions; keep the first few per probe. */
const MAX_PER_PROBE = 6;
const SORRY_WARNING_RE = /declaration uses [`']sorry[`']/;

/**
 * Run library-search probes at the goal reached after `prefixTactics`.
 * Never throws: on any failure the result simply has no suggestions.
 */
export async function librarySearchSuggestions(args: SuggestArgs): Promise<SuggestResult> {
  const started = Date.now();
  const budget = args.timeoutMs ?? Number(process.env.LEAN_SUGGEST_TIMEOUT_MS ?? 60_000);
  const probes = args.probes ?? DEFAULT_PROBES;
  const empty: SuggestResult = { suggestions: [], unavailable: false, durationMs: 0 };

  const run = async (tactic: string): Promise<{ res: LeanVerifyResult; source: string } | undefined> => {
    if (Date.now() - started > budget) return undefined;
    const source = assembleLeanSource({
      theoremName: args.theoremName,
      theoremType: args.theoremType,
      stepCodes: [...args.prefixTactics, tactic],
      useMathlib: args.useMathlib ?? true,
      opens: args.opens,
    });
    try {
      const res = await verifyLeanSource(args.sessionId, source, {
        allowSorry: true,
        theoremName: args.theoremName,
        checkAxioms: false,
        wantSignature: false,
      });
      return { res, source };
    } catch {
      return undefined;
    }
  };

  const suggestions: Suggestion[] = [];
  const seen = new Set<string>();
  const collect = (probe: SearchProbe, r: { res: LeanVerifyResult; source: string } | undefined) => {
    if (!r) return;
    const { res, source } = r;
    // The probe closed its goal iff Lean reports no error on the probe's own
    // line (other goals may remain open elsewhere, e.g. after `constructor`).
    const layout = proofLayout(source);
    const probeIdx = layout ? layout.bodyLines.map((l) => l.trim()).lastIndexOf(probe) : -1;
    const probeLine = layout && probeIdx >= 0 ? layout.bodyStart + probeIdx : -1;
    const admitted = res.messages.some((m) => SORRY_WARNING_RE.test(m.message)) || res.sorries.length > 0;
    const closes =
      !admitted &&
      !res.messages.some(
        (m) => m.severity === "error" && (probeLine < 0 ? isProbeError(m.message) : m.line === probeLine),
      );
    let added = 0;
    for (const parsed of parseTryThis(res.infos)) {
      if (added >= MAX_PER_PROBE) break;
      const key = parsed.tactic.replace(/\s+/g, " ");
      if (seen.has(key)) continue;
      seen.add(key);
      added++;
      suggestions.push({
        probe,
        tactic: parsed.tactic,
        closesGoal: closes && !parsed.remainingGoals,
        remainingGoals: parsed.remainingGoals,
      });
    }
  };

  // exact? first: when it closes the goal there is nothing more to look for.
  let unavailable = false;
  let goal: string | undefined;
  if (probes.includes("exact?")) {
    const r = await run("exact?");
    if (r?.res.status === "unavailable") unavailable = true;
    collect("exact?", r);
    if (suggestions.some((s) => s.closesGoal)) {
      return { suggestions, goal, unavailable, durationMs: Date.now() - started };
    }
  }
  if (unavailable) return { ...empty, unavailable, durationMs: Date.now() - started };

  const rest = probes.filter((p) => p !== "exact?");
  const results = await Promise.all(rest.map((p) => run(p).then((r) => [p, r] as const)));
  for (const [p, r] of results) {
    if (r?.res.status === "unavailable") unavailable = true;
    collect(p, r);
  }

  // Goal for the record (cheap: one sorry probe, usually cached by the caller's own verification).
  if (suggestions.length > 0 && Date.now() - started < budget) {
    const r = await run("sorry");
    goal = r?.res.goals?.[r.res.goals.length - 1] || undefined;
  }

  return { suggestions, goal, unavailable, durationMs: Date.now() - started };
}

export interface ParsedSuggestion {
  tactic: string;
  /** Text of `-- Remaining subgoals:` comment lines, when present. */
  remainingGoals?: string;
}

/**
 * Extract tactics from "Try this: …" info messages. Lean ≥ 4.20 renders
 * them as `Try this:\n  [apply] exact foo` (one suggestion per line, each
 * with a bracketed tag, optionally followed by `-- Remaining subgoals:`
 * comment lines); older versions as `Try this: exact foo`.
 */
export function parseTryThis(infos: string[]): ParsedSuggestion[] {
  const out: ParsedSuggestion[] = [];
  const flush = (tactic: string[], comments: string[]) => {
    const t = tactic.join("\n").trim();
    if (!t || /^Remaining subgoals/i.test(t)) return;
    const goals = comments
      .map((c) => c.replace(/^--\s?/, "").trim())
      .filter((c) => c && !/^Remaining subgoals:?$/i.test(c))
      .join("\n");
    out.push(goals ? { tactic: t, remainingGoals: goals } : { tactic: t });
  };
  for (const info of infos) {
    const idx = info.indexOf("Try this:");
    if (idx < 0) continue;
    const lines = info.slice(idx + "Try this:".length).split("\n").map((l) => l.trim()).filter(Boolean);
    let tactic: string[] = [];
    let comments: string[] = [];
    for (const line of lines) {
      const m = line.match(/^\[[^\]]+\]\s*(.*)$/);
      if (m) {
        if (tactic.length) flush(tactic, comments);
        tactic = [m[1].trim()];
        comments = [];
      } else if (line.startsWith("--")) {
        comments.push(line);
      } else if (tactic.length && comments.length === 0) {
        tactic.push("  " + line); // continuation of a multi-line tactic
      } else if (!tactic.length) {
        tactic = [line];
      }
    }
    if (tactic.length) flush(tactic, comments);
  }
  return out;
}

/** Errors that mean "the probe itself did not close the goal" (as opposed to the prefix being broken). */
function isProbeError(message: string): boolean {
  return (
    /could not close the goal/i.test(message) ||
    /made no progress/i.test(message) ||
    /unsolved goals/i.test(message) ||
    /No goals to be solved/i.test(message) ||
    /failed to/i.test(message)
  );
}

/** Format suggestions as a prompt block (empty string when none). */
export function formatSuggestions(suggestions: Suggestion[], goal?: string): string {
  if (suggestions.length === 0) return "";
  const lines = suggestions.map(
    (s) =>
      `- (${s.probe}${s.closesGoal ? ", closes the goal" : ""}) ${s.tactic}` +
      (s.remainingGoals ? `  -- remaining: ${s.remainingGoals.replace(/\n/g, "; ")}` : ""),
  );
  const head = goal
    ? `Lean's library search at the goal\n\`\`\`\n${goal}\n\`\`\`\nfound these applicable tactics — prefer them over lemma names from memory:`
    : "Lean's library search at the failing goal found these applicable tactics — prefer them over lemma names from memory:";
  return `${head}\n${lines.join("\n")}`;
}
