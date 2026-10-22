/**
 * A whole paper (答卷): photos of every page → the questions on it, each student's working and
 * final answer (one vision call over all pages) → a reference answer per question (the teacher's
 * answer key, else the matching question of the printed bank worksheet, else solved by the model)
 * → each question judged like a single piece of work (mark.ts judgeWork), a few at a time.
 */
import { z } from "zod";
import { chatJson } from "../llm/client";
import { getGeneration } from "../bank/store";
import { stemSimilarity } from "../bank/similarity";
import { bankProblemText } from "./reference";
import { compareAnswers, judgeWork, solveReference } from "./mark";
import type { Marking, Reading, Reference } from "./types";

export const MAX_PAPER_IMAGES = 12;
export const MAX_PAPER_QUESTIONS = 30;

const paperOut = z.object({
  readable: z.boolean().nullish(),
  title: z.string().nullish(),
  questions: z
    .array(
      z.object({
        number: z.union([z.string(), z.number()]).transform(String),
        question: z.string().nullish(),
        figure: z.string().nullish(),
        steps: z.array(z.union([z.string(), z.object({ text: z.string(), crossed_out: z.boolean().nullish(), unclear: z.boolean().nullish() })])).default([]),
        final_answer: z.string().nullish(),
      }),
    )
    .default([]),
  note: z.string().nullish(),
});

export const READ_PAPER_SYSTEM = `You read a student's whole answered maths paper (a test or worksheet) from photos of its pages, in order, for a teacher who will mark it.
For EVERY question on the paper, in order, return one entry:
- "number": the question number as printed ("1", "2(a)", "例3"); number them 1, 2, 3… if none is printed.
- "question": the printed question exactly as written (LaTeX between $ … $; multiple-choice options one per line as "A. …"); empty if it is not visible on the photos.
- "figure": if the question has a printed figure, describe exactly what a solver needs (shapes, labels, given values); else empty.
- "steps": the student's OWN handwritten working for that question, line by line, EXACTLY as written — keep every mistake, never correct or complete anything. Mark crossed-out lines "crossed_out": true and doubtful readings "unclear": true. For a multiple-choice question with only a circled/written letter, steps may be empty.
- "final_answer": the student's answer as written (a chosen letter, a boxed or underlined result, the last result); empty if they gave none.
A question the student left blank still gets an entry (empty steps and answer). Ignore the teacher's marks. Maths in LaTeX between $ … $.
Also "title": the paper's title if printed; "readable": false if no paper can be read; "note": anything the teacher should know (a page cut off, pages out of order).
Return JSON: {"readable":true,"title":"","questions":[{"number":"1","question":"…","figure":"","steps":[{"text":"…"}],"final_answer":"…"}],"note":""}`;

export interface PaperQuestion {
  number: string;
  question: string;
  figure?: string;
  reading: Reading;
}

export async function readPaper(imageUrls: string[]): Promise<{ title?: string; questions: PaperQuestion[]; note?: string }> {
  const r = await chatJson({
    role: "vision",
    system: READ_PAPER_SYSTEM,
    user: `Read the student's answered paper in the ${imageUrls.length} attached page photo(s), in order, and return the JSON.`,
    images: imageUrls,
    schema: paperOut,
    schemaName: "student_paper",
    temperature: 0,
    maxTokens: 16000,
    maxRetries: 1,
    keepLanguage: true,
  });
  if (r.readable === false) return { questions: [], ...(r.note ? { note: r.note } : {}) };
  const questions = r.questions.slice(0, MAX_PAPER_QUESTIONS).map((q, i) => {
    const steps = q.steps
      .map((s) => (typeof s === "string" ? { text: s } : { text: s.text, ...(s.crossed_out ? { crossed_out: true } : {}), ...(s.unclear ? { unclear: true } : {}) }))
      .filter((s) => s.text.trim());
    const final = q.final_answer?.trim();
    return {
      number: q.number.trim() || String(i + 1),
      question: q.question?.trim() ?? "",
      ...(q.figure?.trim() ? { figure: q.figure.trim() } : {}),
      // A blank question is still readable work: it has no answer.
      reading: { readable: true, steps, ...(final ? { final_answer: final } : {}) } satisfies Reading,
    };
  });
  return { ...(r.title?.trim() ? { title: r.title.trim() } : {}), questions, ...(r.note?.trim() ? { note: r.note.trim() } : {}) };
}

