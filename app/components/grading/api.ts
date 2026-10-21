/** Client-side types and calls for /api/grading. */
import type { GradingClass, Member, Submission, Verdict } from "@/lib/grading/types";
import type { LearningStats } from "@/lib/grading/stats";
export type { GradingClass, Member, Submission, Verdict, LearningStats };
export { api, errMsg } from "../bank/api";

export interface ClassesResponse {
  teaching: (GradingClass & { members: number; submissions: number })[];
  enrolled: { class: { id: string; name: string }; member: Member }[];
}

export interface ClassDetail {
  class: GradingClass;
  members: (Omit<Member, "user_id"> & { linked: boolean; stats: LearningStats })[];
  stats: LearningStats;
}

export interface SubmissionSummary {
  id: string;
  created_at: number;
  status: "marked" | "failed";
  problem: string;
  verdict: Verdict | null;
  teacher_corrected: boolean;
  score: number | null;
  needs_review?: boolean;
  final_answer: string | null;
  error_types: string[];
  knowledge_points: string[];
}

export interface MemberDetail {
  role: "teacher" | "student";
  class: { id: string; name: string };
  member: { id: string; name: string; class_id: string; linked: boolean };
  stats: LearningStats;
  submissions: SubmissionSummary[];
}

export interface SubmissionDetail {
  role: "teacher" | "student";
  /** The caller uploaded it (a student may delete only their own uploads). */
  own?: boolean;
  member: { id: string; name: string };
  submission: Submission;
}

/** What a submission is about when it is started from a solved problem or a bank question. */
export interface ProblemPrefill {
  session_id?: string;
  bank_id?: string;
  item_id?: string;
  problem?: string;
}

export const imageUrl = (submissionId: string, name: string) => `/api/grading/submissions/${encodeURIComponent(submissionId)}/images/${encodeURIComponent(name)}`;
