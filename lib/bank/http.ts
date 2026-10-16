/**
 * Shared plumbing for the /api/banks routes: who the request belongs to,
 * the UI language for messages and model output, and error mapping.
 *
 * Ownership: the signed-in NextAuth user id; without a session, "local" (the
 * single user of this machine) unless auth is required (lib/access.ts), when
 * the request is refused with 401. Banks are isolated per owner on disk (store.ts).
 */
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { lt, withRequestLocale } from "../llm/output-locale";
import { BankError } from "./store";

// Who the request belongs to (signed-in user, or "local" when auth is not required): lib/access.ts.
import { requestOwner, UnauthorizedError } from "../access";
export { requestOwner };

type Params = Record<string, string>;
type Handler<P extends Params> = (ctx: { req: Request; owner: string; params: P }) => Promise<Response | unknown>;

/**
 * Wrap a bank route: resolves owner + params, runs in the request's language, maps errors to JSON.
 * `model: true` for routes that call models (import, classify, profile, generate): today's spend
 * limit and the call rate limit are checked and the calls are charged to the owner (lib/quota.ts).
 */
export function bankRoute<P extends Params = Params>(handler: Handler<P>, opts: { model?: boolean } = {}) {
  return withRequestLocale(async (req: Request, ctx: { params: Promise<P> }) => {
    try {
      const params = ((await ctx?.params) ?? {}) as P;
      const owner = await requestOwner();
      const run = async () => {
        const out = await handler({ req, owner, params });
        return out instanceof Response ? out : NextResponse.json(out ?? { ok: true });
      };
      if (!opts.model) return await run();
      const { admitCall, withOwnerBilling } = await import("../quota");
      const admit = await admitCall(owner, lt);
      if (!admit.ok) return NextResponse.json({ error: admit.reason }, { status: 429 });
      return await withOwnerBilling(owner, admit, run);
    } catch (e) {
      if (e instanceof UnauthorizedError) return NextResponse.json({ error: lt("请先登录", "Please sign in") }, { status: 401 });
      if (e instanceof BankError) return NextResponse.json({ error: e.message }, { status: e.status });
      if (e instanceof ZodError) {
        const first = e.issues[0];
        return NextResponse.json({ error: lt(`请求参数无效：${first?.path.join(".")} ${first?.message}`, `Invalid request: ${first?.path.join(".")} ${first?.message}`) }, { status: 400 });
      }
      console.error("[banks]", e);
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  });
}

export async function jsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new BankError(lt("请求体不是有效的 JSON", "Request body is not valid JSON"), 400);
  }
}
