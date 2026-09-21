/**
 * Turns a verification result into feedback a language model can act on.
 *
 * Lean's raw log positions refer to the whole file (imports included). The
 * model only ever sees and edits the tactic block, so errors are reported
 * relative to the proof ("proof line 3") together with the offending source
 * line, followed by the goals still open at each `sorry`.
 */
import type { LeanDiagnostic, LeanVerifyResult } from "./sandbox";

export interface ProofLayout {
  /** 1-based line of the `theorem … := by` declaration in the full source. */
  theoremLine: number;
  /** 1-based line of the first tactic (the line after `:= by`). */
  bodyStart: number;
  /** Tactic lines exactly as they appear in the source (indentation kept). */
  bodyLines: string[];
}

const THEOREM_RE = /^\s*(?:theorem|lemma|example)\b.*:=\s*by\s*$/;

/** Locate the proof body in a source assembled by `assembleLeanSource`. */
export function proofLayout(source: string): ProofLayout | undefined {
  const lines = source.split("\n");
  const idx = lines.findIndex((l) => THEOREM_RE.test(l));
  if (idx < 0) return undefined;
  return { theoremLine: idx + 1, bodyStart: idx + 2, bodyLines: lines.slice(idx + 1) };
}

/** 1-based tactic line (relative to the proof body) of a diagnostic, if it lies in the body. */
export function tacticLineOf(diag: LeanDiagnostic, layout: ProofLayout): number | undefined {
  if (diag.line < layout.bodyStart) return undefined;
  return diag.line - layout.bodyStart + 1;
}

export interface FeedbackOptions {
  /** Max diagnostics to render (default 6). */
  maxMessages?: number;
  /** Max characters per diagnostic message (default 1500). */
  maxMessageChars?: number;
  /** Max total characters (default 6000). */
  maxChars?: number;
  /** Render goals at `sorry` (default true). */
  includeGoals?: boolean;
}

/**
 * Human/LLM-readable feedback for a failed (or partial) verification.
 * Returns "" when there is nothing to report.
 */
export function formatVerificationFeedback(
  result: LeanVerifyResult,
  source: string,
  opts: FeedbackOptions = {},
): string {
  const maxMessages = opts.maxMessages ?? 6;
  const maxMessageChars = opts.maxMessageChars ?? 1500;
  const maxChars = opts.maxChars ?? 6000;
  const layout = proofLayout(source);
  const out: string[] = [];

  if (result.rejected) {
    out.push(`The source was rejected before Lean ran: ${result.rejected}`);
  }

  const errors = result.messages.filter((m) => m.severity === "error");
  const warnings = result.messages.filter((m) => m.severity === "warning" && !/declaration uses [`']sorry[`']/.test(m.message));
  const shown = [...errors, ...warnings].slice(0, maxMessages);

  if (errors.length > 0) {
    const shownErrors = shown.filter((m) => m.severity === "error").length;
    out.push(
      `Lean reported ${errors.length} error${errors.length === 1 ? "" : "s"}` +
        (shownErrors < errors.length ? ` (showing the first ${shownErrors}).` : "."),
    );
  }
  shown.forEach((m, i) => {
    const where = describePosition(m, layout);
    const body = truncate(m.message.trim(), maxMessageChars);
    out.push(`${m.severity === "error" ? "Error" : "Warning"} ${i + 1}${where}:\n${indent(body)}`);
  });
  if (errors.length > shown.length) {
    out.push(`(${errors.length - shown.length} more errors omitted)`);
  }

  if (opts.includeGoals !== false && result.sorries.length > 0) {
    const goals = result.sorries.filter((s) => s.goal.trim());
    if (goals.length > 0) {
      out.push(
        `Goals still open at \`sorry\` (${goals.length}):\n` +
          goals.map((s, i) => `[${i + 1}]${layout ? posLabel(s.line, layout) : ""}\n${indent(truncate(s.goal.trim(), maxMessageChars))}`).join("\n"),
      );
    }
  }

  return truncate(out.join("\n\n"), maxChars);
}

/** Short, single-line summary of why a verification failed (for logs/events). */
export function summarizeFailure(result: LeanVerifyResult, maxChars = 200): string {
  if (result.ok) return "ok";
  if (result.rejected) return truncate(result.rejected, maxChars);
  const first = result.messages.find((m) => m.severity === "error");
  if (!first) return truncate(result.log || "verification failed", maxChars);
  return truncate(first.message.split("\n")[0], maxChars);
}

/**
 * Tactic lines of the proof body that elaborated: everything before the
 * first failing tactic, or — when the whole body ran but goals remain
 * ("unsolved goals" is reported at the theorem line) or a `sorry` is left —
 * everything before the first `sorry`. Undefined when the proof is fine.
 */
export function compilingPrefix(result: LeanVerifyResult, source: string): string[] | undefined {
  const layout = proofLayout(source);
  if (!layout) return undefined;
  const body = dedent(layout.bodyLines);
  const errors = result.messages.filter((m) => m.severity === "error");
  const firstError = errors
    .map((m) => tacticLineOf(m, layout))
    .filter((l): l is number => l !== undefined)
    .sort((a, b) => a - b)[0];
  let cut: number;
  if (firstError !== undefined) {
    // An error on tactic line k means lines 1..k-1 elaborated (Lean stops
    // at the first failing tactic of a sequence).
    cut = firstError - 1;
  } else if (errors.length > 0 || result.sorries.length > 0) {
    const sorryIdx = body.findIndex((l) => /\b(sorry|admit)\b/.test(l));
    cut = sorryIdx >= 0 ? sorryIdx : body.length;
  } else {
    return undefined;
  }
  return body.slice(0, cut).filter((l) => l.trim().length > 0);
}

// ── helpers ───────────────────────────────────────────────────────────

function describePosition(m: LeanDiagnostic, layout: ProofLayout | undefined): string {
  if (!layout) return ` (line ${m.line})`;
  if (m.line === layout.theoremLine) return " (at the theorem statement / whole proof)";
  const t = tacticLineOf(m, layout);
  if (t === undefined) return ` (line ${m.line}, before the proof)`;
  return posLabel(m.line, layout);
}

function posLabel(line: number, layout: ProofLayout): string {
  const t = line - layout.bodyStart + 1;
  const src = layout.bodyLines[t - 1]?.trim();
  return src ? ` (proof line ${t}: \`${truncate(src, 120)}\`)` : ` (proof line ${t})`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + " …";
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
}

/** Remove the common leading indentation of the non-blank lines. */
export function dedent(lines: string[]): string[] {
  const nonBlank = lines.filter((l) => l.trim().length > 0);
  if (nonBlank.length === 0) return lines.map((l) => l.trim());
  const common = Math.min(...nonBlank.map((l) => l.match(/^\s*/)![0].length));
  return lines.map((l) => (l.trim().length ? l.slice(common) : ""));
}
