import { bankRoute } from "@/lib/bank/http";
import { BankError } from "@/lib/bank/store";
import { lt } from "@/lib/llm/output-locale";
import { diagnose } from "@/lib/grading/diagnosis";
import { accessToMember, papersOf, putMemberDiagnosis, submissionsOf } from "@/lib/grading/store";
import { forStudent } from "@/lib/grading/view";

type P = { id: string };

/** A student's learning diagnosis over all their marked work (latest 40 pieces). Teacher, or the student. */
export const POST = bankRoute<P>(
  async ({ owner, params }) => {
    const { member, cls, role } = accessToMember(owner, params.id);
    const subs = submissionsOf(member.id).filter((s) => s.status === "marked").slice(0, 40);
    if (!subs.length) throw new BankError(lt("还没有批改过的作答，无法诊断", "No marked work yet to diagnose"), 400);
    // Labels the model can cite and the reader can find: "《第三单元测验》第 2 题", or the date of single work.
    const titles = new Map(papersOf(member.id).map((p) => [p.id, p.title]));
    const numbers = new Map(
      subs.map((s) => [
        s.id,
        s.paper_id && titles.has(s.paper_id)
          ? lt(`《${titles.get(s.paper_id)}》第 ${s.question_no ?? "?"} 题`, `"${titles.get(s.paper_id)}" question ${s.question_no ?? "?"}`)
          : lt(`${new Date(s.created_at).toISOString().slice(0, 10)} 的作答`, `work of ${new Date(s.created_at).toISOString().slice(0, 10)}`),
      ]),
    );
    const diagnosis = await diagnose({ submissions: subs, numbers, owner: cls.owner });
    const saved = putMemberDiagnosis(member.id, diagnosis) ?? diagnosis;
    return { diagnosis: role === "student" ? forStudent(saved) : saved };
  },
  { model: true },
);
