/**
 * Choosing template questions by Level, Difficulty and Topic (the problem
 * generator's "local bank as template" mode).
 *
 * The topic is a category (with its sub-categories) or a knowledge point
 * and is never relaxed. When no question matches the level and difficulty
 * exactly, the difficulty is widened to ±1, then dropped, then the level is
 * dropped — and the caller is told which, so the UI can say so.
 */
import { z } from "zod";
import { lt } from "../llm/output-locale";
import { categoryMembers, facet } from "./query";
import type { Category, Item } from "./types";

export const templateSelectionSchema = z.object({
  /** Grade/level as stored on the bank's questions (e.g. "Year 4", "四年级"); omitted = any. */
  grade: z.string().max(40).optional(),
  /** 1–5; omitted = any. */
  difficulty: z.number().int().min(1).max(5).optional(),
  /** Topic: a category (incl. sub-categories) … */
  category_id: z.string().min(1).max(64).optional(),
  /** … or a knowledge point. Omitted both = the whole bank. */
  knowledge_point: z.string().max(80).optional(),
});
export type TemplateSelection = z.infer<typeof templateSelectionSchema>;

export type Relaxation = "difficulty_near" | "difficulty_any" | "grade_any";

export interface SelectedTemplate {
  items: Item[];
  relaxed: Relaxation[];
  /** "Year 4 · Number › Fractions · difficulty 2" */
  label: string;
}

const norm = (s: string) => s.normalize("NFKC").trim().toLowerCase();

/** Category name with its parents: "Number › Fractions". */
export function categoryPathName(c: Category, categories: Category[]): string {
  const names = [c.name];
  let parent = c.parent_id;
  for (let i = 0; parent && i < 6; i++) {
    const p = categories.find((x) => x.id === parent);
    if (!p) break;
    names.unshift(p.name);
    parent = p.parent_id;
  }
  return names.join(" › ");
}

export function selectionLabel(sel: TemplateSelection, categories: Category[]): string {
  const cat = sel.category_id ? categories.find((c) => c.id === sel.category_id) : undefined;
  const parts = [
    sel.grade,
    cat ? categoryPathName(cat, categories) : sel.knowledge_point,
    sel.difficulty ? lt(`难度 ${sel.difficulty}`, `difficulty ${sel.difficulty}`) : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : lt("整个题库", "whole bank");
}

/** Questions of the topic only (no level/difficulty filter). */
export function topicItems(items: Item[], categories: Category[], sel: TemplateSelection): Item[] {
  if (sel.category_id) {
    const cat = categories.find((c) => c.id === sel.category_id);
    return cat ? categoryMembers(items, categories, cat) : [];
  }
  if (sel.knowledge_point?.trim()) {
    const kp = norm(sel.knowledge_point);
    return items.filter((it) => it.knowledge_points.some((k) => norm(k) === kp));
  }
  return items;
}

/** Template questions for a selection, relaxing level/difficulty when nothing matches exactly. */
export function selectTemplateItems(items: Item[], categories: Category[], sel: TemplateSelection): SelectedTemplate {
  const label = selectionLabel(sel, categories);
  const pool = topicItems(items, categories, sel);
  const gradeOk = (it: Item) => !sel.grade || norm(it.grade ?? "") === norm(sel.grade);
  const diffOk = (it: Item, spread: number) => !sel.difficulty || (it.difficulty !== undefined && Math.abs(it.difficulty - sel.difficulty) <= spread);
  const steps: Array<{ relaxed: Relaxation[]; keep: (it: Item) => boolean }> = [
    { relaxed: [], keep: (it) => gradeOk(it) && diffOk(it, 0) },
    { relaxed: ["difficulty_near"], keep: (it) => gradeOk(it) && diffOk(it, 1) },
    { relaxed: ["difficulty_any"], keep: (it) => gradeOk(it) },
    { relaxed: ["difficulty_any", "grade_any"], keep: () => true },
  ];
  const tried = new Set<string>();
  for (const s of steps) {
    // Only relaxations of criteria that were actually set count; a step that relaxes nothing new is skipped.
    const relaxed = s.relaxed.filter((r) => (r.startsWith("difficulty") ? !!sel.difficulty : !!sel.grade));
    const key = relaxed.join(",");
    if (tried.has(key)) continue;
    tried.add(key);
    const picked = pool.filter(s.keep);
    if (picked.length) return { items: picked, relaxed, label };
  }
  return { items: [], relaxed: [], label };
}

/** Human-readable note about relaxed criteria. */
export function relaxationNote(sel: TemplateSelection, relaxed: Relaxation[], matched: number): string | undefined {
  if (!relaxed.length) return undefined;
  const bits: string[] = [];
  if (relaxed.includes("difficulty_near")) bits.push(lt(`没有难度 ${sel.difficulty} 的题，使用了难度 ${sel.difficulty! - 1}–${sel.difficulty! + 1} 的题作模板`, `no questions at difficulty ${sel.difficulty}; used difficulty ${sel.difficulty! - 1}–${sel.difficulty! + 1} as templates`));
  if (relaxed.includes("difficulty_any")) bits.push(lt("没有相近难度的题，模板不限难度", "no questions of a similar difficulty; templates of any difficulty were used"));
  if (relaxed.includes("grade_any")) bits.push(lt(`没有 ${sel.grade} 的题，模板不限年级`, `no ${sel.grade} questions; templates of any level were used`));
  return lt(`${bits.join("；")}（共 ${matched} 道）。新题仍按所选年级和难度出。`, `${bits.join("; ")} (${matched} questions). New questions still target the chosen level and difficulty.`);
}

/** Options for the generator's pickers: levels, topics and a compact index to count matches in the browser. */
export function templateOptions(items: Item[], categories: Category[]) {
  const usable = categories.filter((c) => c.kind !== "style");
  const topics = usable
    .map((c) => ({ id: c.id, path: categoryPathName(c, categories), parent_id: c.parent_id, count: categoryMembers(items, categories, c).length }))
    .filter((t) => t.count > 0)
    .sort((a, b) => a.path.localeCompare(b.path));
  // Category ids (incl. ancestors and matching filter categories) per item, for counting in the browser.
  const memberOf = new Map<string, string[]>();
  for (const t of topics) {
    const cat = categories.find((c) => c.id === t.id)!;
    for (const it of categoryMembers(items, categories, cat)) memberOf.set(it.id, [...(memberOf.get(it.id) ?? []), t.id]);
  }
  return {
    grades: facet(items, (it) => it.grade),
    knowledge_points: facet(items, (it) => it.knowledge_points),
    topics,
    index: items.map((it) => ({ g: it.grade ?? null, d: it.difficulty ?? null, c: memberOf.get(it.id) ?? [], k: it.knowledge_points })),
  };
}
