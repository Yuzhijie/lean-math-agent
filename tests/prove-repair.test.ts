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
    expect(result.status).toBe("ok");
    expect(result.lean_code).toBe("rfl");
  });
});
