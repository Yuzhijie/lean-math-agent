/**
 * How hard the independent solver of generated questions thinks (reasoning effort). Every model call
 * ran at LLM_REASONING_EFFORT (high on the main deployment), also for "how many apples are left" in
 * Year 2. Now the solve of a primary / lower-secondary question that is not competition level runs at
 * "medium", and only a question it disagrees with (or finds unsolvable / ill-posed) is solved again at
 * "high", whose verdict counts — so a question still fails only when a high-effort solve says so.
 *
 * GENERATE_SOLVE_EFFORT: auto (default) | low | medium | high (one effort for every solve; with low or
 * medium a disagreement is still checked again at high) | default (bank solves at the configured effort
 * as before; built-in solves at high, as before). Answers the program settles need no solve at all.
 */
import type { DifficultyLevel, GradeLevel } from "./types";

export type SolveEffort = "low" | "medium" | "high";

/** Primary or lower-secondary school, from a grade as banks and the built-in generator write it. */
export function isEarlyGrade(grade: string | undefined): boolean {
  if (!grade) return false;
  const g = grade.trim().toLowerCase();
  if (g === "elementary" || g === "middle") return true;
  if (/小学|初中|初[一二三]|幼儿|学前|kindergarten|foundation|\bprep\b|reception|primary/.test(g)) return true;
  if (/[一二三四五六七八九]年级/.test(g)) return true;
  const m = g.match(/(?:year|grade|yr|gr\.?|p)\s*(\d{1,2})\b/) ?? g.match(/^(\d{1,2})\s*(?:年级|th|st|nd|rd)?$/);
  return m ? Number(m[1]) <= 8 : false;
}

/**
 * The effort of the first independent solve, or undefined for the configured default (which a
 * later disagreement is not checked again against).
 */
export function baseSolveEffort(q: { grade?: string; difficulty?: number | DifficultyLevel; gradeLevel?: GradeLevel }): SolveEffort | undefined {
  const setting = (process.env.GENERATE_SOLVE_EFFORT ?? "auto").trim().toLowerCase();
  if (setting === "default") return undefined;
  if (setting === "low" || setting === "medium" || setting === "high") return setting;
  const early = isEarlyGrade(q.gradeLevel ?? q.grade);
  const hard = q.difficulty === "competition" || (typeof q.difficulty === "number" && q.difficulty >= 4);
  return early && !hard ? "medium" : undefined;
}

/** Whether a solve at this effort is checked again at high when it disagrees. */
export function escalates(effort: SolveEffort | undefined): boolean {
  return effort === "low" || effort === "medium";
}
