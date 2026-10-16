/**
 * Invite-only beta gate (Next 16 proxy, formerly middleware). When auth is required
 * (lib/access.ts: AUTH_REQUIRED, default on in production) nothing but sign-in, the Stripe
 * webhook and the health check is reachable without a signed-in user: pages redirect to the
 * sign-in page, API calls get 401. The API routes check again (requestOwner), so a route the
 * matcher misses is still closed.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { authRequired } from "./lib/access";

const PUBLIC = [/^\/auth(\/|$)/, /^\/api\/auth(\/|$)/, /^\/api\/payments\/webhook$/, /^\/api\/health$/];

export async function proxy(request: NextRequest) {
  if (!authRequired()) return NextResponse.next();
  const { pathname } = request.nextUrl;
  if (PUBLIC.some((re) => re.test(pathname))) return NextResponse.next();
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
