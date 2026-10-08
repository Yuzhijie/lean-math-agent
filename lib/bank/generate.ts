/**
 * Same-type generation (同类创编): new original questions of the same
 * kind as a template — a category, a few selected questions, or a style
 * template.
 *
 * One model call writes ~1.5× the requested number of candidates from the
 * template's profile and a few exemplars. Every candidate is then checked:
 *   format   — programmatic (type, options, answer shape, length)
 *   answer   — an independent re-solve (the solver never sees the proposed
 *              answers) plus programmatic arithmetic where it applies
 *   novelty  — not too close to any bank question or earlier candidate
 *   fit      — a model judge scores fit with the profile (1–5, ≥ 3 passes)
 *   figure   — when the template has figures: each question comes with a
 *              figure spec the program draws in the template's style
 *              (lib/figure/visual.ts); the re-solve and the judge see an
 *              exact description of the drawn figure; a model-drawn SVG
 *              (fallback) is re-read by the vision model
 * Candidates are stored as a Generation; the user adopts the ones they want.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { chatJson } from "../llm/client";
import { lt } from "../llm/output-locale";
import { extractArithmetic, verifyAnswer } from "../llm/answer-verifier";
import type { GeneratedProblem } from "../types";
import { describeItem, detectLanguage, getProfile, inBankLanguage, LETTERS, pickExemplars, styleProfile, typeName, usesFigure, deriveProfile } from "./profile";
import { categoryMembers, itemsHash } from "./query";
import { relaxationNote, selectTemplateItems } from "./select";
import { StemIndex, TOO_CLOSE } from "./similarity";
import { addItems, BankError, getBank, getCategory, getGeneration, getItem, listCategories, listItems, putGeneration } from "./store";
import { QUESTION_TYPES, type Candidate, type Check, type Generation, type Item, type QuestionType, type TemplateProfile, type TemplateRef } from "./types";
import { vocabFor } from "./vocab";
import { buildVisual, DEFAULT_STYLE, SOLID_KINDS, VISUAL_GUIDE, visualSpecSchema, type FigureStyle } from "../figure/visual";
import { loadSharp } from "./import/images";
import { saveAsset } from "./store";
import { hasTemplateImages, readTemplateVisuals, type TemplateVisuals } from "./template-visual";
import type { CandidateFigure } from "./types";
import { tablesIn, withoutTables, type ParsedTable } from "../markdown-table";
import { allStarAngles, type StarSpec } from "../figure/star";
import { svgOverlaps } from "../figure/svg-overlap";

const MAX_COUNT = 10;
const EXEMPLARS = 5;
const JUDGE_PASS = 3;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const newId = () => randomUUID().replace(/-/g, "").slice(0, 20);

// ── Template resolution ─────────────────────────────────────────────

export async function resolveTemplate(
  owner: string,
  bankId: string,
  ref: TemplateRef,
): Promise<{ label: string; profile: TemplateProfile; exemplars: Item[]; note?: string; matched?: number }> {
  const bank = getBank(owner, bankId);
  if (ref.selection) {
    // Level / difficulty / topic from the problem generator: matching bank questions are the template.
    const sel = ref.selection;
    const categories = listCategories(owner, bankId);
    if (sel.category_id) getCategory(owner, bankId, sel.category_id);
    const { items, relaxed, label } = selectTemplateItems(listItems(owner, bankId), categories, sel);
    if (!items.length) {
      throw new BankError(lt(`题库中没有“${label}”的题目，请换一个主题或使用内置出题`, `The bank has no questions for "${label}"; choose another topic or use built-in generation`), 404);
    }
    const body = await deriveProfile(items, { vocab: vocabFor(bank), model: bank.allow_model, bank });
    // New questions target what was chosen, even when the templates had to be widened.
    const profile: TemplateProfile = {
      ...body,
      grade: sel.grade ?? body.grade,
      difficulty_range: sel.difficulty ? [sel.difficulty, sel.difficulty] : body.difficulty_range,
      items_hash: itemsHash(items),
      computed_at: Date.now(),
    };
    return { label, profile, exemplars: pickExemplars(items, EXEMPLARS), note: relaxationNote(sel, relaxed, items.length), matched: items.length };
  }
  if (ref.category_id) {
    const category = getCategory(owner, bankId, ref.category_id);
    const profile = await getProfile(owner, bankId, category.id);
    if (category.kind === "style") return { label: category.name, profile, exemplars: [] };
    const members = categoryMembers(listItems(owner, bankId), listCategories(owner, bankId), category);
    const byId = new Map(members.map((m) => [m.id, m]));
    const cached = profile.exemplar_ids.map((id) => byId.get(id)).filter((x): x is Item => !!x);
    const exemplars = cached.length >= Math.min(EXEMPLARS, members.length) ? cached.slice(0, EXEMPLARS) : pickExemplars(members, EXEMPLARS);
    return { label: category.name, profile, exemplars };
  }
  if (ref.item_ids?.length) {
    const ids = [...new Set(ref.item_ids)];
    if (ids.length > 10) throw new BankError(lt("最多选择 10 道题作为模板", "select at most 10 questions as a template"), 400);
    const items = ids.map((id) => getItem(owner, bankId, id));
    const body = await deriveProfile(items, { vocab: vocabFor(bank), model: bank.allow_model, bank });
    return {
      label: lt(`${items.length} 道选中的题目`, `${items.length} selected question${items.length === 1 ? "" : "s"}`),
      profile: { ...body, items_hash: itemsHash(items), computed_at: Date.now() },
      exemplars: items,
    };
  }
  if (ref.style) {
    return { label: lt("风格模板", "style template"), profile: { ...styleProfile(ref.style), items_hash: "style", computed_at: Date.now() }, exemplars: [] };
  }
  throw new BankError(lt("请选择一个分类、若干题目或风格模板", "choose a category, some questions or a style template"), 400);
}

// ── Answers ─────────────────────────────────────────────────────────

/**
 * Numeric value of an answer: "12", "12 cm", "$12$", "1/2", "\frac{1}{2}",
 * "0.5", "-3", "1 1/2", "x = 4", "1,200", "50%" (→ 50). Null when the
 * answer is not a single number (optionally followed by a unit).
 */
export function parseNumber(answer: string): number | null {
  let s = answer
    .normalize("NFKC")
    .replace(/\$/g, "")
    .replace(/\\[dt]?frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, "($1)/($2)")
    .replace(/\\(?:,|;|!| |quad|text\s*\{([^{}]*)\}|mathrm\s*\{([^{}]*)\})/g, (_m, a?: string, b?: string) => ` ${a ?? b ?? ""} `)
    .replace(/[−–]/g, "-")
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .trim();
  s = s.replace(/^(?:答案|答|结果|解|answer|ans)\s*[:：]?\s*/i, "").replace(/^[a-z]\s*=\s*/i, "").trim();
  // Simple parenthesised fraction from \frac: (a)/(b) with plain numbers.
  s = s.replace(/^\((-?\d+(?:\.\d+)?)\)\/\((-?\d+(?:\.\d+)?)\)/, "$1/$2");
  const m = s.match(/^(-?\d*\.?\d+)(?:\s+(\d+)\s*\/\s*(\d+)|\s*\/\s*(-?\d*\.?\d+))?/);
  if (!m) return null;
  const rest = s
    .slice(m[0].length)
    .replace(/\^\s*\{?\s*\d\s*\}?|[²³]/g, "")
    .trim();
  // Anything left must be a unit (letters, CJK, %, °), not more numbers or operators.
  if (rest && (/\d/.test(rest) || /^[+\-*/×÷=^]/.test(rest))) return null;
  let v = Number(m[1]);
  if (m[2] && m[3]) v = (v < 0 ? -1 : 1) * (Math.abs(v) + Number(m[2]) / Number(m[3]));
  else if (m[4]) v = v / Number(m[4]);
  return Number.isFinite(v) ? v : null;
}

