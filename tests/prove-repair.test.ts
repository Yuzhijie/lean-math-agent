import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MethodOption, Session } from "@/lib/types";

vi.mock("@/lib/llm/client", () => ({
  chatJson: vi.fn(),
}));

vi.mock("@/lib/lean/sandbox", () => ({
  verifyLeanSource: vi.fn(),
}));

import { chatJson } from "@/lib/llm/client";
import { verifyLeanSource, type LeanVerifyResult } from "@/lib/lean/sandbox";
import { proveStepWithRepair } from "@/lib/llm/prove-step";

/** Build a verifier result with sensible defaults for the fields tests don't care about. */
function verifyResult(partial: Partial<LeanVerifyResult>): LeanVerifyResult {
  return {
    ok: false,
    log: "",
    status: "fail",
    backend: "repl",
    messages: [],
    sorries: [],
    goals: [],
    infos: [],
    durationMs: 1,
    ...partial,
  };
}

/** Result of the prefix (goal-state) verification that precedes every attempt. */
const PREFIX_OK = verifyResult({
  ok: true,
  log: "ok",
  status: "ok",
  goals: ["n : Nat\n⊢ n + 0 = n"],
});

const method: MethodOption = {
  id: "m1",
  category: "rewrite",
  title: "rfl",
  inspiration: "i",
  pros: "p",
  cons: "c",
  lean_sketch: "rfl",
  confidence: 0.9,
};

const session: Session = {
  id: "sess-1",
  problem_text: "prove n + 0 = n",
  methods: [method],
  selected_method_id: "m1",
  theorem_name: "problem",
  theorem_type: "(n : Nat) : n + 0 = n",
  steps: [
    {
      index: 0,
      plain_goal: "证明 n+0=n",
      lean_goal: "n + 0 = n",
      plain_explanation: "",
      lean_code: "",
      status: "pending",
    },
  ],
  assembled_lean: "",
  build_status: "idle",
  pipeline_stage: "solving",
  formal_validated: false,
  validation_results: [],
  sorry_labels: [],
  created_at: 1,
  updated_at: 1,
};

describe("proveStepWithRepair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries once after verify fail then succeeds (2 attempts, status ok)", async () => {
    const chatMock = vi.mocked(chatJson);
    chatMock
      .mockResolvedValueOnce({
        plain_explanation: "错误尝试",
        lean_code: "exact False.elim",
      })
      .mockResolvedValueOnce({
        plain_explanation: "用 rfl",
        lean_code: "rfl",
      });

    const verifyMock = vi.mocked(verifyLeanSource);
    verifyMock
      .mockResolvedValueOnce(PREFIX_OK) // goal-state probe before the loop
      .mockResolvedValueOnce(verifyResult({ ok: false, log: "type mismatch", status: "fail" }))
      .mockResolvedValueOnce(verifyResult({ ok: true, log: "ok", status: "ok" }));

    const result = await proveStepWithRepair({
      session,
      method,
      stepIndex: 0,
      theoremType: session.theorem_type!,
    });

    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(verifyMock).toHaveBeenCalledTimes(3);
    expect(result.step.status).toBe("ok");
    expect(result.step.lean_code).toBe("rfl");
    expect(result.buildStatus).toBe("idle");

    // The Lean goal state from the prefix probe is handed to the prover.
    const firstPrompt = chatMock.mock.calls[0][0] as { user: string };
    expect(firstPrompt.user).toContain("Current Lean goal state");
    expect(firstPrompt.user).toContain("⊢ n + 0 = n");
  });

  it("short-circuits on Lean unavailable without further LLM calls", async () => {
    const chatMock = vi.mocked(chatJson);
    chatMock.mockResolvedValueOnce({
      plain_explanation: "尝试",
      lean_code: "rfl",
    });

    const verifyMock = vi.mocked(verifyLeanSource);
    const unavailable = verifyResult({ ok: false, log: "lake missing", status: "unavailable", backend: "none" });
    verifyMock.mockResolvedValueOnce(unavailable).mockResolvedValueOnce(unavailable);

    const result = await proveStepWithRepair({
      session,
      method,
      stepIndex: 0,
      theoremType: session.theorem_type!,
    });

    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(verifyMock).toHaveBeenCalledTimes(2);
    expect(result.step.status).toBe("pending");
    expect(result.buildStatus).toBe("unavailable");
    expect(result.step.build_log).toContain("lake missing");
  });

  it("appends sorry when verifying a non-final step prefix", async () => {
    const multiStep: Session = {
      ...session,
      steps: [
        {
          index: 0,
          plain_goal: "intro",
          lean_goal: "n + 0 = n",
          plain_explanation: "",
          lean_code: "",
          status: "pending",
        },
        {
          index: 1,
          plain_goal: "finish",
          lean_goal: "⊢ n + 0 = n",
          plain_explanation: "",
          lean_code: "",
          status: "pending",
        },
      ],
    };

    vi.mocked(chatJson).mockResolvedValueOnce({
      plain_explanation: "intro n",
      lean_code: "intro n",
    });
    vi.mocked(verifyLeanSource)
      .mockResolvedValueOnce(PREFIX_OK)
      .mockResolvedValueOnce(verifyResult({ ok: true, log: "ok", status: "ok" }));

    await proveStepWithRepair({
      session: multiStep,
      method,
      stepIndex: 0,
      theoremType: multiStep.theorem_type!,
    });

    // calls[0] is the goal-state probe (prefix + sorry), calls[1] the step.
    const probeSource = vi.mocked(verifyLeanSource).mock.calls[0][1];
    expect(probeSource).toMatch(/:= by\s*\n\s*sorry/);
    const source = vi.mocked(verifyLeanSource).mock.calls[1][1];
    const opts = vi.mocked(verifyLeanSource).mock.calls[1][2];
    expect(source).toMatch(/intro n\s*\n\s*sorry/);
    expect(opts).toEqual({ allowSorry: true });
  });
});
