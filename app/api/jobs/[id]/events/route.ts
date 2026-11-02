import { NextResponse } from "next/server";
import { attachJob, type JobEvent } from "@/lib/jobs";
import { requestOwner } from "@/lib/bank/http";

export const dynamic = "force-dynamic";

/**
 * Follow one of the caller's solve jobs again (a page that was reloaded or reopened): SSE with the
 * frames the job has sent so far, then the new ones, the same frames as /api/solve-stream. While a
 * page follows it, the job is not cancelled for having lost its first client. 404 when the job is
 * unknown (finished more than 10 minutes ago, the server restarted, or someone else's).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const owner = await requestOwner();
  const encoder = new TextEncoder();
  let detach: (() => void) | undefined;
  let finished = false;
  const stream = new ReadableStream({
    start(controller) {
      const send = (e: JobEvent) => {
        if (finished) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          end();
        }
      };
      const end = () => {
        if (finished) return;
        finished = true;
        detach?.();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const attached = attachJob(id, owner, (e) => (e ? send(e) : end()));
      if (!attached) return;
      detach = attached.detach;
      for (const e of attached.events) send(e);
      if (attached.closed) end();
      req.signal?.addEventListener("abort", end, { once: true });
    },
    cancel() {
      finished = true;
      detach?.();
    },
  });
  // attachJob runs synchronously in start(): an unknown job is known before the response is returned.
  if (!detach && !finished) {
    return NextResponse.json({ error: "no such job" }, { status: 404 });
  }
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
