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

type Question = Pick<ItemFields, "stem" | "type" | "options" | "answer" | "grade">;

const CLASSIFY_SYSTEM = `You catalogue math questions for a teacher's question bank. For each question decide:
- "path": where it belongs in the bank's catalogue (目录), top level first, 2 levels: [strand, topic] — e.g. ["Number", "Fractions"] or ["数与代数", "一元一次方程"]. Use a third level only for a clearly distinct sub-topic. REUSE an existing catalogue path (same spelling) whenever it fits; otherwise build the path from the strand and knowledge-point names given. Keep names short (1–4 words), no numbering.
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
const cleanName = (s: string) =>
  s
    .normalize("NFKC")
    .replace(/^[\s\d.、()（）\-–—#]+/, "") // leading numbering like "1." or "（一）"
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);

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

/** Snap model output to existing names (case/width-insensitive), so "fractions" reuses "Fractions". */
function snapPath(path: string[], existing: string[][]): string[] {
  const out: string[] = [];
  for (let i = 0; i < path.length; i++) {
    const want = norm(path[i]);
    const match = existing.find((p) => p.length > i && p.slice(0, i).every((x, k) => norm(x) === norm(out[k] ?? "")) && norm(p[i]) === want);
    out.push(match ? match[i] : path[i]);
  }
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
        const given = [q.grade ? `grade given: ${q.grade}` : ""].filter(Boolean).join("; ");
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
