/**
 * The whole marking run of a paper (server side): read all pages → mark every question → store
 * one submission per question → diagnose the paper. Progress goes to `onProgress`; the stored
 * paper is returned (undefined when the student was removed meanwhile).
 */
import { lt } from "../llm/output-locale";
import { diagnose } from "./diagnosis";
import { markPaperQuestions, parseAnswerKey, readPaper, worksheetQuestions, type WorksheetQuestion } from "./paper";
import { getClass, putSubmission, savePaperResult } from "./store";
import type { Member, Paper, Submission } from "./types";

export type PaperProgress = { stage: "reading" | "marking" | "diagnosing"; done?: number; total?: number; message: string };

export async function runPaper(args: {
  paper: Paper;
  member: Member;
  imageUrls: string[];
  onProgress?: (p: PaperProgress) => void;
}): Promise<Paper | undefined> {
  const { member } = args;
  let paper = args.paper;
  const teacher = getClass(member.class_id).owner;
  const say = args.onProgress ?? (() => undefined);

  say({ stage: "reading", message: lt(`正在读 ${args.imageUrls.length} 页答卷…`, `Reading ${args.imageUrls.length} page(s)…`) });
  let read: Awaited<ReturnType<typeof readPaper>>;
  try {
    read = await readPaper(args.imageUrls);
  } catch (e) {
    // Kept as a failed paper (with its photos) so it can be seen and deleted, not lost.
    const msg = e instanceof Error ? e.message : String(e);
    return savePaperResult({ ...paper, title: paper.title || lt("答卷", "Paper"), status: "failed", error: lt(`读卷失败：${msg}`, `Reading failed: ${msg}`).slice(0, 500) }, { isNew: true });
  }
  if (!read.questions.length) {
    return savePaperResult({ ...paper, title: paper.title || read.title || lt("答卷", "Paper"), status: "failed", error: read.note ?? lt("照片里没有读到题目和作答", "No questions or answers could be read from the photos") }, { isNew: true });
  }

  let sheet: WorksheetQuestion[] | undefined;
  if (paper.source.bank_id && paper.source.generation_id) {
    try {
      sheet = worksheetQuestions(teacher, paper.source.bank_id, paper.source.generation_id);
    } catch {
      sheet = undefined;
    }
  }
  const total = read.questions.length;
  say({ stage: "marking", done: 0, total, message: lt(`读到 ${total} 道题，逐题批改中…`, `Found ${total} questions; marking each…`) });
  const marked = await markPaperQuestions(read.questions, {
    answerKey: parseAnswerKey(paper.source.answer_key),
    sheet,
    onProgress: (done) => say({ stage: "marking", done, total, message: lt(`已批改 ${done}/${total} 题`, `Marked ${done}/${total}`) }),
  });

  const subs: Submission[] = marked.map((q, i) => ({
    id: `${paper.id}q${i + 1}`,
    class_id: member.class_id,
    member_id: member.id,
    submitted_by: paper.submitted_by,
    problem: { text: q.question || lt(`第 ${q.number} 题（题目没读清）`, `Question ${q.number} (not readable)`), ...(q.figure ? { figure: q.figure } : {}) },
    reference: q.reference,
    images: [],
    reading: q.reading,
    ...(q.marking ? { marking: q.marking, status: "marked" as const } : { status: "failed" as const, error: q.error }),
    paper_id: paper.id,
    question_no: q.number,
    ...(q.question ? {} : { question_unread: true }),
    created_at: paper.created_at,
  }));
  const failed = subs.filter((s) => s.status === "failed").length;

  say({ stage: "diagnosing", message: lt("正在分析解题思路和知识点掌握…", "Analysing the approach and the skills…") });
  const numbers = new Map(subs.map((s) => [s.id, s.question_no ?? ""]));
  const diagnosis = await diagnose({ submissions: subs, numbers, owner: teacher }).catch(() => undefined);

  paper = {
    ...paper,
    title: (paper.title || read.title || lt(`答卷（${subs.length} 题）`, `Paper (${subs.length} questions)`)).slice(0, 200),
    status: failed === subs.length ? "failed" : failed ? "partial" : "marked",
    ...(read.note ? { note: read.note } : {}),
    submission_ids: subs.map((s) => s.id),
    ...(diagnosis ? { diagnosis } : {}),
  };
  const saved = savePaperResult(paper, { isNew: true });
  if (saved) for (const s of subs) putSubmission(s);
  return saved;
}
