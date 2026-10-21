/**
 * Marking students' handwritten work (批改): classes with a roster, and submissions — a problem,
 * photos of a student's working, what was read from them, and the marking.
 */
import { z } from "zod";

/** How a piece of work is judged overall. */
export const VERDICTS = [
  "correct", // right answer, sound working
  "correct_answer_flawed", // right answer, but a step is wrong or unjustified
  "partially_correct", // a sound approach with an error, so the answer is wrong or missing
  "incorrect", // wrong approach and wrong answer
  "no_answer", // working without a final answer
  "unreadable", // the photos could not be read
] as const;
export type Verdict = (typeof VERDICTS)[number];

export const ERROR_TYPES = ["calculation", "concept", "method", "misread", "incomplete", "notation"] as const;
export type ErrorType = (typeof ERROR_TYPES)[number];

export const STEP_VERDICTS = ["correct", "error", "unjustified", "unclear"] as const;

export const classSchema = z.object({
  id: z.string(),
  owner: z.string(),
  name: z.string().min(1).max(100),
  join_code: z.string(),
  created_at: z.number(),
});
export type GradingClass = z.infer<typeof classSchema>;

export const memberSchema = z.object({
  id: z.string(),
  class_id: z.string(),
  name: z.string().min(1).max(60),
  /** The student's account, once they joined with the code (absent: added by the teacher only). */
  user_id: z.string().optional(),
  created_at: z.number(),
});
export type Member = z.infer<typeof memberSchema>;

/** What the vision model read from the photos, verbatim (mistakes kept). */
export const readingSchema = z.object({
  readable: z.boolean(),
  steps: z.array(z.object({ text: z.string(), crossed_out: z.boolean().optional(), unclear: z.boolean().optional() })),
  final_answer: z.string().optional(),
  note: z.string().optional(),
});
export type Reading = z.infer<typeof readingSchema>;

export const markingSchema = z.object({
  verdict: z.enum(VERDICTS),
  /** null: could not be decided (no reference answer and the checker was unsure). */
  answer_correct: z.boolean().nullable(),
  /** How the answer was compared: the program (same value) or the model (equivalent form). */
  answer_check: z.enum(["program", "model", "none"]),
  approach: z.string(),
  approach_valid: z.boolean().nullable(),
  steps: z.array(z.object({ index: z.number(), verdict: z.enum(STEP_VERDICTS), comment: z.string().optional() })),
  /** 1-based index of the first step with an error, if any. */
  first_error_step: z.number().nullable(),
  error_types: z.array(z.enum(ERROR_TYPES)),
  feedback: z.string(),
  /** The next thing to try, without giving the solution away. */
  hint: z.string().optional(),
  knowledge_points: z.array(z.string()),
  score: z.number().min(0).max(100),
  /** The teacher should look: the answer could not be decided, or the reference was solved by a model. */
  needs_review: z.boolean().optional(),
});
export type Marking = z.infer<typeof markingSchema>;

export const referenceSchema = z.object({
  answer: z.string().optional(),
  solution: z.string().optional(),
  /** Where the reference came from; "model" = solved independently for the marking (less trusted). */
  source: z.enum(["teacher", "session", "bank", "model", "none"]),
});
export type Reference = z.infer<typeof referenceSchema>;

export const submissionSchema = z.object({
  id: z.string(),
  class_id: z.string(),
  member_id: z.string(),
  /** Who uploaded it (teacher or the student). */
  submitted_by: z.string(),
  problem: z.object({
    text: z.string(),
    figure: z.string().optional(),
    session_id: z.string().optional(),
    bank_id: z.string().optional(),
    item_id: z.string().optional(),
  }),
  reference: referenceSchema,
  images: z.array(z.string()),
  reading: readingSchema.optional(),
  marking: markingSchema.optional(),
  /** A teacher's correction of the verdict and their own note to the student. */
  teacher: z.object({ verdict: z.enum(VERDICTS).optional(), note: z.string().max(2000).optional(), at: z.number() }).optional(),
  status: z.enum(["marked", "failed"]),
  error: z.string().optional(),
  created_at: z.number(),
});
export type Submission = z.infer<typeof submissionSchema>;

const SCORE_BAND: Record<Verdict, [number, number]> = {
  correct: [90, 100],
  correct_answer_flawed: [60, 89],
  partially_correct: [20, 79],
  incorrect: [0, 39],
  no_answer: [0, 39],
  unreadable: [0, 0],
};

/** A score consistent with the verdict (clamped into the verdict's band; the middle when unknown). */
export function clampScore(score: number | null | undefined, verdict: Verdict): number {
  const [lo, hi] = SCORE_BAND[verdict];
  const s = typeof score === "number" && Number.isFinite(score) ? Math.round(score) : Math.round((lo + hi) / 2);
  return Math.min(hi, Math.max(lo, s));
}

/** The score that counts: the model's, moved into the band of the teacher's verdict when they corrected it. */
export function effectiveScore(s: Pick<Submission, "marking" | "teacher">): number | null {
  if (!s.marking) return null;
  return s.teacher?.verdict ? clampScore(s.marking.score, s.teacher.verdict) : s.marking.score;
}

/** The verdict that counts: the teacher's when they corrected it. */
export function effectiveVerdict(s: Pick<Submission, "marking" | "teacher">): Verdict | undefined {
  return s.teacher?.verdict ?? s.marking?.verdict;
}
