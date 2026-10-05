"use client";

import { useReducer, useMemo } from "react";
import type {
  BuildStatus,
  LeanProofAttempt,
  MethodOption,
  MethodScore,
  NaturalLanguageSolution,
  ProofStep,
  StepStatus,
} from "@/lib/types";
import type { RunMetrics } from "@/lib/llm/usage-tracker";

// ── State ──────────────────────────────────────────────────────────────

export interface ProofSessionState {
  // core session
  sessionId: string | null;
  problemText: string;

  // method enumeration
  methods: MethodOption[];
  methodScores: MethodScore[];
  recommendedMethodId: string | null;
  selectedMethodId: string | null;
  comparisonSummary: string | null;
  outOfDomainWarning: string | null;

  // proof steps
  steps: ProofStep[];
  selectedStepIndex: number | null;

  // Lean output
  assembledLean: string;
  buildStatus: BuildStatus;
  buildLog: string;

  // solution results
  nlSolution: NaturalLanguageSolution | null;
  leanProofAttempt: LeanProofAttempt | null;
  solvedProblemType: "computational" | "theorem" | null;
  solveEvents: Array<{ stage: string; detail: string }>;
  /** What the last solve run consumed (LLM calls/tokens, Lean verifications, wall time). */
  runMetrics: RunMetrics | null;

  // autoformalize failure detail
  autoformalizeDetail: string | null;
  validationResults: Array<{ layer: number; pass: boolean; detail: string }> | null;

  // UI
  busy: string | null;
  error: string | null;
  leanView: "full" | "step";
  showGenerator: boolean;
}

export type UiPhase = "idle" | "enumerated" | "planned" | "proving" | "verified";

// ── Actions ────────────────────────────────────────────────────────────

export type Action =
  // reset
  | { type: "RESET_ALL"; problemText?: string }
  | { type: "RESET_METHOD" }
  | { type: "RESET_PROOF" }

  // input
  | { type: "SET_PROBLEM_TEXT"; text: string }
  | { type: "TOGGLE_GENERATOR" }

  // async lifecycle
  | { type: "REQUEST"; operation: string }
  | { type: "REQUEST_ERROR"; message: string; autoformalizeDetail?: string; validationResults?: Array<{ layer: number; pass: boolean; detail: string }> }
  | { type: "REQUEST_DONE" }
  | { type: "DISMISS_ERROR" }

  // enumerate
  | {
      type: "ENUMERATE_OK";
      sessionId: string;
      methods: MethodOption[];
      comparisonSummary?: string;
      outOfDomainWarning?: string | null;
    }

  // plan
  | {
      type: "PLAN_OK";
      steps: ProofStep[];
      nlSolution?: NaturalLanguageSolution;
    }
  | { type: "SELECT_METHOD"; methodId: string }
  | { type: "SELECT_STEP"; index: number }

  // prove step
  | {
      type: "STEP_UPDATED";
      step: ProofStep;
      assembledLean: string;
      buildStatus: BuildStatus;
      buildLog?: string;
    }

  // verify
  | {
      type: "VERIFY_OK";
      assembledLean: string;
      buildStatus: BuildStatus;
      buildLog: string;
      leanProofAttempt?: LeanProofAttempt;
    }

  // manual Lean formalization (last solving step)
  | { type: "LEAN_ATTEMPT_OK"; leanProofAttempt: LeanProofAttempt }

  // solve-all
  | {
      type: "SOLVE_OK";
      sessionId: string;
      problemType: "computational" | "theorem";
      nlSolution?: NaturalLanguageSolution;
      leanProofAttempt?: LeanProofAttempt;
      methods?: MethodOption[];
      methodScores?: MethodScore[];
      recommendedMethodId?: string | null;
      steps?: ProofStep[];
      assembledLean?: string;
      buildStatus?: BuildStatus;
      buildLog?: string;
      solveEvents: Array<{ stage: string; detail: string }>;
      metrics?: RunMetrics;
    }

  // solve progress (streaming)
  | {
      type: "SOLVE_PROGRESS";
      stage: string;
      detail: string;
    }

  // load session from history
  | {
      type: "LOAD_SESSION";
      sessionId: string;
      problemText: string;
      methods: MethodOption[];
      methodScores: MethodScore[];
      recommendedMethodId: string | null;
      selectedMethodId: string | null;
      comparisonSummary: string | null;
      steps: ProofStep[];
      assembledLean: string;
      buildStatus: BuildStatus;
      buildLog: string;
      nlSolution: NaturalLanguageSolution | null;
      leanProofAttempt: LeanProofAttempt | null;
      solvedProblemType: "computational" | "theorem" | null;
      solveEvents: Array<{ stage: string; detail: string }>;
    }

  // lean view
  | { type: "SET_LEAN_VIEW"; view: "full" | "step" };

// ── Initial State ──────────────────────────────────────────────────────

