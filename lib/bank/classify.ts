/**
 * Model classification of bank questions: where a question belongs in the
 * category tree (目录), its grade, knowledge points, difficulty and — when
 * parsing could not tell — its question type.
 *
 * The model sees the questions (stem, options, answer), the bank's existing
 * category paths (to reuse them), and the knowledge-point vocabulary (the
 * bank's own first, then the built-in curriculum list, grouped by strand).
 * Its answer is validated and normalised here: paths are 1–3 short names,
 * existing categories are matched case-insensitively, knowledge points are
 * snapped to the vocabulary where they match, difficulty is clamped to 1–5.
 * A question the model skipped, or a chunk that failed, keeps its fields.
 */
import { z } from "zod";
import { chatJson } from "../llm/client";
import { lt } from "../llm/output-locale";
import { inBankLanguage } from "./profile";
import { describeItem } from "./profile";
import { builtinVocab } from "./vocab";
import { QUESTION_TYPES, type Bank, type Category, type ItemFields, type QuestionType } from "./types";

export interface Classification {
  category_path: string[];
  grade?: string;
  knowledge_points: string[];
  difficulty?: number;
  type?: QuestionType;
  reason?: string;
}

type Question = Pick<ItemFields, "stem" | "type" | "options" | "answer" | "grade"> & Partial<Pick<ItemFields, "tags" | "images" | "template_hint">>;

const CLASSIFY_SYSTEM = `You catalogue math questions for a teacher's question bank. For each question decide:
- "path": where it belongs in the bank's catalogue (目录), top level first, 2 levels: [strand, topic] — e.g. ["Number", "Fractions"] or ["数与代数", "一元一次方程"]. Use a third level only for a clearly distinct sub-topic. REUSE an existing catalogue path (same spelling) whenever it fits; otherwise build the path from the strand and knowledge-point names given. Keep names short (1–4 words), no numbering; keep names like "2D shapes" or "3D objects" as they are. Questions in one file usually belong to many different topics: decide each question on its own.
  Classify by the mathematics the student has to do, not by the objects in the story or picture: picking shapes from boxes and asking what is possible or impossible is chance, not shapes; a growing pattern of shapes is patterns; comparing heights read off a picture is measurement. When a question has "paper's category" (the strand the paper itself prints for it), the path's strand must agree with it (map it to the bank's strand names, e.g. "Chance & Data" → probability or statistics, "Measures & Units" → measurement).
- "grade": the school year the question suits, in the bank's style (e.g. "Year 4", "四年级", "初二"). Keep a grade that is already given.
- "knowledge_points": 1–3 knowledge points tested, taken from the vocabulary when one fits.
- "difficulty": 1–5 for students of that grade: 1 = one routine step; 2 = two steps or a familiar context; 3 = several steps, standard application; 4 = non-routine, needs insight or careful reasoning; 5 = competition-hard.
- "type": only if the given type is "other": one of ${QUESTION_TYPES.join(", ")}.
- "reason": one short sentence explaining the difficulty (Chinese).
Write catalogue names and knowledge points in the bank's language (Chinese for a Chinese bank, English for an English bank, the question's language for a mixed bank).
Return JSON only: {"items": [{"n": number, "path": string[], "grade": string, "knowledge_points": string[], "difficulty": number, "type"?: string, "reason": string}]} with one entry per question number.`;

const modelSchema = z.object({
  items: z.array(
    z.object({
      n: z.coerce.number().int(),
      path: z.array(z.string()).nullish(),
      grade: z.string().nullish(),
      knowledge_points: z.array(z.string()).nullish(),
      difficulty: z.coerce.number().nullish().catch(undefined),
      type: z.string().nullish(),
      reason: z.string().nullish(),
    }),
  ),
});

const norm = (s: string) => s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
/** Leading numbering ("1.", "2、", "(3)", "（一）", "一、", "#4", "- ") — but not a name like "2D shapes". */
const NUMBERING = /^\s*(?:[(（][0-9一二三四五六七八九十]+[)）]|[0-9一二三四五六七八九十]+\s*[.．、:：)）](?!\d)|#\d+|[-–—•·])\s*/;
const cleanName = (s: string) =>
  s
    .normalize("NFKC")
    .replace(NUMBERING, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);

/** Core of a name for near-duplicate matching: lower case, no bracketed part, no plural s, no "and"/"&". */
export const nameCore = (s: string) =>
  norm(s)
    .replace(/[(（][^)）]*[)）]/g, "")
    .replace(/\s*(?:&|and|和|与)\s*/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .split(" ")
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w))
    .join(" ");

/** The same name apart from case, plurals, "&"/"and" and a bracketed part ("Data displays" ~ "Data display (graphs and tables)"). */
function nearSame(a: string, b: string): boolean {
  const x = nameCore(a);
  return !!x && x === nameCore(b);
}

