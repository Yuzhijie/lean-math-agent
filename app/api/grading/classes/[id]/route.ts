import { z } from "zod";
import { bankRoute, jsonBody } from "@/lib/bank/http";
import { learningStats } from "@/lib/grading/stats";
import { deleteClass, membersOf, regenerateJoinCode, renameClass, submissionsOf, submissionsOfClass, teacherClass } from "@/lib/grading/store";

type P = { id: string };

/** A class the caller teaches: roster with each student's record, and the class as a whole. */
export const GET = bankRoute<P>(async ({ owner, params }) => {
  const cls = teacherClass(owner, params.id);
  return {
    class: cls,
    members: membersOf(cls.id).map((m) => ({ ...m, linked: !!m.user_id, user_id: undefined, stats: learningStats(submissionsOf(m.id), { recent: 10 }) })),
    stats: learningStats(submissionsOfClass(cls.id)),
  };
});

const patchSchema = z.object({ name: z.string().trim().min(1).max(100).optional(), regenerate_code: z.boolean().optional() });

export const PATCH = bankRoute<P>(async ({ req, owner, params }) => {
  const body = patchSchema.parse(await jsonBody(req));
  let cls = teacherClass(owner, params.id);
  if (body.name) cls = renameClass(owner, params.id, body.name);
  if (body.regenerate_code) cls = regenerateJoinCode(owner, params.id);
  return { class: cls };
});

export const DELETE = bankRoute<P>(async ({ owner, params }) => {
  deleteClass(owner, params.id);
  return { ok: true };
});
