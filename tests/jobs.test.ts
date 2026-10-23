import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetJobsForTests, CancelledError, cancelJob, currentSignal, listJobs, runJob, solveTimeLimitMs, throwIfCancelled, TimeLimitError, TooManyJobsError } from "@/lib/jobs";

beforeEach(() => {
  _resetJobsForTests();
  process.env.SOLVE_CONCURRENCY = "1";
  process.env.JOBS_PER_USER = "2";
});
afterEach(() => {
  delete process.env.SOLVE_CONCURRENCY;
  delete process.env.JOBS_PER_USER;
});

/** A job body that waits until released (or cancelled). */
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

describe("solve jobs", () => {
  it("queues beyond the limit, tells the place, and starts the next when one ends", async () => {
    const a = gate(), b = gate();
    const ids: string[] = [];
    const places: number[] = [];
    const ra = runJob({ owner: "u1", kind: "solve", onStart: (j) => ids.push(j.id) }, a.body);
    const rb = runJob({ owner: "u2", kind: "solve", onStart: (j) => ids.push(j.id), onQueued: (p) => places.push(p) }, b.body);
    await new Promise((r) => setTimeout(r, 5));
    expect(places).toEqual([1]);
    expect(listJobs("u2")[0]).toMatchObject({ state: "queued", position: 1 });
    a.release();
    await expect(ra).resolves.toBe("done");
    await new Promise((r) => setTimeout(r, 5));
    expect(listJobs("u2")[0].state).toBe("running");
    b.release();
    await expect(rb).resolves.toBe("done");
    expect(listJobs("u1")[0].state).toBe("done");
  });

  it("cancels a running job (only its owner can) and a queued one", async () => {
    const a = gate(), b = gate();
    let idA = "", idB = "";
    const ra = runJob({ owner: "u1", kind: "solve", onStart: (j) => (idA = j.id) }, a.body);
    const rb = runJob({ owner: "u1", kind: "solve", onStart: (j) => (idB = j.id) }, b.body);
    await new Promise((r) => setTimeout(r, 5));
    expect(cancelJob(idA, "someone-else")).toBe(false);
    expect(cancelJob(idB, "u1")).toBe(true); // queued
    await expect(rb).rejects.toBeInstanceOf(CancelledError);
    expect(cancelJob(idA, "u1")).toBe(true); // running
    await expect(ra).rejects.toBeInstanceOf(CancelledError);
    expect(listJobs("u1").map((j) => j.state)).toEqual(["cancelled", "cancelled"]);
    expect(cancelJob(idA, "u1")).toBe(false); // already ended
  });

  it("an outside signal (the client went away) cancels; the signal is visible inside the job", async () => {
    const outer = new AbortController();
    const seen = vi.fn();
    const r = runJob({ owner: "u1", kind: "solve", signal: outer.signal }, async (signal) => {
      seen(currentSignal() === signal);
      await new Promise((res) => setTimeout(res, 20));
      throwIfCancelled();
      return 1;
    });
    setTimeout(() => outer.abort(), 5);
    await expect(r).rejects.toBeInstanceOf(CancelledError);
    expect(seen).toHaveBeenCalledWith(true);
    expect(currentSignal()).toBeUndefined();
  });

  it("limits jobs per user", async () => {
    const g = gate();
    const r1 = runJob({ owner: "u1", kind: "solve" }, g.body);
    const r2 = runJob({ owner: "u1", kind: "solve" }, g.body);
    await expect(runJob({ owner: "u1", kind: "solve" }, g.body)).rejects.toBeInstanceOf(TooManyJobsError);
    g.release();
    await Promise.all([r1, r2]);
  });
});

describe("the LLM client and Lean honour a cancel", () => {
  it("aborts the request in flight and refuses new ones", async () => {
    const { chatText } = await import("@/lib/llm/client");
    const { verifyLeanSource } = await import("@/lib/lean/sandbox");
    Object.assign(process.env, { LLM_API_KEY: "k", LLM_BASE_URL: "https://llm.test/v1", LLM_MODEL: "m", LLM_LOG_LEVEL: "silent", LLM_CACHE_ENABLED: "false" });
    const fetchMock = vi.fn(
      (_u: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })), { once: true })),
    );
    vi.stubGlobal("fetch", fetchMock);
    let id = "";
    const r = runJob({ owner: "u1", kind: "solve", onStart: (j) => (id = j.id) }, async () => {
      const first = chatText({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
      await new Promise((res) => setTimeout(res, 5));
      cancelJob(id, "u1");
      const err = await first;
      expect(err).toBeInstanceOf(CancelledError);
      await expect(chatText({ messages: [{ role: "user", content: "again" }] })).rejects.toBeInstanceOf(CancelledError);
      await expect(verifyLeanSource("s", "theorem t : True := trivial")).rejects.toBeInstanceOf(CancelledError);
      throwIfCancelled();
      return "unreachable";
    });
    await expect(r).rejects.toBeInstanceOf(CancelledError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry, no fallback after the cancel
    vi.unstubAllGlobals();
  });
});

describe("solve time limit", () => {
  it("stops a running job after its limit with TimeLimitError (a CancelledError)", async () => {
    const g = gate();
    const r = runJob({ owner: "u1", kind: "solve", timeLimitMs: 20 }, g.body);
    const e = await r.catch((x) => x);
    expect(e).toBeInstanceOf(TimeLimitError);
    expect(e).toBeInstanceOf(CancelledError);
    expect(listJobs("u1")[0].state).toBe("cancelled");
  });

  it("reads SOLVE_TIME_LIMIT_MIN (default 40, 0 = none)", () => {
    expect(solveTimeLimitMs()).toBe(40 * 60_000);
    process.env.SOLVE_TIME_LIMIT_MIN = "0";
    expect(solveTimeLimitMs()).toBeUndefined();
    process.env.SOLVE_TIME_LIMIT_MIN = "90";
    expect(solveTimeLimitMs()).toBe(90 * 60_000);
    delete process.env.SOLVE_TIME_LIMIT_MIN;
  });
});
