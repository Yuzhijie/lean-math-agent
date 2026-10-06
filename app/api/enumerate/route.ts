import { NextResponse } from "next/server";
import { enumerateMethods } from "@/lib/llm/enumerate";
import { createSession, updateSession } from "@/lib/session-store";
import { LlmError } from "@/lib/llm/client";
import { withRequestLocale } from "@/lib/llm/output-locale";
import { requestOwner } from "@/lib/bank/http";
import { describeProblemFigures, figureRefsSchema, figureTextOf, problemWithFigure } from "@/lib/bank/problem-figures";

async function handlePOST(req: Request) {
  const body = (await req.json()) as { problem_text?: string; figures?: unknown; figure_text?: unknown };
  if (!body.problem_text?.trim()) {
    return NextResponse.json({ error: "problem_text required" }, { status: 400 });
  }
  // Figures (question bank images) are read by the vision model and appended to the problem text.
  const figs = figureRefsSchema.safeParse(body.figures ?? []);
  if (!figs.success) return NextResponse.json({ error: "invalid figures" }, { status: 400 });
  const known = figureTextOf(body.figure_text);
  const fig: { description?: string; note?: string } = known ? { description: known } : figs.data.length ? await describeProblemFigures({ owner: await requestOwner(), problemText: body.problem_text.trim(), figures: figs.data }) : {};
  const session = createSession(fig.description ? problemWithFigure(body.problem_text, fig.description) : body.problem_text.trim());
  if (fig.description) updateSession(session.id, { figure_description: fig.description });
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
      ...(fig.description ? { figure_description: fig.description } : {}),
      ...(fig.note ? { figure_note: fig.note } : {}),
    });
  } catch (e) {
    const msg = e instanceof LlmError ? e.message : "enumerate failed";
    return NextResponse.json({ error: msg, session_id: session.id }, { status: 502 });
  }
}

// Server messages and model output follow the UI language (lib/llm/output-locale.ts).
export const POST = withRequestLocale(handlePOST);
