/**
 * Where the solver page was (browser-side): the open session, a solve still running, the tab, the
 * workspace and the problem text being typed. Written to localStorage as the page changes and
 * read when the page opens, so a reload, a crashed tab or a reopened browser comes back to the same
 * place; the session is also in the address (?session=…), so a reloaded tab keeps its own session
 * when several are open. Only within one run of the server: the view records the server's start id
 * (GET /api/boot), and after a restart it is dropped — the page starts fresh.
 */

export type Workspace = "solve" | "bank" | "builtin";

export interface ResumeView {
  sessionId?: string;
  /** A solve that was running: followed again if the server still has it. */
  jobId?: string;
  tab?: string;
  workspace?: Workspace;
  problemText?: string;
  /** The server run it was written in (GET /api/boot). */
  boot?: string;
  /** When it was written (ms). */
  at: number;
}

export const RESUME_KEY = "solver-view";
/** Older views are not restored (a page opened next week starts fresh). */
export const RESUME_MAX_AGE_MS = 7 * 24 * 3600_000;
const MAX_TEXT = 20_000;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const WORKSPACES: Workspace[] = ["solve", "bank", "builtin"];

/** A view read back from storage, or undefined when it is missing, malformed or too old. */
export function parseResumeView(raw: string | null | undefined, now = Date.now()): ResumeView | undefined {
  if (!raw) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.at !== "number" || now - o.at > RESUME_MAX_AGE_MS || o.at > now + 60_000) return undefined;
  const out: ResumeView = { at: o.at };
  if (typeof o.sessionId === "string" && ID.test(o.sessionId)) out.sessionId = o.sessionId;
  if (typeof o.jobId === "string" && ID.test(o.jobId)) out.jobId = o.jobId;
  if (typeof o.tab === "string" && /^[a-z_-]{1,30}$/.test(o.tab)) out.tab = o.tab;
  if (typeof o.workspace === "string" && (WORKSPACES as string[]).includes(o.workspace)) out.workspace = o.workspace as Workspace;
  if (typeof o.problemText === "string") out.problemText = o.problemText.slice(0, MAX_TEXT);
  if (typeof o.boot === "string" && ID.test(o.boot)) out.boot = o.boot;
  return out;
}

export function serializeResumeView(v: Omit<ResumeView, "at">, now = Date.now()): string {
  const out: ResumeView = { at: now };
  if (v.sessionId) out.sessionId = v.sessionId;
  if (v.jobId) out.jobId = v.jobId;
  if (v.tab) out.tab = v.tab;
  if (v.workspace) out.workspace = v.workspace;
  if (v.problemText) out.problemText = v.problemText.slice(0, MAX_TEXT);
  if (v.boot) out.boot = v.boot;
  return JSON.stringify(out);
}

/** A view written before the server's last restart (or without a run id): not restored. */
export function fromEarlierRun(stored: ResumeView | undefined, boot: string | undefined): boolean {
  return !!stored && !!boot && stored.boot !== boot;
}

/**
 * The view to restore: the address's ?session= (with ?tab=) wins over storage; nothing when the
 * address brings a problem, or when the stored view is from before a server restart (then the
 * address's session, which that view put there, goes too).
 */
export function viewToRestore(href: string, stored: ResumeView | undefined, boot?: string): ResumeView | undefined {
  const url = new URL(href);
  if (url.searchParams.get("problem")) return undefined;
  if (fromEarlierRun(stored, boot)) return undefined;
  const session = url.searchParams.get("session");
  if (session && ID.test(session)) {
    const tab = url.searchParams.get("tab") ?? undefined;
    // The stored view belongs to this session (a running solve, the text): keep its details.
    const same = stored && (stored.sessionId === session);
    return {
      ...(same ? stored : { at: Date.now() }),
      sessionId: session,
      ...(tab && /^[a-z_-]{1,30}$/.test(tab) ? { tab } : {}),
    };
  }
  return stored;
}

/** The address for the current view: ?session=<id>&tab=<tab> set or removed, other parameters kept. */
export function addressFor(href: string, sessionId: string | undefined, tab: string | undefined): string {
  const url = new URL(href);
  if (sessionId) {
    url.searchParams.set("session", sessionId);
    if (tab) url.searchParams.set("tab", tab);
    else url.searchParams.delete("tab");
  } else {
    url.searchParams.delete("session");
    url.searchParams.delete("tab");
  }
  return url.pathname + url.search + url.hash;
}