/** Category paths (names, top level first) of a bank's manual categories. */
export function categoryPaths(categories: Category[]): string[][] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const out: string[][] = [];
  for (const c of categories) {
    if (c.kind !== "manual") continue;
    const path: string[] = [];
    let cur: Category | undefined = c;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id) && path.length < 6) {
      seen.add(cur.id);
      path.unshift(cur.name);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    out.push(path);
  }
  return out;
}

/**
 * Snap model output to existing names, level by level: exactly (case/width-insensitive) first, then a
 * near-duplicate sibling ("Data displays" → existing "Data displays (graphs and tables)").
 */
function snapPath(path: string[], existing: string[][]): string[] {
  const out: string[] = [];
  for (let i = 0; i < path.length; i++) {
    const want = norm(path[i]);
    const siblings = existing.filter((p) => p.length > i && p.slice(0, i).every((x, k) => norm(x) === norm(out[k] ?? "")));
    const match = siblings.find((p) => norm(p[i]) === want) ?? siblings.find((p) => nearSame(p[i], path[i]));
    out.push(match ? match[i] : path[i]);
  }
  return out;
}

/**
 * New paths made in different chunks of one run can differ slightly ("Data displays" and "Data displays
 * (graphs and tables)" under the same strand): give them one name — the most used, then the longer.
 */
export function unifyNewPaths(results: Array<Classification | null>, existing: string[][]): void {
  const key = (p: string[]) => p.map(norm).join("\u0000");
  const known = new Set(existing.map((p) => key(p)));
  for (let level = 0; level < 3; level++) {
    const groups = new Map<string, Map<string, number>>(); // parent → name → count
    for (const r of results) {
      if (!r || r.category_path.length <= level) continue;
      const parent = key(r.category_path.slice(0, level));
      const names = groups.get(parent) ?? new Map<string, number>();
      names.set(r.category_path[level], (names.get(r.category_path[level]) ?? 0) + 1);
      groups.set(parent, names);
    }
    for (const [parent, names] of groups) {
      const list = [...names.entries()].sort((a, b) => {
        const ka = known.has(parent ? `${parent}\u0000${norm(a[0])}` : norm(a[0])) ? 1 : 0;
        const kb = known.has(parent ? `${parent}\u0000${norm(b[0])}` : norm(b[0])) ? 1 : 0;
        return kb - ka || b[1] - a[1] || b[0].length - a[0].length;
      });
      const rename = new Map<string, string>();
      list.forEach(([name], i) => {
        const target = list.slice(0, i).find(([other]) => !rename.has(other) && nearSame(other, name));
        if (target) rename.set(name, target[0]);
      });
      if (!rename.size) continue;
      for (const r of results) {
        if (!r || r.category_path.length <= level || key(r.category_path.slice(0, level)) !== parent) continue;
        const to = rename.get(r.category_path[level]);
        if (to) r.category_path = [...r.category_path.slice(0, level), to, ...r.category_path.slice(level + 1)];
      }
    }
  }
}

/** What else the classifier should know about a question: the paper's own category, its figures, its template note. */
function questionHints(q: Question): string[] {
  const out: string[] = [];
  const paperCats = (q.tags ?? []).filter((t) => /&| and |数与|图形|统计|概率|测量|代数|number|measure|space|geometry|chance|data|algebra|pattern|statistic|probab/i.test(t));
  if (paperCats.length) out.push(`paper's category: ${paperCats.join(", ")}`);
  const figs = (q.images ?? []).map((im) => im.caption?.trim()).filter(Boolean);
  if (figs.length) out.push(`figure: ${figs.join(" | ").slice(0, 500)}`);
  if (q.template_hint?.trim()) out.push(`note: ${q.template_hint.trim().slice(0, 300)}`);
  return out;
}

function snapPoints(points: string[], vocab: string[]): string[] {
  const byNorm = new Map(vocab.map((v) => [norm(v), v]));
  const out: string[] = [];
  for (const p of points) {
    const name = cleanName(p);
    if (!name) continue;
    const v = byNorm.get(norm(name)) ?? name;
    if (!out.includes(v)) out.push(v);
  }
  return out.slice(0, 3);
}

/** Validated, normalised classification from one model entry (null when unusable). */
export function normaliseClassification(
  raw: z.infer<typeof modelSchema>["items"][number],
  q: Question,
  ctx: { paths: string[][]; vocab: string[] },
): Classification | null {
  const path = (raw.path ?? []).map(cleanName).filter(Boolean).slice(0, 3);
  if (!path.length) return null;
  const difficulty = typeof raw.difficulty === "number" && Number.isFinite(raw.difficulty) ? Math.min(5, Math.max(1, Math.round(raw.difficulty))) : undefined;
  const type = q.type === "other" && raw.type && (QUESTION_TYPES as readonly string[]).includes(raw.type) && raw.type !== "other" ? (raw.type as QuestionType) : undefined;
  return {
    category_path: snapPath(path, ctx.paths),
    grade: q.grade?.trim() ? undefined : raw.grade?.trim().slice(0, 40) || undefined,
    knowledge_points: snapPoints(raw.knowledge_points ?? [], ctx.vocab),
    difficulty,
    type,
    reason: raw.reason?.trim().slice(0, 300) || undefined,
  };
}

