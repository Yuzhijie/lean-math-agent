import { NextResponse } from "next/server";
import { bankRoute } from "@/lib/bank/http";
import { lt } from "@/lib/llm/output-locale";
import { markWork } from "@/lib/grading/mark";
import { BankError } from "@/lib/bank/store";
import { readSubmissionImage, saveMarkingResult, visibleSubmission } from "@/lib/grading/store";
import { publicSubmission } from "@/lib/grading/view";

type P = { id: string };

export const maxDuration = 300;

const MIME: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

/** Mark the stored photos again (after a failure, or when the teacher wants a second look). */
export const POST = bankRoute<P>(
  async ({ owner, params }) => {
    const { submission, role } = visibleSubmission(owner, params.id);
    // Students may retry only work whose marking failed (not re-roll a verdict they dislike).
    if (role !== "teacher" && submission.status !== "failed") {
      throw new BankError(lt("只有批改失败的作答可以重新批改；对结果有疑问请找老师", "Only work whose marking failed can be marked again; ask your teacher about a result"), 403);
    }
    const urls = submission.images.map((name) => {
      const data = readSubmissionImage(owner, submission.id, name);
      return `data:${MIME[name.split(".").pop() ?? "jpg"] ?? "image/jpeg"};base64,${data.toString("base64")}`;
    });
    // A reference the model solved is solved again; a teacher's, bank or solver answer is kept.
    const reference = submission.reference.source === "model" ? { source: "none" as const } : submission.reference;
    try {
      const r = await markWork({ problem: submission.problem.text, figure: submission.problem.figure, imageUrls: urls, reference });
      const saved = saveMarkingResult(submission, { reference: r.reference, reading: r.reading, marking: r.marking, status: "marked", error: undefined });
      if (!saved) throw new BankError(lt("这份作答在批改时被删除了", "This work was deleted while it was being marked"), 410);
      return { submission: publicSubmission(saved, role) };
    } catch (e) {
      if (e instanceof BankError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ error: lt(`批改失败：${msg}`.slice(0, 300), `Marking failed: ${msg}`.slice(0, 300)) }, { status: 502 });
    }
  },
  { model: true },
);
