import { z } from "zod";
import { bankRoute, jsonBody } from "@/lib/bank/http";
import { MAX_RECLASSIFY, reclassifyItems } from "@/lib/bank/reclassify";

type P = { id: string };
export const maxDuration = 480;

const bodySchema = z.object({
  /** Questions to classify; all questions of the bank when omitted. */
  item_ids: z.array(z.string().min(1).max(64)).max(MAX_RECLASSIFY).optional(),
  /** Replace grade / difficulty / knowledge points that are already set. */
  overwrite: z.boolean().optional(),
});

/** Let the model decide catalogue place, grade, knowledge points and difficulty for existing questions. */
export const POST = bankRoute<P>(async ({ req, owner, params }) => {
  const body = bodySchema.parse(await jsonBody(req));
  return reclassifyItems(owner, params.id, { itemIds: body.item_ids, overwrite: body.overwrite });
});
