import { getSessionForRequest } from "@/lib/session-access";
import { NextResponse } from "next/server";
import { updateSession } from "@/lib/session-store";
import { withUsageScope } from "@/lib/llm/usage-tracker";
import { answerCandidates, attemptLeanFormalization, leanAttemptRetryable } from "@/lib/pipeline/lean-attempt";
import { lt } from "@/lib/llm/output-locale";
import { modelRoute } from "@/lib/model-route";

/**
 * The last solving step, started by hand: Lean 4 formalization of a solved
 * computational / optimization / find-all-values problem. Theorem problems
 * are formalized as part of solving and have their own proof steps.
 */
async function handlePOST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { session_id?: string };
  if (!body.session_id?.trim()) {
    return NextResponse.json({ error: "session_id required" }, { status: 400 });
  }
  const session = await getSessionForRequest(body.session_id);
  if (!session) {
    return NextResponse.json({ error: lt("会话不存在", "session not found") }, { status: 404 });
  }
  // A proof that succeeded is kept; a failed attempt may be run again.
  if (!leanAttemptRetryable(session.lean_proof_attempt)) {
    return NextResponse.json({ lean_proof_attempt: session.lean_proof_attempt });
  }
  return withUsageScope(async (metrics) => {
    updateSession(session.id, { pipeline_stage: "lean_attempting" });
    const attempt = await attemptLeanFormalization(session.problem_text, {
      answers: answerCandidates(session),
      solution: session.nl_solution,
      sessionId: session.id,
      // "Try again" after a failure searches harder than the first attempt.
      ...(session.lean_proof_attempt?.attempted ? { budget: "normal" } : {}),
    });
    updateSession(session.id, { lean_proof_attempt: attempt, pipeline_stage: "complete" });
    return NextResponse.json({ lean_proof_attempt: attempt, metrics: metrics() });
  });
}

// Signed-in caller, spend limit and rate limit checked; model calls charged to the caller (lib/model-route.ts).
export const POST = modelRoute(handlePOST);
