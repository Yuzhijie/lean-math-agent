/**
 * Template profiles: what a class of questions has in common.
 *
 * A profile is derived from the member questions of a category (or from a
 * handful of selected questions): the programmatic part (type, option
 * count, grade, difficulty range, figure use, language, knowledge points)
 * is counted from the items; one model call adds a summary, the answer
 * form and how stems are worded. Profiles of manual / filter categories are
 * cached on the category and recomputed when the members change (hash of
 * ids, fingerprints and update times). Style templates need no source
 * questions: their profile is built from the template fields directly.
 */
import { z } from "zod";
import { chatJson } from "../llm/client";
import { lt, withOutputLocale } from "../llm/output-locale";
import { categoryMembers, itemsHash } from "./query";
import { stemSimilarity } from "./similarity";
import { BankError, getBank, getCategory, listCategories, listItems, putCategory } from "./store";
import { QUESTION_TYPES, type Bank, type Item, type QuestionType, type StyleTemplate, type TemplateProfile } from "./types";
import { vocabFor } from "./vocab";

export type ProfileBody = Omit<TemplateProfile, "items_hash" | "computed_at">;

/** Exemplars sent to the model when deriving a profile. */
const PROFILE_EXEMPLARS = 8;

// ── Small helpers (shared with generate.ts) ─────────────────────────

