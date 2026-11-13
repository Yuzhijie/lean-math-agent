/**
 * Invite-only beta gate (Next 16 proxy, formerly middleware). When auth is required
 * (lib/access.ts: AUTH_REQUIRED, default on in production) nothing but sign-in, the health check
 * and — only while payments are thawed — the Stripe webhook is reachable without a signed-in user
 * (isPublicPath): pages redirect to the sign-in page, API calls get 401. The API routes check
 * again (requestOwner), so a route the matcher misses is still closed.
 *
 * Before that, whoever asks: a path of a frozen feature (lib/scope.ts, docs/SCOPE.md) is not
 * found. An API path gets 404 here (and from its own handler — frozenRoute — should the matcher
 * miss it); a page is sent to a path that does not exist, so the answer is the app's not-found
 * page with status 404 (the page directory's own layout gate can only say "not found" inside a
 * response that has already started as 200).
 */
import { NextResponse, type NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { authRequired, isPublicPath } from "./lib/access";
import { closedAt, frozenMessage } from "./lib/scope";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const closed = closedAt(pathname);
  if (closed) {
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: frozenMessage(closed), frozen: closed }, { status: 404 });
    return NextResponse.rewrite(new URL(`/_frozen/${closed}`, request.url));
  }
  if (!authRequired()) return NextResponse.next();
  if (isPublicPath(pathname)) return NextResponse.next();
  const token = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET }).catch(() => null);
  if (token) return NextResponse.next();
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Please sign in / 请先登录" }, { status: 401 });
  }
  const url = request.nextUrl.clone();
  url.pathname = "/auth/signin";
  url.search = `?callbackUrl=${encodeURIComponent(pathname + request.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except Next's own assets and public files.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|webp|woff2?)$).*)"],
};
