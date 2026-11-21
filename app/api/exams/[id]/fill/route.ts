import { bankRoute } from "@/lib/bank/http";
import { fillExam } from "@/lib/exam/service";

type P = { id: string };

/** POST — writes the questions the exam's parts are short of, in the background. */
export const POST = bankRoute<P>(async ({ owner, params }) => ({ exam: fillExam(owner, params.id) }), { model: true });
