/** Client-side types and calls for /api/grading. */
import type { Diagnosis, Member, Paper, Submission, Verdict } from "@/lib/grading/types";
import type { LearningStats } from "@/lib/grading/stats";
export type { Diagnosis, Member, Paper, Submission, Verdict, LearningStats };
export { api, errMsg } from "../bank/api";

export type StudentRow = Omit<Member, "user_id"> & { linked: boolean; stats: LearningStats };

export interface MeResponse {
  /** I teach: my students (none until I add one or share my invite code). */
  teacher: { name: string; invite_code: string; students: StudentRow[]; stats: LearningStats } | null;
  /** Teachers I joined as a student, and my entry in their list. */
  enrolled: { teacher: string; member: { id: string; name: string } }[];
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

export interface PaperSummary {
  id: string;
  title: string;
  created_at: number;
  status: Paper["status"];
  questions: number;
  summary: string | null;
}

export interface MemberDetail {
  role: "teacher" | "student";
  teacher: string;
  member: { id: string; name: string; class_id: string; linked: boolean };
  stats: LearningStats;
  submissions: SubmissionSummary[];
  papers: PaperSummary[];
  diagnosis: Diagnosis | null;
}

export interface PaperDetail {
  role: "teacher" | "student";
  own: boolean;
  member: { id: string; name: string };
  paper: Omit<Paper, "submitted_by">;
  questions: (SubmissionSummary & { question_no: string | null; reference_source: string })[];
}

export const paperImageUrl = (paperId: string, name: string) => `/api/grading/papers/${encodeURIComponent(paperId)}/images/${encodeURIComponent(name)}`;

export interface SubmissionDetail {
  role: "teacher" | "student";
  /** The paper this question is on (its page photos are the work's photos). */
  paper?: { id: string; title: string; images: string[] };
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
