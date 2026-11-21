import { bankRoute, jsonBody } from "@/lib/bank/http";
import { createExam, listExams } from "@/lib/exam/service";

export const maxDuration = 60;

/** The teacher's exams, newest first (a run cut off by a restart shows as such). */
export const GET = bankRoute(async ({ owner }) => ({ exams: listExams(owner) }));

/**
 * POST {blueprint: {title, grade_level, parts}, basis?} — a new exam; its questions are written in
 * the background (GET /api/exams/:id shows the progress). 409 while another of the teacher's exams
 * is being written. A model route: the run's calls are charged to the teacher.
 */
export const POST = bankRoute(
  async ({ req, owner }) => {
    const body = ((await jsonBody(req)) ?? {}) as { blueprint?: unknown; basis?: unknown };
    return { exam: createExam(owner, body) };
  },
  { model: true },
);