/** Sample problem pre-filled in the input box, per UI language (swapped on language change while unedited). */
export const SAMPLE_PROBLEM = {
  "zh-CN": "证明对任意自然数 n，n + 0 = n",
  "en-US": "Prove that n + 0 = n for every natural number n",
} as const;

export const INITIAL_STATE: ProofSessionState = {
  sessionId: null,
  problemText: SAMPLE_PROBLEM["zh-CN"],
  methods: [],
  methodScores: [],
  recommendedMethodId: null,
  selectedMethodId: null,
  comparisonSummary: null,
  outOfDomainWarning: null,
  steps: [],
  selectedStepIndex: null,
  assembledLean: "",
  buildStatus: "idle",
  buildLog: "",
  nlSolution: null,
  leanProofAttempt: null,
  solvedProblemType: null,
  solveEvents: [],
  runMetrics: null,
  autoformalizeDetail: null,
  validationResults: null,
  busy: null,
  error: null,
  leanView: "full",
  showGenerator: false,
};

// ── Helpers ────────────────────────────────────────────────────────────

function mergeStep(steps: ProofStep[], step: ProofStep): ProofStep[] {
  return steps
    .map((s) => (s.index === step.index ? step : s))
    .sort((a, b) => a.index - b.index);
}

function normalizeSteps(
  raw: Array<{
    index: number;
    plain_goal: string;
    lean_goal: string;
    plain_explanation?: string;
    lean_code?: string;
    status?: StepStatus;
  }>,
): ProofStep[] {
  return raw
    .map((s) => ({
      ...s,
      plain_explanation: s.plain_explanation ?? "",
      lean_code: s.lean_code ?? "",
      status: (s.status ?? "pending") as StepStatus,
    }))
    .sort((a, b) => a.index - b.index);
}

// ── Reducer ────────────────────────────────────────────────────────────

function reducer(
  state: ProofSessionState,
  action: Action,
): ProofSessionState {
  switch (action.type) {
    // ── Reset ──────────────────────────────────────────────────────
    case "RESET_ALL":
      return {
        ...INITIAL_STATE,
        problemText: action.problemText ?? state.problemText,
      };

    case "RESET_METHOD":
      return {
        ...state,
        selectedMethodId: null,
        methodScores: [],
        recommendedMethodId: null,
        steps: [],
        selectedStepIndex: null,
        assembledLean: "",
        buildStatus: "idle",
        buildLog: "",
        nlSolution: null,
        leanProofAttempt: null,
        solvedProblemType: null,
        solveEvents: [],
        runMetrics: null,
        autoformalizeDetail: null,
        validationResults: null,
        error: null,
      };

    case "RESET_PROOF":
      return {
        ...state,
        steps: [],
        selectedStepIndex: null,
        assembledLean: "",
        buildStatus: "idle",
        buildLog: "",
        nlSolution: null,
        leanProofAttempt: null,
      };

    // ── Input ──────────────────────────────────────────────────────
    case "SET_PROBLEM_TEXT":
      return { ...state, problemText: action.text };

    case "TOGGLE_GENERATOR":
      return { ...state, showGenerator: !state.showGenerator };

    // ── Async lifecycle ────────────────────────────────────────────
    case "REQUEST":
      return { ...state, busy: action.operation, error: null };

    case "REQUEST_DONE":
      return { ...state, busy: null };

    case "DISMISS_ERROR":
      return { ...state, error: null, autoformalizeDetail: null, validationResults: null };

    case "REQUEST_ERROR":
      return {
        ...state,
        busy: null,
        error: action.message,
        autoformalizeDetail: action.autoformalizeDetail ?? null,
        validationResults: action.validationResults ?? null,
      };

    // ── Enumerate ──────────────────────────────────────────────────
    case "ENUMERATE_OK":
      return {
        ...state,
        sessionId: action.sessionId,
        methods: action.methods,
        comparisonSummary: action.comparisonSummary ?? null,
        outOfDomainWarning: action.outOfDomainWarning ?? null,
        busy: null,
      };

    // ── Plan ───────────────────────────────────────────────────────
    case "SELECT_METHOD":
      return { ...state, selectedMethodId: action.methodId };

    case "PLAN_OK": {
      const nextSteps = normalizeSteps(action.steps);
      return {
        ...state,
        steps: nextSteps,
        selectedStepIndex: nextSteps[0]?.index ?? null,
        nlSolution: action.nlSolution ?? state.nlSolution,
        solvedProblemType: action.nlSolution ? "theorem" : state.solvedProblemType,
        busy: null,
      };
    }

    case "SELECT_STEP":
      return { ...state, selectedStepIndex: action.index };

    // ── Prove step ─────────────────────────────────────────────────
    // NOTE: does NOT clear busy — proveAll dispatches STEP_UPDATED
    // in a loop and must stay busy="prove-all" until REQUEST_DONE.
    // Single proveStepAt calls REQUEST_DONE via useProofActions.
    case "STEP_UPDATED":
      return {
        ...state,
        steps: mergeStep(state.steps, action.step),
        assembledLean: action.assembledLean,
        buildStatus: action.buildStatus,
        buildLog: action.buildLog ?? state.buildLog,
      };

    // ── Verify ─────────────────────────────────────────────────────
    case "VERIFY_OK":
      return {
        ...state,
        assembledLean: action.assembledLean,
        buildStatus: action.buildStatus,
        buildLog: action.buildLog,
        leanProofAttempt: action.leanProofAttempt ?? state.leanProofAttempt,
        busy: null,
      };

    // ── Manual Lean formalization ──────────────────────────────────
    case "LEAN_ATTEMPT_OK":
      return { ...state, leanProofAttempt: action.leanProofAttempt, busy: null };

    // ── Solve-all ──────────────────────────────────────────────────
    case "SOLVE_OK": {
      const nextSteps = action.steps ? normalizeSteps(action.steps) : [];
      return {
        ...state,
        sessionId: action.sessionId,
        solveEvents: action.solveEvents,
        solvedProblemType: action.problemType,
        nlSolution: action.nlSolution ?? null,
        leanProofAttempt: action.leanProofAttempt ?? null,
        methods: action.methods ?? state.methods,
        methodScores: action.methodScores ?? state.methodScores,
        recommendedMethodId:
          action.recommendedMethodId ?? state.recommendedMethodId,
        steps: nextSteps.length > 0 ? nextSteps : state.steps,
        selectedStepIndex:
          nextSteps.length > 0 ? nextSteps[0]?.index ?? null : state.selectedStepIndex,
        assembledLean: action.assembledLean ?? "",
        buildStatus: action.buildStatus ?? "idle",
        buildLog: action.buildLog ?? "",
        runMetrics: action.metrics ?? null,
        busy: null,
      };
    }

    // ── Solve progress (streaming) ───────────────────────────────
    case "SOLVE_PROGRESS":
      return {
        ...state,
        solveEvents: [
          ...state.solveEvents,
          { stage: action.stage, detail: action.detail },
        ],
        busy: action.stage,
      };

    // ── Load session from history ─────────────────────────────────
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
        outOfDomainWarning: null,
        steps: action.steps,
        selectedStepIndex: action.steps[0]?.index ?? null,
        assembledLean: action.assembledLean,
        buildStatus: action.buildStatus,
        buildLog: action.buildLog,
        nlSolution: action.nlSolution,
        leanProofAttempt: action.leanProofAttempt,
        solvedProblemType: action.solvedProblemType,
        solveEvents: action.solveEvents,
        busy: null,
        error: null,
        leanView: "full",
      };

    // ── Lean view ──────────────────────────────────────────────────
    case "SET_LEAN_VIEW":
      return { ...state, leanView: action.view };

    default:
      return state;
  }
}

