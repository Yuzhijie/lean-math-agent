import type { ClassifiedError, ProofStep, SorryLabel } from "../types";

/**
 * Generate a SorryLabel for a step that couldn't be proved.
 * Extracts the core goal and failure reason for transparent labeling.
 */
export function labelSorry(
  step: ProofStep,
  classifiedErrors?: ClassifiedError[],
): SorryLabel {
  const primaryError = classifiedErrors?.[0];
  const errorSummary = classifiedErrors
    ? `${classifiedErrors.length} 个错误: ${classifiedErrors.map((e) => e.kind).join(", ")}`
    : "证明生成或编译失败";

  return {
    step_index: step.index,
    reason: primaryError
      ? `[${primaryError.kind}] ${primaryError.message.slice(0, 120)}`
      : errorSummary,
    lean_goal: step.lean_goal || step.plain_goal,
    suggested_approach: primaryError?.suggestion ?? "尝试用不同的策略重新证明此步骤",
  };
}

/**
 * Generate an annotation comment for a sorry in the assembled Lean source.
 */
export function sorryAnnotation(label: SorryLabel): string {
  return `-- SORRY: Step ${label.step_index} — ${label.reason}\n-- GOAL: ${label.lean_goal}\n-- SUGGESTED: ${label.suggested_approach}\nsorry`;
}

/**
 * Check if the final proof has any sorry and generate a summary report.
 */
export function sorryReport(labels: SorryLabel[]): {
  fully_verified: boolean;
  summary: string;
  details: string[];
} {
  if (labels.length === 0) {
    return {
      fully_verified: true,
      summary: "✅ 完全形式化验证通过",
      details: [],
    };
  }

  return {
    fully_verified: false,
    summary: `⚠️ ${labels.length}/${labels.length} 个步骤使用了 sorry，未完全验证`,
    details: labels.map(
      (l) =>
        `  Step ${l.step_index}: ${l.reason}\n    目标: ${l.lean_goal}\n    建议: ${l.suggested_approach}`,
    ),
  };
}
