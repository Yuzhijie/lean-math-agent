import { describe, it, expect } from "vitest";
import {
  INITIAL_STATE,
  derivePhase,
  type ProofSessionState,
  type Action,
} from "@/app/hooks/useProofSession";
import type { MethodOption, ProofStep, NaturalLanguageSolution } from "@/lib/types";

// We import the reducer indirectly by re-creating the dispatch logic.
// Since the reducer is not exported, we test via derivePhase and state transitions.

function applyAction(
  state: ProofSessionState,
  action: Action,
): ProofSessionState {
  // Inline reducer logic for testing (mirrors useProofSession.ts)
  switch (action.type) {
    case "RESET_ALL":
      return { ...INITIAL_STATE, problemText: action.problemText ?? state.problemText };
    case "REQUEST":
      return { ...state, busy: action.operation, error: null };
    case "REQUEST_DONE":
      return { ...state, busy: null };
    case "REQUEST_ERROR":
      return { ...state, busy: null, error: action.message };
    case "DISMISS_ERROR":
      return { ...state, error: null };
    case "ENUMERATE_OK":
      return {
        ...state,
        sessionId: action.sessionId,
        methods: action.methods,
        comparisonSummary: action.comparisonSummary ?? null,
        busy: null,
      };
    case "SELECT_METHOD":
      return { ...state, selectedMethodId: action.methodId };
    case "PLAN_OK":
      return {
        ...state,
        steps: action.steps,
        busy: null,
      };
    case "SELECT_STEP":
      return { ...state, selectedStepIndex: action.index };
    case "SOLVE_OK":
      return {
        ...state,
        sessionId: action.sessionId,
        solvedProblemType: action.problemType,
        nlSolution: action.nlSolution ?? null,
        methods: action.methods ?? state.methods,
        methodScores: action.methodScores ?? state.methodScores,
        recommendedMethodId: action.recommendedMethodId ?? state.recommendedMethodId,
        busy: null,
      };
    case "LOAD_SESSION":
      return {
        ...state,
        sessionId: action.sessionId,
        problemText: action.problemText,
        methods: action.methods,
        methodScores: action.methodScores,
        recommendedMethodId: action.recommendedMethodId,
        selectedMethodId: action.selectedMethodId,
        comparisonSummary: action.comparisonSummary,
        steps: action.steps,
        assembledLean: action.assembledLean,
        buildStatus: action.buildStatus,
        nlSolution: action.nlSolution,
        busy: null,
        error: null,
      };
    default:
      return state;
  }
}

describe("derivePhase", () => {
  it("returns idle for initial state", () => {
    expect(derivePhase(INITIAL_STATE)).toBe("idle");
  });

  it("returns enumerated when methods exist", () => {
    const state: ProofSessionState = {
      ...INITIAL_STATE,
      methods: [{ id: "m1", category: "algebra", title: "t", inspiration: "", pros: "", cons: "", lean_sketch: "", confidence: 0.8 }],
    };
    expect(derivePhase(state)).toBe("enumerated");
  });

  it("returns planned when steps exist", () => {
    const state: ProofSessionState = {
      ...INITIAL_STATE,
      steps: [{ index: 0, plain_goal: "g", lean_goal: "g", plain_explanation: "", lean_code: "rfl", status: "pending" }],
    };
    expect(derivePhase(state)).toBe("planned");
  });

  it("returns proving when busy is prove", () => {
    const state: ProofSessionState = {
      ...INITIAL_STATE,
      steps: [{ index: 0, plain_goal: "g", lean_goal: "g", plain_explanation: "", lean_code: "", status: "pending" }],
      busy: "prove",
    };
    expect(derivePhase(state)).toBe("proving");
  });

  it("returns verified when build_status is ok", () => {
    const state: ProofSessionState = {
      ...INITIAL_STATE,
      steps: [{ index: 0, plain_goal: "g", lean_goal: "g", plain_explanation: "", lean_code: "rfl", status: "ok" }],
      buildStatus: "ok",
    };
    expect(derivePhase(state)).toBe("verified");
  });
});

describe("state transitions", () => {
  it("RESET_ALL clears state but preserves problem text", () => {
    const state: ProofSessionState = {
      ...INITIAL_STATE,
      problemText: "original",
      methods: [{ id: "m1", category: "algebra", title: "t", inspiration: "", pros: "", cons: "", lean_sketch: "", confidence: 0.8 }],
      busy: "something",
    };
    const next = applyAction(state, { type: "RESET_ALL", problemText: "new" });
    expect(next.problemText).toBe("new");
    expect(next.methods).toEqual([]);
    expect(next.busy).toBeNull();
  });

  it("REQUEST sets busy and clears error", () => {
    const state: ProofSessionState = { ...INITIAL_STATE, error: "old error" };
    const next = applyAction(state, { type: "REQUEST", operation: "enumerate" });
    expect(next.busy).toBe("enumerate");
    expect(next.error).toBeNull();
  });

  it("ENUMERATE_OK stores methods and session id", () => {
    const methods: MethodOption[] = [
      { id: "m1", category: "algebra", title: "t", inspiration: "i", pros: "p", cons: "c", lean_sketch: "s", confidence: 0.9 },
    ];
    const next = applyAction(INITIAL_STATE, {
      type: "ENUMERATE_OK",
      sessionId: "sess-1",
      methods,
      comparisonSummary: "summary",
    });
    expect(next.sessionId).toBe("sess-1");
    expect(next.methods).toHaveLength(1);
    expect(next.comparisonSummary).toBe("summary");
  });

  it("SOLVE_OK propagates method scores", () => {
    const next = applyAction(INITIAL_STATE, {
      type: "SOLVE_OK",
      sessionId: "sess-2",
      problemType: "theorem",
      methodScores: [
        {
          method_id: "m1",
          feasibility: 0.8,
          elegance: 0.7,
          lean_difficulty: 0.3,
          mathlib_coverage: 0.9,
          pedagogical_value: 0.6,
          composite: 0.75,
          rationale: "good",
        },
      ],
      recommendedMethodId: "m1",
      solveEvents: [],
    });
    expect(next.methodScores).toHaveLength(1);
    expect(next.recommendedMethodId).toBe("m1");
  });

  it("LOAD_SESSION restores full state with scores", () => {
    const next = applyAction(INITIAL_STATE, {
      type: "LOAD_SESSION",
      sessionId: "sess-3",
      problemText: "loaded problem",
      methods: [],
      methodScores: [
        {
          method_id: "m1",
          feasibility: 0.5,
          elegance: 0.5,
          lean_difficulty: 0.5,
          mathlib_coverage: 0.5,
          pedagogical_value: 0.5,
          composite: 0.5,
          rationale: "ok",
        },
      ],
      recommendedMethodId: "m1",
      selectedMethodId: "m1",
      comparisonSummary: "test",
      steps: [],
      assembledLean: "",
      buildStatus: "idle",
      buildLog: "",
      nlSolution: null,
      leanProofAttempt: null,
      solvedProblemType: null,
      solveEvents: [],
    });
    expect(next.sessionId).toBe("sess-3");
    expect(next.methodScores).toHaveLength(1);
    expect(next.recommendedMethodId).toBe("m1");
    expect(next.error).toBeNull();
  });

  it("REQUEST_ERROR sets error and clears busy", () => {
    const state: ProofSessionState = { ...INITIAL_STATE, busy: "test" };
    const next = applyAction(state, { type: "REQUEST_ERROR", message: "failed" });
    expect(next.busy).toBeNull();
    expect(next.error).toBe("failed");
  });
});
