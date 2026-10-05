/**
 * Lean 4 formalization attempt for a solved non-theorem problem
 * (computational, optimization, find-all-values).
 *
 * This is the last step of solving and is started by hand: the solve
 * pipelines return `{ attempted: false }` and the user starts it from the
 * Lean tab (POST /api/lean-attempt). Passing `options.lean_attempt: true`
 * to /api/solve or /api/solve-stream still runs it automatically.
 */
import { autoformalize } from "../llm/autoformalize";
import { lt } from "../llm/output-locale";
import type { LeanProofAttempt } from "../types";

/** The placeholder a solve returns when the Lean step was not run automatically. */
export function manualLeanAttempt(): LeanProofAttempt {
  return { attempted: false, success: false };
}

/** Whether a solve run should attempt Lean automatically (default: no — it is started by hand). */
export function shouldAutoAttemptLean(opts: { lean_attempt?: boolean; skip_lean_attempt?: boolean }): boolean {
  return opts.lean_attempt === true && !opts.skip_lean_attempt;
}

export async function attemptLeanFormalization(problemText: string): Promise<LeanProofAttempt> {
  try {
    const formalResult = await autoformalize({ problemText });

    if (!formalResult.accepted) {
      const failedLayers = formalResult.validation_results.filter((v) => !v.pass).map((v) => `L${v.layer}: ${v.detail}`);
      return {
        attempted: true,
        success: false,
        formal_statement: formalResult.formal_statement,
        failure_reason: lt("自动形式化验证未通过", "Autoformalization did not pass validation"),
        limitations: [
          lt("该计算问题涉及复杂代数运算，Lean 4 形式化存在以下困难：", "This computational problem involves complex algebra; formalizing it in Lean 4 ran into these difficulties:"),
          ...failedLayers,
          lt("建议使用自然语言解答作为主要参考。", "Use the natural-language solution as the primary reference."),
        ],
      };
    }

    return {
      attempted: true,
      success: false,
      formal_statement: formalResult.formal_statement,
      failure_reason: lt("计算问题的形式化证明需要复杂的数值推导，当前自动证明能力有限", "A formal proof of this computational problem requires involved numerical derivation, beyond current automated proving"),
      limitations: [
        lt("问题的数值答案需要多步代数推导才能在 Lean 中验证", "Verifying the numerical answer in Lean requires a multi-step algebraic derivation"),
        lt("涉及平方、根号化简、验根等步骤，Lean 的 norm_num / ring 策略无法直接处理", "It involves squaring, simplifying radicals and checking roots, which Lean's norm_num / ring tactics cannot handle directly"),
        lt("自然语言解答中已提供完整的推导和验证过程", "The natural-language solution gives the full derivation and verification"),
      ],
    };
  } catch (e) {
    return {
      attempted: true,
      success: false,
      failure_reason: lt(`形式化过程出错: ${e instanceof Error ? e.message : "未知错误"}`, `Formalization error: ${e instanceof Error ? e.message : "unknown error"}`),
      limitations: [
        lt("该问题涉及复杂的数值计算或根号运算", "The problem involves complex numerical computation or radicals"),
        lt("Lean 4 的 Mathlib 对这类问题的自动化支持有限", "Mathlib (Lean 4) has limited automation for problems of this kind"),
        lt("自然语言解答已提供完整的推导和验证过程", "The natural-language solution gives the full derivation and verification"),
      ],
    };
  }
}