const clip = (s: string | undefined, n: number) => (s === undefined ? undefined : s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Most common values, most frequent first (ties: first seen). */
function ranked<T>(values: T[]): T[] {
  const m = new Map<T, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
}

const CJK = /[㐀-鿿豈-﫿]/g;
const LATIN_WORD = /[A-Za-z]{2,}/g;

/** "zh" when a text is mostly Chinese, "en" when mostly English words, undefined when empty. */
export function detectLanguage(text: string): "zh" | "en" | undefined {
  // Drop LaTeX (commands and math spans) before counting.
  const plain = text.replace(/\$[^$]*\$/g, " ").replace(/\\[A-Za-z]+/g, " ");
  const cjk = plain.match(CJK)?.length ?? 0;
  const words = plain.match(LATIN_WORD)?.length ?? 0;
  if (!cjk && !words) return undefined;
  // One Chinese character carries about as much as one English word; lean to zh.
  return cjk >= words * 0.5 ? "zh" : "en";
}

const FIGURE_WORDS = /如图|见图|下图|右图|左图|图中|图\s*\d|示意图|figure|diagram|shown below|pictured|the graph|the picture|grid below/i;

/** Whether a stem relies on a figure (images attached, or it refers to one). */
export function usesFigure(it: Pick<Item, "stem"> & { images?: Item["images"] }): boolean {
  return (it.images?.length ?? 0) > 0 || FIGURE_WORDS.test(it.stem);
}

/** Pinned bank language as an output locale for model calls, if any. */
export function pinnedLocale(bank: Pick<Bank, "pin_language" | "language">): "zh-CN" | "en-US" | undefined {
  if (!bank.pin_language) return undefined;
  return bank.language === "zh" ? "zh-CN" : bank.language === "en" ? "en-US" : undefined;
}

/** Run a model call in the bank's pinned language (or the request's). */
export function inBankLanguage<T>(bank: Pick<Bank, "pin_language" | "language">, fn: () => T): T {
  const loc = pinnedLocale(bank);
  return loc ? withOutputLocale(loc, fn) : fn();
}

const TYPE_NAMES: Record<QuestionType, [string, string]> = {
  multiple_choice: ["选择题", "multiple choice"],
  numeric: ["数值填空题", "numeric answer"],
  short_answer: ["简答题", "short answer"],
  proof: ["证明题", "proof"],
  other: ["其他题型", "other"],
};
export const typeName = (t: QuestionType) => lt(...TYPE_NAMES[t]);

// ── Exemplars ────────────────────────────────────────────────────────

/** Largest pool considered when picking exemplars (evenly spaced sample beyond that). */
const EXEMPLAR_POOL = 200;

/**
 * Pick `k` diverse items: greedy max-min over stem similarity — start from
 * the first item, then repeatedly take the item least similar to the ones
 * already chosen. Deterministic for a given input order. Items with an
 * answer are preferred when there are enough of them.
 */
export function pickExemplars(items: Item[], k = 5): Item[] {
  if (k <= 0 || !items.length) return [];
  const answered = items.filter((it) => it.answer?.trim());
  let pool = answered.length >= Math.min(k, items.length) ? answered : items;
  if (pool.length > EXEMPLAR_POOL) {
    const step = pool.length / EXEMPLAR_POOL;
    pool = Array.from({ length: EXEMPLAR_POOL }, (_, i) => pool[Math.floor(i * step)]);
  }
  if (pool.length <= k) return [...pool];
  const chosen = [pool[0]];
  // maxSim[i]: highest similarity of pool[i] to any chosen item.
  const maxSim = pool.map((it) => stemSimilarity(it.stem, pool[0].stem));
  const taken = new Set([0]);
  while (chosen.length < k) {
    let best = -1;
    for (let i = 0; i < pool.length; i++) {
      if (taken.has(i)) continue;
      if (best < 0 || maxSim[i] < maxSim[best]) best = i;
    }
    if (best < 0) break;
    taken.add(best);
    chosen.push(pool[best]);
    for (let i = 0; i < pool.length; i++) if (!taken.has(i)) maxSim[i] = Math.max(maxSim[i], stemSimilarity(pool[i].stem, pool[best].stem));
  }
  return chosen;
}

// ── Programmatic profile ────────────────────────────────────────────

function programmaticProfile(items: Item[]): Omit<ProfileBody, "summary"> {
  // Majority type; ties follow QUESTION_TYPES order.
  const count = (t: QuestionType) => items.filter((it) => it.type === t).length;
  const type = QUESTION_TYPES.reduce((best, t) => (count(t) > count(best) ? t : best), QUESTION_TYPES[0] as QuestionType);
  const optionCounts = items.filter((it) => it.type === "multiple_choice" && (it.options?.length ?? 0) >= 2).map((it) => it.options!.length);
  const option_count = type === "multiple_choice" ? ranked(optionCounts).find((n) => n >= 2 && n <= 8) : undefined;
  const grade = ranked(items.map((it) => it.grade?.trim()).filter((g): g is string => !!g))[0];
  const diffs = items.map((it) => it.difficulty).filter((d): d is number => typeof d === "number");
  const difficulty_range = diffs.length ? ([Math.min(...diffs), Math.max(...diffs)] as [number, number]) : undefined;
  const needs_figure = items.filter((it) => usesFigure(it)).length * 2 >= items.length;
  const declared = ranked(items.map((it) => it.language).filter((l): l is "zh" | "en" => !!l));
  const language = declared.length && items.every((it) => it.language) ? declared[0] : detectLanguage(items.map((it) => it.stem).join("\n"));
  const knowledge_points = ranked(items.flatMap((it) => it.knowledge_points.map((k) => k.trim()).filter(Boolean))).slice(0, 8);
  return {
    type,
    option_count,
    grade,
    difficulty_range,
    needs_figure,
    language,
    knowledge_points,
    exemplar_ids: pickExemplars(items, 5).map((it) => it.id),
  };
}

function plainSummary(p: Omit<ProfileBody, "summary">, n?: number): string {
  const parts = [
    p.grade,
    typeName(p.type) + (p.option_count ? lt(`（${p.option_count} 个选项）`, ` (${p.option_count} options)`) : ""),
    p.knowledge_points.length ? p.knowledge_points.slice(0, 5).join(lt("、", ", ")) : undefined,
    p.difficulty_range ? lt(`难度 ${p.difficulty_range[0]}–${p.difficulty_range[1]}`, `difficulty ${p.difficulty_range[0]}–${p.difficulty_range[1]}`) : undefined,
    p.needs_figure ? lt("含图形", "with figures") : undefined,
  ].filter(Boolean);
  if (n === undefined) return parts.join(lt("，", ", "));
  return lt(`${n} 道题：${parts.join("，")}`, `${n} questions: ${parts.join(", ")}`);
}

// ── Model part ──────────────────────────────────────────────────────

const PROFILE_SYSTEM = `You analyse a class of math questions from a teacher's question bank so that new questions of the same type can be written later.
Read the example questions and describe what they have in common. Return JSON only:
{"summary": string, "answer_form": string, "stem_structure": string, "knowledge_points": string[]}
- summary: 1–3 sentences naming the skill tested, the grade level and what makes these questions this type.
- answer_form: what an answer looks like (e.g. "one option letter; the options are whole numbers", "a number with unit cm²", "a simplified fraction").
- stem_structure: how the questions are worded and structured — typical real-world context, sentence pattern, units used, typical numeric ranges and number types, any figure or table, the number of steps needed.
- knowledge_points: up to 5 short knowledge-point names for the skill tested (prefer names from the given vocabulary when one fits).
Write Chinese for all text values.`;

const profileModelSchema = z.object({
  summary: z.string().min(1),
  answer_form: z.string().optional(),
  stem_structure: z.string().optional(),
  knowledge_points: z.array(z.string()).optional(),
});

export const LETTERS = "ABCDEFGHIJ";

export function describeItem(it: Pick<Item, "stem" | "options" | "answer" | "type">, n: number, withAnswer = true): string {
  const lines = [`[${n}] (${it.type}) ${it.stem.trim()}`];
  (it.options ?? []).forEach((o, i) => lines.push(`  ${LETTERS[i] ?? i + 1}. ${o}`));
  if (withAnswer && it.answer?.trim()) lines.push(`  Answer: ${it.answer.trim()}`);
  return lines.join("\n");
}

async function deriveWithFlag(items: Item[], opts: { vocab?: string[]; model?: boolean; bank?: Pick<Bank, "pin_language" | "language"> }): Promise<{ profile: ProfileBody; modelOk: boolean }> {
  if (!items.length) throw new BankError(lt("该分类下没有题目", "this category has no questions"), 400);
  const base = programmaticProfile(items);
  const fallback = { profile: { ...base, summary: clip(plainSummary(base, items.length), 2000)! }, modelOk: false };
  if (opts.model === false) return fallback;

  const exemplars = pickExemplars(items, PROFILE_EXEMPLARS);
  const vocab = (opts.vocab ?? []).slice(0, 300);
  const user = [
    `Counted from all ${items.length} questions: type ${base.type}` +
      (base.option_count ? `, ${base.option_count} options` : "") +
      (base.grade ? `, grade ${base.grade}` : "") +
      (base.difficulty_range ? `, difficulty ${base.difficulty_range[0]}–${base.difficulty_range[1]} (1–5)` : "") +
      (base.knowledge_points.length ? `, knowledge points: ${base.knowledge_points.join("; ")}` : "") +
      (base.needs_figure ? ", most use a figure" : ""),
    vocab.length ? `Knowledge-point vocabulary: ${vocab.join("; ")}` : "",
    `Example questions (${exemplars.length} of ${items.length}):`,
    exemplars.map((it, i) => describeItem({ ...it, stem: clip(it.stem, 1500)! }, i + 1)).join("\n\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
  try {
    const call = () => chatJson({ system: PROFILE_SYSTEM, user, schema: profileModelSchema, schemaName: "TemplateProfile", temperature: 0.2 });
    const r = opts.bank ? await inBankLanguage(opts.bank, call) : await call();
    const kps = base.knowledge_points.length ? base.knowledge_points : (r.knowledge_points ?? []).map((k) => clip(k.trim(), 80)!).filter(Boolean).slice(0, 5);
    return {
      profile: {
        ...base,
        knowledge_points: kps,
        summary: clip(r.summary.trim(), 2000)!,
        answer_form: clip(r.answer_form?.trim() || undefined, 300),
        stem_structure: clip(r.stem_structure?.trim() || undefined, 1000),
      },
      modelOk: true,
    };
  } catch {
    return fallback;
  }
}

/**
 * Derive a profile from items: counted fields plus one model call for the
 * summary, answer form and stem structure. When the model call fails the
 * counted fields are kept with a plain summary.
 */
export async function deriveProfile(items: Item[], opts?: { vocab?: string[]; model?: boolean; bank?: Pick<Bank, "pin_language" | "language"> }): Promise<ProfileBody> {
  return (await deriveWithFlag(items, opts ?? {})).profile;
}

/** Profile of a style template (no model call). */
export function styleProfile(style: StyleTemplate): ProfileBody {
  const option_count = style.type === "multiple_choice" ? (style.option_count ?? 4) : undefined;
  const base: Omit<ProfileBody, "summary"> = {
    type: style.type,
    option_count,
    grade: style.grade,
    difficulty_range: style.difficulty ? [style.difficulty, style.difficulty] : undefined,
    needs_figure: !!style.with_figure,
    language: style.language,
    knowledge_points: style.knowledge_points,
    exemplar_ids: [],
    answer_form:
      style.type === "multiple_choice"
        ? lt("一个选项字母", "one option letter")
        : style.type === "numeric"
          ? lt("一个数（必要时带单位）", "a number (with unit if needed)")
          : undefined,
    stem_structure: clip(style.notes?.trim() || undefined, 1000),
  };
  const summary = lt("风格模板：", "Style template: ") + plainSummary(base);
  return { ...base, summary: clip(style.notes?.trim() ? `${summary}${lt("。", ". ")}${style.notes.trim()}` : summary, 2000)! };
}

/**
 * Profile of a category. Manual / filter categories: derived from the
 * members and cached on the category until the members change (or
 * `refresh`). Style categories: built from the template, never cached.
 */
export async function getProfile(owner: string, bankId: string, categoryId: string, opts?: { refresh?: boolean }): Promise<TemplateProfile> {
  const bank = getBank(owner, bankId);
  const category = getCategory(owner, bankId, categoryId);
  if (category.kind === "style") {
    return { ...styleProfile(category.style ?? { type: "multiple_choice", knowledge_points: [] }), items_hash: "style", computed_at: Date.now() };
  }
  const members = categoryMembers(listItems(owner, bankId), listCategories(owner, bankId), category);
  if (!members.length) throw new BankError(lt("该分类下没有题目", "this category has no questions"), 400);
  const hash = itemsHash(members);
  if (!opts?.refresh && category.profile?.items_hash === hash) return category.profile;

  const { profile, modelOk } = await deriveWithFlag(members, { vocab: vocabFor(bank), model: bank.allow_model, bank });
  const full: TemplateProfile = { ...profile, items_hash: hash, computed_at: Date.now() };
  // Cache only a complete profile: a fallback (model failed or not allowed) is retried next time.
  if (modelOk) {
    const latest = getCategory(owner, bankId, categoryId);
    putCategory(owner, bankId, { ...latest, profile: full });
  }
  return full;
}