function sameNumber(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** Option letter in an answer ("B", "(B)", "B. 12", "选B"), or null. */
function answerLetter(answer: string, optionCount: number): string | null {
  const s = answer.normalize("NFKC").trim().replace(/^(?:答案|答|选|answer|option)\s*[:：]?\s*/i, "");
  const m = s.match(/^\(?([A-Ja-j])\)?(?=$|[\s.、:：)．,，])/);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  return LETTERS.indexOf(letter) < optionCount ? letter : null;
}

/** "Select all …" questions: several options can be correct; the answer is a set of letters ("A, D"). */
const SELECT_ALL = /\b(?:select|choose|tick|circle|colou?r|mark|pick) all\b|\ball (?:of )?the (?:items|options|answers|ones|cards|shapes|numbers) (?:that|which)\b|选出所有|全部选出|所有(?:正确|符合)|多选|哪几(?:个|项|种|样)/i;

export function isSelectAll(stem: string): boolean {
  return SELECT_ALL.test(stem);
}

/** All option letters an answer names ("A, D", "A and D", "A、D", "AD"), sorted; null if it is not a list of letters. */
export function answerLetters(answer: string, optionCount: number): string[] | null {
  const s = answer
    .normalize("NFKC")
    .trim()
    .replace(/^(?:答案|答|选|answers?|options?)\s*[:：]?\s*/i, "")
    .replace(/\b(?:and|or)\b|和|与|及/gi, ",")
    .replace(/[()（）.]/g, " ")
    .trim();
  if (!/^[A-Ja-j](?:[\s,，、;；&/+]*[A-Ja-j])*$/.test(s)) return null;
  const letters = [...new Set(s.toUpperCase().match(/[A-J]/g) ?? [])].sort();
  return letters.length && letters.every((l) => LETTERS.indexOf(l) < optionCount) ? letters : null;
}

/** Letters an answer names: letters, or option texts (one or several, separated by commas / "and"). */
function resolveLetters(answer: string, options: string[]): string[] | null {
  const direct = answerLetters(answer, options.length);
  if (direct) return direct;
  const parts = answer.split(/\s*(?:,|，|、|;|；|\band\b|和|与)\s*/i).filter(Boolean);
  const letters = parts.map((p) => resolveLetter(p, options));
  return letters.length && letters.every(Boolean) ? [...new Set(letters as string[])].sort() : null;
}

/** Letter of the option an answer names: its letter, or an option text it equals. */
function resolveLetter(answer: string, options: string[]): string | null {
  const l = answerLetter(answer, options.length);
  if (l) return l;
  const norm = (x: string) => x.normalize("NFKC").replace(/\$|\s/g, "").toLowerCase();
  const idx = options.findIndex((o) => norm(o) === norm(answer));
  if (idx >= 0) return LETTERS[idx];
  const n = parseNumber(answer);
  if (n !== null) {
    const hits = options.map((o, i) => [parseNumber(o), i] as const).filter(([v]) => v !== null && sameNumber(v, n));
    if (hits.length === 1) return LETTERS[hits[0][1]];
  }
  return null;
}

/**
 * When the stem is a bare computation (a single $…$ span that is an
 * arithmetic expression, optionally "= ?"), the expression the programmatic
 * verifier would evaluate. Word problems return null: the verifier's
 * "first a op b in the text" heuristic is only reliable for bare sums.
 */
function bareArithmetic(stem: string): string | null {
  const spans = [...stem.matchAll(/\$([^$]+)\$/g)].map((m) => m[1]);
  if (spans.length !== 1) return null;
  const span = spans[0].replace(/=\s*(?:\?|？|\\square|\\_+|_+|\\boxed\{\s*\})?\s*$/, "");
  const expr = extractArithmetic(`$${span}$`);
  if (!expr) return null;
  const whole = span
    .replace(/\\times|\\cdot/g, "*")
    .replace(/\\div/g, "/")
    .replace(/[×✕✖·⋅]/g, "*")
    .replace(/÷/g, "/")
    .replace(/[,，\s]/g, "");
  return whole === expr ? expr : null;
}

// ── Model calls ─────────────────────────────────────────────────────

const GENERATE_SYSTEM = `You write new original math questions for a teacher's question bank, of the same type as a class of existing questions (同类创编).
Match the profile exactly: same question type, same skill and knowledge points, same grade and difficulty, same answer form and the same way of wording and structuring the stem.
The example questions show the type only — do NOT copy them. Every question you write needs a new context, new numbers and new wording, while testing the same skill at the same difficulty. The questions must also differ from each other.
Rules:
- Multiple choice: exactly the required number of options, all different, exactly one correct; "options" holds the option texts without letters; "answer" is only the letter of the correct option (A, B, C, …). Wrong options should be plausible (typical mistakes).
- "Select all" questions (the examples ask to select / tick all that apply): "answer" lists every correct letter, e.g. "A, D". That set must be the ONLY one that works: check every other combination of the options (e.g. other items that add up to the same total) and change the numbers until exactly one set fits.
- Numeric: "answer" is a single number, with a unit if the question needs one (e.g. "12 cm"); fractions as a/b.
- Use $...$ for inline LaTeX math.
- Each question is self-contained and well-posed, with exactly one correct answer; check the answer by solving it yourself in "solution".
- Never refer to a figure, table or picture that is not there. If the profile needs a figure, describe the figure precisely in words in the stem (shapes, labels, lengths, positions) so that it can be drawn from the text.
Write Chinese for stems, options, solutions and hints.
Return JSON only: {"questions": [{"stem": string, "type": "multiple_choice"|"numeric"|"short_answer"|"proof"|"other", "options"?: string[], "answer": string, "solution": string, "hints"?: string[], "difficulty"?: 1-5, "knowledge_points"?: string[]}]}`;

const FIGURE_RULE = "- Never refer to a figure, table or picture that is not there. If the profile needs a figure, describe the figure precisely in words in the stem (shapes, labels, lengths, positions) so that it can be drawn from the text.";
const FIGURE_RULE_WITH_SPECS =
  '- Questions with a figure: put it in "figure" as a figure spec (see FIGURES below); the program draws it in the template\'s style. The stem refers to the figure the way the examples do and must not repeat information that only the figure should give. Copy the layout of the examples\' figures (e.g. the same number of cards with the same kind of picture), never their pictures, logos or brand names.';

const FIGURE_CHECK_SYSTEM = `You check a figure drawn for a maths question. You get the question, the description the figure should match, and the figure image.
Say whether the image shows exactly what the description says (every number, label, time, value and shape) and whether it fits the question. It also fails when anything covers something else (a shape drawn over a face, a figure, a label or text), when text is cut off or overlaps other text, or when part of the drawing runs outside the picture. List concrete problems.
Return JSON only: {"ok": true|false, "problems": "…"}`;

