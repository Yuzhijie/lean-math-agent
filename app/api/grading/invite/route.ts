import { z } from "zod";
import { bankRoute, jsonBody } from "@/lib/bank/http";
import { ensureTeacherGroup, regenerateJoinCode, renameClass } from "@/lib/grading/store";
import { callerDisplayName } from "@/lib/grading/who";

const schema = z.object({ regenerate: z.boolean().optional(), name: z.string().trim().min(1).max(100).optional() });

/**
 * My invite code for students (created on first use); `regenerate` replaces it (students who
 * already joined stay), `name` changes how students see me.
 */
export const POST = bankRoute(async ({ req, owner }) => {
  const body = schema.parse(await jsonBody(req).catch(() => ({})));
  let group = ensureTeacherGroup(owner, await callerDisplayName());
  if (body.name) group = renameClass(owner, group.id, body.name);
  if (body.regenerate) group = regenerateJoinCode(owner, group.id);
  return { name: group.name, invite_code: group.join_code };
});
