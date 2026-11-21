/**
 * Exams (试卷): a teacher's whole paper of generated questions, in parts — each part one kind of
 * question (choice, fill in the blank, worked solution, proof) about one subject at one difficulty —
 * printed in sections, marked against its own answers, and planned from marked work so that the
 * next paper is aimed at what a student (or the class) has not yet mastered. Browser-safe.
 */
import { z } from "zod";
import { COMPETITION_DOMAINS, GRADE_LEVELS } from "../types";

/** The kinds of question a paper has, in the order the sections are printed. */
export const EXAM_KINDS = ["choice", "blank", "solve", "proof"] as const;
export type ExamKind = (typeof EXAM_KINDS)[number];

export const MASTERY = ["mastered", "developing", "weak", "not_yet"] as const;

const id = z.string().min(1).max(64);
const kp = z.string().trim().min(1).max(60);

export const partSourceSchema = z.discriminatedUnion("kind", [
  /** The built-in generator, in one of its domains. */
  z.object({ kind: z.literal("builtin"), domain: z.enum(COMPETITION_DOMAINS) }),
  /** The teacher's question bank: questions of a category or knowledge point are the template (the kind of question follows the template). */
  z.object({ kind: z.literal("bank"), bank_id: id, bank_name: z.string().max(100).optional(), category_id: id.optional(), knowledge_point: kp.optional() }),
]);
export type PartSource = z.infer<typeof partSourceSchema>;

/** Why a part is on a planned paper: the skill it is aimed at and how the marked work went on it. */
export const partTargetSchema = z.object({
  knowledge_point: kp,
  level: z.enum(MASTERY),
  attempts: z.number().int().min(0),
  correct: z.number().int().min(0),
  /** How many of the students (class plans) were weak on it. */
  students: z.number().int().min(0).optional(),
});
export type PartTarget = z.infer<typeof partTargetSchema>;

export const examPartSchema = z.object({
  id,
  kind: z.enum(EXAM_KINDS),
  count: z.number().int().min(1).max(10),
  /** Points for each question of the part. */
  points: z.number().int().min(1).max(50),
  difficulty: z.number().int().min(1).max(5),
  /** What the questions are about (the writer is told; marked work is counted under these names). */
  knowledge_points: z.array(kp).max(3).default([]),
  source: partSourceSchema,
  /** Questions a student got wrong: the part's questions are variants of them (same skill and kind, new numbers and setting). */
  like: z.array(z.string().max(1500)).max(3).default([]),
  /** Why this part (a planned paper): shown to the teacher. */
  reason: z.string().max(400).optional(),
  target: partTargetSchema.optional(),
});
export type ExamPart = z.infer<typeof examPartSchema>;

export const blueprintSchema = z.object({
  title: z.string().trim().min(1).max(100),
  grade_level: z.enum(GRADE_LEVELS),
  parts: z.array(examPartSchema).min(1).max(12),
});
export type Blueprint = z.infer<typeof blueprintSchema>;

/** What a planned paper was planned from. */
export const planBasisSchema = z.object({
  scope: z.enum(["member", "class"]),
  member_id: id.optional(),
  /** Shown as "for …" (the student's name, or "the class"). */
  name: z.string().max(100),
  /** Marked questions counted. */
  submissions: z.number().int().min(0),
  /** Exams whose marked papers were among them. */
  exam_ids: z.array(id).max(50).default([]),
  mastery: z.array(z.object({ knowledge_point: kp, level: z.enum(MASTERY), attempts: z.number().int(), correct: z.number().int() })).max(40),
  at: z.number(),
});
export type PlanBasis = z.infer<typeof planBasisSchema>;

