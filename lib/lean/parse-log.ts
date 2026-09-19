import type { ClassifiedError, ErrorKind } from "../types";

/**
 * Original log filtering — extracts useful error/warning lines.
 * Kept for backward compatibility.
 */
export function parseLeanLog(log: string): string {
  const lines = log.split(/\r?\n/);
  const useful = lines.filter(
    (l) => /error:/i.test(l) || /warning:/i.test(l) || /\.lean:\d+:\d+/i.test(l),
  );
  return (useful.length ? useful : lines.slice(-40)).join("\n").trim();
}

// ── Error Classification Patterns ─────────────────────────────────────

interface ErrorPattern {
  kind: ErrorKind;
  patterns: RegExp[];
  suggestion: string;
}

const ERROR_PATTERNS: ErrorPattern[] = [
  {
    kind: "unknown_identifier",
    patterns: [
      /unknown identifier '([^']+)'/i,
      /unknown constant '([^']+)'/i,
      /unknown tactic '([^']+)'/i,
    ],
    suggestion:
      "检查标识符拼写。如果是 Mathlib 引理，使用完整限定名（如 Nat.add_comm）。尝试 `exact?` 或 `apply?` 搜索。",
  },
  {
    kind: "type_mismatch",
    patterns: [
      /type mismatch/i,
      /has type .+ but is expected to have type/i,
      /expected .+ but got/i,
      /application type mismatch/i,
    ],
    suggestion:
      "类型不匹配。可能需要显式类型转换（↑n for nat→int），push_cast，或使用不同版本的引理。",
  },
  {
    kind: "unsolved_goal",
    patterns: [
      /unsolved goals?/i,
      /goal .* is not solved/i,
      /tactic '.*' did not close the goal/i,
      /goals to prove/i,
    ],
    suggestion:
      "目标未完全闭合。尝试更强的自动化：omega, linarith, ring, norm_num。或将步骤拆分为更小的子目标。",
  },
  {
    kind: "tactic_failed",
    patterns: [
      /tactic '([^']+)' failed/i,
      /rewrite tactic failed/i,
      /simp made no progress/i,
      /ring tactic failed/i,
      /omega failed/i,
      /linarith failed/i,
    ],
    suggestion:
      "特定策略失败。尝试替代方案：rw→simp, induction→cases, ring→omega, simp→simp only [...]。",
  },
  {
    kind: "missing_lemma",
    patterns: [
      /failed to synthesize/i,
      /could not find/i,
      /lemma .* does not exist/i,
      /no applicable tactic/i,
    ],
    suggestion:
      "所需引理不存在。将其作为局部 `have` 引理声明，或使用更通用的方法。",
  },
  {
    kind: "scope_error",
    patterns: [
      /variable .* is not in scope/i,
      /unknown local declaration/i,
      /no such local constant/i,
    ],
    suggestion:
      "变量不在作用域内。检查是否需要用 `intro`, `obtain`, 或 `cases` 引入。",
  },
  {
    kind: "syntax_error",
    patterns: [
      /unexpected token/i,
      /expected .* but found/i,
      /invalid .* syntax/i,
      /ill-formed/i,
    ],
    suggestion: "修复 Lean 语法。检查括号、逗号、关键字拼写和缩进。",
  },
  {
    kind: "timeout",
    patterns: [
      /maximum recursion depth/i,
      /deterministic timeout/i,
      /timeout/i,
    ],
    suggestion:
      "Lean 超时。简化步骤：拆分为更小的子目标，使用更直接的策略，用 `simp only [...]` 限制 simp 集。",
  },
];

// ── Line position parser ──────────────────────────────────────────────

const LINE_COL_RE = /\.lean:(\d+):(\d+)/;

/**
 * Classify Lean build log errors into structured ClassifiedError objects.
 * Returns empty array if no errors found.
 */
export function classifyLeanErrors(log: string): ClassifiedError[] {
  const lines = log.split(/\r?\n/);
  const errors: ClassifiedError[] = [];
  let currentError: Partial<ClassifiedError> | null = null;

  for (const line of lines) {
    // Check for error markers
    const isErrLine = /error:/i.test(line);
    const lineMatch = line.match(LINE_COL_RE);

    if (isErrLine) {
      // Save previous error if exists
      if (currentError?.message) {
        errors.push(finalizeError(currentError));
      }

      // Start new error
      const kind = classifyLine(line);
      currentError = {
        kind,
        message: line.replace(/.*error:\s*/i, "").trim(),
        raw: line,
        suggestion: ERROR_PATTERNS.find((p) => p.kind === kind)?.suggestion,
      };

      if (lineMatch) {
        currentError.line = parseInt(lineMatch[1], 10);
        currentError.column = parseInt(lineMatch[2], 10);
      }
    } else if (lineMatch && currentError) {
      // Attach line/col info to current error
      if (!currentError.line) {
        currentError.line = parseInt(lineMatch[1], 10);
        currentError.column = parseInt(lineMatch[2], 10);
      }
      currentError.raw += "\n" + line;
    } else if (currentError && line.trim()) {
      // Continuation line
      currentError.raw += "\n" + line;
    }
  }

  // Don't forget last error
  if (currentError?.message) {
    errors.push(finalizeError(currentError));
  }

  return errors;
}

function classifyLine(line: string): ErrorKind {
  for (const pattern of ERROR_PATTERNS) {
    if (pattern.patterns.some((re) => re.test(line))) {
      return pattern.kind;
    }
  }
  // Default: check for generic tactic failure
  if (/tactic.*failed/i.test(line)) return "tactic_failed";
  if (/error/i.test(line)) return "syntax_error";
  return "syntax_error";
}

function finalizeError(partial: Partial<ClassifiedError>): ClassifiedError {
  return {
    kind: partial.kind ?? "syntax_error",
    line: partial.line,
    column: partial.column,
    message: partial.message ?? "unknown error",
    suggestion: partial.suggestion,
    raw: partial.raw ?? "",
  };
}

/**
 * Format classified errors for LLM consumption (repair prompt).
 */
export function formatErrorsForRepair(errors: ClassifiedError[]): string {
  return errors
    .map((e, i) => {
      const loc = e.line ? ` (line ${e.line})` : "";
      const hint = e.suggestion ? `\n   修复建议: ${e.suggestion}` : "";
      return `${i + 1}. [${e.kind}]${loc}: ${e.message}${hint}`;
    })
    .join("\n\n");
}