const RESOLVE_SYSTEM = `You solve math questions independently and carefully. For each question, work it out and give only the final answer.
- Multiple choice: the letter of the correct option (A, B, C, …).
- "Select all" questions: every correct letter, e.g. "A, D". If more than one different set of options fits, answer "unsolvable".
- Numeric: the number, with a unit if the question asks for one.
- If a question is ambiguous, has no correct option or cannot be solved, answer "unsolvable".
Return JSON only: {"answers": [{"n": number, "answer": string}]} with one entry per question number.`;

const JUDGE_SYSTEM = `You review generated math questions against the profile of the question type they should belong to.
Score each question 1–5 for fit: 5 = clearly the same type (same skill, knowledge points, grade, difficulty, answer form, stem style); 3 = acceptable; 1 = a different kind of question, wrong difficulty or grade, or badly posed.
Give a short reason (one sentence, Chinese).
Return JSON only: {"scores": [{"n": number, "score": 1-5, "reason": string}]} with one entry per question number.`;

const str = z.union([z.string(), z.number()]).transform((v) => String(v));
const generatedSchema = z.object({
  questions: z
    .array(
      z.object({
        stem: z.string().min(1),
        type: z.string().optional(),
        options: z.array(str).optional().nullable(),
        answer: str,
        solution: z.string().optional().nullable(),
        hints: z.array(z.string()).optional().nullable(),
        difficulty: z.coerce.number().optional().nullable().catch(undefined),
        knowledge_points: z.array(z.string()).optional().nullable(),
        figure: z.unknown().optional().nullable(),
      }),
    )
    .min(1),
});
const resolveSchema = z.object({ answers: z.array(z.object({ n: z.coerce.number(), answer: str })) });
const judgeSchema = z.object({ scores: z.array(z.object({ n: z.coerce.number(), score: z.coerce.number(), reason: z.string().optional().default("") })) });

/** How the template's figures are to be handled in this generation. */
interface FigurePlan {
  /** New questions get figure specs drawn by the program. */
  on: boolean;
  style: FigureStyle;
  kinds: string[];
  layout?: string;
  /** The template questions show a table: every new question must have one (a drawn table). */
  tables: boolean;
  /** Shape of the template's table, as a hint (columns, rows). */
  tableHint?: string;
  /** The template questions show 3D figures: every new question must have one, of these kinds. */
  solids: string[];
}

const SOLID_KIND_SET = new Set<string>(SOLID_KINDS);

/** 3D figure kinds the template uses: from the vision model's reading, or the captions given to figures at import ("cube_stack: …"). */
export function templateSolids(exemplars: Pick<Item, "images">[], visualKinds: string[]): string[] {
  const kinds = new Set(visualKinds.filter((k) => SOLID_KIND_SET.has(k)));
  const captioned = exemplars.map((e) => e.images.map((im) => /^\s*(cube_stack|solid)\s*:/i.exec(im.caption ?? "")?.[1]?.toLowerCase()).find(Boolean));
  if (captioned.filter(Boolean).length * 2 >= exemplars.length && exemplars.length) for (const k of captioned) if (k) kinds.add(k);
  return [...kinds];
}

/** Kinds of figure in a spec (cards included). */
function figureKinds(spec: unknown): string[] {
  const s = spec as { kind?: string; cards?: Array<{ figure?: { kind?: string } }> } | undefined;
  if (!s?.kind) return [];
  return s.kind === "cards" ? (s.cards ?? []).map((c) => c.figure?.kind ?? "").filter(Boolean) : [s.kind];
}

/** Whether most template questions have a table (in their text, or as the figure the vision model saw). */
export function templateTables(exemplars: Pick<Item, "stem">[], itemKinds: string[]): { required: boolean; hint?: string } {
  const withTable = exemplars.map((e) => tablesIn(e.stem)[0]).filter((t): t is ParsedTable => !!t);
  // From the figures: only when most of them are tables (a card sheet with prices is not a table).
  const required = withTable.length > 0 ? withTable.length * 2 >= exemplars.length : itemKinds.length > 0 && itemKinds.filter((k) => k === "table").length * 2 >= itemKinds.length;
  const t = withTable[0];
  const hint = t ? `${t.headers.length} columns (${t.headers.map((h) => `"${h}"`).join(", ")}), ${t.rows.length} rows` : undefined;
  return { required, hint };
}

/** A figure spec contains a table (on its own or on a card). */
function hasTableFigure(spec: unknown): boolean {
  const s = spec as { kind?: string; cards?: Array<{ figure?: { kind?: string } }> } | undefined;
  return s?.kind === "table" || (s?.kind === "cards" && !!s.cards?.some((c) => c.figure?.kind === "table"));
}

/** Notes on the template questions as templates (template_hint: the vision model's analysis, possibly edited), distinct, at most 3. */
export function templateHints(items: Pick<Item, "template_hint">[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const h = it.template_hint?.trim();
    if (!h || seen.has(h)) continue;
    seen.add(h);
    out.push(h.slice(0, 1000));
    if (out.length === 3) break;
  }
  return out;
}

function hintsText(hints: string[]): string {
  return hints.length
    ? `TEMPLATE NOTES — how these template questions work (from analysing the original pages; the teacher may have edited them). Follow them for structure, figure/table role and number range; they never override the rules:\n${hints.map((h) => `- ${h.replace(/\s+/g, " ")}`).join("\n")}`
    : "";
}

