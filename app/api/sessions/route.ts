import { NextResponse } from "next/server";
import {
  listSessionsFromDisk,
  listSessionsPaginated,
  searchSessions,
} from "@/lib/session-store";

// NOTE: the unauthenticated `DELETE /api/sessions` handler (clear ALL
// sessions) was removed. Sessions are not scoped to a user yet, so it let
// anyone wipe every user's history. Individual deletion remains available
// at `DELETE /api/session/[id]`; a bulk clear should come back only behind
// authentication and scoped to the caller's own sessions.
import type { Session } from "@/lib/types";

export const dynamic = "force-dynamic";

function toSummary(s: Session) {
  return {
    id: s.id,
    problem_text: s.problem_text,
    pipeline_stage: s.pipeline_stage,
    build_status: s.build_status,
    created_at: s.created_at,
    updated_at: s.updated_at,
    theorem_name: s.theorem_name ?? null,
    has_methods: s.methods.length > 0,
    has_steps: s.steps.length > 0,
    has_nl_solution: !!s.nl_solution,
    has_lean_attempt: !!s.lean_proof_attempt,
  };
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const perPage = Math.min(
    100,
    Math.max(1, parseInt(searchParams.get("per_page") ?? "20", 10)),
  );
  const q = searchParams.get("q")?.trim() ?? "";

  // Use pagination/search when params are provided, fall back to list all
  if (q) {
    const result = await searchSessions(q, page, perPage);
    return NextResponse.json({
      sessions: result.sessions.map(toSummary),
      total: result.total,
      page: result.page,
      per_page: result.perPage,
    });
  }

  if (searchParams.has("page") || searchParams.has("per_page")) {
    const result = await listSessionsPaginated(page, perPage);
    return NextResponse.json({
      sessions: result.sessions.map(toSummary),
      total: result.total,
      page: result.page,
      per_page: result.perPage,
    });
  }

  // Legacy: return all sessions as flat array (backward compat)
  const sessions = await listSessionsFromDisk();
  const summaries = sessions.map(toSummary);
  return NextResponse.json(summaries);
}