/** "1. 3\n2) C\n3：x=2\n4 A,D" → number → answer. */
export function parseAnswerKey(text: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of (text ?? "").split(/\n|；|;(?=\s*\d)/)) {
    // A sub-question is "5a" (no space) or "5(a)"; "7 x = 3" and "4 A B" are answers, not sub-questions.
    const m = /^\s*(?:第\s*)?(\d+(?:[a-z](?![a-z])|\s*[(（]\s*[a-z]\s*[)）])?)\s*(?:题)?\s*[.)、．:：]?\s+(.+?)\s*$/i.exec(line) ?? /^\s*(\d+)[.)、．:：]\s*(.+?)\s*$/.exec(line);
    if (m) out.set(normNo(m[1]), m[2].trim());
  }
  return out;
}

const normNo = (n: string) => n.replace(/\s|[()（）]/g, "").toLowerCase();

export interface WorksheetQuestion {
  text: string;
  answer: string;
  solution?: string;
  knowledge_points: string[];
}

/** The questions of a printed bank worksheet (a generation), as the solver sees them. */
export function worksheetQuestions(owner: string, bankId: string, generationId: string): WorksheetQuestion[] {
  const g = getGeneration(owner, bankId, generationId);
  return g.candidates.map((c) => ({ text: bankProblemText(c), answer: c.answer, ...(c.solution ? { solution: c.solution } : {}), knowledge_points: c.knowledge_points }));
}

/** The worksheet question a read question is (same text, or the same position when the text was not readable). */
export function matchWorksheet(q: { number: string; question: string }, index: number, sheet: WorksheetQuestion[]): WorksheetQuestion | undefined {
  if (q.question) {
    let best: { w: WorksheetQuestion; s: number } | undefined;
    for (const w of sheet) {
      const s = stemSimilarity(q.question, w.text);
      if (!best || s > best.s) best = { w, s };
    }
    if (best && best.s >= 0.5) return best.w;
  }
  const n = Number(q.number);
  if (Number.isInteger(n) && n >= 1 && n <= sheet.length) return sheet[n - 1];
  return sheet[index];
}

/** The text a solver gets for a question with a printed figure. */
export const withFigure = (problem: string, figure?: string) => (figure ? `${problem}\n\n[Figure: ${figure}]` : problem);

export interface MarkedQuestion extends PaperQuestion {
  reference: Reference;
  marking?: Marking;
  error?: string;
}

/** Marks every question: reference (key > worksheet > solved), then judged, `concurrency` at a time. */
export async function markPaperQuestions(
  questions: PaperQuestion[],
  opts: { answerKey?: Map<string, string>; sheet?: WorksheetQuestion[]; concurrency?: number; onProgress?: (done: number, total: number) => void },
): Promise<MarkedQuestion[]> {
  const out: MarkedQuestion[] = new Array(questions.length);
  let next = 0;
  let done = 0;
  const work = async () => {
    for (;;) {
      const i = next++;
      if (i >= questions.length) return;
      const q = questions[i];
      const keyed = opts.answerKey?.get(normNo(q.number));
      const fromSheet = opts.sheet?.length ? matchWorksheet(q, i, opts.sheet) : undefined;
      const problem = q.question || fromSheet?.text || "";
      let reference: Reference = keyed
        ? // The worksheet's solution only when it is the same question (its answer agrees with the key).
          { answer: keyed, source: "teacher", ...(fromSheet?.solution && compareAnswers(keyed, fromSheet.answer) === true ? { solution: fromSheet.solution } : {}) }
        : fromSheet
          ? { answer: fromSheet.answer, ...(fromSheet.solution ? { solution: fromSheet.solution } : {}), source: "bank" }
          : { source: "none" };
      try {
        if (!problem) throw new Error("the question could not be read");
        if (!reference.answer) {
          const solved = await solveReference(withFigure(problem, q.figure)).catch(() => undefined);
          if (solved?.answer) reference = { ...solved, source: "model" };
        }
        const marking = await judgeWork({ problem, figure: q.figure, reference, reading: q.reading });
        out[i] = { ...q, question: problem, reference, marking };
      } catch (e) {
        out[i] = { ...q, question: problem, reference, error: e instanceof Error ? e.message : String(e) };
      }
      opts.onProgress?.(++done, questions.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 3, questions.length)) }, work));
  return out;
}
