import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetJobsForTests, attachJob, CancelledError, closeJobEvents, publishJobEvent, runJob, throwIfCancelled, type JobEvent } from "@/lib/jobs";
import { addressFor, parseResumeView, RESUME_MAX_AGE_MS, serializeResumeView, viewToRestore } from "@/lib/resume-view";

beforeEach(() => {
  _resetJobsForTests();
  process.env.SOLVE_CONCURRENCY = "2";
  process.env.SOLVE_DETACH_GRACE_MS = "40";
});
afterEach(() => {
  delete process.env.SOLVE_CONCURRENCY;
  delete process.env.SOLVE_DETACH_GRACE_MS;
});

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function gate() {
  let release!: () => void;
  const p = new Promise<void>((r) => (release = r));
  return {
    release,
    body: async (signal: AbortSignal) => {
      await Promise.race([p, new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true }))]);
      throwIfCancelled();
      return "done";
    },
  };
}

describe("detachable jobs", () => {
  it("keep running after the client leaves, and stop when nobody comes back", async () => {
    const g = gate();
    const client = new AbortController();
    const run = runJob({ owner: "u", kind: "solve", signal: client.signal, detachable: true }, g.body);
    await tick();
    client.abort();
    await tick(10);
    let settled = false;
    void run.catch(() => undefined).finally(() => (settled = true));
    await tick(5);
    expect(settled).toBe(false); // still inside the grace period
    await expect(run).rejects.toBeInstanceOf(CancelledError);
  });

  it("a page that attaches again keeps it alive and gets the frames so far, then the new ones", async () => {
    const g = gate();
    const client = new AbortController();
    let id = "";
    const run = runJob({ owner: "u", kind: "solve", signal: client.signal, detachable: true, onStart: (j) => (id = j.id) }, g.body);
    publishJobEvent(id, { type: "job", job_id: id });
    publishJobEvent(id, { type: "progress", stage: "classifying" });
    client.abort();
    await tick(10);
    const seen: Array<JobEvent | null> = [];
    const a = attachJob(id, "u", (e) => seen.push(e))!;
    expect(a.events.map((e) => e.type)).toEqual(["job", "progress"]);
    await tick(60); // past the grace period: still running
    publishJobEvent(id, { type: "result", data: {} });
    g.release();
    await expect(run).resolves.toBe("done");
    closeJobEvents(id);
    expect(seen.map((e) => e?.type ?? null)).toEqual(["result", null]);
    a.detach();
  });

  it("only the owner can attach; a finished job replays and ends", async () => {
    const g = gate();
    let id = "";
    const run = runJob({ owner: "u", kind: "solve", detachable: true, onStart: (j) => (id = j.id) }, g.body);
    expect(attachJob(id, "someone-else", () => undefined)).toBeUndefined();
    expect(attachJob("nope", "u", () => undefined)).toBeUndefined();
    publishJobEvent(id, { type: "result", data: { x: 1 } });
    g.release();
    await run;
    closeJobEvents(id);
    const a = attachJob(id, "u", () => undefined)!;
    expect(a.closed).toBe(true);
    expect(a.events).toEqual([{ type: "result", data: { x: 1 } }]);
  });

  it("without a grace period the old behaviour stays: leaving cancels at once", async () => {
    process.env.SOLVE_DETACH_GRACE_MS = "0";
    const g = gate();
    const client = new AbortController();
    const run = runJob({ owner: "u", kind: "solve", signal: client.signal, detachable: true }, g.body);
    await tick();
    client.abort();
    await expect(run).rejects.toBeInstanceOf(CancelledError);
  });
});

describe("the page's resume view", () => {
  it("round-trips and drops what is malformed or old", () => {
    const now = 1_700_000_000_000;
    const raw = serializeResumeView({ sessionId: "abc-1", jobId: "j_2", tab: "lean", workspace: "solve", problemText: "1+1" }, now);
    expect(parseResumeView(raw, now + 1000)).toEqual({ at: now, sessionId: "abc-1", jobId: "j_2", tab: "lean", workspace: "solve", problemText: "1+1" });
    expect(parseResumeView(raw, now + RESUME_MAX_AGE_MS + 1)).toBeUndefined();
    expect(parseResumeView("{", now)).toBeUndefined();
    expect(parseResumeView(JSON.stringify({ at: now, sessionId: "../x", tab: "<b>", workspace: "x" }), now)).toEqual({ at: now });
  });

  it("the address's session wins; a problem in the address means no restore", () => {
    const stored = { at: 1, sessionId: "s1", jobId: "j1", tab: "lean", problemText: "p" };
    expect(viewToRestore("http://x/?problem=hi", stored)).toBeUndefined();
    expect(viewToRestore("http://x/", stored)).toBe(stored);
    expect(viewToRestore("http://x/?session=s1&tab=proof", stored)).toMatchObject({ sessionId: "s1", jobId: "j1", tab: "proof" });
    const other = viewToRestore("http://x/?session=s2", stored)!;
    expect(other.sessionId).toBe("s2");
    expect(other.jobId).toBeUndefined();
  });

  it("writes the session and tab into the address, keeping other parameters", () => {
    expect(addressFor("http://x/?a=1", "s1", "lean")).toBe("/?a=1&session=s1&tab=lean");
    expect(addressFor("http://x/?a=1&session=s1&tab=lean", undefined, undefined)).toBe("/?a=1");
  });
});
