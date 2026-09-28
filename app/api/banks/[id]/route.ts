import { z } from "zod";
import { bankRoute, jsonBody } from "@/lib/bank/http";
import { facet } from "@/lib/bank/query";
import { deleteBank, getBank, listBatches, listCategories, listItems, updateBank, backendOf } from "@/lib/bank/store";
import { builtinVocab } from "@/lib/bank/vocab";

type P = { id: string };

/** A bank with its categories, facets for filters, vocabulary and recent import batches. */
export const GET = bankRoute<P>(async ({ owner, params }) => {
  const bank = getBank(owner, params.id);
  const items = listItems(owner, params.id);
  return {
    bank,
    storage: backendOf(owner, params.id),
    item_count: items.length,
    categories: listCategories(owner, params.id),
    facets: {
      types: facet(items, (i) => i.type),
      grades: facet(items, (i) => i.grade),
      knowledge_points: facet(items, (i) => i.knowledge_points),
      tags: facet(items, (i) => i.tags),
      origins: facet(items, (i) => i.origin),
    },
    vocab: { own: bank.vocab, builtin: builtinVocab(bank.language) },
    batches: listBatches(owner, params.id).map(({ drafts, ...b }) => ({ ...b, draft_count: drafts.length })),
  };
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(1000).optional(),
  language: z.enum(["zh", "en", "mixed"]).optional(),
  allow_model: z.boolean().optional(),
  pin_language: z.boolean().optional(),
  vocab: z.array(z.string().max(80)).max(2000).optional(),
});

export const PATCH = bankRoute<P>(async ({ req, owner, params }) => ({ bank: updateBank(owner, params.id, patchSchema.parse(await jsonBody(req))) }));

export const DELETE = bankRoute<P>(async ({ owner, params }) => {
  deleteBank(owner, params.id);
  return { ok: true };
});