function profileText(p: TemplateProfile, figures?: FigurePlan, hints: string[] = []): string {
  const lines = [
    `Summary: ${p.summary}`,
    `Question type: ${p.type}${p.option_count ? ` with exactly ${p.option_count} options` : ""}`,
    p.grade ? `Grade: ${p.grade}` : "",
    p.difficulty_range ? `Difficulty (1–5): ${p.difficulty_range[0] === p.difficulty_range[1] ? p.difficulty_range[0] : `${p.difficulty_range[0]}–${p.difficulty_range[1]}`}` : "",
    p.answer_form ? `Answer form: ${p.answer_form}` : "",
    p.stem_structure ? `Stem structure: ${p.stem_structure}` : "",
    p.knowledge_points.length ? `Knowledge points: ${p.knowledge_points.join("; ")}` : "",
    figures?.on
      ? `Figure: these questions come with a figure${figures.kinds.length ? ` (kinds: ${figures.kinds.join(", ")})` : ""}${figures.layout ? `; layout: ${figures.layout}` : ""}. Give each new question a figure of the same kind and layout in "figure"${figures.kinds.length && !figures.tables && !figures.kinds.includes("table") ? ` — keep the examples' kind (${figures.kinds.join(", ")}); do not turn it into a table or a sentence` : ""}.${
          figures.tables
            ? ` TABLE: the example questions present their data in a table${figures.tableHint ? ` (e.g. ${figures.tableHint})` : ""}. Every new question MUST include a table of the same kind — new data, same layout — as "figure": {"kind":"table",…} (or a table on a card); do not write the table in the stem and do not replace it by a sentence.`
            : ""
        }${
          figures.solids.length
            ? ` 3D: the example questions show 3D figures. Every new question MUST include a program-drawn 3D figure with the same layout and the same views (new numbers/arrangement); never describe the solid in words instead of drawing it. Use {"kind":"cube_stack",…} for anything built from blocks — cube stacks, steps, buildings (plain blocks: "unit_lines": false; a curved, sloping or pointed piece on top: "caps"; front/side/top plans: "views") — and {"kind":"solid",…} for a single solid. When the examples give plans (views) and ask which 3D drawing matches, use "cards": the first card a cube_stack with "show_stack": false and the views, then one card per option (labels A, B, C, D), each a cube_stack drawing of a different solid; exactly one option matches the plans.`
            : ""
        }`
      : p.needs_figure
        ? "Figure: these questions use a figure — describe it precisely in words in the stem."
        : "Figure: none — do not refer to any figure.",
    p.language ? `Source questions are written in ${p.language === "zh" ? "Chinese" : "English"}.` : "",
  ];
  lines.push(hintsText(hints));
  return lines.filter(Boolean).join("\n");
}

const LETTER_PREFIX = /^\s*\(?[A-Ja-j]\s*[.．、:：)]\s*/;

function toType(t: string | undefined, fallback: QuestionType): QuestionType {
  const v = (t ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (QUESTION_TYPES as readonly string[]).includes(v) ? (v as QuestionType) : fallback;
}

type Draft = Omit<Candidate, "checks" | "passed" | "adopted_item_id"> & { figureIssue?: string; figureRaw?: unknown };

/** The value at a Zod issue path, for error messages ("got …"). */
function valueAt(raw: unknown, path: Array<string | number>): unknown {
  let v: unknown = raw;
  for (const k of path) v = v && typeof v === "object" ? (v as Record<string | number, unknown>)[k] : undefined;
  return v;
}

/** Draw a question's figure spec; an unusable spec becomes `figureIssue`. */
function drawFigure(raw: unknown, style: FigureStyle): { figure?: CandidateFigure; figureIssue?: string } {
  if (raw === undefined || raw === null) return {};
  const parsed = visualSpecSchema.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    const got = i ? valueAt(raw, i.path) : undefined;
    const gotText = got === undefined ? "" : ` (got ${clip(JSON.stringify(got), 80)})`;
    return { figureIssue: lt(`图形描述无效：${i?.path.join(".")} ${i?.message}${gotText}`, `invalid figure spec: ${i?.path.join(".")} ${i?.message}${gotText}`) };
  }
  try {
    const v = buildVisual(parsed.data, style);
    return { figure: { spec: parsed.data, svg: v.svg, description: v.description, source: v.source, verified: v.verified }, ...(v.issues.length ? { figureIssue: v.issues.join(lt("；", "; ")) } : {}) };
  } catch (e) {
    return { figureIssue: lt(`无法绘制图形：${errText(e)}`, `the figure could not be drawn: ${errText(e)}`) };
  }
}

/** The question as a solver or judge sees it: stem plus the exact description of its figure. */
function withFigureText<T extends { stem: string; figure?: CandidateFigure }>(d: T): T {
  return d.figure ? { ...d, stem: `${d.stem}\n[Figure: ${d.figure.description}]` } : d;
}

function toDraft(q: z.infer<typeof generatedSchema>["questions"][number], p: TemplateProfile, style: FigureStyle = DEFAULT_STYLE): Draft {
  const type = toType(q.type ?? undefined, p.type);
  const options = q.options?.length ? q.options.map((o) => o.replace(LETTER_PREFIX, "").trim()) : undefined;
  let answer = q.answer.trim();
  if (type === "multiple_choice" && options) {
    const many = isSelectAll(q.stem) ? resolveLetters(answer, options) : null;
    answer = many ? many.join(", ") : (answerLetter(answer, 26) ?? answer);
  }
  const d = typeof q.difficulty === "number" && Number.isFinite(q.difficulty) ? Math.min(5, Math.max(1, Math.round(q.difficulty))) : undefined;
  const kps = (q.knowledge_points ?? []).map((k) => k.trim()).filter(Boolean);
  // A table written into the stem becomes a drawn table (when the question has no other figure).
  let stem = q.stem.trim();
  let figureSpec = q.figure;
  const stemTable = tablesIn(stem)[0];
  if (stemTable && (figureSpec === undefined || figureSpec === null)) {
    figureSpec = { kind: "table", headers: stemTable.headers, rows: stemTable.rows };
    stem = withoutTables(stem);
  }
  return {
    id: newId(),
    stem,
    type,
    options,
    answer,
    solution: q.solution?.trim() || undefined,
    hints: (q.hints ?? []).map((h) => h.trim()).filter(Boolean),
    grade: p.grade,
    difficulty: d ?? (p.difficulty_range ? Math.round((p.difficulty_range[0] + p.difficulty_range[1]) / 2) : undefined),
    knowledge_points: (kps.length ? kps : p.knowledge_points).slice(0, 20),
    ...drawFigure(figureSpec, style),
    ...(figureSpec !== undefined && figureSpec !== null ? { figureRaw: figureSpec } : {}),
  };
}

const FIGURE_FIX_SYSTEM = `You fix the figure specs of generated maths questions. Each question below either has a figure spec the program could not use (the error is given) or is missing a figure that questions of this type must have.
For each question return a corrected "figure" that follows the FIGURES guide exactly (only the kinds and fields listed there), shows exactly what the question and its answer need, and keeps the same intent as the original spec. Do not change the question.
Return JSON only: {"fixes":[{"n":1,"figure":{…}}]}`;

/** One repair round for figures the program could not draw, or that a required kind is missing from. */
async function repairFigures(drafts: Draft[], figures: FigurePlan, inLang: <T>(fn: () => Promise<T>) => Promise<T>, svgChecks = new Map<number, Check>()): Promise<number[]> {
  const needs = (d: Draft, i: number): string | undefined => {
    if (d.figureIssue && !d.figure) return d.figureIssue;
    const svg = svgChecks.get(i);
    if (svg && !svg.ok && !svg.skipped) return `${svg.detail} — draw it with a program kind from the guide if one fits (e.g. "star" for a star cut into pieces, "speech" for someone saying something), not "svg"; if "svg" is the only way, make sure nothing covers anything else`;
    const angles = d.figure?.source === "program" ? angleCheck(d) : null;
    if (angles && !angles.ok) return `${angles.detail} — change the figure's numbers so that they match the question`;
    if (figures.solids.length && !figureKinds(d.figure?.spec).some((k) => SOLID_KIND_SET.has(k))) return `a 3D figure (${figures.solids.join(" or ")}) is required`;
    if (figures.tables && !hasTableFigure(d.figure?.spec) && !tablesIn(d.stem).length) return "a table figure is required";
    return undefined;
  };
  const todo = drafts.map((d, i) => ({ d, i, why: needs(d, i) })).filter((x) => x.why);
  if (!todo.length) return [];
  let res: { fixes: Array<{ n: number; figure?: unknown }> };
  try {
    res = await inLang(() =>
      chatJson({
        system: `${FIGURE_FIX_SYSTEM}\n\n${VISUAL_GUIDE}`,
        user: todo
          .map(({ d, i, why }) => `${describeItem(d, i + 1, true)}\nProblem: ${why}${d.figureRaw !== undefined ? `\nSpec given: ${clip(JSON.stringify(d.figureRaw), 4000)}` : ""}`)
          .join("\n\n"),
        schema: z.object({ fixes: z.array(z.object({ n: z.coerce.number(), figure: z.unknown().optional() })).default([]) }),
        schemaName: "FigureFixes",
        temperature: 0,
        noCache: true,
        maxTokens: 8000,
      }),
    );
  } catch {
    return [];
  }
  const fixed: number[] = [];
  for (const f of res.fixes) {
    const d = drafts[Math.round(f.n) - 1];
    if (!d || !todo.some((t) => t.d === d) || f.figure === undefined || f.figure === null) continue;
    const drawn = drawFigure(f.figure, figures.style);
    if (!drawn.figure) continue;
    d.figure = drawn.figure;
    d.figureIssue = drawn.figureIssue;
    d.figureRaw = f.figure;
    fixed.push(drafts.indexOf(d));
  }
  return fixed;
}

