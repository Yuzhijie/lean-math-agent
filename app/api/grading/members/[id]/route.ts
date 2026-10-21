import { z } from "zod";
import { bankRoute, jsonBody } from "@/lib/bank/http";
import { learningStats } from "@/lib/grading/stats";
import { accessToMember, removeMember, renameMember, submissionsOf, unlinkMember } from "@/lib/grading/store";
import { submissionSummary } from "@/lib/grading/view";

type P = { id: string };

/** One student's learning record and work (their teacher, or the student themself). */
export const GET = bankRoute<P>(async ({ owner, params }) => {
  const { role, member, cls } = accessToMember(owner, params.id);
  const subs = submissionsOf(member.id);
  return {
    role,
    class: { id: cls.id, name: cls.name },
    member: { id: member.id, name: member.name, class_id: member.class_id, linked: !!member.user_id },
    stats: learningStats(subs),
    submissions: subs.map(submissionSummary),
  };
});

const patchSchema = z.object({ name: z.string().trim().min(1).max(60).optional(), unlink: z.boolean().optional() });

/** The teacher renames the entry, or unlinks the account that claimed it. */
export const PATCH = bankRoute<P>(async ({ req, owner, params }) => {
  const body = patchSchema.parse(await jsonBody(req));
  let member = body.name ? renameMember(owner, params.id, body.name) : undefined;
  if (body.unlink) member = unlinkMember(owner, params.id);
  if (!member) accessToMember(owner, params.id);
  const { user_id, ...rest } = member ?? { user_id: undefined };
  return { member: { ...rest, linked: !!user_id } };
});

export const DELETE = bankRoute<P>(async ({ owner, params }) => {
  removeMember(owner, params.id);
  return { ok: true };
});
