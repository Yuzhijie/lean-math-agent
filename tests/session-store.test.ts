import { describe, it, expect, beforeEach } from "vitest";
import {
  createSession,
  getSession,
  updateSession,
  resetStepsForMethod,
  _resetStoreForTests,
} from "@/lib/session-store";

beforeEach(() => _resetStoreForTests());

describe("session-store", () => {
  it("creates and retrieves a session", () => {
    const s = createSession("prove n + 0 = n");
    expect(getSession(s.id)?.problem_text).toBe("prove n + 0 = n");
    expect(s.build_status).toBe("idle");
    expect(s.steps).toEqual([]);
  });

  it("resetStepsForMethod clears steps and sets method id", () => {
    const s = createSession("p");
    updateSession(s.id, {
      steps: [
        {
          index: 0,
          plain_goal: "g",
          lean_goal: "g",
          plain_explanation: "e",
          lean_code: "rfl",
          status: "ok",
        },
      ],
      assembled_lean: "old",
      build_status: "ok",
    });
    const next = resetStepsForMethod(s.id, "m2");
    expect(next.selected_method_id).toBe("m2");
    expect(next.steps).toEqual([]);
    expect(next.assembled_lean).toBe("");
    expect(next.build_status).toBe("idle");
  });
});
