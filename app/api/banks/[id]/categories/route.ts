import { z } from "zod";
import { bankRoute, jsonBody } from "@/lib/bank/http";
import { categoryMembers } from "@/lib/bank/query";
import { listCategories, listItems, putCategory } from "@/lib/bank/store";
import { itemFilterSchema, styleTemplateSchema } from "@/lib/bank/types";

type P = { id: string };

export const GET = bankRoute<P>(async ({ owner, params }) => {
  const cats = listCategories(owner, params.id);
  const items = listItems(owner, params.id);
  return { categories: cats.map((c) => ({ ...c, member_count: categoryMembers(items, cats, c).length })) };
});

const putSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(100),
  parent_id: z.string().nullable().default(null),
  kind: z.enum(["manual", "filter", "style"]).default("manual"),
  filter: itemFilterSchema.optional(),
  style: styleTemplateSchema.optional(),
});

/** Create or update (with id) a category: a manual group, a saved filter or a style template. */
export const POST = bankRoute<P>(async ({ req, owner, params }) => {
  const body = putSchema.parse(await jsonBody(req));
  // A changed definition invalidates the cached template profile.
  return { category: putCategory(owner, params.id, { ...body, profile: undefined }) };
});
