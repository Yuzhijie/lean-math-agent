/**
 * Writing a paper's questions (server side): each part is generated — by the built-in generator
 * with the part's focus (kind, skills, difficulty, variants of questions got wrong), or from the
 * teacher's bank with the part's knowledge point or category as the template — and every question
 * goes through the generator's own checks; only questions that pass go on the paper, the others
 * are kept with their reasons. The run is detached from the request that started it: it writes
 * its progress to the exam, a page polls the exam, and a run cut off by a server restart is told
 * apart by the server's start id (lib/boot.ts). The same run fills the parts that are short.
 */
import { randomUUID } from "node:crypto";
import { bootId } from "../boot";
import { difficultyLevelOf } from "../bank/generator-bridge";
import { generateFromTemplate } from "../bank/generate";
import type { Candidate } from "../bank/types";
import { examDoc, examOf, putExamDoc } from "../grading/store";
import { generateProblems } from "../llm/generate-problem";
import { lt } from "../llm/output-locale";
import type { GeneratedProblem } from "../types";
import { missingByPart, numberQuestions, type Exam, type ExamKind, type ExamPart, type ExamQuestion, type RejectedQuestion } from "./types";

const LETTERS = "ABCDEFGH";

/** A choice question's stem and options: option lines "A. …" at the end, or all on the last line ("A. 3  B. 4  C. 5  D. 6"). */
export function splitChoice(statement: string): { stem: string; options?: string[] } {
  const lines = statement.replace(/\r/g, "").split("\n");
  const opt = /^\s*\(?([A-H])\s*[.．、)）:：]\s*(.*?)\s*$/;
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  let start = end;
  while (start > 0 && opt.test(lines[start - 1])) start--;
  const found = lines.slice(start, end).map((l) => opt.exec(l)!);
  if (found.length >= 2 && found.every((m, i) => m[1] === LETTERS[i])) {
    return { stem: lines.slice(0, start).join("\n").trim(), options: found.map((m) => m[2]) };
  }
  // one line: "A. 3   B. 4   C. 5   D. 6"
  const last = lines[end - 1] ?? "";
  const inline = [...last.matchAll(/(?:^|\s)\(?([A-H])\s*[.．、)）]\s*(.+?)(?=\s+\(?[A-H]\s*[.．、)）]\s|$)/g)];
  if (inline.length >= 2 && inline.every((m, i) => m[1] === LETTERS[i])) {
    return { stem: lines.slice(0, end - 1).join("\n").trim(), options: inline.map((m) => m[2].trim()) };
  }
  return { stem: statement.trim() };
}

