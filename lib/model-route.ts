/**
 * Every API route that calls a model goes through modelRoute: the caller must be known (401 when
 * auth is required and nobody is signed in), today's spend limit and the call rate limit are
 * checked (429 with the reason), and every model call the route makes — also after a streaming
 * route has returned — is charged to the caller as it happens. Solves have their own admission
 * (admitSolve: monthly solves, solves at once) and use the same billing.
 */
import { NextResponse } from "next/server";
import { requestOwner } from "./access";
import { lt, withRequestLocale } from "./llm/output-locale";
import { admitCall, withOwnerBilling } from "./quota";

export function modelRoute<A extends unknown[]>(handler: (...args: A) => Promise<Response>): (...args: A) => Promise<Response> {
  return withRequestLocale(async (...args: A) => {
    const owner = await requestOwner();
    const admit = await admitCall(owner, lt);
    if (!admit.ok) return NextResponse.json({ error: admit.reason, quota: { plan: admit.plan, dayCost: admit.dayCost, dayLimit: admit.dayLimit } }, { status: 429 });
    return withOwnerBilling(owner, admit, () => handler(...args));
  });
}
