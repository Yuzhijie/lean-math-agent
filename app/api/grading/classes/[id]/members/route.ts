import { z } from "zod";
import { bankRoute, jsonBody } from "@/lib/bank/http";
import { addMember } from "@/lib/grading/store";

type P = { id: string };

/** Add students to the roster: one name, or a pasted list (one per line, or separated by commas). */
const schema = z.object({ name: z.string().max(60).optional(), names: z.string().max(5000).optional() });

export const POST = bankRoute<P>(async ({ req, owner, params }) => {
  const body = schema.parse(await jsonBody(req));
  const names = [body.name ?? "", ...(body.names ?? "").split(/[\n,，、;；]+/)].map((n) => n.trim()).filter(Boolean);
  return { members: [...new Set(names)].slice(0, 200).map((n) => addMember(owner, params.id, n)) };
});