/** The letter of a choice answer ("B", "B. 12", "（B）"), when it names one of the options. */
export function choiceLetter(answer: string, options: number): string | undefined {
  const m = /^[\s(（[]*([A-H])(?![A-Za-z])/i.exec(answer);
  const l = m?.[1].toUpperCase();
  return l && LETTERS.indexOf(l) < options ? l : undefined;
}

const KIND_OF_TYPE: Record<string, ExamKind> = { multiple_choice: "choice", numeric: "blank", short_answer: "solve", proof: "proof" };

function checkedWords(p: GeneratedProblem): string {
  const v = p.verification;
  const out: string[] = [];
  if (v?.solved_by === "program") out.push(lt("答案由程序算出", "answer computed by the program"));
  else if (v?.checks.answer.ok && !v.checks.answer.skipped) out.push(lt("独立重解一致", "independent solve agrees"));
  if (v?.checks.counterexample.ok && !v.checks.counterexample.skipped) out.push(lt("Lean 未找到反例", "no counterexample in Lean"));
  if (v?.lean?.proved) out.push(lt("Lean 已证", "proved in Lean"));
  return out.join(" · ");
}

function failedWords(checks: Record<string, { ok: boolean; detail: string; skipped?: boolean } | undefined>): string {
  return Object.values(checks)
    .filter((c): c is { ok: boolean; detail: string } => !!c && !c.ok)
    .map((c) => c.detail)
    .join("; ")
    .slice(0, 600);
}

/** A built-in problem as a question of the part (choice questions split into stem and options). */
export function fromBuiltin(p: GeneratedProblem, part: ExamPart): ExamQuestion {
  let stem = p.statement.trim();
  let options: string[] | undefined;
  let answer = p.answer.trim();
  if (part.kind === "choice") {
    const s = splitChoice(stem);
    const letter = s.options ? choiceLetter(answer, s.options.length) : undefined;
    if (s.options && letter) {
      stem = s.stem;
      options = s.options;
      answer = letter;
    }
  }
  return {
    id: randomUUID().replace(/-/g, "").slice(0, 12),
    no: "",
    part_id: part.id,
    kind: part.kind,
    stem,
    ...(options ? { options } : {}),
    answer,
    hints: p.hints ?? [],
    knowledge_points: part.knowledge_points,
    difficulty: part.difficulty,
    points: part.points,
    ...(p.diagram_svg ? { figure_svg: p.diagram_svg } : {}),
    ...(checkedWords(p) ? { checked: checkedWords(p) } : {}),
    ...(p.verification?.lean?.proved ? { lean_proved: true } : {}),
    source: { kind: "builtin" },
  };
}

/** A bank candidate as a question of the part (its kind follows the bank template's type). */
export function fromCandidate(c: Candidate, part: ExamPart, bankId: string, generationId: string): ExamQuestion {
  const kind = KIND_OF_TYPE[c.type] ?? part.kind;
  const letter = c.type === "multiple_choice" && c.options?.length ? choiceLetter(c.answer, c.options.length) : undefined;
  return {
    id: randomUUID().replace(/-/g, "").slice(0, 12),
    no: "",
    part_id: part.id,
    kind,
    stem: c.stem,
    ...(c.options?.length ? { options: c.options } : {}),
    answer: letter ?? c.answer,
    ...(c.solution ? { solution: c.solution } : {}),
    hints: c.hints,
    knowledge_points: part.knowledge_points.length ? part.knowledge_points : c.knowledge_points.slice(0, 3),
    difficulty: c.difficulty ?? part.difficulty,
    points: part.points,
    ...(c.figure ? { figure_svg: c.figure.svg, figure_description: c.figure.description } : {}),
    checked: lt("题库模板 · 独立重解与相似度检查通过", "bank template · independent solve and novelty checks passed"),
    source: { kind: "bank", bank_id: bankId, generation_id: generationId, candidate_id: c.id },
  };
}

export interface PartResult {
  questions: ExamQuestion[];
  rejected: RejectedQuestion[];
  note?: string;
}

/** Test seam: how one part is written (the generators). */
export type PartWriter = (part: ExamPart, need: number, exam: Exam, onProgress: (detail: string) => void) => Promise<PartResult>;

export const writePart: PartWriter = async (part, need, exam, onProgress) => {
  if (part.source.kind === "bank") {
    const g = await generateFromTemplate({
      owner: exam.owner,
      bankId: part.source.bank_id,
      template: {
        selection: {
          ...(part.source.knowledge_point ? { knowledge_point: part.source.knowledge_point } : {}),
          ...(part.source.category_id ? { category_id: part.source.category_id } : {}),
          difficulty: part.difficulty,
        },
      },
      count: need,
      onProgress: (p) => onProgress(p.detail),
    });
    const passed = g.candidates.filter((c) => c.passed).slice(0, need);
    return {
      questions: passed.map((c) => fromCandidate(c, part, g.bank_id, g.id)),
      rejected: g.candidates.filter((c) => !c.passed).map((c) => ({ part_id: part.id, stem: c.stem, answer: c.answer, reason: failedWords(c.checks) || lt("没有通过检查", "did not pass the checks") })),
      ...(g.note ? { note: g.note } : {}),
    };
  }
  const r = await generateProblems({
    gradeLevel: exam.grade_level,
    difficulty: difficultyLevelOf(part.difficulty),
    domain: part.source.domain,
    count: need,
    focus: { kind: part.kind, knowledge_points: part.knowledge_points, difficulty: part.difficulty, like: part.like },
    onProgress: (p) => onProgress(p.detail),
  });
  const passed = r.problems.filter((p) => p.verification?.passed).slice(0, need);
  return {
    questions: passed.map((p) => fromBuiltin(p, part)),
    rejected: r.problems
      .filter((p) => !p.verification?.passed)
      .map((p) => ({ part_id: part.id, stem: p.statement, answer: p.answer, reason: p.verification ? failedWords(p.verification.checks) || lt("没有通过检查", "did not pass the checks") : lt("没有检查", "not checked") })),
  };
};

const partName = (exam: Exam, part: ExamPart) => {
  const n = exam.parts.findIndex((p) => p.id === part.id) + 1;
  return lt(`第 ${n} 部分`, `Part ${n}`);
};

/** Interrupted by a server restart: the run that was generating it is gone. */
export function reconcile(exam: Exam): Exam {
  if (exam.status !== "generating" || exam.run === bootId()) return exam;
  const missing = [...missingByPart(exam).values()].reduce((a, b) => a + b, 0);
  const note = [exam.note, lt(`生成被中断（服务器重启），缺 ${missing} 道题；可以点“补齐缺题”继续。`, `Generation was interrupted (the server restarted); ${missing} question(s) missing — use “Fill in the missing questions” to go on.`)].filter(Boolean).join("\n");
  const { progress: _p, ...rest } = exam;
  void _p;
  return putExamDoc({ ...rest, status: exam.questions.length ? "partial" : "failed", note: note.slice(0, 1500), updated_at: Date.now() });
}

/** The exam for its owner, a run cut off by a restart marked as such. */
export function examFor(owner: string, id: string): Exam {
  return reconcile(examOf(owner, id));
}

/**
 * Writes the questions the parts still need (all of them for a new exam), `EXAM_PART_CONCURRENCY`
 * parts at a time (default 2). Returns the exam as it ends, or undefined when it was deleted.
 */
export async function runExam(examId: string, opts: { write?: PartWriter } = {}): Promise<Exam | undefined> {
  const write = opts.write ?? writePart;
  const start = examDoc(examId);
  if (!start) return undefined;
  const need = missingByPart(start);
  const todo = start.parts.filter((p) => need.has(p.id));
  const run = bootId();
  const notes: string[] = [];
  /** Parts whose writing threw, with what it threw. */
  const failures = new Map<string, string>();
  let done = 0;
  const save = (change: (e: Exam) => Exam): Exam | undefined => {
    const cur = examDoc(examId);
    if (!cur) return undefined;
    return putExamDoc({ ...change(cur), updated_at: Date.now() });
  };
  save((e) => ({ ...e, status: "generating", run, progress: { part: 0, parts: todo.length, message: lt(`开始生成 ${todo.length} 个部分…`, `Starting ${todo.length} part(s)…`) } }));

  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= todo.length) return;
      const part = todo[i];
      const cur = examDoc(examId);
      if (!cur || cur.status === "cancelled") return;
      const name = partName(cur, part);
      const say = (detail: string) => save((e) => (e.status === "generating" ? { ...e, progress: { part: done, parts: todo.length, message: `${name}：${detail}`.slice(0, 400) } } : e));
      say(lt(`正在出 ${need.get(part.id)} 道题…`, `writing ${need.get(part.id)} question(s)…`));
      let result: PartResult;
      try {
        result = await write(part, need.get(part.id)!, cur, say);
      } catch (e) {
        failures.set(part.id, (e instanceof Error ? e.message : String(e)).slice(0, 240));
        done++;
        continue;
      }
      done++;
      if (result.note) notes.push(`${name}：${result.note}`.slice(0, 300));
      save((e) => ({
        ...e,
        questions: numberQuestions([...e.questions, ...result.questions], e.parts),
        rejected: [...e.rejected, ...result.rejected].slice(-200),
        ...(e.status === "generating" ? { progress: { part: done, parts: todo.length, message: lt(`${name}完成：${result.questions.length} 道通过检查`, `${name} done: ${result.questions.length} passed the checks`) } } : {}),
      }));
    }
  };
  const n = Math.max(1, Math.min(Number(process.env.EXAM_PART_CONCURRENCY ?? 2) || 2, todo.length || 1));
  await Promise.all(Array.from({ length: n }, worker));

  return save((e) => {
    const missing = missingByPart(e);
    // a part that could not be written says why once (every part with the same reason: one line); a part short of questions that passed says so
    const reasons = [...new Set(failures.values())];
    const failed =
      failures.size > 1 && reasons.length === 1
        ? [lt(`${failures.size} 个部分出题失败：${reasons[0]}`, `${failures.size} parts could not be written: ${reasons[0]}`)]
        : e.parts.filter((p) => failures.has(p.id)).map((p) => lt(`${partName(e, p)}出题失败：${failures.get(p.id)}`, `${partName(e, p)} could not be written: ${failures.get(p.id)}`));
    const short = e.parts
      .filter((p) => missing.has(p.id) && !failures.has(p.id))
      .map((p) => lt(`${partName(e, p)}缺 ${missing.get(p.id)} 道（没有通过检查的题不放进试卷）`, `${partName(e, p)} is ${missing.get(p.id)} short (questions that failed their checks are left out)`));
    // a stop keeps the teacher's note; a finished run replaces what an earlier run said
    const note = [e.status === "cancelled" ? e.note : undefined, ...failed, ...notes, ...short].filter(Boolean).join("\n").slice(0, 1500);
    const { progress: _p, ...rest } = e;
    void _p;
    const status = e.status === "cancelled" ? "cancelled" : !e.questions.length ? "failed" : missing.size ? "partial" : "ready";
    return { ...rest, status, note: note || undefined };
  });
}
