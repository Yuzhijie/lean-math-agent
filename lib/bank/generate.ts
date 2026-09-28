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
import { StemIndex, TOO_CLOSE } from "./similarity";
import { addItems, BankError, getBank, getCategory, getGeneration, getItem, listCategories, listItems, putGeneration } from "./store";
import { QUESTION_TYPES, type Candidate, type Check, type Generation, type Item, type QuestionType, type TemplateProfile, type TemplateRef } from "./types";
import { vocabFor } from "./vocab";

const MAX_COUNT = 10;
const EXEMPLARS = 5;
const JUDGE_PASS = 3;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const newId = () => randomUUID().replace(/-/g, "").slice(0, 20);

// ── Template resolution ─────────────────────────────────────────────

export async function resolveTemplate(owner: string, bankId: string, ref: TemplateRef): Promise<{ label: string; profile: TemplateProfile; exemplars: Item[] }> {
  const bank = getBank(owner, bankId);
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
- Numeric: "answer" is a single number, with a unit if the question needs one (e.g. "12 cm"); fractions as a/b.
- Use $...$ for inline LaTeX math.
- Each question is self-contained and well-posed, with exactly one correct answer; check the answer by solving it yourself in "solution".
- Never refer to a figure, table or picture that is not there. If the profile needs a figure, describe the figure precisely in words in the stem (shapes, labels, lengths, positions) so that it can be drawn from the text.
Write Chinese for stems, options, solutions and hints.
Return JSON only: {"questions": [{"stem": string, "type": "multiple_choice"|"numeric"|"short_answer"|"proof"|"other", "options"?: string[], "answer": string, "solution": string, "hints"?: string[], "difficulty"?: 1-5, "knowledge_points"?: string[]}]}`;

const RESOLVE_SYSTEM = `You solve math questions independently and carefully. For each question, work it out and give only the final answer.
- Multiple choice: the letter of the correct option (A, B, C, …).
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
      }),
    )
    .min(1),
});
const resolveSchema = z.object({ answers: z.array(z.object({ n: z.coerce.number(), answer: str })) });
const judgeSchema = z.object({ scores: z.array(z.object({ n: z.coerce.number(), score: z.coerce.number(), reason: z.string().optional().default("") })) });

