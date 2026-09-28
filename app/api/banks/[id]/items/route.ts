import { z } from "zod";
import { bankRoute, jsonBody } from "@/lib/bank/http";
import { categoryMembers, filterItems } from "@/lib/bank/query";
import { addItems, getCategory, listCategories, listItems } from "@/lib/bank/store";
import { itemFieldsSchema, QUESTION_TYPES, type ItemFilter } from "@/lib/bank/types";

type P = { id: string };

const list = (v: string | null) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

/** Search / filter / page the bank's questions. ?category=<id> resolves the category's members (manual, filter or style). */
export const GET = bankRoute<P>(async ({ req, owner, params }) => {
  const u = new URL(req.url);
  const q = u.searchParams;
  let items = listItems(owner, params.id);
  const categoryId = q.get("category");
  if (categoryId) items = categoryMembers(items, listCategories(owner, params.id), getCategory(owner, params.id, categoryId));
  const types = list(q.get("types"))?.filter((t): t is (typeof QUESTION_TYPES)[number] => (QUESTION_TYPES as readonly string[]).includes(t));
  const filter: ItemFilter = {
    query: q.get("q") ?? undefined,
    types,
    grades: list(q.get("grades")),
    knowledge_points: list(q.get("knowledge_points")),
    tags: list(q.get("tags")),
    difficulty_min: q.get("difficulty_min") ? Number(q.get("difficulty_min")) : undefined,
    difficulty_max: q.get("difficulty_max") ? Number(q.get("difficulty_max")) : undefined,
    origin: (q.get("origin") as ItemFilter["origin"]) ?? undefined,
  };
  items = filterItems(items, filter).sort((a, b) => b.created_at - a.created_at);
  const pageSize = Math.min(200, Math.max(1, Number(q.get("page_size") ?? 50)));
  const page = Math.max(1, Number(q.get("page") ?? 1));
  return { total: items.length, page, page_size: pageSize, items: items.slice((page - 1) * pageSize, page * pageSize) };
});

const addSchema = z.object({ items: z.array(itemFieldsSchema).min(1).max(200), category_id: z.string().optional() });

/** Add questions by hand (or from a solved problem: "加入题库"). */
export const POST = bankRoute<P>(async ({ req, owner, params }) => {
  const body = addSchema.parse(await jsonBody(req));
  if (body.category_id) getCategory(owner, params.id, body.category_id);
  const items = addItems(owner, params.id, body.items.map((fields) => ({ fields, origin: "manual" as const, category_ids: body.category_id ? [body.category_id] : [] })));
  return { items };
});
