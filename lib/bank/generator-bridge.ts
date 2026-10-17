/**
 * The problem generator's "local bank as template" mode: the user picks
 * Level, Difficulty and Topic; the matching bank questions are the template
 * the model writes new questions from (lib/bank/generate.ts, with all its
 * checks). Results are returned in the generator's GeneratedProblem shape
 * with the bank metadata attached, so "Use this problem", figures and
 * "Add to bank" work from the same card.
 */
import type { BankProblemMeta, DifficultyLevel, GeneratedProblem, GradeLevel } from "../types";
import { answerLetters, generateFromTemplate, type GenerationProgress } from "./generate";
import { LETTERS } from "./profile";
import { isEnglish, lt } from "../llm/output-locale";
import { selectTemplateItems, type TemplateSelection } from "./select";
import { listCategories, listItems } from "./store";
import { MAX_TEMPLATE_RUNS } from "./template-runs";
import type { Candidate, Generation, Item } from "./types";

/** Built-in level for a bank grade string ("Year 4", "四年级", "初二", "Grade 10" …). */
export function gradeLevelOf(grade: string | undefined): GradeLevel {
  const g = (grade ?? "").normalize("NFKC").toLowerCase();
  if (/大学|university|college/.test(g)) return "university";
  if (/高[一二三中]|high/.test(g)) return "high";
  if (/初[一二三中]|middle|junior/.test(g)) return "middle";
  const n = Number(g.match(/(?:year|grade|yr|y)\s*(\d{1,2})/)?.[1] ?? g.match(/(\d{1,2})\s*年级/)?.[1] ?? NaN);
  const cn = "一二三四五六七八九".indexOf(g.match(/([一二三四五六七八九])年级/)?.[1] ?? "") + 1;
  const year = Number.isFinite(n) ? n : cn || NaN;
  if (Number.isFinite(year)) return year <= 6 ? "elementary" : year <= 9 ? "middle" : "high";
  return "elementary";
}

export function difficultyLevelOf(d: number | undefined): DifficultyLevel {
  return !d || d <= 2 ? "standard" : d === 3 ? "advanced" : "competition";
}

/** Question text for the solver: stem plus "A. …" option lines. */
function statementOf(c: Pick<Candidate, "stem" | "options">): string {
  const opts = c.options?.length ? "\n" + c.options.map((o, i) => `${LETTERS[i] ?? i + 1}. ${o}`).join("\n") : "";
  return c.stem + opts;
}

function answerOf(c: Candidate): string {
  let a = c.answer;
  if (c.type === "multiple_choice" && c.options?.length) {
    // One letter, or several for "select all" questions ("A, D").
    const letters = answerLetters(c.answer, c.options.length) ?? [];
    const named = letters.map((l) => ({ l, o: c.options![LETTERS.indexOf(l)] })).filter((x) => x.o !== undefined);
    if (named.length) a = named.map((x) => `${x.l}. ${x.o}`).join("\n");
  }
  return c.solution?.trim() ? `${a}\n\n${c.solution.trim()}` : a;
}

const SHORT_NOTE = /^要求 \d+ 道，通过全部检查|^\d+ requested, \d+ passed every check/;

/**
 * The bank questions that match the selection, when each is to be a template of its own:
 * 2 … MAX_TEMPLATE_RUNS matches. One match is one template anyway; more than that many
 * are treated as one class (one generation from exemplars of the whole set).
 */
export function perQuestionTemplates(owner: string, bankId: string, selection: TemplateSelection): Item[] | null {
  const { items } = selectTemplateItems(listItems(owner, bankId), listCategories(owner, bankId), selection);
  return items.length > 1 && items.length <= MAX_TEMPLATE_RUNS ? items : null;
}

