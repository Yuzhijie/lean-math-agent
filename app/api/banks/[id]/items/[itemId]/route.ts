import { bankRoute, jsonBody } from "@/lib/bank/http";
import { deleteItem, getItem, updateItem } from "@/lib/bank/store";
import { itemFieldsSchema } from "@/lib/bank/types";
import { z } from "zod";

type P = { id: string; itemId: string };

export const GET = bankRoute<P>(async ({ owner, params }) => ({ item: getItem(owner, params.id, params.itemId) }));

const patchSchema = itemFieldsSchema.partial().extend({ category_ids: z.array(z.string()).max(50).optional() });

export const PATCH = bankRoute<P>(async ({ req, owner, params }) => {
  const raw = (await jsonBody(req)) as Record<string, unknown>;
  // Only the fields actually sent (partial() would otherwise fill defaults like tags: []).
  const parsed = patchSchema.parse(raw);
  const patch = Object.fromEntries(Object.entries(parsed).filter(([k]) => k in raw));
  return { item: updateItem(owner, params.id, params.itemId, patch) };
});

export const DELETE = bankRoute<P>(async ({ owner, params }) => {
  deleteItem(owner, params.id, params.itemId);
  return { ok: true };
});
