/**
 * The problem and reference answer for a submission, from what the teacher or student points at:
 * an answer typed by the teacher wins; else a bank question's stored answer and solution; else a
 * solved session's answer (the cross-validated computation, else the written solution's) and its
 * worked solution. With none of these the marking solves the problem itself (source "model").
 */
import { BankError, getItem } from "../bank/store";
import { lt } from "../llm/output-locale";
import { answerCandidates } from "../pipeline/lean-attempt";
import type { NaturalLanguageSolution, Session } from "../types";
import type { Reference, Submission } from "./types";

export function solutionText(s: NaturalLanguageSolution | undefined): string | undefined {
  if (!s) return undefined;
  const t = [s.summary, ...(s.steps ?? []).map((x, i) => `${i + 1}. ${x.title}: ${x.content}`), s.final_answer ? `Answer: ${s.final_answer}` : ""]
    .filter(Boolean)
    .join("\n")
    .trim();
  return t ? t.slice(0, 6000) : undefined;
}

/** A bank question as problem text: stem, then the options as "A. …". */
export function bankProblemText(item: { stem: string; options?: string[] }): string {
  const opts = (item.options ?? []).map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`);
  return [item.stem, ...opts].join("\n");
}

export interface ProblemInput {
  text?: string;
  figure?: string;
  answer?: string;
  session_id?: string;
  bank_id?: string;
  item_id?: string;
}

/**
 * Resolves the problem and the reference. `owner` is the uploader (bank questions and sessions are
 * read with their access); `getSession` is injected so this stays testable.
 */
export async function resolveProblem(
  owner: string,
  input: ProblemInput,
  deps: { getSession: (id: string) => Promise<Session | undefined> },
): Promise<{ problem: Submission["problem"]; reference: Reference }> {
  const typed = input.answer?.trim();
  if (input.bank_id && input.item_id) {
    const item = getItem(owner, input.bank_id, input.item_id);
    const captions = item.images.map((i) => i.caption).filter(Boolean).join("; ");
    const figure = input.figure?.trim() || captions || undefined;
    return {
      problem: { text: input.text?.trim() || bankProblemText(item), ...(figure ? { figure } : {}), bank_id: input.bank_id, item_id: input.item_id },
      reference: typed
        ? { answer: typed, source: "teacher", ...(item.solution ? { solution: item.solution } : {}) }
        : item.answer?.trim()
          ? { answer: item.answer.trim(), ...(item.solution ? { solution: item.solution } : {}), source: "bank" }
          : { source: "none" },
    };
  }
  if (input.session_id) {
    const s = await deps.getSession(input.session_id);
    if (s) {
      const answer = answerCandidates(s)[0];
      const solution = solutionText(s.nl_solution);
      const figure = input.figure?.trim() || s.figure_description || undefined;
      return {
        problem: { text: input.text?.trim() || s.problem_text, ...(figure ? { figure } : {}), session_id: s.id },
        reference: typed
          ? { answer: typed, source: "teacher", ...(solution ? { solution } : {}) }
          : answer
            ? { answer, ...(solution ? { solution } : {}), source: "session" }
            : { source: "none", ...(solution ? { solution } : {}) },
      };
    }
  }
  const text = input.text?.trim();
  if (!text) throw new BankError(lt("请填写题目，或选择一道已求解的题 / 题库题", "Enter the problem, or pick a solved problem or a bank question"), 400);
  return {
    problem: { text, ...(input.figure?.trim() ? { figure: input.figure.trim() } : {}) },
    reference: typed ? { answer: typed, source: "teacher" } : { source: "none" },
  };
}
