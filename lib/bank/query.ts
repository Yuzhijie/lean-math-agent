/**
 * Filtering items and resolving what a category contains.
 */
import { createHash } from "node:crypto";
import type { Category, Item, ItemFilter } from "./types";
import { normaliseStem } from "./similarity";

export function matchesFilter(it: Item, f: ItemFilter): boolean {
  if (f.types?.length && !f.types.includes(it.type)) return false;
  if (f.grades?.length && (!it.grade || !f.grades.includes(it.grade))) return false;
  if (f.knowledge_points?.length && !f.knowledge_points.some((k) => it.knowledge_points.includes(k))) return false;
  if (f.tags?.length && !f.tags.every((t) => it.tags.includes(t))) return false;
  if (f.difficulty_min && (it.difficulty ?? 0) < f.difficulty_min) return false;
  if (f.difficulty_max && (it.difficulty ?? 99) > f.difficulty_max) return false;
  if (f.origin && it.origin !== f.origin) return false;
  if (f.category_id && !it.category_ids.includes(f.category_id)) return false;
  if (f.query?.trim()) {
    const q = normaliseStem(f.query);
    const hay = normaliseStem([it.stem, it.answer ?? "", it.knowledge_points.join(" "), it.tags.join(" "), it.source?.label ?? ""].join(" "));
    if (!hay.includes(q)) return false;
  }
  return true;
}

export function filterItems(items: Item[], f: ItemFilter): Item[] {
  return items.filter((it) => matchesFilter(it, f));
}

/** Category ids of `categoryId` and all its descendants. */
export function descendantIds(categories: Category[], categoryId: string): Set<string> {
  const out = new Set([categoryId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of categories) if (c.parent_id && out.has(c.parent_id) && !out.has(c.id)) (out.add(c.id), (grew = true));
  }
  return out;
}

/**
 * Items belonging to a category: manual → items assigned to it or to a
 * sub-category; filter → items matching the saved filter; style → none
 * (a style template describes questions without source items).
 */
export function categoryMembers(items: Item[], categories: Category[], category: Category): Item[] {
  if (category.kind === "style") return [];
  if (category.kind === "filter") return filterItems(items, category.filter ?? {});
  const ids = descendantIds(categories, category.id);
  return items.filter((it) => it.category_ids.some((c) => ids.has(c)));
}

/** Stable hash of a set of items' content, to tell whether a cached profile is stale. */
export function itemsHash(items: Item[]): string {
  const h = createHash("sha256");
  for (const it of [...items].sort((a, b) => a.id.localeCompare(b.id))) h.update(`${it.id}:${it.fingerprint}:${it.updated_at}\n`);
  return h.digest("hex").slice(0, 16);
}

/** Distinct values of a field across items, most common first (for filter pickers). */
export function facet(items: Item[], pick: (it: Item) => string | string[] | undefined): Array<{ value: string; count: number }> {
  const m = new Map<string, number>();
  for (const it of items) {
    const v = pick(it);
    for (const x of Array.isArray(v) ? v : v ? [v] : []) m.set(x, (m.get(x) ?? 0) + 1);
  }
  return [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}
