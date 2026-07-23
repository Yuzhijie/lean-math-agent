"use client";

import { useMemo, useState } from "react";
import { BuildLog } from "./components/BuildLog";
import { LeanPane } from "./components/LeanPane";
import { MethodDetail } from "./components/MethodDetail";
import { MethodList } from "./components/MethodList";
import { StepPane } from "./components/StepPane";
import type {
  BuildStatus,
  MethodOption,
  ProofStep,
  StepStatus,
} from "@/lib/types";

type UiPhase = "idle" | "enumerated" | "planned" | "proving" | "verified";

type ApiErrorBody = { error?: string };

async function readJson<T>(res: Response): Promise<T> {
  const data = (await res.json()) as T & ApiErrorBody;
  if (!res.ok) {
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
  return data;
}

function firstPendingIndex(steps: ProofStep[]): number | undefined {
  const pending = steps.find((s) => s.status === "pending" || s.status === "fail");
  return pending?.index;
}

function mergeStep(steps: ProofStep[], step: ProofStep): ProofStep[] {
  return steps
    .map((s) => (s.index === step.index ? step : s))
    .sort((a, b) => a.index - b.index);
}

export default function Home() {
  const [phase, setPhase] = useState<UiPhase>("idle");
  const [problemText, setProblemText] = useState(
    "证明对任意自然数 n，n + 0 = n",
  );
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [methods, setMethods] = useState<MethodOption[]>([]);
  const [comparisonSummary, setComparisonSummary] = useState<string>();
  const [outOfDomainWarning, setOutOfDomainWarning] = useState<string | null>(
    null,
  );
  const [selectedMethodId, setSelectedMethodId] = useState<string>();
  const [steps, setSteps] = useState<ProofStep[]>([]);
  const [selectedStepIndex, setSelectedStepIndex] = useState<number>();
  const [assembledLean, setAssembledLean] = useState("");
  const [buildStatus, setBuildStatus] = useState<BuildStatus>("idle");
  const [buildLog, setBuildLog] = useState("");
  const [leanView, setLeanView] = useState<"full" | "step">("full");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedMethod = useMemo(
    () => methods.find((m) => m.id === selectedMethodId),
    [methods, selectedMethodId],
  );

  const selectedStep = useMemo(
    () => steps.find((s) => s.index === selectedStepIndex),
    [steps, selectedStepIndex],
  );

  const planned = phase === "planned" || phase === "proving" || phase === "verified";
  const canProve = planned && !!sessionId && steps.length > 0 && !busy;
  const canVerify =
    !!sessionId &&
    !busy &&
    steps.length > 0 &&
    steps.every((s) => s.status === "ok" && s.lean_code.trim().length > 0);

  async function enumerate() {
    setError(null);
    setBusy("enumerate");
    setPhase("idle");
    setMethods([]);
    setSelectedMethodId(undefined);
    setSteps([]);
    setSelectedStepIndex(undefined);
    setAssembledLean("");
    setBuildStatus("idle");
    setBuildLog("");
    setComparisonSummary(undefined);
    setOutOfDomainWarning(null);
    try {
      const data = await readJson<{
        session_id: string;
        methods: MethodOption[];
        comparison_summary?: string;
        out_of_domain_warning?: string | null;
      }>(
        await fetch("/api/enumerate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ problem_text: problemText }),
        }),
      );
      setSessionId(data.session_id);
      setMethods(data.methods);
      setComparisonSummary(data.comparison_summary);
      setOutOfDomainWarning(data.out_of_domain_warning ?? null);
      setPhase("enumerated");
    } catch (e) {
      setError(e instanceof Error ? e.message : "枚举失败");
    } finally {
      setBusy(null);
    }
  }

  async function planMethod(methodId: string) {
    if (!sessionId) return;
    setError(null);
    setBusy("plan");
    setSelectedMethodId(methodId);
    setSteps([]);
    setSelectedStepIndex(undefined);
    setAssembledLean("");
    setBuildStatus("idle");
    setBuildLog("");
    try {
      const data = await readJson<{
        session_id: string;
        steps: ProofStep[];
      }>(
        await fetch("/api/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId, method_id: methodId }),
        }),
      );
      const nextSteps = data.steps
        .map((s) => ({
          ...s,
          plain_explanation: s.plain_explanation ?? "",
          lean_code: s.lean_code ?? "",
          status: (s.status ?? "pending") as StepStatus,
        }))
        .sort((a, b) => a.index - b.index);
      setSteps(nextSteps);
      setSelectedStepIndex(nextSteps[0]?.index);
      setPhase("planned");
    } catch (e) {
      setError(e instanceof Error ? e.message : "规划失败");
      setPhase("enumerated");
    } finally {
      setBusy(null);
    }
  }

  async function proveStepAt(stepIndex: number, asRetry = false) {
    if (!sessionId) return;
    setError(null);
    setBusy(asRetry ? "retry" : "prove");
    setPhase("proving");
    setSelectedStepIndex(stepIndex);
    try {
      const data = await readJson<{
        session_id: string;
        step: ProofStep;
        assembled_lean: string;
        build_status: BuildStatus;
      }>(
        await fetch("/api/prove-step", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId, step_index: stepIndex }),
        }),
      );
      setSteps((prev) => mergeStep(prev, data.step));
      setAssembledLean(data.assembled_lean);
      // prove-step never sets whole-proof "ok"; only unavailable or idle.
      setBuildStatus(data.build_status);
      if (data.step.build_log) {
        setBuildLog(data.step.build_log);
      }
      if (data.build_status === "unavailable") {
        setBuildLog(
          data.step.build_log ??
            "Lean/lake unavailable. Install elan/Lean and ensure lean-sandbox builds.",
        );
      }
      setPhase("planned");
    } catch (e) {
      setError(e instanceof Error ? e.message : "证明本步失败");
      setPhase("planned");
    } finally {
      setBusy(null);
    }
  }

  async function proveAll() {
    if (!sessionId || steps.length === 0) return;
    setError(null);
    setBusy("prove-all");
    setPhase("proving");
    let current = [...steps];
    try {
      for (const step of current) {
        if (step.status === "ok" && step.lean_code.trim()) continue;
        setSelectedStepIndex(step.index);
        const data = await readJson<{
          step: ProofStep;
          assembled_lean: string;
          build_status: BuildStatus;
        }>(
          await fetch("/api/prove-step", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              session_id: sessionId,
              step_index: step.index,
            }),
          }),
        );
        current = mergeStep(current, data.step);
        setSteps(current);
        setAssembledLean(data.assembled_lean);
        setBuildStatus(data.build_status);
        if (data.step.build_log) setBuildLog(data.step.build_log);
        if (data.build_status === "unavailable") {
          setBuildLog(
            data.step.build_log ??
              "Lean/lake unavailable. Install elan/Lean and ensure lean-sandbox builds.",
          );
          break;
        }
        if (data.step.status === "fail") break;
      }
      setPhase("planned");
    } catch (e) {
      setError(e instanceof Error ? e.message : "逐步生成失败");
      setPhase("planned");
    } finally {
      setBusy(null);
    }
  }

  async function verify() {
    if (!sessionId) return;
    setError(null);
    setBusy("verify");
    try {
      const data = await readJson<{
        ok: boolean;
        log: string;
        build_status: BuildStatus;
        assembled_lean: string;
      }>(
        await fetch("/api/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId }),
        }),
      );
      setAssembledLean(data.assembled_lean);
      setBuildStatus(data.build_status);
      setBuildLog(data.log);
      setPhase(data.build_status === "ok" ? "verified" : "planned");
    } catch (e) {
      setError(e instanceof Error ? e.message : "验证失败");
    } finally {
      setBusy(null);
    }
  }

  function switchMethod() {
    setSteps([]);
    setSelectedStepIndex(undefined);
    setAssembledLean("");
    setBuildStatus("idle");
    setBuildLog("");
    setSelectedMethodId(undefined);
    setPhase("enumerated");
    setError(null);
  }

  const activeStepIndex =
    selectedStepIndex ?? firstPendingIndex(steps) ?? steps[0]?.index;

  return (
    <main className="app-shell">
      <h1 className="brand">Lean Math Agent</h1>
      <p className="tagline">
        枚举解法、逐步证明，并在本地 Lean 4 沙箱中验证 Nat/Int 等式问题。
      </p>

      <section className="problem-band">
        <label className="problem-label" htmlFor="problem">
          问题
        </label>
        <textarea
          id="problem"
          className="problem-textarea"
          value={problemText}
          onChange={(e) => setProblemText(e.target.value)}
          disabled={!!busy}
          rows={3}
        />
        <div className="problem-actions">
          <button
            type="button"
            className="btn"
            onClick={() => void enumerate()}
            disabled={!!busy || !problemText.trim()}
          >
            {busy === "enumerate" ? "枚举中…" : "枚举解法"}
          </button>
          {busy ? (
            <span className="status-line">工作中：{busy}</span>
          ) : (
            <span className="status-line">状态：{phase}</span>
          )}
          {error ? <span className="status-line error">{error}</span> : null}
        </div>
      </section>

      {outOfDomainWarning ? (
        <div className="banner-warn" role="status">
          域外警告：{outOfDomainWarning}
        </div>
      ) : null}

      {buildStatus === "unavailable" ? (
        <div className="banner-unavailable" role="alert">
          Lean / lake 不可用。请安装 elan 与 Lean 4，并确保{" "}
          <code>lean-sandbox</code> 可 <code>lake build</code>。
          {buildLog ? `\n\n${buildLog}` : null}
        </div>
      ) : null}

      {phase !== "idle" ? (
        <div className="methods-row">
          <MethodList
            methods={methods}
            selectedId={selectedMethodId}
            disabled={!!busy}
            onSelect={(id) => void planMethod(id)}
          />
          <MethodDetail
            method={selectedMethod}
            comparisonSummary={comparisonSummary}
          />
        </div>
      ) : null}

      {planned || steps.length > 0 ? (
        <>
          <div className="workspace">
            <div className="workspace-actions">
              <button
                type="button"
                className="btn"
                disabled={!canProve || activeStepIndex === undefined}
                onClick={() =>
                  activeStepIndex !== undefined &&
                  void proveStepAt(activeStepIndex)
                }
              >
                {busy === "prove" ? "证明中…" : "证明本步"}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={!canProve}
                onClick={() => void proveAll()}
              >
                {busy === "prove-all" ? "生成中…" : "全部逐步生成"}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={!canVerify}
                onClick={() => void verify()}
              >
                {busy === "verify" ? "验证中…" : "验证"}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={
                  !canProve ||
                  activeStepIndex === undefined ||
                  !selectedStep ||
                  selectedStep.status === "pending"
                }
                onClick={() =>
                  activeStepIndex !== undefined &&
                  void proveStepAt(activeStepIndex, true)
                }
              >
                {busy === "retry" ? "重试中…" : "重试本步"}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={!!busy || phase === "idle"}
                onClick={switchMethod}
              >
                换解法
              </button>
              <span className={`build-status-pill ${buildStatus}`}>
                build: {buildStatus}
              </span>
            </div>
            <StepPane
              steps={steps}
              selectedIndex={selectedStepIndex}
              onSelect={setSelectedStepIndex}
            />
            <LeanPane
              leanSource={assembledLean}
              selectedStepCode={selectedStep?.lean_code}
              view={leanView}
              onViewChange={setLeanView}
            />
          </div>
          <BuildLog
            log={buildLog}
            defaultOpen={buildStatus === "fail" || buildStatus === "unavailable"}
          />
        </>
      ) : null}
    </main>
  );
}