// ── Phase derivation ───────────────────────────────────────────────────

export function derivePhase(state: ProofSessionState): UiPhase {
  if (state.buildStatus === "ok") return "verified";
  if (
    state.busy === "prove" ||
    state.busy === "prove-all" ||
    state.busy === "retry"
  )
    return "proving";
  if (state.steps.length > 0) return "planned";
  if (state.methods.length > 0) return "enumerated";
  return "idle";
}

// ── Hook ───────────────────────────────────────────────────────────────

export function useProofSession(initialProblemText: string = INITIAL_STATE.problemText) {
  const [state, dispatch] = useReducer(reducer, initialProblemText, (text) => ({ ...INITIAL_STATE, problemText: text }));

  const phase = useMemo(() => derivePhase(state), [state]);

  const selectedMethod = useMemo(
    () => state.methods.find((m) => m.id === state.selectedMethodId),
    [state.methods, state.selectedMethodId],
  );

  const selectedStep = useMemo(
    () => state.steps.find((s) => s.index === state.selectedStepIndex),
    [state.steps, state.selectedStepIndex],
  );

  const activeStepIndex = useMemo(() => {
    if (state.selectedStepIndex != null) return state.selectedStepIndex;
    const pending = state.steps.find(
      (s) => s.status === "pending" || s.status === "fail",
    );
    return pending?.index ?? state.steps[0]?.index;
  }, [state.steps, state.selectedStepIndex]);

  const planned =
    phase === "planned" || phase === "proving" || phase === "verified";

  const canProve =
    planned && !!state.sessionId && state.steps.length > 0 && !state.busy;

  const canVerify =
    !!state.sessionId &&
    !state.busy &&
    state.steps.length > 0 &&
    state.steps.every(
      (s) => s.status === "ok" && s.lean_code.trim().length > 0,
    );

  return {
    state,
    dispatch,
    // derived
    phase,
    selectedMethod,
    selectedStep,
    activeStepIndex,
    planned,
    canProve,
    canVerify,
  };
}
