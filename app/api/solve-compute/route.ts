import { NextResponse } from "next/server";
import { solveComputational } from "@/lib/compute/solver";
import { LlmError } from "@/lib/llm/client";
import { modelRoute } from "@/lib/model-route";

interface SolveComputeRequest {
  problem_text: string;
  options?: {
    skip_cross_validation?: boolean;
    max_methods?: number;
    decimal_precision?: number;
  };
}

async function handlePOST(req: Request) {
  let body: SolveComputeRequest;
  try {
    body = (await req.json()) as SolveComputeRequest;
  } catch {
    return NextResponse.json(
      { error: "invalid JSON body" },
      { status: 400 },
    );
  }

  if (!body.problem_text?.trim()) {
    return NextResponse.json(
      { error: "problem_text is required" },
      { status: 400 },
    );
  }

  try {
    const result = await solveComputational({
      problemText: body.problem_text.trim(),
      options: body.options,
    });

    return NextResponse.json(result);
  } catch (e) {
    const msg =
      e instanceof LlmError ? e.message : "solve-compute pipeline failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

// Server messages and model output follow the UI language (lib/llm/output-locale.ts).
// Signed-in caller, spend limit and rate limit checked; model calls charged to the caller (lib/model-route.ts).
export const POST = modelRoute(handlePOST);
