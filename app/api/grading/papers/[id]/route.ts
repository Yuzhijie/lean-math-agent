import { bankRoute } from "@/lib/bank/http";
import { deletePaper, getMember, getSubmission, visiblePaper } from "@/lib/grading/store";
import { publicPaper, submissionSummary } from "@/lib/grading/view";

type P = { id: string };

/** A paper with its questions (each a marked submission) and its diagnosis. */
export const GET = bankRoute<P>(async ({ owner, params }) => {
  const { paper, role } = visiblePaper(owner, params.id);
  const member = getMember(paper.member_id);
  const questions = paper.submission_ids
    .map((id) => {
      try {
        return getSubmission(id);
      } catch {
        return undefined; // deleted on its own
      }
    })
    .filter((s): s is NonNullable<typeof s> => !!s)
    .map((s) => ({ ...submissionSummary(s), question_no: s.question_no ?? null, reference_source: s.reference.source }));
  return { role, own: paper.submitted_by === owner, member: { id: member.id, name: member.name }, paper: publicPaper(paper, role), questions };
});

export const DELETE = bankRoute<P>(async ({ owner, params }) => {
  deletePaper(owner, params.id);
  return { ok: true };
});
