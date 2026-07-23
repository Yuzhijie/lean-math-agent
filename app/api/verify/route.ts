import { NextResponse } from "next/server";
import { assembleLeanSource } from "@/lib/lean/assemble";
import { verifyLeanSource } from "@/lib/lean/sandbox";
import { getSession, updateSession } from "@/lib/session-store";

export async function POST(req: Request) {
  const body = (await req.json()) as { session_id?: string };
  if (!body.session_id?.trim()) {
    return NextResponse.json({ error: "session_id required" }, { status: 400 });
  }
  const session = getSession(body.session_id);
  if (!session) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  if (!session.theorem_type) {
    return NextResponse.json(
      { error: "session missing theorem_type; run plan first" },
      { status: 400 },
    );
  }

  const assembled_lean = assembleLeanSource({
    theoremName: session.theorem_name ?? "problem",
    theoremType: session.theorem_type,
    stepCodes: session.steps
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((s) => s.lean_code)
      .filter(Boolean),
  });
  const result = await verifyLeanSource(session.id, assembled_lean);
  const updated = updateSession(session.id, {
    assembled_lean,
    build_status: result.status,
  });
  return NextResponse.json({
    session_id: updated.id,
    ok: result.ok,
    log: result.log,
    build_status: updated.build_status,
    assembled_lean: updated.assembled_lean,
  });
}
