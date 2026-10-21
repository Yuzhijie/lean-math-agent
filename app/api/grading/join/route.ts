import { z } from "zod";
import { bankRoute, jsonBody } from "@/lib/bank/http";
import { lt } from "@/lib/llm/output-locale";
import { BankError } from "@/lib/bank/store";
import { classByCode, joinClass, membersOf } from "@/lib/grading/store";

/** GET ?code=… — the class behind a join code and the roster names not yet linked to an account. */
export const GET = bankRoute(async ({ req, owner }) => {
  const code = new URL(req.url).searchParams.get("code") ?? "";
  const cls = classByCode(code);
  if (!cls) throw new BankError(lt("没有这个班级码", "No class has this code"), 404);
  const members = membersOf(cls.id);
  return {
    class: { id: cls.id, name: cls.name },
    joined: members.find((m) => m.user_id === owner) ?? null,
    names: members.filter((m) => !m.user_id).map((m) => ({ id: m.id, name: m.name })),
  };
});

const schema = z.object({ code: z.string().trim().min(4).max(12), member_id: z.string().max(64).optional(), name: z.string().trim().max(60).optional() });

/** Join a class: pick your name from the roster, or add yourself. */
export const POST = bankRoute(async ({ req, owner }) => {
  const body = schema.parse(await jsonBody(req));
  const { cls, member } = joinClass(owner, body.code, { memberId: body.member_id, name: body.name });
  return { class: { id: cls.id, name: cls.name }, member };
});
