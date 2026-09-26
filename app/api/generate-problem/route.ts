import { NextResponse } from "next/server";
import { generateProblems } from "@/lib/llm/generate-problem";
import { LlmError } from "@/lib/llm/client";
import type { GradeLevel, DifficultyLevel, CompetitionDomain } from "@/lib/types";
import {
  GRADE_LEVELS,
  DIFFICULTY_LEVELS,
  COMPETITION_DOMAINS,
} from "@/lib/types";
import { withRequestLocale } from "@/lib/llm/output-locale";

// Problem generation can take a long time with slow LLM endpoints.
// Deadline = GENERATE_TIMEOUT_MS (180s) × 2.5 = 450s; give a 30s buffer.
export const maxDuration = 480;

interface GenerateRequest {
  grade_level?: GradeLevel;
  difficulty?: DifficultyLevel;
  domain?: CompetitionDomain;
  count?: number;
}

async function handlePOST(req: Request) {
  let body: GenerateRequest;
  try {
    body = (await req.json()) as GenerateRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body.grade_level || !GRADE_LEVELS.includes(body.grade_level)) {
    return NextResponse.json(
      { error: `grade_level required, one of: ${GRADE_LEVELS.join(", ")}` },
      { status: 400 },
    );
  }
  if (!body.difficulty || !DIFFICULTY_LEVELS.includes(body.difficulty)) {
    return NextResponse.json(
      { error: `difficulty required, one of: ${DIFFICULTY_LEVELS.join(", ")}` },
      { status: 400 },
    );
  }
  if (!body.domain || !COMPETITION_DOMAINS.includes(body.domain)) {
    return NextResponse.json(
      { error: `domain required, one of: ${COMPETITION_DOMAINS.join(", ")}` },
      { status: 400 },
    );
  }

  const count = typeof body.count === "number" ? body.count : 3;

  try {
    const problems = await generateProblems({
      gradeLevel: body.grade_level,
      difficulty: body.difficulty,
      domain: body.domain,
      count,
    });

    return NextResponse.json({ problems });
  } catch (e) {
    console.error("[generate-problem] caught error:", e);

    let msg: string;
    if (e instanceof LlmError) {
      msg = e.message;
    } else if (
      e instanceof DOMException &&
      e.name === "AbortError"
    ) {
      msg = "LLM request timed out";
    } else {
      msg = `generate-problem failed: ${e instanceof Error ? e.message : String(e)}`;
    }

    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

// Server messages and model output follow the UI language (lib/llm/output-locale.ts).
export const POST = withRequestLocale(handlePOST);
