import { NextResponse } from "next/server";
import { assembleLeanSource } from "@/lib/lean/assemble";
import { verifyLeanSource } from "@/lib/lean/sandbox";
import { getSessionAsync, updateSession } from "@/lib/session-store";
import type { LeanProofAttempt } from "@/lib/types";

export async function POST(req: Request) {
  const body = (await req.json()) as { session_id?: string };
  if (!body.session_id?.trim()) {
    return NextResponse.json({ error: "session_id required" }, { status: 400 });
  }
  const session = await getSessionAsync(body.session_id);
  if (!session) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  if (!session.theorem_type) {
    return NextResponse.json(
      { error: "session missing theorem_type; run plan first" },
      { status: 400 },
    );
  }

  const assembled_lean = assembleLeanSource({
    theoremName: session.theorem_name ?? "problem",
    theoremType: session.theorem_type,
    stepCodes: session.steps
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((s) => s.lean_code)
      .filter(Boolean),
    useMathlib: true,
  });
  // Complete-proof verification: no sorry, standard axioms only, and — when
  // the statement was validated by autoformalization — the same signature.
  const theoremName = session.theorem_name ?? "problem";
  const expectedSignature = session.formal_validated ? session.formal_signature : undefined;
  const result = await verifyLeanSource(session.id, assembled_lean, {
    theoremName,
    expectedSignature,
  });

  // Build lean_proof_attempt from verification results
  const sorrySteps = session.steps.filter((s) => s.status === "sorry");
  const failedSteps = session.steps.filter((s) => s.status === "fail");

  const leanProofAttempt: LeanProofAttempt = {
    attempted: true,
    success: result.ok && sorrySteps.length === 0 && failedSteps.length === 0,
    formal_statement: assembled_lean,
    proof_code: result.ok ? assembled_lean : undefined,
    failure_reason: result.ok
      ? sorrySteps.length > 0
        ? `Lean 编译通过，但有 ${sorrySteps.length} 个步骤使用了 sorry（未完成的证明）`
        : undefined
      : `Lean 验证失败: ${result.log.slice(0, 300)}`,
    limitations: [
      ...sorrySteps.map(
        (s) => `步骤 ${s.index + 1} (${s.plain_goal}): 使用了 sorry，需要进一步完善`,
      ),
      ...failedSteps.map(
        (s) => `步骤 ${s.index + 1} (${s.plain_goal}): 证明失败`,
      ),
    ],
    axioms: result.axioms?.axioms,
    statement_locked: expectedSignature !== undefined && result.signatureMatch === true,
    verifier: result.backend,
  };

  const updated = updateSession(session.id, {
    assembled_lean,
    build_status: result.status,
    lean_proof_attempt: leanProofAttempt,
  });

  return NextResponse.json({
    session_id: updated.id,
    ok: result.ok,
    log: result.log,
    build_status: updated.build_status,
    assembled_lean: updated.assembled_lean,
    lean_proof_attempt: leanProofAttempt,
    verification: {
      backend: result.backend,
      axioms: result.axioms?.axioms ?? null,
      disallowed_axioms: result.axioms?.disallowed ?? null,
      statement_locked: leanProofAttempt.statement_locked,
      signature: result.signature ?? null,
    },
  });
}
