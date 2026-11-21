import { bankRoute } from "@/lib/bank/http";
import { deletePaper, examOf, getMember, getSubmission, visiblePaper } from "@/lib/grading/store";
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
    .map((s) => ({ ...submissionSummary(s), question_no: s.question_no ?? null, reference_source: s.reference.source, points: s.points ?? null }));
  // a paper of a generated exam: its score out of the exam's points (the teacher's verdicts count)
  const pointed = questions.filter((q) => q.points);
  const score = pointed.length ? { got: Math.round(pointed.reduce((a, q) => a + (q.points! * (q.score ?? 0)) / 100, 0) * 10) / 10, total: pointed.reduce((a, q) => a + q.points!, 0) } : null;
  let exam: { id: string; title: string } | null = null;
  if (role === "teacher" && paper.source.exam_id) {
    try {
      const e = examOf(owner, paper.source.exam_id);
      exam = { id: e.id, title: e.title };
    } catch {
      exam = null; // deleted
    }
  }
  return { role, own: paper.submitted_by === owner, member: { id: member.id, name: member.name }, paper: publicPaper(paper, role), questions, score, exam };
});

export const DELETE = bankRoute<P>(async ({ owner, params }) => {
  deletePaper(owner, params.id);
  return { ok: true };
});
