import { NextResponse } from "next/server";
import { cancelJob } from "@/lib/jobs";
import { requestOwner } from "@/lib/bank/http";

/** Cancel one of the caller's jobs; its stream then ends with a `cancelled` event. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!cancelJob(id, await requestOwner())) return NextResponse.json({ error: "no such running job" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
