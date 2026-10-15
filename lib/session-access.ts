/**
 * Sessions belong to the user who created them (`Session.owner`: the signed-in user's id, or "local"
 * when nobody is signed in). API routes read sessions through these helpers, so one user can neither
 * open, list nor delete another's: a session of someone else is reported as not found.
 */
import { requestOwner } from "./bank/http";
import { createSession, getSessionAsync, sessionOwner } from "./session-store";
import type { Session } from "./types";

/** The session if it exists and belongs to the caller. */
export async function getSessionForRequest(id: string): Promise<Session | undefined> {
  const s = await getSessionAsync(id);
  if (!s) return undefined;
  return sessionOwner(s) === (await requestOwner()) ? s : undefined;
}

/** A new session owned by the caller. */
export async function createSessionForRequest(problemText: string): Promise<Session> {
  return createSession(problemText, await requestOwner());
}