// ── Checks ──────────────────────────────────────────────────────────

const check = (ok: boolean, detail: string, skipped?: boolean): Check => ({ ok, detail: clip(detail, 1000), ...(skipped ? { skipped: true } : {}) });

export function formatCheck(c: Draft, p: TemplateProfile): Check {
  const issues: string[] = [];
  if (c.type !== p.type) issues.push(lt(`题型为${typeName(c.type)}，应为${typeName(p.type)}`, `type is ${typeName(c.type)}, expected ${typeName(p.type)}`));
  if ([...c.stem.replace(/\s+/g, "")].length < 8) issues.push(lt("题干过短", "stem is too short"));
  if (!c.answer.trim()) issues.push(lt("缺少答案", "no answer"));
  if (c.type === "multiple_choice") {
    const opts = c.options ?? [];
    if (opts.length < 2) issues.push(lt("选项不足", "too few options"));
    else if (p.option_count && opts.length !== p.option_count) issues.push(lt(`有 ${opts.length} 个选项，应为 ${p.option_count} 个`, `${opts.length} options, expected ${p.option_count}`));
    const norm = opts.map((o) => o.normalize("NFKC").replace(/\s+/g, "").toLowerCase());
    if (opts.some((o) => !o.trim())) issues.push(lt("有空选项", "an option is empty"));
    else if (new Set(norm).size !== norm.length) issues.push(lt("选项有重复", "options are not distinct"));
    const multi = isSelectAll(c.stem);
    const letters = c.answer.trim() ? (multi ? answerLetters(c.answer, 10) : /^[A-J]$/.test(c.answer.trim()) ? [c.answer.trim()] : null) : [];
    if (c.answer.trim() && !letters) issues.push(multi ? lt(`答案“${c.answer}”不是选项字母（可多个，如 A, D）`, `answer "${c.answer}" is not a list of option letters (e.g. A, D)`) : lt(`答案“${c.answer}”不是选项字母`, `answer "${c.answer}" is not an option letter`));
    else if (letters?.some((l) => LETTERS.indexOf(l) >= opts.length)) issues.push(lt(`答案 ${c.answer} 超出选项范围`, `answer ${c.answer} is not one of the options`));
  } else if (c.type === "numeric") {
    if (c.answer.trim() && parseNumber(c.answer) === null) issues.push(lt(`答案“${c.answer}”不是一个数`, `answer "${c.answer}" is not a number`));
  }
  if (!p.needs_figure && !c.figure && usesFigure({ stem: c.stem })) issues.push(lt("题干引用了不存在的图", "the stem refers to a figure that is not there"));
  return issues.length ? check(false, issues.join(lt("；", "; "))) : check(true, lt("格式正确", "format ok"));
}

/** Compare the proposed answer with the independent one (null → cannot compare). */
function compareAnswers(c: Draft, independent: string): { same: boolean; comparable: boolean } {
  if (/^\s*unsolvable\s*$/i.test(independent)) return { same: false, comparable: true };
  if (c.type === "multiple_choice" && isSelectAll(c.stem)) {
    const mine = answerLetters(c.answer, c.options?.length ?? 0);
    const theirs = resolveLetters(independent, c.options ?? []);
    if (!mine || !theirs) return { same: false, comparable: !!mine };
    return { same: mine.join(",") === theirs.join(","), comparable: true };
  }
  if (c.type === "multiple_choice") {
    const mine = answerLetter(c.answer, c.options?.length ?? 0);
    const theirs = resolveLetter(independent, c.options ?? []);
    if (!mine || !theirs) return { same: false, comparable: !!mine };
    return { same: mine === theirs, comparable: true };
  }
  const a = parseNumber(c.answer);
  const b = parseNumber(independent);
  if (a === null || b === null) return { same: false, comparable: a !== null };
  return { same: sameNumber(a, b), comparable: true };
}

/** Programmatic arithmetic for a bare computation: mismatch detail, "ok", or null (not applicable). */
function arithmeticCheck(c: Draft): { mismatch: boolean; detail: string } | null {
  if (!bareArithmetic(c.stem)) return null;
  let stated = c.answer;
  if (c.type === "multiple_choice") {
    const l = answerLetter(c.answer, c.options?.length ?? 0);
    if (!l || !c.options) return null;
    stated = c.options[LETTERS.indexOf(l)];
  } else if (c.type !== "numeric") return null;
  const r = verifyAnswer({ statement: c.stem, answer: stated } as Omit<GeneratedProblem, "id">);
  if (!r.verified) return null;
  if (r.corrected) return { mismatch: true, detail: lt(`算式 ${r.expression} = ${r.correctAnswer}，与答案不符`, `${r.expression} = ${r.correctAnswer}, which does not match the answer`) };
  return { mismatch: false, detail: lt(`算式核对通过（${r.expression} = ${r.computed}）`, `arithmetic verified (${r.expression} = ${r.computed})`) };
}

/** Money in cents ("$1.50", "50c", "2元", "¥3.5", "1.20"), or null. */
function money(text: string): number | null {
  const t = text.normalize("NFKC");
  let m = /(?:\$|¥|￥|A\$)\s*(\d+(?:\.\d{1,2})?)/.exec(t) ?? /(\d+(?:\.\d{1,2})?)\s*(?:元|dollars?)/.exec(t);
  if (m) return Math.round(parseFloat(m[1]) * 100);
  m = /(\d+)\s*(?:c|cents?|¢|分)\b/.exec(t) ?? /(\d+)\s*(?:c|cents?|¢|分)/.exec(t);
  if (m) return parseInt(m[1], 10);
  m = /(\d+)\s*角/.exec(t);
  return m ? parseInt(m[1], 10) * 10 : null;
}

const fmtMoney = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Texts that pair a name with a price: figure cards and table rows, and lines of the stem. */
function pricedTexts(c: Draft): string[] {
  const out: string[] = [];
  const spec = c.figure?.spec as { kind?: string; rows?: unknown[][]; cards?: Array<{ label?: string; caption?: string }> } | undefined;
  if (spec?.kind === "table") for (const r of spec.rows ?? []) out.push(r.map(String).join(" "));
  if (spec?.kind === "cards") for (const k of spec.cards ?? []) out.push(`${k.label ?? ""} ${k.caption ?? ""}`);
  for (const t of tablesIn(c.stem)) for (const r of t.rows) out.push(r.join(" "));
  out.push(...withoutTables(c.stem).split(/\n|;|；/));
  return out;
}

/**
 * "Select all the items that cost exactly $5": the program finds every set of options whose prices make the
 * total. Exactly one set must work and it must be the answer. Null when the question is not of this kind.
 */
