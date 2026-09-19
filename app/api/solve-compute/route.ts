import { NextResponse } from "next/server";
import { solveComputational } from "@/lib/compute/solver";
import { LlmError } from "@/lib/llm/client";

interface SolveComputeRequest {
  problem_text: string;
  options?: {
    skip_cross_validation?: boolean;
    max_methods?: number;
    decimal_precision?: number;
  };
}

export async function POST(req: Request) {
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
