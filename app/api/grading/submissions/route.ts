import { NextResponse } from "next/server";
import { bankRoute } from "@/lib/bank/http";
import { BankError } from "@/lib/bank/store";
import { lt } from "@/lib/llm/output-locale";
import { getSessionForRequest } from "@/lib/session-access";
import { markWork, MarkingError, MAX_WORK_IMAGES, prepareWorkImages } from "@/lib/grading/mark";
import { resolveProblem } from "@/lib/grading/reference";
import { accessToMember, newSubmissionId, saveMarkingResult, saveSubmissionImages } from "@/lib/grading/store";
import { publicSubmission } from "@/lib/grading/view";
import type { Submission } from "@/lib/grading/types";

export const maxDuration = 300;

const field = (form: FormData, k: string) => {
  const v = form.get(k);
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};

/**
 * POST multipart/form-data — mark a student's work:
 *   member_id   the roster entry (a teacher: any student in their class; a student: themself)
 *   images      1–6 photos of the working (repeat the field)
 *   problem_text, figure, answer (teacher's reference answer), session_id, bank_id + item_id
 * Reads the photos, compares the answer, judges the working; the submission is stored either way.
 */
export const POST = bankRoute(
  async ({ req, owner }) => {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new BankError(lt("请以表单上传（multipart/form-data）", "Send the work as multipart/form-data"), 400);
    }
    const memberId = field(form, "member_id");
    if (!memberId) throw new BankError(lt("请选择学生", "Choose the student"), 400);
    const { member, role } = accessToMember(owner, memberId);
    const files = form.getAll("images").filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length > MAX_WORK_IMAGES) throw new BankError(lt(`最多 ${MAX_WORK_IMAGES} 张照片`, `At most ${MAX_WORK_IMAGES} photos`), 400);
    const { problem, reference } = await resolveProblem(
      owner,
      {
        text: field(form, "problem_text"),
        figure: field(form, "figure"),
        // Only the teacher gives the reference answer (a student must not supply their own key).
        answer: role === "teacher" ? field(form, "answer") : undefined,
        session_id: field(form, "session_id"),
        bank_id: field(form, "bank_id"),
        item_id: field(form, "item_id"),
      },
      { getSession: getSessionForRequest },
    );
    let prepared: Awaited<ReturnType<typeof prepareWorkImages>>;
    try {
      prepared = await prepareWorkImages(await Promise.all(files.map(async (f) => ({ data: Buffer.from(await f.arrayBuffer()) }))));
    } catch (e) {
      if (e instanceof MarkingError) throw new BankError(e.message, e.status);
      throw e;
    }
    const id = newSubmissionId();
    const images = saveSubmissionImages(id, prepared.files);
    const base: Submission = {
      id,
      class_id: member.class_id,
      member_id: member.id,
      submitted_by: owner,
      problem,
      reference,
      images,
      status: "failed",
      created_at: Date.now(),
    };
    try {
      const r = await markWork({ problem: problem.text, figure: problem.figure, imageUrls: prepared.urls, reference });
      const saved = saveMarkingResult(base, { reference: r.reference, reading: r.reading, marking: r.marking, status: "marked" }, { isNew: true });
      if (!saved) throw new BankError(lt("学生或班级在批改时被删除了", "The student or class was deleted while marking"), 410);
      return { submission: publicSubmission(saved, role) };
    } catch (e) {
      console.error("[grading]", e);
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof BankError) throw e;
      const saved = saveMarkingResult(base, { error: msg.slice(0, 500) }, { isNew: true });
      return NextResponse.json(
        { ...(saved ? { submission: publicSubmission(saved, role) } : {}), error: lt(`批改失败：${msg}`.slice(0, 300), `Marking failed: ${msg}`.slice(0, 300)) },
        { status: 502 },
      );
    }
  },
  { model: true },
);
