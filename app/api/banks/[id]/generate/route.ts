import { z } from "zod";
import { generateFromTemplate } from "@/lib/bank/generate";
import { bankRoute, jsonBody } from "@/lib/bank/http";
import { templateRefSchema } from "@/lib/bank/types";

type P = { id: string };
// Profile + generate + re-solve + judge: several model calls.
export const maxDuration = 600;

const bodySchema = z.object({ template: templateRefSchema, count: z.number().int().min(1).max(10).default(3) });

/** Generate candidate questions from a template (category, picked questions or style template). */
export const POST = bankRoute<P>(async ({ req, owner, params }) => {
  const body = bodySchema.parse(await jsonBody(req));
  return { generation: await generateFromTemplate({ owner, bankId: params.id, template: body.template, count: body.count }) };
});
