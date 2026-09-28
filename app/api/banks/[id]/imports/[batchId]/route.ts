import { z } from "zod";
import { bankRoute, jsonBody } from "@/lib/bank/http";
import { commitBatch, recheckBatch } from "@/lib/bank/import";
import { BankError, getBatch, putBatch } from "@/lib/bank/store";
import { draftItemSchema } from "@/lib/bank/types";
import { lt } from "@/lib/llm/output-locale";

type P = { id: string; batchId: string };

export const GET = bankRoute<P>(async ({ owner, params }) => ({ batch: getBatch(owner, params.id, params.batchId) }));

/** Save edited drafts (re-runs validation and duplicate checks). */
export const PATCH = bankRoute<P>(async ({ req, owner, params }) => {
  const body = z.object({ drafts: z.array(draftItemSchema).max(5000) }).parse(await jsonBody(req));
  return { batch: recheckBatch(owner, params.id, params.batchId, body.drafts) };
});

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("commit"), rights_confirmed: z.boolean(), category_id: z.string().optional() }),
  z.object({ action: z.literal("discard") }),
]);

/** Commit the batch into the bank (requires the rights confirmation) or discard it. */
export const POST = bankRoute<P>(async ({ req, owner, params }) => {
  const body = actionSchema.parse(await jsonBody(req));
  if (body.action === "commit") {
    const { batch, items } = commitBatch(owner, params.id, params.batchId, { rightsConfirmed: body.rights_confirmed, categoryId: body.category_id });
    return { batch, committed: items.length };
  }
  const batch = getBatch(owner, params.id, params.batchId);
  if (batch.status !== "draft") throw new BankError(lt("该批次已处理", "This batch has already been processed"), 409);
  return { batch: putBatch(owner, params.id, { ...batch, status: "discarded" }) };
});
