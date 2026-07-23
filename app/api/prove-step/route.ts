import { NextResponse } from "next/server";
import { assembleLeanSource, stepCodesUpTo } from "@/lib/lean/assemble";
import { proveStepWithRepair } from "@/lib/llm/prove-step";
import { LlmError } from "@/lib/llm/client";
import { getSession, updateSession } from "@/lib/session-store";

export async function POST(req: Request) {
  const body = (await req.json()) as {
    session_id?: string;
    step_index?: number;
    theorem_type?: string;
  };
  if (!body.session_id?.trim() || typeof body.step_index !== "number") {
    return NextResponse.json(
      { error: "session_id and step_index required" },
      { status: 400 },
    );
  }
  const session = getSession(body.session_id);
  if (!session) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  if (!session.selected_method_id) {
    return NextResponse.json({ error: "no method selected" }, { status: 400 });
  }
  const method = session.methods.find(
    (m) => m.id === session.selected_method_id,
  );
  if (!method) {
    return NextResponse.json({ error: "method not found" }, { status: 400 });
  }
  const theoremType = body.theorem_type ?? session.theorem_type;
  if (!theoremType) {
    return NextResponse.json(
      { error: "theorem_type required (body or session)" },
      { status: 400 },
    );
  }
  if (!session.steps.some((s) => s.index === body.step_index)) {
    return NextResponse.json({ error: "step not found" }, { status: 400 });
  }

  try {
    const { step: proved, buildStatus } = await proveStepWithRepair({
      session,
      method,
      stepIndex: body.step_index,
      theoremType,
    });
    const steps = session.steps.map((s) =>
      s.index === proved.index ? proved : s,
    );
    // Same prefix filter as repair verifies (no sorry — only real step codes).
    const assembled_lean = assembleLeanSource({
      theoremName: session.theorem_name ?? "problem",
      theoremType,
      stepCodes: stepCodesUpTo(steps, body.step_index),
    });
    const updated = updateSession(session.id, {
      steps,
      assembled_lean,
      // Never set "ok" here — only /api/verify may. Prefer idle; signal unavailable.
      build_status: buildStatus === "unavailable" ? "unavailable" : "idle",
    });
    return NextResponse.json({
      session_id: updated.id,
      step: proved,
      assembled_lean: updated.assembled_lean,
      build_status: updated.build_status,
    });
  } catch (e) {
    const msg = e instanceof LlmError ? e.message : "prove-step failed";
    return NextResponse.json(
      { error: msg, session_id: session.id },
      { status: 502 },
    );
  }
}