export function selectionCheck(c: Pick<Draft, "stem" | "type" | "options" | "answer" | "figure">): { mismatch: boolean; detail: string } | null {
  if (c.type !== "multiple_choice" || !c.options?.length || c.options.length > 10 || !isSelectAll(c.stem)) return null;
  const totalM = /(?:exactly|total(?:ling|led)?|spent|spends|paid|pays|costs?|altogether|一共|共|总共|正好|恰好|刚好)[^\n]{0,30}?((?:\$|¥|￥)\s*\d+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?\s*(?:元|c\b|cents?)|\d+\s*角)/i.exec(withoutTables(c.stem).normalize("NFKC"));
  const total = totalM ? money(totalM[1]) : null;
  if (total === null) return null;
  const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const texts = pricedTexts(c as Draft).map((t) => ({ t: norm(t.replace(/(?:\$|¥|￥)\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:元|角|c\b|cents?)/gi, " ")), price: money(t) })).filter((x) => x.price !== null && x.t);
  const prices = c.options.map((o) => {
    const own = money(o);
    if (own !== null) return own;
    const name = norm(o);
    const hit = texts.find((x) => x.t === name) ?? texts.find((x) => name && (x.t.includes(name) || name.includes(x.t)));
    return hit ? hit.price : null;
  });
  if (prices.some((p) => p === null)) return null;
  const sets: string[][] = [];
  const n = c.options.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    let sum = 0;
    const letters: string[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) (sum += prices[i]!, letters.push(LETTERS[i]));
    if (sum === total) sets.push(letters);
  }
  const show = (l: string[]) => l.join(" + ");
  const priceList = c.options.map((o, i) => `${LETTERS[i]} ${fmtMoney(prices[i]!)}`).join(lt("，", ", "));
  if (!sets.length) return { mismatch: true, detail: lt(`没有一组选项正好是 ${fmtMoney(total)}（${priceList}）`, `no set of options makes exactly ${fmtMoney(total)} (${priceList})`) };
  if (sets.length > 1) return { mismatch: true, detail: lt(`有 ${sets.length} 组选项都是 ${fmtMoney(total)}：${sets.map(show).join("；")}，答案不唯一`, `${sets.length} sets of options make ${fmtMoney(total)}: ${sets.map(show).join("; ")} — the answer is not unique`) };
  const mine = answerLetters(c.answer, n);
  if (!mine || mine.join(",") !== sets[0].join(",")) return { mismatch: true, detail: lt(`只有 ${show(sets[0])} 正好是 ${fmtMoney(total)}，与答案 ${c.answer} 不符`, `only ${show(sets[0])} makes ${fmtMoney(total)}, not the answer ${c.answer}`) };
  return { mismatch: false, detail: lt(`程序核对：只有 ${show(sets[0])} 正好是 ${fmtMoney(total)}`, `checked by the program: only ${show(sets[0])} makes ${fmtMoney(total)}`) };
}

function answerCheck(c: Draft, independent: string | undefined, resolveError: string | undefined): Check {
  const sel = selectionCheck(c);
  if (sel?.mismatch) return check(false, sel.detail);
  const arith = sel ?? arithmeticCheck(c);
  if (arith?.mismatch) return check(false, arith.detail);
  const extra = arith ? ` ${arith.detail}` : "";
  if (c.type !== "multiple_choice" && c.type !== "numeric") {
    return check(true, lt(`${typeName(c.type)}的答案无法自动核对，请人工检查`, `${typeName(c.type)} answers are not checked automatically; please review`) + extra, true);
  }
  if (resolveError) return check(true, lt(`独立解题未完成：${resolveError}`, `independent solve failed: ${resolveError}`) + extra, true);
  if (independent === undefined) return check(true, lt("独立解题没有给出这道题的答案", "the independent solve gave no answer for this question") + extra, true);
  const cmp = compareAnswers(c, independent);
  if (!cmp.comparable) return check(false, lt(`答案“${c.answer}”无法与独立解答“${independent}”比较`, `answer "${c.answer}" cannot be compared with the independent answer "${independent}"`) + extra);
  return cmp.same
    ? check(true, lt(`独立解答一致：${independent}`, `independent answer agrees: ${independent}`) + extra)
    : check(false, lt(`独立解答为 ${independent}，与答案 ${c.answer} 不一致`, `independent answer is ${independent}, not ${c.answer}`) + extra);
}

function noveltyChecks(drafts: Draft[], bankItems: Item[]): Check[] {
  const index = new StemIndex<string>();
  for (const it of bankItems) {
    const label = it.source?.label ? `${it.source.label}: ` : "";
    index.add(lt(`题库题目「${label}${clip(it.stem.replace(/\s+/g, " "), 40)}」`, `bank question "${label}${clip(it.stem.replace(/\s+/g, " "), 40)}"`), it.stem);
  }
  return drafts.map((d, i) => {
    const near = index.nearest(d.stem);
    index.add(lt(`本批第 ${i + 1} 道候选题`, `candidate ${i + 1} of this batch`), d.stem);
    const pct = near ? Math.round(near.score * 100) : 0;
    if (near && near.score >= TOO_CLOSE) return check(false, lt(`与${near.item}过于相似（${pct}%）`, `too close to ${near.item} (${pct}%)`));
    return check(true, near ? lt(`最相近的题目相似度 ${pct}%`, `closest question is ${pct}% similar`) : lt("没有相近的题目", "no similar question"));
  });
}

/** Angles a program-drawn figure has exactly (stars and their pieces), or [] when it has none to check. */
function figureAngles(spec: unknown): number[] {
  const s = spec as { kind?: string; cards?: Array<{ figure?: unknown }> } | undefined;
  if (!s?.kind) return [];
  if (s.kind === "star") return allStarAngles(s as StarSpec);
  if (s.kind === "cards") return (s.cards ?? []).flatMap((c) => figureAngles(c.figure));
  return [];
}

const DEGREES = /(\d+(?:\.\d+)?)\s*(?:°|\^\s*\{?\s*\\circ\s*\}?|\\degree|degrees?|度)/gi;

/**
 * The angles named in the question (and a degree answer) must be angles the figure really has:
 * a star drawn with a 76° tip cannot go with "the smallest angle is 42°". Null when not applicable.
 */
export function angleCheck(d: Pick<Draft, "stem" | "answer" | "type" | "figure">): { ok: boolean; detail: string } | null {
  const have = figureAngles(d.figure?.spec);
  if (!have.length) return null;
  const said = [...d.stem.matchAll(DEGREES)].map((m) => parseFloat(m[1]));
  const ans = parseNumber(d.answer);
  if (ans !== null && (DEGREES.test(d.answer) || /angle|degree|角|度/i.test(d.stem))) said.push(ans);
  DEGREES.lastIndex = 0;
  if (!said.length) return null;
  const fmtA = (v: number) => `${Math.round(v * 100) / 100}°`;
  const off = said.filter((v) => !have.some((h) => Math.abs(h - v) <= 0.5));
  return off.length
    ? { ok: false, detail: lt(`图中的角是 ${have.map(fmtA).join("、")}，题目或答案中的 ${off.map(fmtA).join("、")} 与图不符`, `the figure's angles are ${have.map(fmtA).join(", ")}; ${off.map(fmtA).join(", ")} in the question or answer does not match the figure`) }
    : { ok: true, detail: lt(`题目中的角与图一致（${said.map(fmtA).join("、")}）`, `the angles in the question match the figure (${said.map(fmtA).join(", ")})`) };
}

