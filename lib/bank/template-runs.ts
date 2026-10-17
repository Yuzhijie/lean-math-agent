/**
 * Browser-side: the generation runs for what was picked as the template on the bank page.
 * A category is one template. Several picked questions are several templates: each question
 * is generated from on its own (its own run, its own candidates), so different kinds of
 * question are not blended into one template.
 */
import type { TemplateRef } from "./types";

/** At most this many picked questions are generated from at once (each is a separate run). */
export const MAX_TEMPLATE_RUNS = 10;

export type TemplateRun = {
  /** Stable key: the category or item id. */
  key: string;
  ref: TemplateRef;
  /** The picked question this run uses as its template (absent for a category). */
  itemId?: string;
};

export function templateRuns(t: { kind: "category"; categoryId: string } | { kind: "items"; itemIds: string[] }): TemplateRun[] {
  if (t.kind === "category") return [{ key: t.categoryId, ref: { category_id: t.categoryId } }];
  const ids = [...new Set(t.itemIds)].slice(0, MAX_TEMPLATE_RUNS);
  return ids.map((id) => ({ key: id, ref: { item_ids: [id] }, itemId: id }));
}
