/**
 * Solve jobs: a queue with a concurrency limit, and cancellation.
 *
 * Every solve runs as a job. At most SOLVE_CONCURRENCY jobs run at once (default 2: each holds Lean
 * workers and model calls); the rest wait in order and are told their place. A user may have at
 * most JOBS_PER_USER jobs running or waiting (default 2).
 *
 * A job is cancelled by its owner (POST /api/jobs/:id/cancel), or when the client that started it
 * goes away. The cancel signal travels with the job (AsyncLocalStorage): the LLM client refuses new
 * calls and aborts the one in flight, Lean verification refuses to start, and the theorem pipeline
 * stops at the next stage boundary — so a cancelled job stops spending money within one call.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export class CancelledError extends Error {
  constructor(message = "cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

/** Too many jobs of this user running or waiting. */
export class TooManyJobsError extends Error {
  constructor(public readonly limit: number) {
    super(`at most ${limit} solve(s) at a time per user`);
    this.name = "TooManyJobsError";
  }
}

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface JobInfo {
  id: string;
  owner: string;
  kind: string;
  sessionId?: string;
  state: JobState;
  /** 1 = next to start (queued jobs only). */
  position?: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
}

interface Job extends JobInfo {
  controller: AbortController;
  start?: () => void;
  onQueued?: (position: number) => void;
}

const jobs = new Map<string, Job>();
const queue: Job[] = [];
let running = 0;
const storage = new AsyncLocalStorage<{ signal: AbortSignal; jobId: string }>();

const envInt = (name: string, dflt: number) => {
  const v = Number(process.env[name]);
  return process.env[name] && Number.isFinite(v) && v >= 1 ? Math.floor(v) : dflt;
};
const concurrency = () => envInt("SOLVE_CONCURRENCY", 2);
const perUser = () => envInt("JOBS_PER_USER", 2);

/** The running job's cancel signal (undefined outside a job). */
export function currentSignal(): AbortSignal | undefined {
  return storage.getStore()?.signal;
}

export function currentJobId(): string | undefined {
  return storage.getStore()?.jobId;
}

/** Throw CancelledError when the current job was cancelled. */
export function throwIfCancelled(): void {
  if (storage.getStore()?.signal.aborted) throw new CancelledError();
}

export function isCancelled(e: unknown): boolean {
  return e instanceof CancelledError || (!!storage.getStore()?.signal.aborted && e instanceof Error && /abort/i.test(e.name + e.message));
}

function info(j: Job): JobInfo {
  const { controller: _c, start: _s, onQueued: _q, ...rest } = j;
  return { ...rest, ...(j.state === "queued" ? { position: queue.indexOf(j) + 1 } : {}) };
}

function tellPositions(): void {
  queue.forEach((j, i) => j.onQueued?.(i + 1));
}

function next(): void {
  while (running < concurrency() && queue.length) {
    const j = queue.shift()!;
    running++;
    j.start?.();
  }
  tellPositions();
}

/** Forget finished jobs after a while (the list is for the UI, not an archive). */
function prune(): void {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [id, j] of jobs) if (j.endedAt && j.endedAt < cutoff) jobs.delete(id);
}

/**
 * Run `fn` as a job: queued behind the running ones when the limit is reached, cancellable through
 * `cancelJob`, through `opts.signal` (e.g. the request's) and from inside via the signal it gets.
 * `onStart` runs once the job has an id (before it waits), `onQueued` each time its place changes.
 */
export async function runJob<T>(
  opts: {
    owner: string;
    kind: string;
    sessionId?: string;
    signal?: AbortSignal;
    /** Jobs this owner may have running or waiting (the plan's concurrentSolvers; -1 = no limit); default JOBS_PER_USER. */
    maxActive?: number;
    onStart?: (job: JobInfo) => void;
    onQueued?: (position: number) => void;
  },
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  prune();
  const active = [...jobs.values()].filter((j) => j.owner === opts.owner && (j.state === "queued" || j.state === "running")).length;
  const limit = opts.maxActive === undefined ? perUser() : opts.maxActive < 0 ? Infinity : Math.max(1, opts.maxActive);
  if (active >= limit) throw new TooManyJobsError(limit);
  const job: Job = { id: randomUUID(), owner: opts.owner, kind: opts.kind, sessionId: opts.sessionId, state: "queued", createdAt: Date.now(), controller: new AbortController(), onQueued: opts.onQueued };
  jobs.set(job.id, job);
  const outer = opts.signal;
  const onOuterAbort = () => job.controller.abort();
  if (outer) {
    if (outer.aborted) job.controller.abort();
    else outer.addEventListener("abort", onOuterAbort, { once: true });
  }
  opts.onStart?.(info(job));
  try {
    // Wait for a slot (or a cancel while waiting).
    await new Promise<void>((resolve, reject) => {
      if (job.controller.signal.aborted) return reject(new CancelledError());
      job.start = resolve;
      job.controller.signal.addEventListener(
        "abort",
        () => {
          const i = queue.indexOf(job);
          if (i >= 0) {
            queue.splice(i, 1);
            tellPositions();
            reject(new CancelledError());
          }
        },
        { once: true },
      );
      queue.push(job);
      next();
    });
  } catch (e) {
    job.state = "cancelled";
    job.endedAt = Date.now();
    outer?.removeEventListener("abort", onOuterAbort);
    throw e;
  }
  job.state = "running";
  job.startedAt = Date.now();
  try {
    const out = await storage.run({ signal: job.controller.signal, jobId: job.id }, () => fn(job.controller.signal));
    job.state = job.controller.signal.aborted ? "cancelled" : "done";
    return out;
  } catch (e) {
    job.state = job.controller.signal.aborted ? "cancelled" : "failed";
    if (job.controller.signal.aborted && !(e instanceof CancelledError)) throw new CancelledError();
    throw e;
  } finally {
    job.endedAt = Date.now();
    outer?.removeEventListener("abort", onOuterAbort);
    running--;
    next();
  }
}

/** Cancel a job of `owner`; false when there is no such job (or it is someone else's) or it already ended. */
export function cancelJob(id: string, owner: string): boolean {
  const j = jobs.get(id);
  if (!j || j.owner !== owner || (j.state !== "queued" && j.state !== "running")) return false;
  j.controller.abort();
  return true;
}

/** The owner's jobs, newest first. */
export function listJobs(owner: string): JobInfo[] {
  prune();
  return [...jobs.values()].filter((j) => j.owner === owner).map(info).sort((a, b) => b.createdAt - a.createdAt);
}

export function _resetJobsForTests(): void {
  for (const j of jobs.values()) j.controller.abort();
  jobs.clear();
  queue.length = 0;
  running = 0;
}
