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
import { ProblemGenerator, type GenerationSummary, type UsedProblemFigure } from "./components/ProblemGenerator";
import { useBanks } from "./components/BankTemplateControls";
import { SessionHistory, SessionHistoryList } from "./components/SessionHistory";
import { LocaleSwitcher } from "./components/LocaleSwitcher";
import { StepCard } from "./components/StepCard";
import { StepPane } from "./components/StepPane";
import { containsMath } from "@/lib/math-segments";
import { SAMPLE_PROBLEM, useProofSession } from "./hooks/useProofSession";
import { useProofActions } from "./hooks/useProofActions";
import { useI18n } from "@/lib/i18n";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { FigurePanel, figureSteps } from "./components/FigurePanel";
import { DiagramSvg } from "./components/DiagramSvg";
import { QuestionFigure } from "./components/QuestionFigure";
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
  Pencil,
  Library,
  Wand2,
  ImageUp,
  X,
  PanelLeftClose,
  FileDown,
} from "lucide-react";
import { generationPrintHref, stashWorksheet } from "@/lib/bank/worksheet";
import { ProblemExamples } from "./components/ProblemExamples";
import Link from "next/link";

export default function Home() {
  const { tr, locale } = useI18n();
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
  } = useProofSession(SAMPLE_PROBLEM[locale]);

  // The pre-filled sample problem follows the UI language until the user edits it.
  useEffect(() => {
    const samples = Object.values(SAMPLE_PROBLEM) as string[];
    if (samples.includes(state.problemText) && state.problemText !== SAMPLE_PROBLEM[locale]) {
      dispatch({ type: "SET_PROBLEM_TEXT", text: SAMPLE_PROBLEM[locale] });
    }
  }, [locale, state.problemText, dispatch]);

  const {
    enumerate,
    planMethod,
    proveStepAt,
    proveAll,
    verify,
    solveAll,
    cancelSolve,
    attemptLean,
    switchMethod,
    useGeneratedProblem: loadGeneratedProblem,
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
    nlSolution,
    leanProofAttempt,
    solvedProblemType,
    solveEvents,
    runMetrics,
    jobId,
    queuePosition,
    cancelling,
  } = state;

  const [activeTab, setActiveTab] = useState("solution");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showComparison, setShowComparison] = useState(false);
  const [stepsExpanded, setStepsExpanded] = useState(false);
  // The solution figure's current step, linked to the step cards (per session, so a new session starts fresh).
  const [figureView, setFigureView] = useState<{ session: string | null; step: number | null; steps: number[] }>({ session: null, step: null, steps: [] });
  const figStep = figureView.session === state.sessionId ? figureView.step : null;
  const figSteps = figureView.session === state.sessionId ? figureView.steps : [];
  const figureBoxRef = useRef<HTMLDivElement>(null);
  const showStepOnFigure = (n: number) => {
    setFigureView((v) => ({ session: state.sessionId, steps: v.session === state.sessionId ? v.steps : [], step: n }));
    figureBoxRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  // What the page is for right now: solving a problem, or generating questions (from the bank / built-in).
  // Wide screens show the generator and the solver side by side; narrow screens show one at a time.
  const [workspace, setWorkspace] = useState<"solve" | "bank" | "builtin">("solve");
  const [generatorMode, setGeneratorMode] = useState<"bank" | "builtin">("bank");
  const generating = workspace !== "solve";
  const { banks } = useBanks();
  const hasBank = !!banks?.length;
  const problemCardRef = useRef<HTMLDivElement>(null);
  // History sidebar on wide screens (≥1280px while solving; ≥1760px next to the generator); the History button
  // shows/hides it there, and opens the slide-out panel on narrower screens. Remembered in this browser.
  const [historyPinned, setHistoryPinned] = useState(true);
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from this browser after mount
      if (localStorage.getItem("history-sidebar") === "hidden") setHistoryPinned(false);
    } catch {
      /* storage unavailable */
    }
  }, []);
  const pinHistory = (on: boolean) => {
    setHistoryPinned(on);
    try {
      localStorage.setItem("history-sidebar", on ? "shown" : "hidden");
    } catch {
      /* storage unavailable */
    }
  };
  const onHistoryButton = () => {
    const wide = window.matchMedia(generating ? "(min-width: 1760px)" : "(min-width: 1280px)").matches;
    if (wide) pinHistory(!historyPinned);
    else setHistoryOpen(true);
  };
  const [lastGeneration, setLastGeneration] = useState<GenerationSummary | null>(null);
  const pickWorkspace = (w: "solve" | "bank" | "builtin") => {
    setWorkspace(w);
    if (w !== "solve") setGeneratorMode(w);
  };
  // Figure that came with the problem (generator, bank, or a pasted image); it stays while the text is edited,
  // and goes when the box is emptied, another problem is picked, or "移除图形" is pressed.
  const [usedFigure, setUsedFigure] = useState<UsedProblemFigure | null>(null);
  // A question generated on the bank page ("使用此题"): exporting it prints the generated question (with its answer
  // and solution) from the generation, while the text is unchanged.
  const [problemSource, setProblemSource] = useState<{ bankId: string; genId: string; candId: string; text: string } | null>(null);
  // Bumped for every problem put in the box from outside (generator, bank, image): the preview's figure
  // components are rebuilt, so a new question never shows the previous question's figure.
  const [usedKey, setUsedKey] = useState(0);
  const applyProblem = (text: string, figure?: UsedProblemFigure) => {
    setUsedKey((k) => k + 1);
    loadGeneratedProblem(text);
    // A generated question's figure comes with its exact description, which is added to the problem when solving;
    // bank figures (images) are registered by the caller and read by the vision model.
    dispatch({ type: "SET_PROBLEM_FIGURES", figures: figure?.description ? { refs: [], text, description: figure.description } : null });
    setUsedFigure(figure ?? null);
  };
  // The text the current solution belongs to (the solution is only printed with that problem).
  const solvedTextRef = useRef<string | null>(null);
  useEffect(() => {
    solvedTextRef.current = nlSolution ? state.problemText : null;
    // Only when a solution arrives or goes; editing the text afterwards must not move it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nlSolution]);
  /** "导出 PDF" on the problem card: a printable page of the problem only (answers are left off unless chosen there). */
  const exportProblemPdf = () => {
    const text = problemText.trim();
    if (!text) return;
    if (problemSource && problemSource.text === problemText) {
      window.open(generationPrintHref(problemSource.bankId, problemSource.genId, [problemSource.candId]), "_blank");
      return;
    }
    const href = stashWorksheet({
      title: tr("练习题", "Practice question"),
      questions: [{ id: "p1", stem: text, answer: "", figureSvg: usedFigure?.fallbackSvg, figureImages: usedFigure?.images?.map((im) => im.url) }],
    });
    window.open(href, "_blank");
  };
  /** The solution figure as currently shown (the largest drawing in the figure panel, not its icons). */
  const solutionFigureSvg = () => {
    const svgs = Array.from(figureBoxRef.current?.querySelectorAll("svg") ?? []).filter((el) => !el.classList.contains("lucide"));
    const area = (el: SVGSVGElement) => el.getBoundingClientRect().width * el.getBoundingClientRect().height;
    return svgs.sort((x, y) => area(y) - area(x))[0]?.outerHTML;
  };
  /** "导出 PDF" on the solution: the problem, the worked steps (with the solution figure as shown) and the answer at the end. */
  const exportSolutionPdf = () => {
    if (!nlSolution) return;
    const stem = (solvedTextRef.current ?? problemText).trim();
    const sameProblem = stem === problemText.trim();
    const href = stashWorksheet({
      title: tr("解题过程", "Worked solution"),
      kind: "solution",
      questions: [
        {
          id: "s1",
          stem,
          answer: nlSolution.final_answer,
          steps: nlSolution.steps,
          verification: nlSolution.verification || undefined,
          figureSvg: sameProblem ? usedFigure?.fallbackSvg : undefined,
          figureImages: sameProblem ? usedFigure?.images?.map((im) => im.url) : undefined,
          solutionFigureSvg: solutionFigureSvg(),
        },
      ],
    });
    window.open(href, "_blank");
  };
  const removeFigure = () => {
    dispatch({ type: "SET_PROBLEM_FIGURES", figures: null });
    setUsedFigure(null);
  };
  const isUntouched = !problemText.trim() || (Object.values(SAMPLE_PROBLEM) as string[]).includes(problemText);
  const pickExample = (text: string) => {
    removeFigure();
    dispatch({ type: "SET_PROBLEM_TEXT", text });
  };

  // A problem pasted / dropped / uploaded as an image: the vision model reads the text (and describes any figure).
  const [readingImage, setReadingImage] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const readImage = async (file: File) => {
    setImageError(null);
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(file.type)) {
      setImageError(tr("只支持 PNG、JPEG、GIF、WebP 图片（iPhone 的 HEIC 请先导出为 JPEG 或截屏）", "Only PNG, JPEG, GIF and WebP images (export iPhone HEIC photos as JPEG, or take a screenshot)"));
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setImageError(tr("图片太大（最大 10 MB）", "The image is too large (10 MB at most)"));
      return;
    }
    setReadingImage(true);
    try {
      const form = new FormData();
      form.set("image", file);
      const res = await fetch("/api/read-problem-image", { method: "POST", body: form });
      const data = (await res.json()) as { text?: string; figure?: string; error?: string };
      if (!res.ok || !data.text) throw new Error(data.error ?? tr("读取图片失败", "Reading the image failed"));
      const url = URL.createObjectURL(file);
      applyProblem(data.text, { images: [{ url, caption: tr("题目图片", "Problem image") }], ...(data.figure ? { description: data.figure } : {}) });
    } catch (e) {
      setImageError(e instanceof Error ? e.message : String(e));
    } finally {
      setReadingImage(false);
    }
  };
  /** "使用此题" in the generator: narrow screens switch to solving; then the problem card scrolls into view. */
  const useFromGenerator = (text: string, figure?: UsedProblemFigure) => {
    applyProblem(text, figure);
    if (!window.matchMedia("(min-width: 1280px)").matches) setWorkspace("solve");
    requestAnimationFrame(() => problemCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  // "使用此题" from the question bank (/bank) arrives as ?problem=<text>, with the question's
  // figures as ?bank=<id>&fig=<asset>… (images cut from the original page).
  const applyProblemFromBank = applyProblem;
  const problemParamHandled = useRef(false);
  useEffect(() => {
    if (problemParamHandled.current) return;
    problemParamHandled.current = true;
    const url = new URL(window.location.href);
    const text = url.searchParams.get("problem");
    if (!text?.trim()) return;
    dispatch({ type: "SET_PROBLEM_TEXT", text });
    const bankId = url.searchParams.get("bank");
    // A question generated on the bank page: its figure is fetched from the generation (?gen&cand).
    const gen = url.searchParams.get("gen");
    const cand = url.searchParams.get("cand");
    if (bankId && gen && cand) {
      applyProblem(text);
      setProblemSource({ bankId, genId: gen, candId: cand, text });
      fetch(`/api/banks/${encodeURIComponent(bankId)}/generations/${encodeURIComponent(gen)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { generation?: { candidates: Array<{ id: string; figure?: { svg: string; description: string } }> } } | null) => {
          const fig = d?.generation?.candidates.find((c) => c.id === cand)?.figure;
          if (fig?.svg) applyProblem(text, { fallbackSvg: fig.svg, description: fig.description });
        })
        .catch(() => undefined);
      for (const k of ["problem", "bank", "gen", "cand"]) url.searchParams.delete(k);
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
      return;
    }
    const figs = url.searchParams.getAll("fig").filter((a) => /^[a-f0-9]{16,64}\.(png|jpe?g|gif|webp)$/.test(a));
    applyProblemFromBank(
      text,
      bankId && figs.length
        ? { images: figs.map((a, i) => ({ url: `/api/banks/${encodeURIComponent(bankId)}/assets/${encodeURIComponent(a)}`, caption: tr(`题目图形 ${i + 1}`, `Figure ${i + 1}`) })) }
        : undefined,
    );
    // Solving sends these figures to the vision model, which reads them into the problem text.
    if (bankId && figs.length) dispatch({ type: "SET_PROBLEM_FIGURES", figures: { refs: figs.map((asset) => ({ bank_id: bankId, asset })), text } });
    url.searchParams.delete("problem");
    url.searchParams.delete("bank");
    url.searchParams.delete("fig");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    // Runs once on mount; the handler only needs the text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    removeFigure();
    setHistoryOpen(false);
    if (!window.matchMedia("(min-width: 1280px)").matches) setWorkspace("solve");
  };

  const hasResults = !!(nlSolution || leanProofAttempt || methods.length > 0);

  const phaseLabel: Record<string, string> = {
    idle: tr("就绪", "Ready"),
    enumerated: tr("已枚举", "Enumerated"),
    planned: tr("已规划", "Planned"),
    proving: tr("证明中", "Proving"),
    proved: tr("已证明", "Proved"),
    verified: tr("已验证", "Verified"),
    solved: tr("已求解", "Solved"),
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
                    {tr("AI × Lean 4 形式化证明", "AI × Lean 4 formal proofs")}
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
                <LocaleSwitcher />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onHistoryButton}
                  aria-label={tr("历史记录", "History")}
                  className="gap-1.5"
                >
                  <History className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">{tr("历史", "History")}</span>
                </Button>
                <Link href="/bank" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "gap-1.5")}>
                  <Library className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">{tr("题库", "Bank")}</span>
                </Link>
              </div>
            </div>
          </div>
        </header>

        {/* ── Main Content ──────────────────────────────────────────── */}
        <div className="flex justify-center">
        {/* ── History sidebar (wide screens) ─────────────────────────── */}
        <aside
          className={cn(
            "sticky top-14 h-[calc(100vh-3.5rem)] w-64 shrink-0 flex-col gap-3 border-r border-border/50 py-6 pl-4 pr-3",
            historyPinned ? (generating ? "hidden min-[1760px]:flex" : "hidden xl:flex") : "hidden",
          )}
          aria-label={tr("历史记录", "History")}
          data-testid="history-sidebar"
        >
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <History className="h-4 w-4 text-primary" />
              {tr("历史记录", "History")}
            </span>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => pinHistory(false)} aria-label={tr("收起历史", "Hide history")} title={tr("收起历史", "Hide history")}>
              <PanelLeftClose className="h-4 w-4" />
            </Button>
          </div>
          {lastGeneration && (
            <button
              type="button"
              onClick={() => pickWorkspace(lastGeneration.mode)}
              className="rounded-lg border border-border/60 p-2.5 text-left text-xs transition-colors hover:border-primary/30 hover:bg-accent/10"
              data-testid="last-generation"
            >
              <span className="flex items-center gap-1.5 font-medium text-foreground">
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                {tr("最近一次出题", "Latest generation")}
              </span>
              <span className="mt-1 block text-muted-foreground">
                {lastGeneration.mode === "bank"
                  ? tr(`要求 ${lastGeneration.requested} 道，通过 ${Math.min(lastGeneration.passed, lastGeneration.requested)} 道`, `${lastGeneration.requested} requested, ${Math.min(lastGeneration.passed, lastGeneration.requested)} passed`)
                  : tr(`生成了 ${lastGeneration.passed} 道`, `${lastGeneration.passed} generated`)}
                {lastGeneration.failed ? tr(`，${lastGeneration.failed} 道未通过`, `, ${lastGeneration.failed} failed`) : ""}
              </span>
              {lastGeneration.label && <span className="mt-0.5 block truncate text-[11px] text-muted-foreground/80">{lastGeneration.label}</span>}
            </button>
          )}
          <SessionHistoryList
            active
            compact
            disabled={!!busy}
            currentId={state.sessionId}
            refreshKey={`${state.sessionId ?? ""}:${phase}`}
            onLoadSession={handleLoadSession}
            scrollClassName="min-h-0 flex-1"
          />
        </aside>

        <main className={cn("min-w-0 flex-1 px-4 sm:px-6 py-6 space-y-5", generating ? "max-w-6xl xl:max-w-[1480px]" : "max-w-6xl")}>
          {/* What to do: solve a problem, or generate questions */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div role="radiogroup" aria-label={tr("要做什么", "What to do")} className="inline-flex rounded-lg border border-border/60 bg-card/60 p-1" data-testid="workspace-switch">
              {(
                [
                  ["solve", <Calculator key="i" className="h-4 w-4" />, tr("求解一道题", "Solve a problem"), undefined],
                  ["bank", <Library key="i" className="h-4 w-4" />, tr("从题库出题", "From the bank"), hasBank ? undefined : tr("题库中还没有题目：先在“题库”页面导入", "No bank questions yet: import some on the Bank page first")],
                  ["builtin", <Wand2 key="i" className="h-4 w-4" />, tr("内置出题", "Built-in generator"), undefined],
                ] as const
              ).map(([w, icon, label, off]) => (
                <button
                  key={w}
                  type="button"
                  role="radio"
                  aria-checked={workspace === w}
                  disabled={!!off}
                  title={off}
                  onClick={() => pickWorkspace(w)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                    workspace === w ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  {icon}
                  {label}
                </button>
              ))}
            </div>
            {generating && (
              <p className="hidden text-xs text-muted-foreground xl:block">
                {tr("左边出题，右边求解：点“使用此题”会把题目放到右边。", "Generate on the left, solve on the right: “Use this problem” puts it on the right.")}
              </p>
            )}
          </div>

          <div className={cn(generating && "xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:items-start xl:gap-6")}>
          {/* Generator: kept mounted while solving, so its results are still there when you come back */}
          <section className={cn(!generating && "hidden", "@container")} aria-label={tr("出题", "Generate")}>
            <ProblemGenerator
              mode={generatorMode}
              onUseProblem={useFromGenerator}
              onResults={setLastGeneration}
              onFormalize={useFromGenerator}
              disabled={!!busy}
            />
          </section>

          {/* Solver */}
          <section className={cn("@container space-y-6", generating && "max-xl:hidden")} aria-label={tr("求解", "Solve")}>
          {/* Problem Input Card */}
          <Card className="animate-fade-in scroll-mt-20" ref={problemCardRef}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Calculator className="h-4 w-4 text-primary" />
                  {tr("问题", "Problem")}
                </CardTitle>
                <div className="flex items-center gap-2">
                {!busy && problemText.trim() && !isUntouched && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 text-xs"
                    onClick={exportProblemPdf}
                    title={tr("打开可打印的题目页（解出后含答案和步骤），在打印窗口选择“另存为 PDF”", "Open a printable page of this problem (with the answer and steps once solved); choose “Save as PDF” in the print window")}
                    data-testid="export-problem-pdf"
                  >
                    <FileDown className="h-3.5 w-3.5" />
                    {tr("导出 PDF", "Export PDF")}
                  </Button>
                )}
                {busy && (
                  <Badge variant="info" className="gap-1.5 animate-pulse-soft">
                    <span className="h-1.5 w-1.5 rounded-full bg-primary animate-spin" />
                    {tr("工作中：", "Working: ")}{busy === "lean-attempt" ? tr("形式化证明", "formal proof") : busy}
                  </Badge>
                )}
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* Problem box: type, paste or drop an image; the rendered problem (and its figure) shows underneath as you type */}
              <div
                className="relative"
                onDragOver={(e) => {
                  if (busy || readingImage || !Array.from(e.dataTransfer.items).some((i) => i.type.startsWith("image/"))) return;
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
                }}
                onDrop={(e) => {
                  const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/"));
                  setDragging(false);
                  if (!file || busy || readingImage) return;
                  e.preventDefault();
                  void readImage(file);
                }}
              >
                <Textarea
                  value={problemText}
                  onChange={(e) => {
                    dispatch({ type: "SET_PROBLEM_TEXT", text: e.target.value });
                    // Emptying the box drops the figure (the reducer drops it from the request too).
                    if (!e.target.value.trim()) setUsedFigure(null);
                  }}
                  onPaste={(e) => {
                    const file = Array.from(e.clipboardData.files).find((f) => f.type.startsWith("image/"));
                    if (!file) return;
                    e.preventDefault();
                    void readImage(file);
                  }}
                  disabled={!!busy || readingImage}
                  rows={3}
                  placeholder={tr("输入数学问题（支持 LaTeX，如 $x^2 + y^2 = z^2$），或粘贴 / 拖入一张题目图片…", "Type a math problem (LaTeX works, e.g. $x^2 + y^2 = z^2$), or paste / drop a picture of one…")}
                  className="min-h-[80px] text-base leading-relaxed"
                  data-testid="problem-input"
                />
                {(dragging || readingImage) && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 rounded-md border-2 border-dashed border-primary/60 bg-background/85 text-sm text-primary" data-testid="image-drop">
                    {readingImage ? (
                      <>
                        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                        {tr("正在从图片读题…", "Reading the problem from the image…")}
                      </>
                    ) : (
                      <>
                        <ImageUp className="h-4 w-4" />
                        {tr("松开即可从图片读题", "Drop to read the problem from the image")}
                      </>
                    )}
                  </div>
                )}
              </div>
              {imageError && (
                <p className="flex items-start gap-1.5 text-xs text-destructive" data-testid="image-error">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {imageError}
                </p>
              )}

              {/* Examples while the box is empty or still holds the sample */}
              {!busy && isUntouched && <ProblemExamples onPick={pickExample} disabled={readingImage} />}

              {/* Live preview: rendered maths, options one per line, and the problem's figure */}
              {problemText.trim() && (containsMath(problemText) || problemText.includes("\n") || usedFigure) && (
                <div className="rounded-md border border-border/60 bg-muted/30 p-3 animate-fade-in" data-testid="problem-preview">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      {tr("预览", "Preview")}
                    </span>
                    {usedFigure && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 gap-1 px-2 text-xs"
                        disabled={!!busy}
                        onClick={removeFigure}
                        title={tr("这道题不再带这个图形", "Stop sending this figure with the problem")}
                      >
                        <X className="h-3 w-3" />
                        {tr("移除图形", "Remove figure")}
                      </Button>
                    )}
                  </div>
                  <div className="mt-1.5 whitespace-pre-line text-sm">
                    <MathText text={problemText} />
                  </div>
                  {usedFigure && (
                    <div className="mt-3" key={usedKey}>
                      {usedFigure.figure ? (
                        <FigurePanel problemText={problemText} initialFigure={usedFigure.figure} />
                      ) : usedFigure.fallbackSvg ? (
                        usedFigure.description ? (
                          // A generated question's figure (program-drawn, on paper): a thumbnail that opens full size.
                          <QuestionFigure svg={usedFigure.fallbackSvg} compact />
                        ) : (
                          <DiagramSvg svg={usedFigure.fallbackSvg} />
                        )
                      ) : usedFigure.images?.length ? (
                        <div className="flex flex-wrap gap-3" data-testid="problem-images">
                          {usedFigure.images.map((im) => (
                            <a key={im.url} href={im.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md border border-border/60 bg-white" title={tr("查看大图", "Open full size")}>
                              {/* eslint-disable-next-line @next/next/no-img-element -- bank assets / a local image the user pasted */}
                              <img src={im.url} alt={im.caption ?? ""} className="block max-h-56 max-w-full object-contain" />
                            </a>
                          ))}
                        </div>
                      ) : null}
                      {usedFigure.images?.length && (state.figureDescription || usedFigure.description) ? (
                        <details className="mt-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs" open data-testid="figure-description">
                          <summary className="cursor-pointer select-none font-medium text-primary">
                            {tr("模型读取的图形信息（已加入题目，用于求解）", "The figure as read by the model (added to the problem for solving)")}
                          </summary>
                          <div className="mt-1.5 whitespace-pre-wrap leading-relaxed text-muted-foreground">
                            <MathText text={(state.figureDescription || usedFigure.description)!} />
                          </div>
                        </details>
                      ) : usedFigure.images?.length ? (
                        <p className="mt-2 text-[11px] text-muted-foreground">
                          {tr("求解时会先让能读图片的模型读取图形，并把读到的信息加入题目。", "When solving, a model that reads images first reads the figure and adds what it sees to the problem.")}
                        </p>
                      ) : null}
                    </div>
                  )}
                </div>
              )}

              {/* Action buttons, with what each one does */}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={-1} className="inline-flex">
                      <Button
                        onClick={() => void solveAll()}
                        disabled={!!busy || readingImage || !problemText.trim()}
                        loading={busy === "solve-all"}
                        className="gap-1.5"
                        aria-describedby="solve-help"
                      >
                        <Play className="h-3.5 w-3.5" />
                        {tr("一键求解", "Solve")}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs">
                    {tr("自动判断题型（计算、证明、最值、求所有解），直接给出一份完整解答；证明题还会尝试用 Lean 形式化验证。", "Works out the kind of problem (computation, proof, optimization, find-all) and gives one complete solution; proofs are also checked formally in Lean.")}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={-1} className="inline-flex">
                      <Button
                        variant="outline"
                        onClick={() => void enumerate()}
                        disabled={!!busy || readingImage || !problemText.trim()}
                        loading={busy === "enumerate"}
                        className="gap-1.5"
                        aria-describedby="enumerate-help"
                      >
                        <ListOrdered className="h-3.5 w-3.5" />
                        {tr("枚举解法", "Enumerate methods")}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs">
                    {tr("先列出几种不同的解题思路并评分，你选一种后再逐步规划、证明。适合想比较方法或学习思路时用。", "Lists several different approaches with scores first; you pick one and then plan and prove it step by step. Good for comparing methods or learning.")}
                  </TooltipContent>
                </Tooltip>
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 text-muted-foreground"
                  disabled={!!busy || readingImage}
                  onClick={() => imageInputRef.current?.click()}
                  title={tr("上传一张题目图片（截图或照片），自动读出题目", "Upload a picture of a problem (screenshot or photo) and read it")}
                >
                  <ImageUp className="h-3.5 w-3.5" />
                  {tr("从图片读题", "From an image")}
                </Button>
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  className="hidden"
                  data-testid="image-input"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) void readImage(file);
                  }}
                />
              </div>
              <p className="sr-only" id="solve-help">
                {tr("一键求解：自动判断题型，直接给出完整解答。", "Solve: works out the kind of problem and gives one complete solution.")}
              </p>
              <p className="sr-only" id="enumerate-help">
                {tr("枚举解法：先列出几种思路，选一种再逐步证明。", "Enumerate methods: lists approaches first; pick one and prove it step by step.")}
              </p>

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
                <span className="font-medium text-warning">{tr("域外警告：", "Out-of-domain warning: ")}</span>
                <span className="text-muted-foreground">{outOfDomainWarning}</span>
              </div>
            </div>
          )}

          {buildStatus === "unavailable" && (
            <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm animate-fade-in">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div className="text-muted-foreground">
                {tr("Lean / lake 不可用。请安装 elan 与 Lean 4，并确保", "Lean / lake is unavailable. Install elan and Lean 4, and make sure")}{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">lean-sandbox</code>{" "}
                {tr("可", "passes")}{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">lake build</code>{tr("。", ".")}
              </div>
            </div>
          )}

          {/* ── Pipeline Progress (real-time streaming) ───────────── */}
          {(solveEvents.length > 0 || busy === "solve-all") && (
            <PipelineProgress
              events={solveEvents}
              busy={busy}
              queuePosition={queuePosition}
              onCancel={jobId && busy ? () => void cancelSolve() : undefined}
              cancelling={cancelling}
            />
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
                    {tr("解答", "Solution")}
                  </TabsTrigger>
                )}
                {methods.length > 0 && (
                  <TabsTrigger value="methods" className="gap-1.5 data-[state=active]:bg-primary/10 data-[state=active]:text-primary">
                    <ListOrdered className="h-3.5 w-3.5" />
                    {tr("解法", "Methods")}
                    <span className="ml-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-bold text-primary">
                      {methods.length}
                    </span>
                  </TabsTrigger>
                )}
                {(planned || steps.length > 0) && (
                  <TabsTrigger value="proof" className="gap-1.5 data-[state=active]:bg-primary/10 data-[state=active]:text-primary">
                    <FileCode className="h-3.5 w-3.5" />
                    {tr("证明", "Proof")}
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
                          {tr("自然语言解答", "Natural-language solution")}
                        </CardTitle>
                        <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 gap-1.5 text-xs"
                          onClick={exportSolutionPdf}
                          title={tr("导出题目、解题过程和答案（答案在最后），在打印窗口选择“另存为 PDF”", "Export the problem, the worked steps and the answer (at the end); choose “Save as PDF” in the print window")}
                          data-testid="export-solution-pdf"
                        >
                          <FileDown className="h-3.5 w-3.5" />
                          {tr("导出 PDF", "Export PDF")}
                        </Button>
                        <Badge
                          variant={solvedProblemType === "theorem" ? "info" : "default"}
                        >
                          {solvedProblemType === "theorem" ? tr("定理证明", "Theorem proof") : tr("计算求解", "Computation")}
                        </Badge>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-5">
                      {/* Figure (geometry / function graphs), computed and checked server-side */}
                      {state.sessionId && (
                        <div ref={figureBoxRef} className="scroll-mt-20">
                          <FigurePanel
                            key={state.sessionId}
                            sessionId={state.sessionId}
                            step={figStep}
                            onStepChange={(step) => setFigureView((v) => ({ session: state.sessionId, steps: v.session === state.sessionId ? v.steps : [], step }))}
                            onFigure={(f) => setFigureView({ session: state.sessionId, step: null, steps: figureSteps(f) })}
                            stepTitles={nlSolution.steps.map((st) => st.title)}
                          />
                        </div>
                      )}

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
                            {stepsExpanded ? tr("折叠全部", "Collapse all") : tr("展开全部", "Expand all")}
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
                          onShowOnFigure={figSteps.includes(i + 1) ? () => showStepOnFigure(i + 1) : undefined}
                          active={figStep === i + 1}
                        />
                      ))}

                      <Separator />

                      {/* Final answer */}
                      <div className="rounded-lg border-2 border-success/30 bg-success/5 p-4">
                        <div className="text-[11px] font-bold uppercase tracking-wider text-success mb-2">
                          <CheckCircle2 className="inline h-3.5 w-3.5 mr-1" />
                          {tr("最终答案", "Final answer")}
                        </div>
                        <div className="text-base font-semibold">
                          <MathText text={nlSolution.final_answer} />
                        </div>
                      </div>

                      {/* Verification */}
                      {nlSolution.verification && (
                        <div className="rounded-lg border border-border/60 bg-muted/20 p-4 text-sm">
                          <span className="font-semibold text-muted-foreground">{tr("验证：", "Verification: ")}</span>
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
                        {tr("列表视图", "List view")}
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
                          {tr("对比视图", "Compare view")}
                        </Button>
                      </div>
                    )}
                    <div className="grid grid-cols-1 @2xl:grid-cols-[minmax(220px,0.85fr)_minmax(280px,1.15fr)] gap-4">
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
                        {tr("证明本步", "Prove step")}
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
                        {tr("全部逐步生成", "Prove all steps")}
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
                        {tr("验证", "Verify")}
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
                            {tr("重试", "Retry")}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{tr("重试当前步骤的证明", "Retry the proof of the current step")}</TooltipContent>
                      </Tooltip>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!!busy || phase === "idle"}
                        onClick={switchMethod}
                      >
                        {tr("换解法", "Switch method")}
                      </Button>
                    </div>

                    {/* Steps + Lean side by side */}
                    <div className="grid grid-cols-1 @4xl:grid-cols-2 divide-y @4xl:divide-y-0 @4xl:divide-x divide-border">
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
                          {tr("Lean 4 形式化", "Lean 4 formalization")}
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
                            ? tr("未开始", "Not started")
                            : leanProofAttempt.success
                              ? tr("✅ 证明成功", "✅ Proof succeeded")
                              : tr("⚠️ 未能完成", "⚠️ Incomplete")}
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {!leanProofAttempt.attempted && (
                        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary/20 bg-primary/5 px-4 py-3">
                          <p className="text-sm text-muted-foreground">
                            {tr(
                              "形式化证明是求解的最后一步，需要手动开始，可能需要几分钟。",
                              "The formal proof is the last solving step. Start it by hand; it can take a few minutes.",
                            )}
                          </p>
                          <Button
                            size="sm"
                            onClick={() => void attemptLean()}
                            disabled={!!busy || !state.sessionId}
                            loading={busy === "lean-attempt"}
                          >
                            <Play className="h-3.5 w-3.5" />
                            {busy === "lean-attempt" ? tr("形式化中…", "Formalizing…") : tr("开始形式化证明", "Start formal proof")}
                          </Button>
                        </div>
                      )}
                      {leanProofAttempt.attempted && leanProofAttempt.success && (
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <Badge variant="secondary">
                            {tr("公理：", "Axioms: ")}{leanProofAttempt.axioms && leanProofAttempt.axioms.length > 0
                              ? leanProofAttempt.axioms.join(", ")
                              : tr("无", "none")}
                          </Badge>
                          <Badge variant={leanProofAttempt.statement_locked ? "success" : "warning"}>
                            {leanProofAttempt.statement_locked
                              ? tr("陈述与形式化校验一致", "Statement matches the checked formalization")
                              : tr("陈述未经形式化校验锁定", "Statement not locked by formalization check")}
                          </Badge>
                          {leanProofAttempt.verifier && (
                            <span>{tr("验证后端：", "Verifier: ")}{leanProofAttempt.verifier === "repl" ? "Lean REPL" : leanProofAttempt.verifier}</span>
                          )}
                          {leanProofAttempt.strategy && (
                            <span>
                              {tr("证明方式：", "Strategy: ")}
                              {leanProofAttempt.strategy === "whole_proof"
                                ? tr(
                                    `整体证明（${leanProofAttempt.attempts ?? "?"} 个候选 / ${leanProofAttempt.rounds ?? "?"} 轮）`,
                                    `Whole proof (${leanProofAttempt.attempts ?? "?"} candidates / ${leanProofAttempt.rounds ?? "?"} rounds)`,
                                  )
                                : leanProofAttempt.strategy === "sketch"
                                  ? tr(
                                      `骨架分解（${leanProofAttempt.holes_solved ?? "?"}/${leanProofAttempt.holes ?? "?"} 个子目标）`,
                                      `Proof sketch (${leanProofAttempt.holes_solved ?? "?"}/${leanProofAttempt.holes ?? "?"} subgoals)`,
                                    )
                                  : leanProofAttempt.strategy === "trivial" || leanProofAttempt.strategy === "hammer"
                                    ? tr("自动化策略", "Automated tactics")
                                    : leanProofAttempt.strategy === "memory"
                                      ? tr("证明记忆（相似定理的已验证证明直接适用）", "Proof memory (a verified proof of a similar theorem, as is)")
                                      : tr(
                                        `分步搜索（${leanProofAttempt.attempts ?? "?"} 次尝试）`,
                                        `Stepwise search (${leanProofAttempt.attempts ?? "?"} attempts)`,
                                      )}
                            </span>
                          )}
                          {leanProofAttempt.remembered && (
                            <span title={tr("相似的题会先试这个证明；它也会成为训练证明模型的数据（npm run expert:iterate）", "Similar problems try this proof first; it also becomes training data for the prover (npm run expert:iterate)")}>
                              {tr("已存入证明记忆", "Saved to proof memory")}
                            </span>
                          )}
                        </div>
                      )}

                      {leanProofAttempt.failure_reason && (
                        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-warning">
                          <span>{leanProofAttempt.failure_reason}</span>
                          {leanProofAttempt.attempted && !leanProofAttempt.success && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void attemptLean()}
                              disabled={!!busy || !state.sessionId}
                              loading={busy === "lean-attempt"}
                            >
                              <Play className="h-3.5 w-3.5" />
                              {busy === "lean-attempt" ? tr("形式化中…", "Formalizing…") : tr("再试一次", "Try again")}
                            </Button>
                          )}
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
              {leanProofAttempt?.strategy && (
                <span className="font-medium text-foreground/80">
                  {tr("证明方式：", "Proved by: ")}
                  {strategyLabel(leanProofAttempt.strategy, tr)}
                  {leanProofAttempt.success ? "" : tr("（未完成）", " (not completed)")}
                </span>
              )}
              {runMetrics.estimated_cost !== undefined && (
                <span className="font-medium text-foreground/80">{tr("费用", "Cost")} ${runMetrics.estimated_cost.toFixed(4)}</span>
              )}
              <span>{tr(`LLM 调用 ${runMetrics.llm_calls} 次`, `${runMetrics.llm_calls} LLM calls`)}</span>
              <span>
                tokens {runMetrics.prompt_tokens + runMetrics.completion_tokens}
                {runMetrics.by_role?.prover
                  ? tr(`（prover ${runMetrics.by_role.prover.requests} 次）`, ` (prover: ${runMetrics.by_role.prover.requests})`)
                  : ""}
              </span>
              <span>
                {tr(`Lean 验证 ${runMetrics.lean_verifications} 次`, `${runMetrics.lean_verifications} Lean verifications`)}
                {runMetrics.lean_verifications > 0
                  ? tr(`（${(runMetrics.lean_verify_ms / 1000).toFixed(1)}s）`, ` (${(runMetrics.lean_verify_ms / 1000).toFixed(1)}s)`)
                  : ""}
              </span>
              <span>{tr("总耗时", "Total time")} {(runMetrics.wall_ms / 1000).toFixed(1)}s</span>
            </div>
          )}

          {/* ── Solve Events (collapsible log) ─────────────────────── */}
          {solveEvents.length > 0 && (
            <Card className="animate-fade-in">
              <CardContent className="p-4">
                <details>
                  <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors select-none">
                    <ChevronDown className="h-4 w-4" />
                    {tr(`求解过程日志 (${solveEvents.length} 条)`, `Solve log (${solveEvents.length} entries)`)}
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
          </section>
          </div>
        </main>
        </div>

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
          {" "}— {tr("AI 驱动的数学定理证明", "AI-powered mathematical theorem proving")}
        </footer>
      </div>
    </TooltipProvider>
  );
}

/** How the proof was found, in words (lean_proof_attempt.strategy). */
function strategyLabel(strategy: string, tr: (zh: string, en: string) => string): string {
  const labels: Record<string, string> = {
    trivial: tr("单条策略", "a single tactic"),
    hammer: tr("自动化策略（锤子）", "automation (hammer)"),
    memory: tr("证明记忆（相似定理的证明直接适用）", "proof memory (a similar theorem's proof, as is)"),
    whole_proof: tr("整体证明（模型写完整证明，Lean 验证）", "whole proof (the model writes it, Lean checks it)"),
    sketch: tr("骨架分解（子目标逐个证明）", "sketch and fill (subgoals proved one by one)"),
    stepwise: tr("分步搜索", "step-by-step search"),
  };
  return labels[strategy] ?? strategy;
}
