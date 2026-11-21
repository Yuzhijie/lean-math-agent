/** A generated exam as a printable worksheet (app/print/page.tsx, ?exam=…). Browser-safe. */
import type { WorksheetQuestion } from "../bank/worksheet";
import { sectionTitle, type Tr } from "./labels";
import { EXAM_KINDS, examTotal, orderQuestions, type Exam, type ExamKind } from "./types";

/** The questions in printed order, each with its number, points and the heading of its section. */
export function examWorksheet(exam: Pick<Exam, "title" | "parts" | "questions">, tr: Tr): { title: string; total: number; questions: WorksheetQuestion[] } {
  const ordered = orderQuestions(exam.questions, exam.parts);
  const kinds = EXAM_KINDS.filter((k) => ordered.some((q) => q.kind === k));
  const heading = new Map<ExamKind, string>(kinds.map((k, i) => [k, sectionTitle(i, k, ordered.filter((q) => q.kind === k).map((q) => q.points), tr)]));
  return {
    title: exam.title,
    total: examTotal(ordered),
    questions: ordered.map((q, i) => ({
      id: q.id,
      stem: q.stem,
      ...(q.options?.length ? { options: q.options } : {}),
      answer: q.answer,
      ...(q.solution ? { solution: q.solution } : {}),
      ...(q.figure_svg ? { figureSvg: q.figure_svg } : {}),
      passed: true,
      no: q.no || String(i + 1),
      points: q.points,
      section: heading.get(q.kind),
      kind: q.kind,
    })),
  };
}
