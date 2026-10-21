/** Words and colours for the marking UI (browser-side). */
import type { ErrorType, Verdict } from "@/lib/grading/types";

export type Tr = (zh: string, en: string) => string;

export function verdictLabel(v: Verdict | null | undefined, tr: Tr): string {
  switch (v) {
    case "correct":
      return tr("全对", "Correct");
    case "correct_answer_flawed":
      return tr("答案对，过程有问题", "Right answer, flawed working");
    case "partially_correct":
      return tr("思路对，有错误", "Right idea, with a mistake");
    case "incorrect":
      return tr("错误", "Incorrect");
    case "no_answer":
      return tr("没有答案", "No answer");
    case "unreadable":
      return tr("无法辨认", "Unreadable");
    default:
      return tr("未批改", "Not marked");
  }
}

export function verdictVariant(v: Verdict | null | undefined): "success" | "warning" | "destructive" | "secondary" {
  if (v === "correct") return "success";
  if (v === "correct_answer_flawed" || v === "partially_correct") return "warning";
  if (v === "incorrect" || v === "no_answer") return "destructive";
  return "secondary";
}

export function errorTypeLabel(e: ErrorType | string, tr: Tr): string {
  switch (e) {
    case "calculation":
      return tr("计算错误", "Calculation");
    case "concept":
      return tr("概念错误", "Concept");
    case "method":
      return tr("方法错误", "Method");
    case "misread":
      return tr("审题错误", "Misread");
    case "incomplete":
      return tr("不完整", "Incomplete");
    case "notation":
      return tr("书写不规范", "Notation");
    default:
      return e;
  }
}

export function referenceSourceLabel(s: string, tr: Tr): string {
  switch (s) {
    case "teacher":
      return tr("老师给的答案", "teacher's answer");
    case "bank":
      return tr("题库答案", "bank answer");
    case "session":
      return tr("求解结果", "solver's answer");
    case "model":
      return tr("模型独立解出（请核对）", "solved by the model (check it)");
    default:
      return tr("无", "none");
  }
}

export const pct = (x: number) => `${Math.round(x * 100)}%`;
