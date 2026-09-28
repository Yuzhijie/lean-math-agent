import { z } from "zod";
import { adoptCandidates } from "@/lib/bank/generate";
import { bankRoute, jsonBody } from "@/lib/bank/http";
import { getGeneration } from "@/lib/bank/store";

type P = { id: string; generationId: string };

export const GET = bankRoute<P>(async ({ owner, params }) => ({ generation: getGeneration(owner, params.id, params.generationId) }));

/** Adopt candidates into the bank (marked as generated). */
export const POST = bankRoute<P>(async ({ req, owner, params }) => {
  const body = z.object({ candidate_ids: z.array(z.string()).min(1).max(20), category_id: z.string().optional() }).parse(await jsonBody(req));
  const items = adoptCandidates(owner, params.id, params.generationId, body.candidate_ids, { categoryId: body.category_id });
  return { items, generation: getGeneration(owner, params.id, params.generationId) };
});
