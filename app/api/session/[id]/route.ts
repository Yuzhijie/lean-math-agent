import { getSessionForRequest } from "@/lib/session-access";
import { NextResponse } from "next/server";
import { deleteSessionFromDisk } from "@/lib/session-store";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const session = await getSessionForRequest(id);
  if (!session) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  return NextResponse.json(session);
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  // Only the owner may delete it; someone else's session is "not found".
  if (!(await getSessionForRequest(id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const ok = await deleteSessionFromDisk(id);
  if (!ok) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
