import { NextResponse } from "next/server";
import { runMultiAgentEvaluation } from "@/lib/agents/orchestrator";
import { getSessionAsync, updateSession } from "@/lib/session-store";
import { LlmError } from "@/lib/llm/client";
import type { MathDomain } from "@/lib/types";

export async function POST(req: Request) {
  const body = (await req.json()) as {
    session_id: string;
    domain?: MathDomain;
  };

  if (!body.session_id) {
    return NextResponse.json({ error: "session_id required" }, { status: 400 });
  }

  const session = await getSessionAsync(body.session_id);
  if (!session) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }

  const domain = body.domain ?? session.math_domain ?? "other";

  try {
    updateSession(session.id, { pipeline_stage: "evaluating" });

    const result = await runMultiAgentEvaluation({
      problemText: session.problem_text,
      formalStatement: session.formal_statement,
      domain,
    });

    const updated = updateSession(session.id, {
      methods: result.methods,
      method_scores: result.scores,
      recommended_method_id: result.recommended_method_id,
      comparison_summary: result.comparison,
      pipeline_stage: "solving",
    });

    return NextResponse.json({
      session_id: updated.id,
      domain,
      methods: result.methods,
      scores: result.scores,
      recommended_method_id: result.recommended_method_id,
      comparison: result.comparison,
    });
  } catch (e) {
    updateSession(session.id, { pipeline_stage: "failed" });
    const msg = e instanceof LlmError ? e.message : "evaluation failed";
    return NextResponse.json(
      { error: msg, session_id: session.id },
      { status: 502 },
    );
  }
}
