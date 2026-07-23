import { NextResponse } from "next/server";
import { enumerateMethods } from "@/lib/llm/enumerate";
import { createSession, updateSession } from "@/lib/session-store";
import { LlmError } from "@/lib/llm/client";

export async function POST(req: Request) {
  const body = (await req.json()) as { problem_text?: string };
  if (!body.problem_text?.trim()) {
    return NextResponse.json({ error: "problem_text required" }, { status: 400 });
  }
  const session = createSession(body.problem_text.trim());
  try {
    const result = await enumerateMethods(session.problem_text);
    const updated = updateSession(session.id, {
      methods: result.methods,
      comparison_summary: result.comparison_summary,
      out_of_domain_warning: result.out_of_domain_warning ?? undefined,
    });
    return NextResponse.json({
      session_id: updated.id,
      methods: updated.methods,
      comparison_summary: updated.comparison_summary,
      out_of_domain_warning: updated.out_of_domain_warning ?? null,
    });
  } catch (e) {
    const msg = e instanceof LlmError ? e.message : "enumerate failed";
    return NextResponse.json({ error: msg, session_id: session.id }, { status: 502 });
  }
}