function figureCheck(d: Draft, svgCheck: Check | undefined, needTable = false, needSolid: string[] = []): Check {
  if (d.figureIssue && !d.figure) return check(false, d.figureIssue);
  if (needTable && !hasTableFigure(d.figure?.spec) && !tablesIn(d.stem).length) {
    return check(false, lt("模板题目带表格，此题没有表格", "the template questions have a table, this question does not"));
  }
  if (needSolid.length && !figureKinds(d.figure?.spec).some((k) => SOLID_KIND_SET.has(k))) {
    return check(false, lt("模板题目带立体图形，此题没有立体图形", "the template questions have a 3D figure, this question does not"));
  }
  if (!d.figure) {
    return usesFigure({ stem: d.stem })
      ? check(false, lt("题干引用了图形，但没有给出图形", "the stem refers to a figure but none was given"))
      : check(true, lt("此题不需要图形", "this question has no figure"), true);
  }
  if (d.figure.source === "program") {
    const angles = angleCheck(d);
    if (angles && !angles.ok) return check(false, angles.detail);
    if (angles && d.figure.verified && !d.figureIssue) return check(true, `${lt("图形由程序按题目数据绘制", "the figure was drawn by the program from the question's data")}; ${angles.detail}`);
    return d.figure.verified && !d.figureIssue
      ? check(true, lt("图形由程序按题目数据绘制", "the figure was drawn by the program from the question's data"))
      : check(false, lt(`图形条件不成立：${d.figureIssue ?? ""}`, `the figure's conditions do not hold: ${d.figureIssue ?? ""}`));
  }
  return svgCheck ?? check(true, lt("图形由模型绘制，未经校验，请人工核对", "the figure was drawn by the model and is not checked; please review"), true);
}

/** Re-read model-drawn SVG figures with the vision model (needs sharp to rasterise). Keyed by draft index. */
async function checkModelFigures(drafts: Draft[]): Promise<Map<number, Check>> {
  const out = new Map<number, Check>();
  let todo = drafts.map((d, i) => ({ d, i })).filter(({ d }) => d.figure?.source === "model");
  // Things covering each other are found by the program first (no model call needed).
  todo = todo.filter(({ d, i }) => {
    const covered = svgOverlaps(d.figure!.svg);
    if (!covered?.length) return true;
    out.set(i, check(false, lt(`模型绘制的图形有遮挡：${covered.join("；")}`, `the model-drawn figure has things covering each other: ${covered.join("; ")}`)));
    return false;
  });
  if (!todo.length) return out;
  const sharp = await loadSharp();
  if (!sharp) return out;
  await Promise.all(
    todo.map(async ({ d, i }) => {
      try {
        const png = await sharp(Buffer.from(d.figure!.svg)).png().toBuffer();
        const res = await chatJson({
          role: "vision",
          system: FIGURE_CHECK_SYSTEM,
          user: `Question:\n${clip(d.stem, 2000)}\n\nThe figure should show: ${d.figure!.description}`,
          images: [`data:image/png;base64,${png.toString("base64")}`],
          schema: z.object({ ok: z.boolean(), problems: z.string().optional().default("") }),
          schemaName: "FigureCheck",
          temperature: 0,
          maxRetries: 1,
          keepLanguage: true,
        });
        out.set(
          i,
          res.ok
            ? check(true, lt("模型绘制的图形经视觉模型核对与描述一致", "the model-drawn figure matches its description (checked by the vision model)"))
            : check(false, lt(`模型绘制的图形与描述不符：${res.problems}`, `the model-drawn figure does not match its description: ${res.problems}`)),
        );
      } catch (e) {
        out.set(i, check(true, lt(`图形核对未完成：${errText(e)}`, `figure check failed: ${errText(e)}`), true));
      }
    }),
  );
  return out;
}

function listForModel(drafts: Draft[], withAnswer: boolean): string {
  return drafts.map((d, i) => describeItem(d, i + 1, withAnswer)).join("\n\n");
}

const errText = (e: unknown) => clip(e instanceof Error ? e.message : String(e), 200);

// ── Generation ──────────────────────────────────────────────────────

