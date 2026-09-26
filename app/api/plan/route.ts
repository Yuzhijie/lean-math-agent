import { NextResponse } from "next/server";
import { planSteps } from "@/lib/llm/plan";
import { normalizeTheoremType } from "@/lib/llm/autoformalize";
import { validateTheoremStatement } from "@/lib/lean/sanitize";
import { LlmError } from "@/lib/llm/client";
import {
  getSessionAsync,
  resetStepsForMethod,
  updateSession,
} from "@/lib/session-store";
import type { ProofStep } from "@/lib/types";
import { generateNLSolution } from "@/lib/llm/nl-solution";
import { withRequestLocale } from "@/lib/llm/output-locale";

async function handlePOST(req: Request) {
  const body = (await req.json()) as {
    session_id?: string;
    method_id?: string;
  };
  if (!body.session_id?.trim() || !body.method_id?.trim()) {
    return NextResponse.json(
      { error: "session_id and method_id required" },
      { status: 400 },
    );
  }
  const session = await getSessionAsync(body.session_id);
  if (!session) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  const method = session.methods.find((m) => m.id === body.method_id);
  if (!method) {
    return NextResponse.json({ error: "method not found" }, { status: 400 });
  }

  try {
    // Step 1: Plan proof steps
    resetStepsForMethod(session.id, method.id);
    const plan = await planSteps(session.problem_text, method);
    const steps: ProofStep[] = plan.steps.map((s) => ({
      index: s.index,
      plain_goal: s.plain_goal,
      lean_goal: s.lean_goal,
      plain_explanation: "",
      lean_code: "",
      status: "pending",
    }));

    // Step 2: Generate method-specific NL solution
    const nlSolution = await generateNLSolution({
      problemText: session.problem_text,
      problemType: "theorem",
      method: {
        title: method.title,
        category: method.category,
        inspiration: method.inspiration,
        lean_sketch: method.lean_sketch,
      },
    }).catch(() => null);

    // Statement lock: a validated formalization is never overwritten by the
    // planner; otherwise accept the planner's declaration only if well-formed.
    const frozen = session.formal_validated && !!session.formal_signature;
    let theoremName = session.theorem_name;
    let theoremType = session.theorem_type;
    if (!frozen) {
      const candidateName = plan.theorem_name || theoremName || "problem";
      const candidateType = normalizeTheoremType(plan.theorem_type || theoremType || "");
      if (validateTheoremStatement(candidateName, candidateType).ok) {
        theoremName = candidateName;
        theoremType = candidateType;
      }
    }

    const updated = updateSession(session.id, {
      steps,
      theorem_name: theoremName,
      theorem_type: theoremType,
      assembled_lean: "",
      build_status: "idle",
      nl_solution: nlSolution ?? undefined,
    });

    return NextResponse.json({
      session_id: updated.id,
      theorem_name: updated.theorem_name,
      theorem_type: updated.theorem_type,
      steps: updated.steps,
      nl_solution: nlSolution,
    });
  } catch (e) {
    const msg = e instanceof LlmError ? e.message : "plan failed";
    return NextResponse.json(
      { error: msg, session_id: session.id },
      { status: 502 },
    );
  }
}

// Server messages and model output follow the UI language (lib/llm/output-locale.ts).
export const POST = withRequestLocale(handlePOST);