function toProblems(g: Generation, args: { bankId: string; selection: TemplateSelection }, templateNo?: number): GeneratedProblem[] {
  const source = templateNo ? lt(`${g.template_label}（模板 ${templateNo}）`, `${g.template_label} (template ${templateNo})`) : g.template_label;
  return g.candidates.map((c): GeneratedProblem => {
    const bank: BankProblemMeta = {
      bank_id: args.bankId,
      generation_id: g.id,
      candidate_id: c.id,
      passed: c.passed,
      checks: c.checks,
      template_label: source,
      note: g.note,
      matched: g.matched,
      question_type: c.type,
      options: c.options,
      grade: args.selection.grade ?? c.grade,
      difficulty: c.difficulty ?? args.selection.difficulty,
      knowledge_points: c.knowledge_points,
      topic_category_id: args.selection.category_id,
      ...(c.figure ? { figure: { svg: c.figure.svg, description: c.figure.description, source: c.figure.source, verified: c.figure.verified } } : {}),
    };
    return {
      id: c.id,
      statement: statementOf(c),
      answer: answerOf(c),
      hints: c.hints,
      grade_level: gradeLevelOf(bank.grade),
      difficulty: difficultyLevelOf(bank.difficulty),
      domain: "computation",
      suggested_techniques: [],
      source_inspiration: source,
      estimated_solve_time: "",
      bank,
    };
  });
}

/** The generation note without the "N requested, M passed" part (the generator shows that itself). */
function shortNote(note: string | undefined): string | undefined {
  return note?.split(/；|; /).filter((part) => !SHORT_NOTE.test(part)).join(isEnglish() ? "; " : "；") || undefined;
}

export async function generateProblemsFromBank(args: {
  owner: string;
  bankId: string;
  selection: TemplateSelection;
  count: number;
  onProgress?: (p: GenerationProgress) => void;
}): Promise<{ problems: GeneratedProblem[]; generation_id: string; generation_ids: string[]; template_label: string; note?: string; matched?: number; templates: number; requested: number }> {
  const templates = perQuestionTemplates(args.owner, args.bankId, args.selection);
  if (!templates) {
    const g = await generateFromTemplate({ owner: args.owner, bankId: args.bankId, template: { selection: args.selection }, count: args.count, onProgress: args.onProgress });
    return { problems: toProblems(g, args), generation_id: g.id, generation_ids: [g.id], template_label: g.template_label, note: shortNote(g.note), matched: g.matched, templates: 1, requested: g.requested };
  }
  // Several matching questions: each is a template of its own, generated from in turn.
  const n = templates.length;
  const problems: GeneratedProblem[] = [];
  const generations: Generation[] = [];
  const notes: string[] = [];
  let firstError: unknown;
  for (let i = 0; i < n; i++) {
    const tag = lt(`模板 ${i + 1}/${n}`, `Template ${i + 1}/${n}`);
    try {
      const g = await generateFromTemplate({
        owner: args.owner,
        bankId: args.bankId,
        template: { selection: args.selection, item_ids: [templates[i].id] },
        count: args.count,
        onProgress: args.onProgress ? (p) => args.onProgress!({ ...p, detail: `${tag} · ${p.detail}`, requested: args.count * n }) : undefined,
      });
      generations.push(g);
      problems.push(...toProblems(g, args, i + 1));
      const note = shortNote(g.note);
      if (note) notes.push(lt(`${tag}：${note}`, `${tag}: ${note}`));
    } catch (e) {
      firstError ??= e;
      notes.push(lt(`${tag} 出题失败：${e instanceof Error ? e.message : String(e)}`, `${tag} failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
  if (!generations.length) throw firstError;
  const label = generations[0].template_label;
  return {
    problems,
    generation_id: generations[0].id,
    generation_ids: generations.map((g) => g.id),
    template_label: label,
    note: [lt(`${n} 道匹配的题各作为一个模板，每个出 ${args.count} 道`, `each of the ${n} matching questions was a template of its own, ${args.count} per template`), ...notes].join(isEnglish() ? "; " : "；"),
    matched: n,
    templates: n,
    requested: args.count * n,
  };
}
