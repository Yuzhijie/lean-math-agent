import { NextResponse } from "next/server";
import { generateIntuitionReview } from "@/lib/llm/intuition";
import { getSessionAsync, updateSession } from "@/lib/session-store";
import { LlmError } from "@/lib/llm/client";

export async function POST(req: Request) {
  const body = (await req.json()) as { session_id: string };

  if (!body.session_id) {
    return NextResponse.json({ error: "session_id required" }, { status: 400 });
  }

  const session = await getSessionAsync(body.session_id);
  if (!session) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }

  if (!session.selected_method_id) {
    return NextResponse.json(
      { error: "no method selected" },
      { status: 400 },
    );
  }

  const method = session.methods.find(
    (m) => m.id === session.selected_method_id,
  );
  if (!method) {
    return NextResponse.json(
      { error: "selected method not found" },
      { status: 400 },
    );
  }

  try {
    updateSession(session.id, { pipeline_stage: "reviewing" });

    const review = await generateIntuitionReview({
      problemText: session.problem_text,
      method,
      steps: session.steps,
      formalStatement: session.formal_statement,
    });

    const updated = updateSession(session.id, {
      intuition_review: review,
      pipeline_stage: "complete",
    });

    return NextResponse.json({
      session_id: updated.id,
      per_step: review.per_step,
      overall_lessons: review.overall_lessons,
      transferable_patterns: review.transferable_patterns,
    });
  } catch (e) {
    updateSession(session.id, { pipeline_stage: "failed" });
    const msg = e instanceof LlmError ? e.message : "intuition review failed";
    return NextResponse.json(
      { error: msg, session_id: session.id },
      { status: 502 },
    );
  }
}
