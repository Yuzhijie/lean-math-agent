/** Client-side types for /api/exams. */
import type { Blueprint, Exam, ExamPart, ExamQuestion, ExamStatus, PlanBasis } from "@/lib/exam/types";
export type { Blueprint, Exam, ExamPart, ExamQuestion, ExamStatus, PlanBasis };
export { api, errMsg } from "../bank/api";

export interface ExamSummary {
  id: string;
  title: string;
  grade_level: Exam["grade_level"];
  status: ExamStatus;
  questions: number;
  planned: number;
  total: number;
  parts: number;
  basis?: { scope: "member" | "class"; name: string; member_id?: string };
  progress?: Exam["progress"];
  created_at: number;
  updated_at: number;
}

/** A skill as the plan counted it from the marked work. */
export interface SkillRow {
  knowledge_point: string;
  attempts: number;
  correct: number;
  credit: number;
  level: "mastered" | "developing" | "weak" | "not_yet";
  wrong: string[];
  difficulty?: number;
  students?: number;
}

export interface PlanResponse {
  blueprint: Blueprint;
  basis: PlanBasis;
  records: SkillRow[];
  total: number;
}

export const examUrl = (id: string, path = "") => `/api/exams/${encodeURIComponent(id)}${path}`;
export const examPrintHref = (id: string, answers?: "end") => `/print?exam=${encodeURIComponent(id)}${answers ? `&answers=${answers}` : ""}`;
