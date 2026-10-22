import { bankRoute } from "@/lib/bank/http";
import { BankError } from "@/lib/bank/store";
import { lt } from "@/lib/llm/output-locale";
import { diagnose } from "@/lib/grading/diagnosis";
import { getClass, getSubmission, putPaper, visiblePaper } from "@/lib/grading/store";
import { publicPaper } from "@/lib/grading/view";

type P = { id: string };

/** Diagnose the paper again (e.g. after the teacher corrected some verdicts). Teacher only. */
export const POST = bankRoute<P>(
  async ({ owner, params }) => {
    const { paper, role } = visiblePaper(owner, params.id);
    if (role !== "teacher") throw new BankError(lt("只有老师可以重新分析", "Only the teacher can run the analysis again"), 403);
    const subs = paper.submission_ids.flatMap((id) => {
      try {
        return [getSubmission(id)];
      } catch {
        return [];
      }
    });
    const diagnosis = await diagnose({ submissions: subs, numbers: new Map(subs.map((s) => [s.id, s.question_no ?? ""])), owner: getClass(paper.class_id).owner });
    const current = visiblePaper(owner, params.id).paper;
    return { paper: publicPaper(putPaper({ ...current, diagnosis }), role) };
  },
  { model: true },
);