export const examQuestionSchema = z.object({
  id,
  /** Number on the printed paper ("1", "2", …), counted across sections. */
  no: z.string().max(8),
  part_id: id,
  kind: z.enum(EXAM_KINDS),
  stem: z.string().min(1),
  /** Choices (A, B, …) without the letter. */
  options: z.array(z.string()).max(8).optional(),
  /** The letter of a choice question, else the answer as written. */
  answer: z.string(),
  solution: z.string().optional(),
  hints: z.array(z.string()).default([]),
  knowledge_points: z.array(z.string()).default([]),
  difficulty: z.number().int().min(1).max(5),
  points: z.number().int().min(1).max(50),
  figure_svg: z.string().optional(),
  figure_description: z.string().optional(),
  /** The checks it passed, in a few words ("独立重解一致 · Lean 已证"). */
  checked: z.string().max(300).optional(),
  lean_proved: z.boolean().optional(),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("builtin") }),
    z.object({ kind: z.literal("bank"), bank_id: id, generation_id: id, candidate_id: id }),
  ]),
});
export type ExamQuestion = z.infer<typeof examQuestionSchema>;

/** A question that did not pass its checks: kept out of the paper, with the reason. */
export const rejectedQuestionSchema = z.object({ part_id: id, stem: z.string(), answer: z.string(), reason: z.string().max(600) });
export type RejectedQuestion = z.infer<typeof rejectedQuestionSchema>;

export const EXAM_STATUSES = ["generating", "ready", "partial", "failed", "cancelled"] as const;
export type ExamStatus = (typeof EXAM_STATUSES)[number];

export const examSchema = z.object({
  id,
  owner: z.string(),
  title: z.string().max(100),
  grade_level: z.enum(GRADE_LEVELS),
  parts: z.array(examPartSchema).min(1).max(12),
  questions: z.array(examQuestionSchema).default([]),
  rejected: z.array(rejectedQuestionSchema).max(200).default([]),
  status: z.enum(EXAM_STATUSES),
  /** While generating: where the run is. */
  progress: z.object({ part: z.number().int(), parts: z.number().int(), message: z.string().max(400) }).optional(),
  /** The server run generating it (lib/boot.ts): a run of an earlier server process was interrupted. */
  run: z.string().optional(),
  /** Why parts are short, or what went wrong. */
  note: z.string().max(1500).optional(),
  /** A planned paper: whom it is for and what it was planned from. */
  basis: planBasisSchema.optional(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type Exam = z.infer<typeof examSchema>;

// ── Numbers of a paper (browser-safe) ────────────────────────────────

export const KIND_ORDER: Record<ExamKind, number> = { choice: 0, blank: 1, solve: 2, proof: 3 };

/** Questions in printed order: by kind (sections), then by part, keeping each part's order. */
export function orderQuestions<T extends { kind: ExamKind; part_id: string }>(questions: T[], parts: { id: string }[]): T[] {
  const partIndex = new Map(parts.map((p, i) => [p.id, i]));
  return questions
    .map((q, i) => ({ q, i }))
    .sort((a, b) => KIND_ORDER[a.q.kind] - KIND_ORDER[b.q.kind] || (partIndex.get(a.q.part_id) ?? 99) - (partIndex.get(b.q.part_id) ?? 99) || a.i - b.i)
    .map(({ q }) => q);
}

/** Printed order and numbers 1, 2, … */
export function numberQuestions(questions: ExamQuestion[], parts: { id: string }[]): ExamQuestion[] {
  return orderQuestions(questions, parts).map((q, i) => ({ ...q, no: String(i + 1) }));
}

export function examTotal(questions: { points: number }[]): number {
  return questions.reduce((a, q) => a + q.points, 0);
}

/** Questions the parts still need (passed questions per part below its count). */
export function missingByPart(exam: Pick<Exam, "parts" | "questions">): Map<string, number> {
  const have = new Map<string, number>();
  for (const q of exam.questions) have.set(q.part_id, (have.get(q.part_id) ?? 0) + 1);
  return new Map(exam.parts.map((p) => [p.id, Math.max(0, p.count - (have.get(p.id) ?? 0))]).filter(([, n]) => (n as number) > 0) as [string, number][]);
}

export function plannedTotal(parts: { count: number; points: number }[]): number {
  return parts.reduce((a, p) => a + p.count * p.points, 0);
}
