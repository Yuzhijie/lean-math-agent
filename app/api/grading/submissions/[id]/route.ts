import { z } from "zod";
import { bankRoute, jsonBody } from "@/lib/bank/http";
import { BankError } from "@/lib/bank/store";
import { lt } from "@/lib/llm/output-locale";
import { deleteSubmission, getMember, getPaper, putSubmission, visibleSubmission } from "@/lib/grading/store";
import { VERDICTS } from "@/lib/grading/types";
import { publicSubmission } from "@/lib/grading/view";

type P = { id: string };

/** A submission with its photos (names), what was read and the marking. */
export const GET = bankRoute<P>(async ({ owner, params }) => {
  const { submission, role } = visibleSubmission(owner, params.id);
  const member = getMember(submission.member_id);
  let paper: { id: string; title: string; images: string[] } | undefined;
  if (submission.paper_id) {
    try {
      const p = getPaper(submission.paper_id);
      paper = { id: p.id, title: p.title, images: p.images };
    } catch {
      paper = undefined;
    }
  }
  return { role, member: { id: member.id, name: member.name }, submission: publicSubmission(submission, role), own: submission.submitted_by === owner, ...(paper ? { paper } : {}) };
});

const patchSchema = z.object({ verdict: z.enum(VERDICTS).nullable().optional(), note: z.string().max(2000).optional() });

/** The teacher corrects the verdict or leaves a note for the student. */
export const PATCH = bankRoute<P>(async ({ req, owner, params }) => {
  const { submission, role } = visibleSubmission(owner, params.id);
  if (role !== "teacher") throw new BankError(lt("只有老师可以修改批改结果", "Only the teacher can change the marking"), 403);
  const body = patchSchema.parse(await jsonBody(req));
  const verdict = body.verdict === null ? undefined : (body.verdict ?? submission.teacher?.verdict);
  const note = body.note !== undefined ? body.note.trim() || undefined : submission.teacher?.note;
  const teacher = verdict || note ? { ...(verdict ? { verdict } : {}), ...(note ? { note } : {}), at: Date.now() } : undefined;
  return { submission: publicSubmission(putSubmission({ ...submission, teacher }), role) };
});

export const DELETE = bankRoute<P>(async ({ owner, params }) => {
  deleteSubmission(owner, params.id);
  return { ok: true };
});
