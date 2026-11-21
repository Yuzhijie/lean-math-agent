/**
 * What the exam routes do (server side): create an exam from a blueprint and start its run,
 * change it, plan the next paper from marked work.
 */
import { randomUUID } from "node:crypto";
import { bootId } from "../boot";
import { BankError, getBank } from "../bank/store";
import { ownerBanks } from "../grading/diagnosis";
import { accessToMember, examDoc, examsOf, getMemberDiagnosis, getPaper, membersOf, putExamDoc, submissionsOf, teacherGroup } from "../grading/store";
import type { Submission } from "../grading/types";
import { lt } from "../llm/output-locale";
import { domainAllowed, GRADE_LEVELS, type GradeLevel } from "../types";
import { classRecords, planBasis, planExam, PlanError, skillRecords, type SkillRecord } from "./plan";
import { examFor, reconcile, runExam } from "./run";
import { blueprintSchema, examTotal, missingByPart, numberQuestions, planBasisSchema, plannedTotal, type Blueprint, type Exam, type PlanBasis } from "./types";

/** Marked work a plan is made from: the latest 40 marked questions of a student (as the diagnosis). */
export const PLAN_WINDOW = 40;

const newId = () => randomUUID().replace(/-/g, "").slice(0, 10);

export function examSummary(e: Exam) {
  return {
    id: e.id,
    title: e.title,
    grade_level: e.grade_level,
    status: e.status,
    questions: e.questions.length,
    planned: e.parts.reduce((a, p) => a + p.count, 0),
    total: examTotal(e.questions),
    parts: e.parts.length,
    ...(e.basis ? { basis: { scope: e.basis.scope, name: e.basis.name, ...(e.basis.member_id ? { member_id: e.basis.member_id } : {}) } } : {}),
    ...(e.progress ? { progress: e.progress } : {}),
    created_at: e.created_at,
    updated_at: e.updated_at,
  };
}

export function listExams(owner: string) {
  return examsOf(owner).map((e) => examSummary(reconcile(e)));
}

function generating(owner: string): Exam | undefined {
  return examsOf(owner).find((e) => e.status === "generating" && e.run === bootId());
}

/** Starts the run without waiting for it; a run that throws leaves the exam failed with the reason. */
function start(id: string): void {
  void runExam(id).catch((e) => {
    console.error("[exam run]", e);
    const cur = examDoc(id);
    if (!cur || cur.status !== "generating") return;
    const { progress: _p, ...rest } = cur;
    void _p;
    const why = lt(`生成出错：${e instanceof Error ? e.message : String(e)}`, `Generation failed: ${e instanceof Error ? e.message : String(e)}`);
    putExamDoc({ ...rest, status: cur.questions.length ? "partial" : "failed", note: [cur.note, why].filter(Boolean).join("\n").slice(0, 1500), updated_at: Date.now() });
  });
}

/** A blueprint the generators can write: domains allowed at the level, banks the teacher owns and lets the model read. */
export function checkBlueprint(owner: string, raw: unknown): Blueprint {
  const bp = blueprintSchema.parse(raw);
  for (const [i, p] of bp.parts.entries()) {
    if (p.source.kind === "builtin" && !domainAllowed(p.source.domain, bp.grade_level)) {
      throw new BankError(lt(`第 ${i + 1} 部分：这个内容不适用于所选学段`, `Part ${i + 1}: that subject is not offered at the chosen level`), 400);
    }
    if (p.source.kind === "bank") {
      const bank = getBank(owner, p.source.bank_id);
      if (!bank.allow_model) throw new BankError(lt(`第 ${i + 1} 部分：题库“${bank.name}”不允许把内容发给模型`, `Part ${i + 1}: the bank “${bank.name}” does not allow sending its content to the model`), 403);
    }
  }
  return { ...bp, parts: bp.parts.map((p) => ({ ...p, id: newId() })) };
}

export function createExam(owner: string, body: { blueprint?: unknown; basis?: unknown }): Exam {
  const bp = checkBlueprint(owner, body.blueprint);
  if (generating(owner)) throw new BankError(lt("已有一张试卷正在生成，请等它完成或停止后再开始新的", "Another exam is being generated; wait for it or stop it first"), 409);
  let basis: PlanBasis | undefined;
  const parsed = body.basis === undefined ? undefined : planBasisSchema.safeParse(body.basis);
  if (parsed?.success) {
    basis = parsed.data;
    // the student must be one of this teacher's
    if (basis.member_id) {
      try {
        if (accessToMember(owner, basis.member_id).role !== "teacher") basis = undefined;
      } catch {
        basis = undefined;
      }
    }
  }
  const now = Date.now();
  const exam = putExamDoc({
    id: newId(),
    owner,
    title: bp.title,
    grade_level: bp.grade_level,
    parts: bp.parts,
    questions: [],
    rejected: [],
    status: "generating",
    run: bootId(),
    progress: { part: 0, parts: bp.parts.length, message: lt("排队中…", "Queued…") },
    ...(basis ? { basis } : {}),
    created_at: now,
    updated_at: now,
  });
  start(exam.id);
  return exam;
}

