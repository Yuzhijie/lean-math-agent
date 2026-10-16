/**
 * Who may use the app (invite-only beta, see docs: 7e).
 *
 * - AUTH_REQUIRED (default: on in production, off in development): every API call needs a
 *   signed-in user. Without it, requests belong to "local" — the single user of a machine — which
 *   is unlimited and shared, so it must never exist on a server other people can reach.
 * - Invites: only listed addresses may sign in. INVITE_EMAILS / INVITE_DOMAINS (comma separated:
 *   "a@x.com,b@y.org" / "school.edu") and the file INVITE_FILE (default .data/invites.txt, one email
 *   or "@domain" per line, "#" comments; read on every sign-in, so adding a line needs no restart).
 *   With auth required and no list at all, nobody can sign in (closed by default).
 */
import { promises as fs } from "node:fs";

export class UnauthorizedError extends Error {
  constructor(message = "sign in required") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export function authRequired(): boolean {
  const v = process.env.AUTH_REQUIRED?.trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return process.env.NODE_ENV === "production";
}

export function inviteFilePath(): string {
  return process.env.INVITE_FILE ?? ".data/invites.txt";
}

const split = (raw: string | undefined) =>
  (raw ?? "")
    .split(/[,\s]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

/** The invite list: emails and domains ("@school.edu" or "school.edu" in INVITE_DOMAINS). */
export async function inviteList(): Promise<{ emails: Set<string>; domains: Set<string> }> {
  const emails = new Set(split(process.env.INVITE_EMAILS));
  const domains = new Set(split(process.env.INVITE_DOMAINS).map((d) => d.replace(/^@/, "")));
  try {
    const text = await fs.readFile(inviteFilePath(), "utf8");
    for (const raw of text.split("\n")) {
      const line = raw.replace(/#.*/, "").trim().toLowerCase();
      if (!line) continue;
      if (line.startsWith("@")) domains.add(line.slice(1));
      else if (line.includes("@")) emails.add(line);
    }
  } catch {
    // no file
  }
  return { emails, domains };
}

/**
 * May this address sign in? Without auth required and without any invite list, everyone may
 * (local development). With a list, only listed addresses; with auth required and no list, nobody.
 */
export async function isInvited(email: string | null | undefined): Promise<boolean> {
  const { emails, domains } = await inviteList();
  const open = emails.size === 0 && domains.size === 0;
  if (open) return !authRequired();
  const e = email?.trim().toLowerCase();
  if (!e) return false;
  return emails.has(e) || domains.has(e.slice(e.lastIndexOf("@") + 1));
}

/**
 * The signed-in user's id; "local" when auth is not required and nobody is signed in.
 * Throws UnauthorizedError when auth is required and nobody is signed in.
 */
export async function requestOwner(): Promise<string> {
  let id: string | undefined;
  try {
    const [{ getServerSession }, { authOptions }] = await Promise.all([import("next-auth"), import("./auth")]);
    const session = await getServerSession(authOptions);
    const v = (session?.user as { id?: string } | undefined)?.id;
    id = v && typeof v === "string" ? v : undefined;
  } catch {
    // Auth not configured (no NEXTAUTH_SECRET / database).
    id = undefined;
  }
  if (id) return id;
  if (authRequired()) throw new UnauthorizedError();
  return "local";
}
