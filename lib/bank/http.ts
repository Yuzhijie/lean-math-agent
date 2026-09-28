/**
 * Shared plumbing for the /api/banks routes: who the request belongs to,
 * the UI language for messages and model output, and error mapping.
 *
 * Ownership: the signed-in NextAuth user id; without a session (or when
 * auth is not configured) everything belongs to "local" — the single user
 * of this machine. Banks are isolated per owner on disk (store.ts).
 */
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { lt, withRequestLocale } from "../llm/output-locale";
import { BankError } from "./store";

export async function requestOwner(): Promise<string> {
  try {
    const [{ getServerSession }, { authOptions }] = await Promise.all([import("next-auth"), import("../auth")]);
    const session = await getServerSession(authOptions);
    const id = (session?.user as { id?: string } | undefined)?.id;
    return id && typeof id === "string" ? id : "local";
  } catch {
    // Auth not configured (no NEXTAUTH_SECRET / database) → single local user.
    return "local";
  }
}

type Params = Record<string, string>;
type Handler<P extends Params> = (ctx: { req: Request; owner: string; params: P }) => Promise<Response | unknown>;

/** Wrap a bank route: resolves owner + params, runs in the request's language, maps errors to JSON. */
export function bankRoute<P extends Params = Params>(handler: Handler<P>) {
  return withRequestLocale(async (req: Request, ctx: { params: Promise<P> }) => {
    try {
      const params = ((await ctx?.params) ?? {}) as P;
      const owner = await requestOwner();
      const out = await handler({ req, owner, params });
      return out instanceof Response ? out : NextResponse.json(out ?? { ok: true });
    } catch (e) {
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
