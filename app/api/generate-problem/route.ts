import { NextResponse } from "next/server";
import { z } from "zod";
import { generateProblemsFromBank } from "@/lib/bank/generator-bridge";
import { requestOwner } from "@/lib/bank/http";
import { BankError } from "@/lib/bank/store";
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

const bankSourceSchema = z.object({
  source: z.literal("bank"),
  bank_id: z.string().min(1).max(64),
  grade: z.string().max(40).optional(),
  difficulty: z.number().int().min(1).max(5).optional(),
  category_id: z.string().min(1).max(64).optional(),
  knowledge_point: z.string().max(80).optional(),
  count: z.number().int().min(1).max(10).default(3),
});

/** Method 1: the local question bank as the template (Level / Difficulty / Topic pick the template questions). */
async function generateFromBank(body: unknown) {
  const parsed = bankSourceSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json({ error: `invalid request: ${first?.path.join(".")} ${first?.message}` }, { status: 400 });
  }
  const { bank_id, count, ...selection } = parsed.data;
  try {
    const owner = await requestOwner();
    const result = await generateProblemsFromBank({ owner, bankId: bank_id, selection: { grade: selection.grade, difficulty: selection.difficulty, category_id: selection.category_id, knowledge_point: selection.knowledge_point }, count });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof BankError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("[generate-problem/bank] caught error:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

async function handlePOST(req: Request) {
  let body: GenerateRequest;
  try {
    body = (await req.json()) as GenerateRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  // Method 1 (local bank as template); everything below is method 2 (built-in), unchanged.
  if ((body as { source?: string }).source === "bank") return generateFromBank(body);

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