function vocabText(bank: Pick<Bank, "vocab" | "language">): string {
  const lines: string[] = [];
  if (bank.vocab.length) lines.push(`Bank's own knowledge points: ${bank.vocab.slice(0, 300).join("; ")}`);
  for (const g of builtinVocab(bank.language)) lines.push(`${g.strand}: ${g.points.join("; ")}`);
  return lines.join("\n");
}

/**
 * Classify questions. Returns one entry per question (null where the model
 * gave nothing usable). Throws only when no model call succeeded at all.
 */
export async function classifyQuestions(
  questions: Question[],
  ctx: { bank: Pick<Bank, "vocab" | "language" | "pin_language">; categories: Category[] },
  opts: { batchSize?: number; concurrency?: number } = {},
): Promise<Array<Classification | null>> {
  const size = Math.max(1, opts.batchSize ?? 12);
  const limit = Math.max(1, opts.concurrency ?? 3);
  const paths = categoryPaths(ctx.categories);
  const vocab = [...ctx.bank.vocab, ...builtinVocab(ctx.bank.language).flatMap((g) => g.points)];
  const langNote = ctx.bank.language === "zh" ? "Chinese" : ctx.bank.language === "en" ? "English" : "mixed (use each question's language)";
  const header = [
    `Bank language: ${langNote}.`,
    paths.length ? `Existing catalogue paths (reuse when they fit):\n${paths.slice(0, 200).map((p) => `- ${p.join(" > ")}`).join("\n")}` : "The catalogue is empty: build it from the strands and knowledge points below.",
    `Knowledge-point vocabulary by strand:\n${vocabText(ctx.bank)}`,
  ].join("\n\n");

  const out: Array<Classification | null> = questions.map(() => null);
  const chunks: number[][] = [];
  for (let i = 0; i < questions.length; i += size) chunks.push(questions.slice(i, i + size).map((_, k) => i + k));
  let succeeded = 0;
  let lastError: unknown;

  const run = async (idx: number[]) => {
    const list = idx
      .map((i, k) => {
        const q = questions[i];
        const given = [q.grade ? `grade given: ${q.grade}` : "", ...questionHints(q)].filter(Boolean).join("; ");
        return describeItem({ stem: q.stem.slice(0, 2500), options: q.options, answer: q.answer, type: q.type }, k + 1) + (given ? `\n  (${given})` : "");
      })
      .join("\n\n");
    try {
      // Catalogue names follow the bank's language, not the UI language.
      const res = await inBankLanguage({ ...ctx.bank, pin_language: ctx.bank.language !== "mixed" }, () =>
        chatJson({ system: CLASSIFY_SYSTEM, user: `${header}\n\nQUESTIONS:\n\n${list}`, schema: modelSchema, schemaName: "BankClassification", temperature: 0.1 }),
      );
      succeeded++;
      for (const raw of res.items) {
        const k = raw.n - 1;
        if (k < 0 || k >= idx.length) continue;
        const i = idx[k];
        out[i] = normaliseClassification(raw, questions[i], { paths, vocab });
      }
    } catch (e) {
      lastError = e;
    }
  };
  for (let k = 0; k < chunks.length; k += limit) await Promise.all(chunks.slice(k, k + limit).map(run));
  if (!succeeded && chunks.length) throw lastError instanceof Error ? lastError : new Error(String(lastError));
  unifyNewPaths(out, paths);
  return out;
}

/**
 * Merge a classification into question fields. Values the file already had
 * (grade, difficulty, knowledge points) are kept unless `overwrite`; the
 * catalogue place and the "classified by model" mark are always set.
 */
export function applyClassification<T extends Partial<ItemFields>>(fields: T, c: Classification | null, overwrite = false): T {
  if (!c) return fields;
  const has = (v: unknown) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== "");
  return {
    ...fields,
    category_path: c.category_path,
    grade: overwrite || !has(fields.grade) ? (c.grade ?? fields.grade) : fields.grade,
    difficulty: overwrite || !has(fields.difficulty) ? (c.difficulty ?? fields.difficulty) : fields.difficulty,
    knowledge_points: overwrite || !has(fields.knowledge_points) ? (c.knowledge_points.length ? c.knowledge_points : (fields.knowledge_points ?? [])) : fields.knowledge_points,
    type: c.type ?? fields.type,
    classified: { by: "model" as const, reason: c.reason },
  };
}

/** Short status line for logs/UI. */
export const classifyFailedIssue = () => lt("模型分类失败，目录、难度需手动填写", "Model classification failed; fill in the category and difficulty by hand");
