import { bankRoute, jsonBody } from "@/lib/bank/http";
import { deleteExamDoc } from "@/lib/grading/store";
import { examFor } from "@/lib/exam/run";
import { changeExam } from "@/lib/exam/service";

type P = { id: string };

/** The whole exam (the teacher's own): parts, questions with answers, rejected questions, progress. */
export const GET = bankRoute<P>(async ({ owner, params }) => ({ exam: examFor(owner, params.id) }));

/** PATCH {title?, cancel?: true (stop generating), remove_question?: id}. */
export const PATCH = bankRoute<P>(async ({ req, owner, params }) => {
  const body = ((await jsonBody(req)) ?? {}) as { title?: unknown; cancel?: unknown; remove_question?: unknown };
  return { exam: changeExam(owner, params.id, body) };
});

/** Deletes the exam (a run still writing it stops after its current part). */
export const DELETE = bankRoute<P>(async ({ owner, params }) => {
  deleteExamDoc(owner, params.id);
  return { ok: true };
});
