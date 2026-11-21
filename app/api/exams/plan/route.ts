import { bankRoute, jsonBody } from "@/lib/bank/http";
import { planFor } from "@/lib/exam/service";

/**
 * POST {member_id} or {scope: "class"}, questions?, grade_level?, title? — the next paper planned
 * from marked work (no model call): the blueprint to edit, what it is based on, the skills table.
 */
export const POST = bankRoute(async ({ req, owner }) => {
  const body = ((await jsonBody(req)) ?? {}) as Record<string, unknown>;
  return planFor(owner, body);
});
