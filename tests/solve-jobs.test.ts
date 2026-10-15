import { beforeEach, describe, expect, it, vi } from "vitest";

const { ownerMock } = vi.hoisted(() => ({ ownerMock: vi.fn(async () => "local") }));
vi.mock("@/lib/bank/http", async (orig) => ({ ...(await orig<typeof import("@/lib/bank/http")>()), requestOwner: ownerMock }));
// The classifier waits until the job is cancelled (a long model call).
vi.mock("@/lib/llm/classify-problem", async () => {
  const { currentSignal, CancelledError } = await import("@/lib/jobs");
  return {
    classifyProblem: () =>
      new Promise((_, reject) => currentSignal()?.addEventListener("abort", () => reject(new CancelledError()), { once: true })),
  };
});
vi.mock("@/lib/db", () => ({ prisma: { subscription: { findUnique: async () => null } } }));

import { POST as solveStream } from "@/app/api/solve-stream/route";
import { POST as cancel } from "@/app/api/jobs/[id]/cancel/route";
import { GET as jobs } from "@/app/api/jobs/route";
import { getSession } from "@/lib/session-store";
import { _resetJobsForTests } from "@/lib/jobs";
import { _resetQuotaForTests } from "@/lib/quota";

const post = (body: unknown) => new Request("http://x/api/solve-stream", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  _resetJobsForTests();
  _resetQuotaForTests();
  ownerMock.mockResolvedValue("local");
});

async function frames(res: Response, until: (f: Record<string, unknown>) => boolean) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const out: Array<Record<string, unknown>> = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const p of parts) {
      const f = JSON.parse(p.slice(6)) as Record<string, unknown>;
      out.push(f);
      if (until(f)) return out;
    }
  }
}

describe("solve jobs over the stream", () => {
  it("the job id comes first; cancelling ends the stream with `cancelled`", async () => {
    const res = await solveStream(post({ problem_text: "prove that 1 + 1 = 2" }));
    const reader = res.clone();
    const first = await frames(res, (f) => f.type === "job");
    const { job_id, session_id } = first[0] as { job_id: string; session_id: string };
    expect((await (await jobs()).json()).jobs[0]).toMatchObject({ id: job_id, state: "running" });
    // Someone else cannot cancel it.
    ownerMock.mockResolvedValueOnce("mallory");
    expect((await cancel(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ id: job_id }) })).status).toBe(404);
    expect((await cancel(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ id: job_id }) })).status).toBe(200);
    const rest = await frames(reader, () => false);
    expect(rest.at(-1)).toMatchObject({ type: "cancelled" });
    expect(getSession(session_id)?.pipeline_stage).toBe("cancelled");
  });

  it("over quota: 429 with the reason, before anything starts", async () => {
    ownerMock.mockResolvedValue("u1");
    process.env.RATE_LIMIT_PER_MIN = "1";
    const ok = await solveStream(post({ problem_text: "a" }));
    expect(ok.headers.get("content-type")).toContain("text/event-stream");
    const res = await solveStream(post({ problem_text: "b" }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/Too many solves|太频繁/);
    delete process.env.RATE_LIMIT_PER_MIN;
    _resetJobsForTests();
  });
});