export async function generateFromTemplate(args: { owner: string; bankId: string; template: TemplateRef; count: number }): Promise<Generation> {
  const { owner, bankId, template } = args;
  const bank = getBank(owner, bankId);
  if (!bank.allow_model) throw new BankError(lt("该题库不允许将内容发送给模型服务", "this bank does not allow sending its content to the model service"), 403);
  const count = Math.min(MAX_COUNT, Math.max(1, Math.floor(Number(args.count) || 1)));
  const ask = Math.ceil(count * 1.5);
  const { label, profile, exemplars, note: templateNote, matched } = await resolveTemplate(owner, bankId, template);
  const inLang = <T>(fn: () => Promise<T>) => inBankLanguage(bank, fn);

  // The teacher's notes on the template questions (given when importing, editable on each question).
  const hints = templateHints(exemplars);
  // 0. Template figures (scans / photos): the vision model reads what they show and their style.
  let visuals: TemplateVisuals | undefined;
  if (hasTemplateImages(exemplars)) visuals = await readTemplateVisuals(owner, bankId, exemplars, hints);
  const tables = templateTables(exemplars, visuals?.itemKinds ?? []);
  const solids = templateSolids(exemplars, visuals?.kinds ?? []);
  const figures: FigurePlan = {
    on: !!visuals?.descriptions.size || tables.required || solids.length > 0,
    style: visuals?.style ?? DEFAULT_STYLE,
    kinds: [...new Set([...(visuals?.kinds ?? []), ...(tables.required ? ["table"] : []), ...solids])],
    layout: visuals?.layout,
    tables: tables.required,
    tableHint: tables.hint,
    solids,
  };
  const figureNote = visuals?.note ? lt(`未能读取模板图形（${visuals.note}），新题按文字出`, `the template's figures could not be read (${visuals.note}); questions were written from the text`) : undefined;
  const note = [templateNote, figureNote].filter(Boolean).join(lt("；", "; ")) || undefined;

  // 1. Write candidates.
  const exemplarText = exemplars.length
    ? `EXAMPLES — for the type only, do NOT copy (new context, new numbers, new wording; same skill and difficulty):\n\n${exemplars
        .map((e, i) => {
          const fig = visuals?.descriptions.get(e.id);
          return describeItem({ ...e, stem: clip(e.stem, 1500) }, i + 1) + (fig ? `\nFigure of example ${i + 1}: ${fig}` : "");
        })
        .join("\n\n")}`
    : "No example questions: follow the profile.";
  const user = [`PROFILE\n${profileText(profile, figures, hints)}`, exemplarText, `Write ${ask} new question(s) of this type.`].join("\n\n");
  const system = figures.on ? `${GENERATE_SYSTEM.replace(FIGURE_RULE, FIGURE_RULE_WITH_SPECS)}\n\n${VISUAL_GUIDE}` : GENERATE_SYSTEM;
  let generated: z.infer<typeof generatedSchema>;
  try {
    generated = await inLang(() => chatJson({ system, user, schema: generatedSchema, schemaName: "SameTypeQuestions", temperature: 0.8, noCache: true, ...(figures.on ? { maxTokens: 12000 } : {}) }));
  } catch (e) {
    throw new BankError(lt(`生成失败：${errText(e)}`, `generation failed: ${errText(e)}`), 502);
  }
  const drafts = generated.questions.slice(0, ask * 2).map((q) => toDraft(q, profile, figures.style));
  // Figures the program could not draw (or a required kind left out) go back to the writer once, with the error.
  if (figures.on) await repairFigures(drafts, figures, inLang);
  // Model-drawn figures (no kind fitted): the vision model checks them against their description.
  const svgChecks = figures.on ? await checkModelFigures(drafts) : new Map<number, Check>();
  // A model-drawn figure that does not match, or a figure whose angles contradict the question: one more repair round.
  if (figures.on && drafts.some((d, i) => (svgChecks.get(i) && !svgChecks.get(i)!.ok && !svgChecks.get(i)!.skipped) || (d.figure?.source === "program" && angleCheck(d)?.ok === false))) {
    const fixed = await repairFigures(drafts, figures, inLang, svgChecks);
    for (const i of fixed) svgChecks.delete(i);
    const again = await checkModelFigures(fixed.map((i) => drafts[i]));
    for (const [k, c] of again) svgChecks.set(fixed[k], c);
  }

  // 2. Independent re-solve and fit judge (in parallel; neither sees the other).
  const solvable = drafts.map((d, i) => ({ d, n: i + 1 })).filter(({ d }) => d.type === "multiple_choice" || d.type === "numeric");
  const resolveP = solvable.length
    ? inLang(() =>
        chatJson({
          system: RESOLVE_SYSTEM,
          user: `Questions:\n\n${solvable.map(({ d, n }) => describeItem(withFigureText(d), n, false)).join("\n\n")}`,
          schema: resolveSchema,
          schemaName: "IndependentAnswers",
          temperature: 0,
          noCache: true,
        }),
      )
    : Promise.resolve({ answers: [] });
  const judgeP = inLang(() =>
    chatJson({
      system: JUDGE_SYSTEM,
      user: `PROFILE\n${profileText(profile, figures, hints)}\n\nGenerated questions:\n\n${listForModel(drafts.map(withFigureText), true)}`,
      schema: judgeSchema,
      schemaName: "FitScores",
      temperature: 0,
      noCache: true,
    }),
  );
  const [resolved, judged] = await Promise.allSettled([resolveP, judgeP]);
  const answers = new Map<number, string>();
  if (resolved.status === "fulfilled") for (const a of resolved.value.answers) answers.set(Math.round(a.n), a.answer.trim());
  const scores = new Map<number, { score: number; reason: string }>();
  if (judged.status === "fulfilled") for (const s of judged.value.scores) scores.set(Math.round(s.n), { score: s.score, reason: s.reason.trim() });

  // 3. Checks.
  const novelty = noveltyChecks(drafts, listItems(owner, bankId));
  const candidates: Candidate[] = drafts.map((d, i) => {
    const n = i + 1;
    const fitScore = scores.get(n);
    const fit =
      judged.status === "rejected"
        ? check(true, lt(`匹配度评审未完成：${errText(judged.reason)}`, `fit review failed: ${errText(judged.reason)}`), true)
        : !fitScore
          ? check(true, lt("评审没有给出这道题的分数", "the review gave no score for this question"), true)
          : check(fitScore.score >= JUDGE_PASS, `${lt("匹配度", "fit")} ${fitScore.score}/5${fitScore.reason ? ` — ${fitScore.reason}` : ""}`);
    const figure = figures.on || d.figure || d.figureIssue ? figureCheck(d, svgChecks.get(i), figures.tables, figures.solids) : undefined;
    const checks = {
      format: formatCheck(d, profile),
      answer: answerCheck(d, answers.get(n), resolved.status === "rejected" ? errText(resolved.reason) : undefined),
      novelty: novelty[i],
      fit,
      ...(figure ? { figure } : {}),
    };
    const passed = Object.values(checks).every((c) => c.skipped || c.ok);
    const { figureIssue: _issue, figureRaw: _raw, ...candidate } = d;
    void _issue;
    void _raw;
    return { ...candidate, checks, passed };
  });

  // 4. Passed first (at most `count`), then the failed ones so the UI can show why.
  const passed = candidates.filter((c) => c.passed).slice(0, count);
  const failed = candidates.filter((c) => !c.passed);
  const figure_plan = figures.on || visuals ? { kinds: (visuals?.itemKinds.length ? visuals.itemKinds : figures.kinds).slice(0, 20), layout: figures.layout?.slice(0, 300), tables: figures.tables, solids: figures.solids, ...(visuals?.note ? { note: visuals.note.slice(0, 300) } : {}) } : undefined;
  return putGeneration(owner, bankId, { template, template_label: clip(label, 200), mode: "same_type", requested: count, note, matched, ...(figure_plan ? { figure_plan } : {}), candidates: [...passed, ...failed] });
}

// ── Adoption ────────────────────────────────────────────────────────

/**
 * Add chosen candidates to the bank as items (origin "generated"). Already
 * adopted candidates are skipped; failed candidates may be adopted (the
 * user's choice) and are tagged "unchecked".
 */
/** Store a candidate's figure as a bank asset: PNG when sharp can rasterise it, else the SVG. */
async function saveFigureAsset(owner: string, bankId: string, fig: CandidateFigure): Promise<string> {
  const sharp = await loadSharp();
  if (sharp) {
    try {
      return saveAsset(owner, bankId, await sharp(Buffer.from(fig.svg)).png().toBuffer(), "png");
    } catch {
      /* fall through to the SVG */
    }
  }
  return saveAsset(owner, bankId, Buffer.from(fig.svg, "utf8"), "svg");
}

export async function adoptCandidates(owner: string, bankId: string, generationId: string, candidateIds: string[], opts?: { categoryId?: string }): Promise<Item[]> {
  const g = getGeneration(owner, bankId, generationId);
  // Only manual categories hold assigned questions (filters and style templates do not).
  const target = opts?.categoryId ? getCategory(owner, bankId, opts.categoryId) : undefined;
  const categoryIds = target && target.kind === "manual" ? [target.id] : [];
  const byId = new Map(g.candidates.map((c) => [c.id, c]));
  const picked: Candidate[] = [];
  for (const id of new Set(candidateIds)) {
    const c = byId.get(id);
    if (!c) throw new BankError(lt("候选题不存在", "candidate not found"), 404);
    if (!c.adopted_item_id) picked.push(c);
  }
  if (!picked.length) return [];
  const figureAssets = await Promise.all(picked.map((c) => (c.figure ? saveFigureAsset(owner, bankId, c.figure) : Promise.resolve(undefined))));
  const items = addItems(
    owner,
    bankId,
    picked.map((c, i) => ({
      origin: "generated" as const,
      generated_from: { generation_id: g.id, template_label: g.template_label },
      category_ids: categoryIds,
      fields: {
        stem: clip(c.stem, 20_000),
        type: c.type,
        options: c.options?.slice(0, 10).map((o) => clip(o, 2000)),
        answer: clip(c.answer, 5000) || undefined,
        solution: c.solution ? clip(c.solution, 20_000) : undefined,
        grade: c.grade ? clip(c.grade, 40) : undefined,
        difficulty: c.difficulty,
        knowledge_points: c.knowledge_points.slice(0, 20).map((k) => clip(k, 80)),
        tags: c.passed ? ["generated"] : ["generated", "unchecked"],
        images: figureAssets[i] ? [{ asset: figureAssets[i]!, caption: c.figure?.source === "model" ? lt("模型绘制的图形", "figure drawn by the model") : lt("题目图形", "figure") }] : [],
        language: detectLanguage(c.stem),
      },
    })),
  );
  const adopted = new Map(picked.map((c, i) => [c.id, items[i].id]));
  putGeneration(owner, bankId, { ...g, candidates: g.candidates.map((c) => (adopted.has(c.id) ? { ...c, adopted_item_id: adopted.get(c.id) } : c)) });
  return items;
}