/** Writes the questions the parts are short of (after an interruption, removed questions, failed checks). */
export function fillExam(owner: string, id: string): Exam {
  const e = examFor(owner, id);
  if (e.status === "generating") throw new BankError(lt("这张试卷正在生成", "This exam is being generated"), 409);
  if (!missingByPart(e).size) throw new BankError(lt("这张试卷不缺题", "This exam is not missing any questions"), 400);
  if (generating(owner)) throw new BankError(lt("已有一张试卷正在生成，请等它完成或停止后再补题", "Another exam is being generated; wait for it or stop it first"), 409);
  putExamDoc({ ...e, status: "generating", run: bootId(), updated_at: Date.now() });
  start(id);
  return examFor(owner, id);
}

export function changeExam(owner: string, id: string, body: { title?: unknown; cancel?: unknown; remove_question?: unknown }): Exam {
  let e = examFor(owner, id);
  if (typeof body.title === "string" && body.title.trim()) e = { ...e, title: body.title.trim().slice(0, 100) };
  if (body.cancel === true && e.status === "generating") {
    const { progress: _p, ...rest } = e;
    void _p;
    e = { ...rest, status: "cancelled", note: [e.note, lt("老师停止了生成；正在写的部分写完后不再继续。", "Stopped by the teacher; the part being written is finished, no more are started.")].filter(Boolean).join("\n").slice(0, 1500) };
  }
  if (typeof body.remove_question === "string") {
    const left = e.questions.filter((q) => q.id !== body.remove_question);
    if (left.length !== e.questions.length) {
      e = { ...e, questions: numberQuestions(left, e.parts) };
      if (e.status === "ready") e = { ...e, status: "partial" };
    }
  }
  return putExamDoc({ ...e, updated_at: Date.now() });
}

// ── Planning from marked work ───────────────────────────────────────

const marked = (subs: Submission[]) => subs.filter((s) => s.status === "marked" && s.marking).slice(0, PLAN_WINDOW);

function examIdsOf(subs: Submission[]): string[] {
  const ids = new Set<string>();
  for (const pid of new Set(subs.map((s) => s.paper_id).filter((x): x is string => !!x))) {
    try {
      const ex = getPaper(pid).source.exam_id;
      if (ex) ids.add(ex);
    } catch {
      /* deleted */
    }
  }
  return [...ids];
}

const today = () => new Date().toISOString().slice(0, 10);

export function planFor(
  owner: string,
  body: { member_id?: unknown; scope?: unknown; questions?: unknown; grade_level?: unknown; title?: unknown },
): { blueprint: Blueprint; basis: PlanBasis; records: SkillRecord[]; total: number } {
  const grade = (GRADE_LEVELS as readonly string[]).includes(String(body.grade_level)) ? (body.grade_level as GradeLevel) : undefined;
  const questions = typeof body.questions === "number" ? body.questions : undefined;
  let records: SkillRecord[];
  let subs: Submission[];
  let name: string;
  let memberId: string | undefined;
  if (body.scope === "class") {
    const cls = teacherGroup(owner);
    if (!cls) throw new BankError(lt("还没有学生", "You have no students yet"), 404);
    const byMember = membersOf(cls.id).map((m) => marked(submissionsOf(m.id)));
    subs = byMember.flat();
    records = classRecords(byMember);
    name = lt("全班", "the class");
  } else {
    if (typeof body.member_id !== "string") throw new BankError(lt("请选择学生", "Choose the student"), 400);
    const { member, role } = accessToMember(owner, body.member_id);
    if (role !== "teacher") throw new BankError(lt("只有老师可以按学情出卷", "Only the teacher can plan a paper from the record"), 403);
    subs = marked(submissionsOf(member.id));
    records = skillRecords(subs);
    name = member.name;
    memberId = member.id;
  }
  // the level: as asked, else the last paper planned for the same student or class, else the
  // level of the exams the marked papers were of (newest first), else the diagnosis's suggestion
  const last = examsOf(owner).find((e) => e.basis && (memberId ? e.basis.member_id === memberId : e.basis.scope === "class"));
  const examIds = examIdsOf(subs);
  const sat = examIds.map((id) => examDoc(id)).find((e): e is NonNullable<typeof e> => !!e && e.owner === owner);
  const diag = memberId ? getMemberDiagnosis(memberId) : undefined;
  const fromDiag = diag?.next[0]?.builtin?.grade_level;
  const grade_level: GradeLevel = grade ?? last?.grade_level ?? sat?.grade_level ?? ((GRADE_LEVELS as readonly string[]).includes(fromDiag ?? "") ? (fromDiag as GradeLevel) : "middle");
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : lt(`${name} · 针对性练习卷（${today()}）`, `${name} — targeted practice (${today()})`);
  let blueprint: Blueprint;
  try {
    blueprint = planExam({ records, grade_level, title, ...(questions ? { questions } : {}), banks: ownerBanks(owner) });
  } catch (e) {
    if (e instanceof PlanError) throw new BankError(e.message, 400);
    throw e;
  }
  const basis = planBasis({ scope: memberId ? "member" : "class", ...(memberId ? { member_id: memberId } : {}), name, records, submissions: subs.length, exam_ids: examIds });
  return { blueprint, basis, records: records.slice(0, 20), total: plannedTotal(blueprint.parts) };
}