function profileText(p: TemplateProfile): string {
  const lines = [
    `Summary: ${p.summary}`,
    `Question type: ${p.type}${p.option_count ? ` with exactly ${p.option_count} options` : ""}`,
    p.grade ? `Grade: ${p.grade}` : "",
    p.difficulty_range ? `Difficulty (1–5): ${p.difficulty_range[0] === p.difficulty_range[1] ? p.difficulty_range[0] : `${p.difficulty_range[0]}–${p.difficulty_range[1]}`}` : "",
    p.answer_form ? `Answer form: ${p.answer_form}` : "",
    p.stem_structure ? `Stem structure: ${p.stem_structure}` : "",
    p.knowledge_points.length ? `Knowledge points: ${p.knowledge_points.join("; ")}` : "",
    p.needs_figure ? "Figure: these questions use a figure — describe it precisely in words in the stem." : "Figure: none — do not refer to any figure.",
    p.language ? `Source questions are written in ${p.language === "zh" ? "Chinese" : "English"}.` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

const LETTER_PREFIX = /^\s*\(?[A-Ja-j]\s*[.．、:：)]\s*/;

function toType(t: string | undefined, fallback: QuestionType): QuestionType {
  const v = (t ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (QUESTION_TYPES as readonly string[]).includes(v) ? (v as QuestionType) : fallback;
}

type Draft = Omit<Candidate, "checks" | "passed" | "adopted_item_id">;

function toDraft(q: z.infer<typeof generatedSchema>["questions"][number], p: TemplateProfile): Draft {
  const type = toType(q.type ?? undefined, p.type);
  const options = q.options?.length ? q.options.map((o) => o.replace(LETTER_PREFIX, "").trim()) : undefined;
  let answer = q.answer.trim();
  if (type === "multiple_choice" && options) answer = answerLetter(answer, 26) ?? answer;
  const d = typeof q.difficulty === "number" && Number.isFinite(q.difficulty) ? Math.min(5, Math.max(1, Math.round(q.difficulty))) : undefined;
  const kps = (q.knowledge_points ?? []).map((k) => k.trim()).filter(Boolean);
  return {
    id: newId(),
    stem: q.stem.trim(),
    type,
    options,
    answer,
    solution: q.solution?.trim() || undefined,
    hints: (q.hints ?? []).map((h) => h.trim()).filter(Boolean),
    grade: p.grade,
    difficulty: d ?? (p.difficulty_range ? Math.round((p.difficulty_range[0] + p.difficulty_range[1]) / 2) : undefined),
    knowledge_points: (kps.length ? kps : p.knowledge_points).slice(0, 20),
  };
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
    if (c.answer.trim() && !/^[A-J]$/.test(c.answer.trim())) issues.push(lt(`答案“${c.answer}”不是选项字母`, `answer "${c.answer}" is not an option letter`));
    else if (c.answer.trim() && LETTERS.indexOf(c.answer.trim()) >= opts.length) issues.push(lt(`答案 ${c.answer} 超出选项范围`, `answer ${c.answer} is not one of the options`));
  } else if (c.type === "numeric") {
    if (c.answer.trim() && parseNumber(c.answer) === null) issues.push(lt(`答案“${c.answer}”不是一个数`, `answer "${c.answer}" is not a number`));
  }
  if (!p.needs_figure && usesFigure({ stem: c.stem })) issues.push(lt("题干引用了不存在的图", "the stem refers to a figure that is not there"));
  return issues.length ? check(false, issues.join(lt("；", "; "))) : check(true, lt("格式正确", "format ok"));
}

/** Compare the proposed answer with the independent one (null → cannot compare). */
function compareAnswers(c: Draft, independent: string): { same: boolean; comparable: boolean } {
  if (/^\s*unsolvable\s*$/i.test(independent)) return { same: false, comparable: true };
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

function answerCheck(c: Draft, independent: string | undefined, resolveError: string | undefined): Check {
  const arith = arithmeticCheck(c);
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
  const { label, profile, exemplars } = await resolveTemplate(owner, bankId, template);
  const inLang = <T>(fn: () => Promise<T>) => inBankLanguage(bank, fn);

  // 1. Write candidates.
  const exemplarText = exemplars.length
    ? `EXAMPLES — for the type only, do NOT copy (new context, new numbers, new wording; same skill and difficulty):\n\n${exemplars.map((e, i) => describeItem({ ...e, stem: clip(e.stem, 1500) }, i + 1)).join("\n\n")}`
    : "No example questions: follow the profile.";
  const user = [`PROFILE\n${profileText(profile)}`, exemplarText, `Write ${ask} new question(s) of this type.`].join("\n\n");
  let generated: z.infer<typeof generatedSchema>;
  try {
    generated = await inLang(() => chatJson({ system: GENERATE_SYSTEM, user, schema: generatedSchema, schemaName: "SameTypeQuestions", temperature: 0.8, noCache: true }));
  } catch (e) {
    throw new BankError(lt(`生成失败：${errText(e)}`, `generation failed: ${errText(e)}`), 502);
  }
  const drafts = generated.questions.slice(0, ask * 2).map((q) => toDraft(q, profile));

  // 2. Independent re-solve and fit judge (in parallel; neither sees the other).
  const solvable = drafts.map((d, i) => ({ d, n: i + 1 })).filter(({ d }) => d.type === "multiple_choice" || d.type === "numeric");
  const resolveP = solvable.length
    ? inLang(() =>
        chatJson({
          system: RESOLVE_SYSTEM,
          user: `Questions:\n\n${solvable.map(({ d, n }) => describeItem(d, n, false)).join("\n\n")}`,
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
      user: `PROFILE\n${profileText(profile)}\n\nGenerated questions:\n\n${listForModel(drafts, true)}`,
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
    const checks = {
      format: formatCheck(d, profile),
      answer: answerCheck(d, answers.get(n), resolved.status === "rejected" ? errText(resolved.reason) : undefined),
      novelty: novelty[i],
      fit,
    };
    const passed = Object.values(checks).every((c) => c.skipped || c.ok);
    return { ...d, checks, passed };
  });

  // 4. Passed first (at most `count`), then the failed ones so the UI can show why.
  const passed = candidates.filter((c) => c.passed).slice(0, count);
  const failed = candidates.filter((c) => !c.passed);
  return putGeneration(owner, bankId, { template, template_label: clip(label, 200), mode: "same_type", requested: count, candidates: [...passed, ...failed] });
}

// ── Adoption ────────────────────────────────────────────────────────

/**
 * Add chosen candidates to the bank as items (origin "generated"). Already
 * adopted candidates are skipped; failed candidates may be adopted (the
 * user's choice) and are tagged "unchecked".
 */
export function adoptCandidates(owner: string, bankId: string, generationId: string, candidateIds: string[], opts?: { categoryId?: string }): Item[] {
  const g = getGeneration(owner, bankId, generationId);
  if (opts?.categoryId) getCategory(owner, bankId, opts.categoryId);
  const byId = new Map(g.candidates.map((c) => [c.id, c]));
  const picked: Candidate[] = [];
  for (const id of new Set(candidateIds)) {
    const c = byId.get(id);
    if (!c) throw new BankError(lt("候选题不存在", "candidate not found"), 404);
    if (!c.adopted_item_id) picked.push(c);
  }
  if (!picked.length) return [];
  const items = addItems(
    owner,
    bankId,
    picked.map((c) => ({
      origin: "generated" as const,
      generated_from: { generation_id: g.id, template_label: g.template_label },
      category_ids: opts?.categoryId ? [opts.categoryId] : [],
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
        images: [],
        language: detectLanguage(c.stem),
      },
    })),
  );
  const adopted = new Map(picked.map((c, i) => [c.id, items[i].id]));
  putGeneration(owner, bankId, { ...g, candidates: g.candidates.map((c) => (adopted.has(c.id) ? { ...c, adopted_item_id: adopted.get(c.id) } : c)) });
  return items;
}
