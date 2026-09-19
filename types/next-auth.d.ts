import type { DefaultSession } from "next-auth";

/**
 * Module augmentation: `lib/auth.ts` copies the user id from the JWT onto
 * `session.user.id`, and API routes read it. NextAuth's default `Session`
 * type has no `id` on `user`, so declare it here.
 */
declare module "next-auth" {
  interface Session {
    user: DefaultSession["user"] & {
      id: string;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
  }
}
