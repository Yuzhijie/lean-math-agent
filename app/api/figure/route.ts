import { NextResponse } from "next/server";
import { z } from "zod";
import { generateFigure } from "@/lib/figure/generate";
import { LlmError } from "@/lib/llm/client";
import { getSessionAsync, updateSession } from "@/lib/session-store";
import { withRequestLocale } from "@/lib/llm/output-locale";

const bodySchema = z.object({
  session_id: z.string().min(1).optional(),
  problem_text: z.string().min(1).max(5000).optional(),
  /** Regenerate even when the session already has a figure. */
  refresh: z.boolean().optional(),
  /** Skip the "does this problem need a figure" keyword filter. */
  force: z.boolean().optional(),
});

/**
 * POST /api/figure — a figure for a session's problem (and its natural
 * language solution, for step highlights), or for a bare problem text.
 * The figure is computed and checked server-side and cached on the session.
 */
async function handlePOST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request", detail: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;
  const session = body.session_id ? await getSessionAsync(body.session_id) : undefined;
  if (body.session_id && !session) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  const problemText = session?.problem_text ?? body.problem_text;
  if (!problemText) {
    return NextResponse.json({ error: "session_id or problem_text required" }, { status: 400 });
  }
  if (session?.figure && !body.refresh) {
    return NextResponse.json({ session_id: session.id, figure: session.figure, cached: true });
  }
  try {
    const result = await generateFigure({ problemText, solution: session?.nl_solution, force: body.force });
    if (session && result.figure) updateSession(session.id, { figure: result.figure });
    return NextResponse.json({ session_id: session?.id, figure: result.figure ?? null, reason: result.reason, attempts: result.attempts });
  } catch (e) {
    const msg = e instanceof LlmError ? e.message : "figure generation failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

// Server messages and model output follow the UI language (lib/llm/output-locale.ts).
export const POST = withRequestLocale(handlePOST);
