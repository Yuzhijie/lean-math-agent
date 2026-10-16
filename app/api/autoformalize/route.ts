import { getSessionForRequest, createSessionForRequest } from "@/lib/session-access";
import { NextResponse } from "next/server";
import { autoformalize } from "@/lib/llm/autoformalize";
import { updateSession } from "@/lib/session-store";
import { LlmError } from "@/lib/llm/client";
import { modelRoute } from "@/lib/model-route";

async function handlePOST(req: Request) {
  const body = (await req.json()) as {
    problem_text?: string;
    session_id?: string;
  };

  // Either use existing session or create new one
  let session;
  if (body.session_id) {
    session = await getSessionForRequest(body.session_id);
    if (!session) {
      return NextResponse.json(
        { error: "session not found" },
        { status: 404 },
      );
    }
  } else if (body.problem_text?.trim()) {
    session = await createSessionForRequest(body.problem_text.trim());
  } else {
    return NextResponse.json(
      { error: "problem_text or session_id required" },
      { status: 400 },
    );
  }

  try {
    updateSession(session.id, { pipeline_stage: "autoformalizing" });

    const result = await autoformalize({
      problemText: session.problem_text,
    });

    const updated = updateSession(session.id, {
      theorem_name: result.theorem_name,
      theorem_type: result.theorem_type,
      math_domain: result.domain,
      formal_statement: result.formal_statement,
      formal_validated: result.accepted,
      validation_results: result.validation_results,
      pipeline_stage: result.accepted ? "enumerating" : "failed",
    });

    return NextResponse.json({
      session_id: updated.id,
      theorem_name: result.theorem_name,
      theorem_type: result.theorem_type,
      domain: result.domain,
      formal_statement: result.formal_statement,
      accepted: result.accepted,
      validation_results: result.validation_results,
    });
  } catch (e) {
    updateSession(session.id, { pipeline_stage: "failed" });
    const msg = e instanceof LlmError ? e.message : "autoformalize failed";
    return NextResponse.json(
      { error: msg, session_id: session.id },
      { status: 502 },
    );
  }
}

// Server messages and model output follow the UI language (lib/llm/output-locale.ts).
// Signed-in caller, spend limit and rate limit checked; model calls charged to the caller (lib/model-route.ts).
export const POST = modelRoute(handlePOST);
