/** What lists show of a submission (the full record is fetched when one is opened). */
import { effectiveScore, effectiveVerdict, type Submission } from "./types";

export function submissionSummary(s: Submission) {
  return {
    id: s.id,
    created_at: s.created_at,
    status: s.status,
    problem: s.problem.text.slice(0, 200),
    verdict: effectiveVerdict(s) ?? null,
    teacher_corrected: !!s.teacher?.verdict,
    score: effectiveScore(s),
    needs_review: !!s.marking?.needs_review && !s.teacher?.verdict,
    final_answer: s.reading?.final_answer ?? null,
    error_types: s.marking?.error_types ?? [],
    knowledge_points: s.marking?.knowledge_points ?? [],
  };
}

/**
 * A submission as the API returns it: without the uploader's account id, and for a student without
 * the teacher's own ids (solved session, bank and question) the problem came from.
 */
export function publicSubmission(s: Submission, role: "teacher" | "student") {
  const { submitted_by: _uploader, ...rest } = s;
  void _uploader;
  if (role === "teacher") return rest;
  const { session_id: _s, bank_id: _b, item_id: _i, ...problem } = s.problem;
  void _s;
  void _b;
  void _i;
  return { ...rest, problem };
}
