import { z } from "zod";
import { bankRoute, jsonBody } from "@/lib/bank/http";
import { addMember, ensureTeacherGroup } from "@/lib/grading/store";
import { callerDisplayName } from "@/lib/grading/who";

/** Add students to my list: one name, or a pasted list (one per line, or separated by commas). */
const schema = z.object({ name: z.string().max(60).optional(), names: z.string().max(5000).optional() });

export const POST = bankRoute(async ({ req, owner }) => {
  const body = schema.parse(await jsonBody(req));
  const names = [body.name ?? "", ...(body.names ?? "").split(/[\n,，、;；]+/)].map((n) => n.trim()).filter(Boolean);
  const group = ensureTeacherGroup(owner, await callerDisplayName());
  return { students: [...new Set(names)].slice(0, 200).map((n) => addMember(owner, group.id, n)).map(({ user_id, ...m }) => ({ ...m, linked: !!user_id })) };
});
