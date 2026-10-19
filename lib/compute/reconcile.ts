/**
 * A program's answer against the written solution's answer. The optimization search answers
 * the structure the model extracted, which can be the wrong problem altogether (a "how many
 * triangles can be traced in the drawing" question once became "2 positive integers summing
 * to 3" → 2, while the written solution counted 18). When the solution's \boxed answer differs,
 * a careful independent check decides and the result is no longer reported as cross-validated.
 */
import { lt } from "../llm/output-locale";
import { boxedAnswer, resolveConflict, sameAnswer } from "./solver";

export interface Reconciled {
  /** The answer to report. */
  answer: string;
  /** The written solution agrees with the program (or there is nothing to compare). */
  agreed: boolean;
  /** What happened, for the checks list and the progress line (only when they disagreed). */
  check?: string;
  /** The written solution argues for a different answer than the one reported (rewrite it). */
  solutionStale: boolean;
}

/** The written solution's final answer: its \boxed{…}, else the final-answer text when it is short. */
export function writtenAnswer(finalAnswer: string | undefined): string | undefined {
  if (!finalAnswer?.trim()) return undefined;
  return boxedAnswer([finalAnswer]) ?? (finalAnswer.trim().length <= 40 ? finalAnswer.trim() : undefined);
}

export async function reconcileWithSolution(
  problemText: string,
  programAnswer: string,
  solutionFinalAnswer: string | undefined,
  decide: (problem: string, a: string, b: string) => Promise<string | undefined> = resolveConflict,
): Promise<Reconciled> {
  const written = writtenAnswer(solutionFinalAnswer);
  if (!written || sameAnswer(written, programAnswer)) return { answer: programAnswer, agreed: true, solutionStale: false };
  const decided = await decide(problemText, programAnswer, written);
  const answer = decided ?? programAnswer;
  return {
    answer,
    agreed: false,
    check: lt(
      `程序搜索得到 ${programAnswer}，解答推导出 ${written}，两者不一致；复核后采用 ${answer}`,
      `The program's search gave ${programAnswer} but the written solution derived ${written}; after a re-check the answer is ${answer}`,
    ),
    solutionStale: !sameAnswer(answer, written),
  };
}
