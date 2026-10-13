/**
 * Worksheets of generated questions for printing / saving as PDF (app/print/page.tsx).
 *
 * Sources: a bank generation (/print?bank=&gen=[&ids=a,b]) — the bank page's generator and the
 * problem generator's bank mode — or questions handed over in localStorage (/print?key=…) for the
 * built-in generator, whose questions are not stored on the server. Browser-safe.
 */
import type { Candidate } from "./types";

export interface WorksheetQuestion {
  id: string;
  stem: string;
  options?: string[];
  answer: string;
  solution?: string;
  /** SVG of the question's figure (drawn by the program for paper, or the model's sketch). */
  figureSvg?: string;
  passed?: boolean;
}

export interface Worksheet {
  title: string;
  questions: WorksheetQuestion[];
}

const LETTERS = "ABCDEFGHIJ";

export function fromCandidates(candidates: Candidate[]): WorksheetQuestion[] {
  return candidates.map((c) => ({
    id: c.id,
    stem: c.stem,
    options: c.options?.length ? c.options : undefined,
    answer: c.answer,
    solution: c.solution,
    figureSvg: c.figure?.svg,
    passed: c.passed,
  }));
}

/** "C. 12" for a choice (each letter of a multi-select answer with its option), else the answer as written. */
export function answerText(q: Pick<WorksheetQuestion, "answer" | "options">): string {
  if (!q.options?.length) return q.answer;
  const letters = (q.answer.toUpperCase().match(/[A-J]/g) ?? []).filter((l, i, a) => a.indexOf(l) === i);
  if (!letters.length || letters.some((l) => LETTERS.indexOf(l) >= q.options!.length)) return q.answer;
  return letters.map((l) => `${l}. ${q.options![LETTERS.indexOf(l)]}`).join("；");
}

/** Short options sit side by side (A. 6   B. 10   C. 12   D. 15); long ones one per line. */
export function optionColumns(options: string[]): 1 | 2 | 4 {
  const len = Math.max(...options.map((o) => o.replace(/\$[^$]*\$/g, "xx").length));
  if (options.length <= 4 && len <= 10) return 4;
  if (len <= 28) return 2;
  return 1;
}

const KEY_PREFIX = "worksheet:";

/** Hand questions to the print page (opened in a new tab); returns the URL to open. */
export function stashWorksheet(ws: Worksheet): string {
  const key = Math.random().toString(36).slice(2, 10);
  try {
    // Old hand-overs are removed so storage does not fill up.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(KEY_PREFIX)) localStorage.removeItem(k);
    }
    localStorage.setItem(KEY_PREFIX + key, JSON.stringify(ws));
  } catch {
    /* storage unavailable: the print page says so */
  }
  return `/print?key=${key}`;
}

export function loadStashedWorksheet(key: string): Worksheet | null {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + key);
    return raw ? (JSON.parse(raw) as Worksheet) : null;
  } catch {
    return null;
  }
}

/** Print-page URL for a bank generation (optionally only some of its candidates). */
export function generationPrintHref(bankId: string, generationId: string, ids?: string[]): string {
  const p = new URLSearchParams({ bank: bankId, gen: generationId });
  if (ids?.length) p.set("ids", ids.join(","));
  return `/print?${p.toString()}`;
}
