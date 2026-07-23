import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MethodOption, Session } from "@/lib/types";

vi.mock("@/lib/llm/client", () => ({
  chatJson: vi.fn(),
}));

vi.mock("@/lib/lean/sandbox", () => ({
  verifyLeanSource: vi.fn(),
}));

import { chatJson } from "@/lib/llm/client";
import { verifyLeanSource } from "@/lib/lean/sandbox";
import { proveStepWithRepair } from "@/lib/llm/prove-step";

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
  created_at: 1,
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
      .mockResolvedValueOnce({
        ok: false,
        log: "type mismatch",
        status: "fail",
      })
      .mockResolvedValueOnce({
        ok: true,
        log: "ok",
        status: "ok",
      });

    const result = await proveStepWithRepair({
      session,
      method,
      stepIndex: 0,
      theoremType: session.theorem_type!,
    });

    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(verifyMock).toHaveBeenCalledTimes(2);
    expect(result.step.status).toBe("ok");
    expect(result.step.lean_code).toBe("rfl");
    expect(result.buildStatus).toBe("idle");
  });

  it("short-circuits on Lean unavailable without further LLM calls", async () => {
    const chatMock = vi.mocked(chatJson);
    chatMock.mockResolvedValueOnce({
      plain_explanation: "尝试",
      lean_code: "rfl",
    });

    const verifyMock = vi.mocked(verifyLeanSource);
    verifyMock.mockResolvedValueOnce({
      ok: false,
      log: "lake missing",
      status: "unavailable",
    });

    const result = await proveStepWithRepair({
      session,
      method,
      stepIndex: 0,
      theoremType: session.theorem_type!,
    });

    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(verifyMock).toHaveBeenCalledTimes(1);
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
    vi.mocked(verifyLeanSource).mockResolvedValueOnce({
      ok: true,
      log: "ok",
      status: "ok",
    });

    await proveStepWithRepair({
      session: multiStep,
      method,
      stepIndex: 0,
      theoremType: multiStep.theorem_type!,
    });

    const source = vi.mocked(verifyLeanSource).mock.calls[0][1];
    expect(source).toMatch(/intro n\s*\n\s*sorry/);
  });
});
