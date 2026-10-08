/**
 * The problem generator's "local bank as template" mode: the user picks
 * Level, Difficulty and Topic; the matching bank questions are the template
 * the model writes new questions from (lib/bank/generate.ts, with all its
 * checks). Results are returned in the generator's GeneratedProblem shape
 * with the bank metadata attached, so "Use this problem", figures and
 * "Add to bank" work from the same card.
 */
import type { BankProblemMeta, DifficultyLevel, GeneratedProblem, GradeLevel } from "../types";
import { answerLetters, generateFromTemplate } from "./generate";
import { LETTERS } from "./profile";
import type { TemplateSelection } from "./select";
import type { Candidate } from "./types";

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

export async function generateProblemsFromBank(args: {
  owner: string;
  bankId: string;
  selection: TemplateSelection;
  count: number;
}): Promise<{ problems: GeneratedProblem[]; generation_id: string; template_label: string; note?: string; matched?: number }> {
  const g = await generateFromTemplate({ owner: args.owner, bankId: args.bankId, template: { selection: args.selection }, count: args.count });
  const problems = g.candidates.map((c): GeneratedProblem => {
    const bank: BankProblemMeta = {
      bank_id: args.bankId,
      generation_id: g.id,
      candidate_id: c.id,
      passed: c.passed,
      checks: c.checks,
      template_label: g.template_label,
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
      source_inspiration: g.template_label,
      estimated_solve_time: "",
      bank,
    };
  });
  return { problems, generation_id: g.id, template_label: g.template_label, note: g.note, matched: g.matched };
}
