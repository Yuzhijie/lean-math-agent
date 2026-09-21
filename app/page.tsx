"use client";

import { useState, useEffect, useRef } from "react";
import { BuildLog } from "./components/BuildLog";
import { ErrorBanner } from "./components/ErrorBanner";
import { LeanPane } from "./components/LeanPane";
import { MathText } from "./components/MathText";
import { MethodDetail } from "./components/MethodDetail";
import { MethodList } from "./components/MethodList";
import { MethodComparison } from "./components/MethodComparison";
import { PipelineProgress } from "./components/PipelineProgress";
import { ProblemGenerator } from "./components/ProblemGenerator";
import { SessionHistory } from "./components/SessionHistory";
import { StepCard } from "./components/StepCard";
import { StepPane } from "./components/StepPane";
import { containsMath } from "@/lib/math-segments";
import { useProofSession } from "./hooks/useProofSession";
import { useProofActions } from "./hooks/useProofActions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import {
  Calculator,
  Sparkles,
  BookOpen,
  FlaskConical,
  Sigma,
  RotateCcw,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  AlertCircle,
  Play,
  ListOrdered,
  CheckCircle2,
  FileCode,
  History,
  Columns3,
} from "lucide-react";

export default function Home() {
  const {
    state,
    dispatch,
    phase,
    selectedMethod,
    selectedStep,
    activeStepIndex,
    planned,
    canProve,
    canVerify,
  } = useProofSession();

  const {
    enumerate,
    planMethod,
    proveStepAt,
    proveAll,
    verify,
    solveAll,
    switchMethod,
    useGeneratedProblem,
    loadSession,
    retryLastAction,
  } = useProofActions(state, dispatch);

  const {
    problemText,
    methods,
    comparisonSummary,
    outOfDomainWarning,
    steps,
    assembledLean,
    buildStatus,
    buildLog,
    leanView,
    busy,
    error,
    autoformalizeDetail,
    validationResults,
    showGenerator,
    nlSolution,
    leanProofAttempt,
    solvedProblemType,
    solveEvents,
    runMetrics,
  } = state;

  const [activeTab, setActiveTab] = useState("solution");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showComparison, setShowComparison] = useState(false);
  const [stepsExpanded, setStepsExpanded] = useState(false);

  // Auto-select tab when session data changes (e.g., after loading history)
  const prevSessionId = useRef(state.sessionId);
  useEffect(() => {
    if (state.sessionId && state.sessionId !== prevSessionId.current) {
      prevSessionId.current = state.sessionId;
      if (state.nlSolution) setActiveTab("solution");
      else if (state.methods.length > 0) setActiveTab("methods");
      else if (state.leanProofAttempt) setActiveTab("lean");
    }
  }, [state.sessionId, state.nlSolution, state.methods.length, state.leanProofAttempt]);

  const handleLoadSession = (sessionId: string) => {
    void loadSession(sessionId);
    setHistoryOpen(false);
  };

  const hasResults = !!(nlSolution || leanProofAttempt || methods.length > 0);

  const phaseLabel: Record<string, string> = {
    idle: "就绪",
    enumerated: "已枚举",
    planned: "已规划",
    proving: "证明中",
    proved: "已证明",
    verified: "已验证",
    solved: "已求解",
  };

  const buildBadgeVariant =
    buildStatus === "ok"
      ? "success"
      : buildStatus === "fail"
        ? "destructive"
        : buildStatus === "unavailable"
          ? "warning"
          : "secondary";

  return (
    <TooltipProvider>
      <div className="relative z-10 min-h-screen">
        {/* ── Sticky Header ──────────────────────────────────────────── */}
        <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-xl">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <div className="flex h-14 items-center justify-between">
              {/* Brand */}
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
                  <Sigma className="h-5 w-5" />
                </div>
                <div>
                  <h1 className="font-serif text-base font-bold leading-none tracking-tight text-foreground">
                    Lean Math Agent
                  </h1>
                  <p className="text-[11px] text-muted-foreground">
                    AI × Lean 4 形式化证明
                  </p>
                </div>
              </div>

              {/* Status */}
              <div className="flex items-center gap-3">
                <Badge variant="outline" className="hidden sm:inline-flex gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse-soft" />
                  {phaseLabel[phase] ?? phase}
                </Badge>
                {buildStatus && buildStatus !== "idle" && (
                  <Badge variant={buildBadgeVariant as "success" | "destructive" | "warning" | "secondary"}>
                    build: {buildStatus}
                  </Badge>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setHistoryOpen(true)}
                  disabled={!!busy}
                  className="gap-1.5"
                >
                  <History className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">历史</span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => dispatch({ type: "TOGGLE_GENERATOR" })}
                  disabled={!!busy}
                  className="gap-1.5"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">
                    {showGenerator ? "收起" : "生成题目"}
                  </span>
                </Button>
              </div>
            </div>
          </div>
        </header>

        {/* ── Main Content ──────────────────────────────────────────── */}
        <main className="mx-auto max-w-6xl px-4 sm:px-6 py-6 space-y-6">
          {/* Problem Generator (collapsible) */}
          {showGenerator && (
            <div className="animate-slide-down">
              <ProblemGenerator
                onUseProblem={useGeneratedProblem}
                onFormalize={useGeneratedProblem}
                disabled={!!busy}
              />
            </div>
          )}

          {/* Problem Input Card */}
          <Card className="animate-fade-in">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Calculator className="h-4 w-4 text-primary" />
                  问题
                </CardTitle>
                {busy && (
                  <Badge variant="info" className="gap-1.5 animate-pulse-soft">
                    <span className="h-1.5 w-1.5 rounded-full bg-primary animate-spin" />
                    工作中：{busy}
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                value={problemText}
                onChange={(e) =>
                  dispatch({ type: "SET_PROBLEM_TEXT", text: e.target.value })
                }
                disabled={!!busy}
                rows={3}
                placeholder="输入数学问题，支持 LaTeX 公式（如 $x^2 + y^2 = z^2$）..."
                className="min-h-[80px] text-base leading-relaxed"
              />

              {/* Math preview */}
              {containsMath(problemText) && (
                <div className="rounded-md border border-border/60 bg-muted/30 p-3 animate-fade-in">
                  <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    预览
                  </span>
                  <div className="mt-1.5 text-sm">
                    <MathText text={problemText} />
                  </div>
                </div>
              )}

              {/* Action buttons */}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button
                  onClick={() => void solveAll()}
                  disabled={!!busy || !problemText.trim()}
                  loading={busy === "solve-all"}
                  className="gap-1.5"
                >
                  <Play className="h-3.5 w-3.5" />
                  一键求解
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void enumerate()}
                  disabled={!!busy || !problemText.trim()}
                  loading={busy === "enumerate"}
                  className="gap-1.5"
                >
                  <ListOrdered className="h-3.5 w-3.5" />
                  枚举解法
                </Button>
              </div>

              {/* Error banner */}
              {error && (
                <ErrorBanner
                  error={error}
                  detail={autoformalizeDetail}
                  validationResults={validationResults}
                  onRetry={retryLastAction}
                  onDismiss={() => dispatch({ type: "DISMISS_ERROR" })}
                />
              )}
            </CardContent>
          </Card>

          {/* Warnings */}
          {outOfDomainWarning && (
            <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm animate-fade-in">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <div>
                <span className="font-medium text-warning">域外警告：</span>
                <span className="text-muted-foreground">{outOfDomainWarning}</span>
              </div>
            </div>
          )}

          {buildStatus === "unavailable" && (
            <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm animate-fade-in">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div className="text-muted-foreground">
                Lean / lake 不可用。请安装 elan 与 Lean 4，并确保{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">lean-sandbox</code>{" "}
                可{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">lake build</code>。
              </div>
            </div>
          )}

          {/* ── Pipeline Progress (real-time streaming) ───────────── */}
          {(solveEvents.length > 0 || busy === "solve-all") && (
            <PipelineProgress events={solveEvents} busy={busy} />
          )}

          {/* ── Results Section (Tabs) ──────────────────────────────── */}
          {hasResults && (
            <Tabs
              value={activeTab}
              onValueChange={setActiveTab}
              className="animate-slide-up"
            >
              <TabsList className="w-full justify-start bg-transparent p-0 h-auto gap-1 mb-4">
                {nlSolution && (
                  <TabsTrigger value="solution" className="gap-1.5 data-[state=active]:bg-primary/10 data-[state=active]:text-primary">
                    <BookOpen className="h-3.5 w-3.5" />
                    解答
                  </TabsTrigger>
                )}
                {methods.length > 0 && (
                  <TabsTrigger value="methods" className="gap-1.5 data-[state=active]:bg-primary/10 data-[state=active]:text-primary">
                    <ListOrdered className="h-3.5 w-3.5" />
                    解法
                    <span className="ml-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-bold text-primary">
                      {methods.length}
                    </span>
                  </TabsTrigger>
                )}
                {(planned || steps.length > 0) && (
                  <TabsTrigger value="proof" className="gap-1.5 data-[state=active]:bg-primary/10 data-[state=active]:text-primary">
                    <FileCode className="h-3.5 w-3.5" />
                    证明
                  </TabsTrigger>
                )}
                {leanProofAttempt && (
                  <TabsTrigger value="lean" className="gap-1.5 data-[state=active]:bg-primary/10 data-[state=active]:text-primary">
                    <FlaskConical className="h-3.5 w-3.5" />
                    Lean
                  </TabsTrigger>
                )}
              </TabsList>

              {/* ── Tab: NL Solution ──────────────────────────────── */}
              <TabsContent value="solution">
                {nlSolution && (
                  <Card>
                    <CardHeader>
                      <div className="flex items-center justify-between">
                        <CardTitle className="flex items-center gap-2">
                          <BookOpen className="h-5 w-5 text-primary" />
                          自然语言解答
                        </CardTitle>
                        <Badge
                          variant={solvedProblemType === "theorem" ? "info" : "default"}
                        >
                          {solvedProblemType === "theorem" ? "定理证明" : "计算求解"}
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-5">
                      {/* Summary */}
                      <div className="rounded-lg bg-primary/5 border border-primary/10 p-4">
                        <MathText text={nlSolution.summary} className="text-sm leading-relaxed" />
                      </div>

                      {/* Steps */}
                      {nlSolution.steps.length > 3 && (
                        <div className="flex justify-end">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => {
                              // Toggle all steps via re-render key
                              setStepsExpanded(!stepsExpanded);
                            }}
                          >
                            {stepsExpanded ? "折叠全部" : "展开全部"}
                          </Button>
                        </div>
                      )}
                      {nlSolution.steps.map((step, i) => (
                        <StepCard
                          key={`${i}-${stepsExpanded}`}
                          step={step}
                          index={i}
                          defaultOpen={
                            nlSolution.steps.length <= 3 ||
                            stepsExpanded ||
                            i === 0 ||
                            i === nlSolution.steps.length - 1
                          }
                        />
                      ))}

                      <Separator />

                      {/* Final answer */}
                      <div className="rounded-lg border-2 border-success/30 bg-success/5 p-4">
                        <div className="text-[11px] font-bold uppercase tracking-wider text-success mb-2">
                          <CheckCircle2 className="inline h-3.5 w-3.5 mr-1" />
                          最终答案
                        </div>
                        <div className="text-base font-semibold">
                          <MathText text={nlSolution.final_answer} />
                        </div>
                      </div>

                      {/* Verification */}
                      {nlSolution.verification && (
                        <div className="rounded-lg border border-border/60 bg-muted/20 p-4 text-sm">
                          <span className="font-semibold text-muted-foreground">验证：</span>
                          <MathText text={nlSolution.verification} />
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )}
              </TabsContent>

              {/* ── Tab: Methods ──────────────────────────────────── */}
              <TabsContent value="methods">
                {showComparison && state.methodScores.length > 0 ? (
                  <div className="space-y-4">
                    <div className="flex justify-end">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => setShowComparison(false)}
                      >
                        <Columns3 className="h-3.5 w-3.5 mr-1" />
                        列表视图
                      </Button>
                    </div>
                    <MethodComparison
                      methods={methods}
                      scores={state.methodScores}
                      recommendedId={state.recommendedMethodId}
                    />
                  </div>
                ) : (
                  <>
                    {state.methodScores.length > 0 && (
                      <div className="flex justify-end mb-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => setShowComparison(true)}
                        >
                          <Columns3 className="h-3.5 w-3.5 mr-1" />
                          对比视图
                        </Button>
                      </div>
                    )}
                    <div className="grid grid-cols-1 md:grid-cols-[minmax(220px,0.85fr)_minmax(280px,1.15fr)] gap-4">
                      <MethodList
                        methods={methods}
                        scores={state.methodScores}
                        recommendedId={state.recommendedMethodId}
                        selectedId={state.selectedMethodId ?? undefined}
                        disabled={!!busy}
                        onSelect={(id) => void planMethod(id)}
                      />
                      <MethodDetail
                        method={selectedMethod}
                        score={state.methodScores.find(
                          (s) => s.method_id === state.selectedMethodId,
                        )}
                        comparisonSummary={comparisonSummary ?? undefined}
                      />
                    </div>
                  </>
                )}
              </TabsContent>

              {/* ── Tab: Proof Workspace ──────────────────────────── */}
              <TabsContent value="proof">
                <Card>
                  <CardContent className="p-0">
                    {/* Workspace actions */}
                    <div className="flex flex-wrap items-center gap-2 border-b border-border p-4">
                      <Button
                        size="sm"
                        disabled={!canProve || activeStepIndex === undefined}
                        onClick={() =>
                          activeStepIndex !== undefined &&
                          void proveStepAt(activeStepIndex)
                        }
                        loading={busy === "prove"}
                        className="gap-1.5"
                      >
                        <Play className="h-3.5 w-3.5" />
                        证明本步
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!canProve}
                        onClick={() => void proveAll()}
                        loading={busy === "prove-all"}
                        className="gap-1.5"
                      >
                        <ListOrdered className="h-3.5 w-3.5" />
                        全部逐步生成
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!canVerify}
                        onClick={() => void verify()}
                        loading={busy === "verify"}
                        className="gap-1.5"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        验证
                      </Button>
                      <Separator orientation="vertical" className="h-6" />
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
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
                            loading={busy === "retry"}
                            className="gap-1.5"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                            重试
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>重试当前步骤的证明</TooltipContent>
                      </Tooltip>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!!busy || phase === "idle"}
                        onClick={switchMethod}
                      >
                        换解法
                      </Button>
                    </div>

                    {/* Steps + Lean side by side */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-border">
                      <StepPane
                        steps={steps}
                        selectedIndex={state.selectedStepIndex ?? undefined}
                        onSelect={(idx) => dispatch({ type: "SELECT_STEP", index: idx })}
                      />
                      <LeanPane
                        leanSource={assembledLean}
                        selectedStepCode={selectedStep?.lean_code}
                        view={leanView}
                        onViewChange={(v) => dispatch({ type: "SET_LEAN_VIEW", view: v })}
                      />
                    </div>
                  </CardContent>
                </Card>

                {/* Build log */}
                <BuildLog
                  log={buildLog}
                  defaultOpen={buildStatus === "fail" || buildStatus === "unavailable"}
                />
              </TabsContent>

              {/* ── Tab: Lean Proof Attempt ───────────────────────── */}
              <TabsContent value="lean">
                {leanProofAttempt && (
                  <Card>
                    <CardHeader>
                      <div className="flex items-center justify-between">
                        <CardTitle className="flex items-center gap-2">
                          <FlaskConical className="h-5 w-5 text-primary" />
                          Lean 4 形式化
                        </CardTitle>
                        <Badge
                          variant={
                            !leanProofAttempt.attempted
                              ? "secondary"
                              : leanProofAttempt.success
                                ? "success"
                                : "warning"
                          }
                        >
                          {!leanProofAttempt.attempted
                            ? "未尝试"
                            : leanProofAttempt.success
                              ? "✅ 证明成功"
                              : "⚠️ 未能完成"}
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {leanProofAttempt.attempted && leanProofAttempt.success && (
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <Badge variant="secondary">
                            公理：{leanProofAttempt.axioms && leanProofAttempt.axioms.length > 0
                              ? leanProofAttempt.axioms.join(", ")
                              : "无"}
                          </Badge>
                          <Badge variant={leanProofAttempt.statement_locked ? "success" : "warning"}>
                            {leanProofAttempt.statement_locked
                              ? "陈述与形式化校验一致"
                              : "陈述未经形式化校验锁定"}
                          </Badge>
                          {leanProofAttempt.verifier && (
                            <span>验证后端：{leanProofAttempt.verifier === "repl" ? "Lean REPL" : leanProofAttempt.verifier}</span>
                          )}
                          {leanProofAttempt.strategy && (
                            <span>
                              证明方式：
                              {leanProofAttempt.strategy === "whole_proof"
                                ? `整体证明（${leanProofAttempt.attempts ?? "?"} 个候选 / ${leanProofAttempt.rounds ?? "?"} 轮）`
                                : leanProofAttempt.strategy === "trivial"
                                  ? "单策略"
                                  : `分步搜索（${leanProofAttempt.attempts ?? "?"} 次尝试）`}
                            </span>
                          )}
                        </div>
                      )}

                      {leanProofAttempt.failure_reason && (
                        <div className="rounded-md border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-warning">
                          {leanProofAttempt.failure_reason}
                        </div>
                      )}

                      {(leanProofAttempt.limitations?.length ?? 0) > 0 && (
                        <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
                          {leanProofAttempt.limitations!.map((lim, i) => (
                            <li key={i}>{lim}</li>
                          ))}
                        </ul>
                      )}

                      {leanProofAttempt.proof_code && (
                        <pre className="lean-code-block max-h-[28rem]">
                          {leanProofAttempt.proof_code}
                        </pre>
                      )}
                    </CardContent>
                  </Card>
                )}
              </TabsContent>
            </Tabs>
          )}

          {/* ── Run metrics ─────────────────────────────────────────── */}
          {runMetrics && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground animate-fade-in">
              <span>LLM 调用 {runMetrics.llm_calls} 次</span>
              <span>
                tokens {runMetrics.prompt_tokens + runMetrics.completion_tokens}
                {runMetrics.by_role?.prover ? `（prover ${runMetrics.by_role.prover.requests} 次）` : ""}
              </span>
              {runMetrics.estimated_cost !== undefined && <span>估算费用 {runMetrics.estimated_cost.toFixed(4)}</span>}
              <span>
                Lean 验证 {runMetrics.lean_verifications} 次
                {runMetrics.lean_verifications > 0 ? `（${(runMetrics.lean_verify_ms / 1000).toFixed(1)}s）` : ""}
              </span>
              <span>总耗时 {(runMetrics.wall_ms / 1000).toFixed(1)}s</span>
            </div>
          )}

          {/* ── Solve Events (collapsible log) ─────────────────────── */}
          {solveEvents.length > 0 && (
            <Card className="animate-fade-in">
              <CardContent className="p-4">
                <details>
                  <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors select-none">
                    <ChevronDown className="h-4 w-4" />
                    求解过程日志 ({solveEvents.length} 条)
                  </summary>
                  <div className="mt-3 max-h-64 overflow-auto rounded-md bg-code-bg p-3 font-mono text-xs leading-relaxed text-muted-foreground">
                    {solveEvents.map((evt, i) => (
                      <div key={i}>
                        <span className="text-primary/70">[{evt.stage}]</span>{" "}
                        {evt.detail}
                      </div>
                    ))}
                  </div>
                </details>
              </CardContent>
            </Card>
          )}
        </main>

        {/* ── Session History Sidebar ──────────────────────────────── */}
        <SessionHistory
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          onLoadSession={handleLoadSession}
          refreshKey={state.sessionId}
        />

        {/* ── Footer ──────────────────────────────────────────────── */}
        <footer className="border-t border-border/40 py-6 text-center text-xs text-muted-foreground">
          <span className="text-gradient font-medium">Lean Math Agent</span>
          {" "}— AI 驱动的数学定理证明
        </footer>
      </div>
    </TooltipProvider>
  );
}
