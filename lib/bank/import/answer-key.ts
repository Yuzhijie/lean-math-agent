/**
 * Answer keys printed in a paper ("Results / Question number / Correct answer / Category / Descriptor",
 * "答案：1.C 2.B …"): found on a PDF's text pages, kept out of the questions, and used to fill in the
 * answers of the questions read from the other pages (by question number).
 *
 * Three layouts are recognised, because PDF text extraction keeps them differently:
 *  - columns  — all the numbers 1…N on their own lines, then the N answers, (then N categories)
 *  - rows     — "12  C  Number & Arithmetic …" one question per line
 *  - inline   — "1.C 2.B 3.A …" in running text
 */
import { lt } from "@/lib/llm/output-locale";
import { LETTERS, normaliseChoiceAnswer, type ParsedQuestion } from "./fields";

export interface AnswerKeyEntry {
  answer: string;
  /** Strand / category printed next to it (e.g. "Number & Arithmetic"). */
  category?: string;
}
export type AnswerKey = Map<string, AnswerKeyEntry>;

/** A short answer token: a letter, a number, a fraction, or a few characters. */
const ANSWER = /^(?:[A-Ja-j]|[-−]?\d+(?:[.,]\d+)?(?:\s*\/\s*\d+)?|[^\s]{1,8})$/;
const MIN_ENTRIES = 5;

function fromColumns(lines: string[]): AnswerKey | null {
  // Longest run of lines 1, 2, 3, …
  let best = { start: -1, len: 0 };
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== "1") continue;
    let n = 1;
    while (i + n < lines.length && lines[i + n] === String(n + 1)) n++;
    if (n > best.len) best = { start: i, len: n };
  }
  const N = best.len;
  if (N < MIN_ENTRIES) return null;
  const answers = lines.slice(best.start + N, best.start + 2 * N);
  if (answers.length < N || !answers.every((a) => ANSWER.test(a))) return null;
  // Most answers should look like choices or numbers (not words of a sentence).
  if (answers.filter((a) => /^[A-Ja-j]$|^[-−]?\d/.test(a)).length < N * 0.8) return null;
  const key: AnswerKey = new Map(answers.map((a, i) => [String(i + 1), { answer: a }]));
  // A column of N short, repeated labels after the header words: the categories.
  // Lines made of column headings only ("Category", "number Correct", "answer Mark Descriptor").
  const HEADER = /^(?:(?:category|question|number|no\.?|correct|answer|mark|marks|descriptor|strand|topic|skill|题号|答案|分类|类别|得分)\s*)+$/i;
  const rest = lines.slice(best.start + 2 * N).filter((l) => !HEADER.test(l));
  for (let k = 0; k + N <= rest.length && k < 8; k++) {
    const col = rest.slice(k, k + N);
    if (col.every((c) => c.length <= 40 && !/\d/.test(c)) && new Set(col).size <= Math.max(2, Math.ceil(N / 2))) {
      col.forEach((c, i) => (key.get(String(i + 1))!.category = c));
      break;
    }
  }
  return key;
}

function fromRows(lines: string[]): AnswerKey | null {
  const key: AnswerKey = new Map();
  for (const l of lines) {
    const m = /^\s*(\d{1,3})\s*[.)、:：]?\s+([A-Ja-j]|[-−]?\d+(?:[.,]\d+)?(?:\s*\/\s*\d+)?)(?:\s{2,}|\s+(?=[A-Z][a-z])|\s*$)(.*)$/.exec(l);
    if (!m) continue;
    const category = m[3]?.split(/\s{2,}/)[0]?.trim();
    key.set(String(Number(m[1])), { answer: m[2], ...(category && category.length <= 40 && !/\d/.test(category) ? { category } : {}) });
  }
  return consecutive(key) ? key : null;
}

function fromInline(text: string): AnswerKey | null {
  const key: AnswerKey = new Map();
  for (const m of text.matchAll(/(?:^|[\s,，;；:：])(\d{1,3})\s*[.、:：)）]\s*([A-Ja-j])(?=$|[\s,，;；.。])/g)) key.set(String(Number(m[1])), { answer: m[2] });
  return consecutive(key) ? key : null;
}

/** At least MIN_ENTRIES answers, numbered 1, 2, 3, … without large gaps. */
function consecutive(key: AnswerKey): boolean {
  if (key.size < MIN_ENTRIES || !key.has("1")) return false;
  let n = 0;
  while (key.has(String(n + 1))) n++;
  return n >= Math.min(key.size, MIN_ENTRIES) && n >= key.size * 0.8;
}

/** The answer key on a page of text, or null when the page is not one. */
export function parseAnswerKey(pageText: string): AnswerKey | null {
  const lines = pageText.split(/\r?\n/).map((l) => l.replace(/[^\S\n]+/g, " ").trim()).filter(Boolean);
  const looksLikeKey = /correct\s*answer|answer\s*key|answers?\b|results|答案|参考答案/i.test(pageText);
  const key = fromColumns(lines) ?? fromRows(pageText.split(/\r?\n/)) ?? (looksLikeKey ? fromInline(pageText) : null);
  if (!key) return null;
  // Column/row keys need no heading (their shape is distinctive); a loose inline list does.
  return key;
}

const labelNumber = (q: ParsedQuestion) => {
  const m = /\d{1,3}/.exec(q.fields.source?.label ?? "");
  return m ? String(Number(m[0])) : undefined;
};

/**
 * Fill in answers from the key, by question number (or by order when no question has a number and the
 * counts agree). Existing answers are kept; a disagreement is reported on the draft.
 */
export function applyAnswerKey(questions: ParsedQuestion[], key: AnswerKey): { questions: ParsedQuestion[]; filled: number } {
  const numbered = questions.some((q) => labelNumber(q));
  const byOrder = !numbered && questions.length === key.size;
  let filled = 0;
  const out = questions.map((q, i) => {
    const n = numbered ? labelNumber(q) : byOrder ? String(i + 1) : undefined;
    const entry = n ? key.get(n) : undefined;
    if (!entry) return q;
    const f = { ...q.fields };
    const issues = [...q.issues];
    let answer = entry.answer.replace(/−/g, "-");
    if (f.options?.length) {
      if (/^[A-Ja-j]$/.test(answer)) {
        answer = answer.toUpperCase();
        if (LETTERS.indexOf(answer) >= f.options.length) issues.push(lt(`答案页写的是 ${answer}，但这道题只有 ${f.options.length} 个选项`, `The answer key says ${answer}, but this question has only ${f.options.length} options`));
      } else {
        // A value: the option that says it.
        const idx = f.options.findIndex((o) => o.replace(/\s|\$/g, "") === answer.replace(/\s/g, ""));
        if (idx >= 0) answer = LETTERS[idx];
      }
    }
    if (f.answer?.trim()) {
      const have = f.options?.length ? normaliseChoiceAnswer(f.answer) : f.answer.trim();
      if (have !== answer) issues.push(lt(`答案页写的是 ${answer}，题目里是 ${f.answer}`, `The answer key says ${answer}, the question says ${f.answer}`));
    } else {
      f.answer = answer;
      filled++;
    }
    if (entry.category && !(f.tags ?? []).includes(entry.category)) f.tags = [...(f.tags ?? []), entry.category].slice(0, 30);
    return { ...q, fields: f, issues };
  });
  return { questions: out, filled };
}
