"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  GradeLevel,
  DifficultyLevel,
  CompetitionDomain,
  GeneratedProblem,
} from "@/lib/types";
import { GRADE_LEVELS, DIFFICULTY_LEVELS, COMPETITION_DOMAINS } from "@/lib/types";
import { MathText } from "./MathText";
import { QuestionFigure } from "./QuestionFigure";
import { FigurePanel } from "./FigurePanel";
import { BankTemplateControls, MatchHint, perQuestion, useBanks, type BankTemplateValue } from "./BankTemplateControls";
import type { SolvedFigure } from "@/lib/figure/spec";
import { cardStatus, checkIssues, readNdjson, type CheckKey, type ProgressLine } from "@/lib/bank/generation-view";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import {
  Sparkles,
  GraduationCap,
  BarChart3,
  FolderOpen,
  Hash,
  Lightbulb,
  Clock,
  Eye,
  EyeOff,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  ArrowRight,
  FileCode,
  Library,
  Wand2,
  BookPlus,
  CircleCheck,
  CircleX,
  Info,
  AlertTriangle,
  Loader2,
  MoreHorizontal,
  FileDown,
} from "lucide-react";
import { generationPrintHref, stashWorksheet } from "@/lib/bank/worksheet";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/** What a generated problem carries over when it is used: its computed figure, or the model's SVG. */
export interface UsedProblemFigure {
  figure?: SolvedFigure;
  fallbackSvg?: string;
  /** Exact description of the figure (generated questions): added to the problem text when solving. */
  description?: string;
  /** Figures of a question bank item (images cut from the original page), shown as they are. */
  images?: Array<{ url: string; caption?: string }>;
}

type Props = {
  /** Set by the page (its "what to do" switch): the generator then shows no method switch of its own. */
  mode?: "bank" | "builtin";
  onUseProblem: (problemText: string, figure?: UsedProblemFigure) => void;
  /** After each generation: a summary for the page's history sidebar. */
  onResults?: (r: GenerationSummary) => void;
  onFormalize: (problemText: string) => void;
  disabled?: boolean;
};

export interface GenerationSummary {
  mode: "bank" | "builtin";
  requested: number;
  /** Bank mode: passed every check; built-in: generated. */
  passed: number;
  failed: number;
  label?: string;
  at: number;
}

type Tr = (zh: string, en: string) => string;

function getLabels(tr: Tr) {
  const GRADE_LABELS: Record<GradeLevel, string> = {
    elementary: tr("小学", "Primary school"),
    middle: tr("初中", "Middle school"),
    high: tr("高中", "High school"),
    university: tr("大学", "University"),
  };

  const DIFFICULTY_LABELS: Record<DifficultyLevel, string> = {
    standard: tr("标准", "Standard"),
    advanced: tr("提高", "Advanced"),
    competition: tr("竞赛", "Competition"),
  };

  const DOMAIN_LABELS: Record<CompetitionDomain, string> = {
    competition_elementary: tr("竞赛初等", "Competition elementary math"),
    competition_inequality: tr("竞赛不等式", "Competition inequalities"),
    competition_number_theory: tr("竞赛数论", "Competition number theory"),
    competition_combinatorics: tr("竞赛组合", "Competition combinatorics"),
    competition_set_theory: tr("竞赛集合", "Competition set theory"),
    number_theory: tr("数论", "Number theory"),
    combinatorics: tr("组合", "Combinatorics"),
    set_theory: tr("集合", "Set theory"),
    algebra: tr("代数", "Algebra"),
    geometry: tr("几何", "Geometry"),
    inequality: tr("不等式", "Inequalities"),
    logic: tr("逻辑", "Logic"),
    computation: tr("计算", "Computation"),
  };

  return { GRADE_LABELS, DIFFICULTY_LABELS, DOMAIN_LABELS };
}

export function ProblemGenerator({ mode: modeProp, onUseProblem, onFormalize, onResults, disabled }: Props) {
  const { tr } = useI18n();
  const { GRADE_LABELS, DIFFICULTY_LABELS, DOMAIN_LABELS } = getLabels(tr);
  const [gradeLevel, setGradeLevel] = useState<GradeLevel>("high");
  const [difficulty, setDifficulty] = useState<DifficultyLevel>("competition");
  const [domain, setDomain] = useState<CompetitionDomain>("competition_number_theory");
  const [count, setCount] = useState(1);
  const [problems, setProblems] = useState<GeneratedProblem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Method 1 (default when the account has a bank with questions): the local bank as the template.
  // Method 2: built-in generation by level / difficulty / domain (unchanged).
  const { banks } = useBanks();
  const [mode, setMode] = useState<"bank" | "builtin" | null>(null);
  const activeMode = modeProp === "bank" && banks && !banks.length ? "builtin" : (modeProp ?? mode ?? (banks?.length ? "bank" : "builtin"));
  const [bankValue, setBankValue] = useState<BankTemplateValue>({ bankId: "", grade: "", difficulty: 0, topic: "" });
  const bankId = bankValue.bankId || banks?.[0]?.id || "";
  const [match, setMatch] = useState<{ exact: number; topic: number } | null>(null);
  const onMatchChange = useCallback((m: { exact: number; topic: number } | null) => setMatch(m), []);
  const [resultNote, setResultNote] = useState<string | null>(null);
  // The page switched method: results of the other method no longer apply.
  const [shownMode, setShownMode] = useState(activeMode);
  if (shownMode !== activeMode) {
    setShownMode(activeMode);
    setProblems([]);
    setResultNote(null);
    setError(null);
  }
  // Bank mode: candidates that failed a check are kept but hidden behind a toggle.
  const [showFailed, setShowFailed] = useState(false);
  const failedBank = problems.filter((p) => p.bank && !p.bank.passed);
  const passedBank = problems.filter((p) => p.bank?.passed);
  const isBankResult = problems.some((p) => p.bank);
  // When nothing passed, show the failed ones right away (with their check results) instead of an empty list.
  const nonePassed = failedBank.length > 0 && failedBank.length === problems.length;
  const shown = problems.filter((p) => !p.bank || p.bank.passed || showFailed || nonePassed);
  // How many were asked for (the summary says when fewer came back), and where the generation is.
  const [requested, setRequested] = useState(0);
  const [progress, setProgress] = useState<ProgressLine | null>(null);
  const [steps, setSteps] = useState<string[]>([]);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!busy || startedAt === null) return;
    const t = setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [busy, startedAt]);

  /** Printable worksheet (saved as PDF from the print dialog): a bank generation by its id, built-in questions handed over. */
  function exportPdf() {
    const gen = problems.find((p) => p.bank)?.bank;
    // One generation: print it from the bank. Several (one per template): hand all the questions over.
    if (gen && new Set(problems.map((p) => p.bank?.generation_id)).size === 1) {
      window.open(generationPrintHref(gen.bank_id, gen.generation_id), "_blank");
      return;
    }
    const href = stashWorksheet({
      title: tr("练习题", "Practice questions"),
      questions: problems.map((p) => ({ id: p.id, stem: p.statement, answer: p.answer, solution: p.hints.length ? p.hints.map((h, i) => `${i + 1}. ${h}`).join("\n") : undefined, figureSvg: p.bank?.figure?.svg ?? p.diagram_svg, passed: p.bank?.passed })),
    });
    window.open(href, "_blank");
  }

  async function generate() {
    setError(null);
    setBusy(true);
    setProblems([]);
    setResultNote(null);
    setShowFailed(false);
    setProgress(null);
    setSteps([]);
    setStartedAt(Date.now());
    setElapsed(0);
    const asked = activeMode === "bank" ? Math.min(10, Math.max(1, count || 1)) : count;
    setRequested(asked);
    try {
      // Client-side timeout: generous enough for server maxDuration (330s)
      // plus network overhead. The server's deadline-aware retry loop will
      // return a proper error well before this fires in most cases.
      // Bank mode streams: the timer restarts with every line, so generating from several
      // templates in turn (minutes) is not cut off while progress keeps coming.
      const controller = new AbortController();
      let timeoutId = setTimeout(() => controller.abort(), 350_000);

      const res = await fetch("/api/generate-problem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          activeMode === "bank"
            ? {
                source: "bank",
                bank_id: bankId,
                grade: bankValue.grade || undefined,
                difficulty: bankValue.difficulty || undefined,
                category_id: bankValue.topic.startsWith("cat:") ? bankValue.topic.slice(4) : undefined,
                knowledge_point: bankValue.topic.startsWith("kp:") ? bankValue.topic.slice(3) : undefined,
                count: asked,
                stream: true,
              }
            : {
                grade_level: gradeLevel,
                difficulty,
                domain,
                count,
              },
        ),
        signal: controller.signal,
      });

      type Reply = {
        problems?: GeneratedProblem[];
        error?: string;
        note?: string;
        matched?: number;
        template_label?: string;
        requested?: number;
      };
      let data: Reply = {};
      if (res.ok && res.body && (res.headers.get("content-type") ?? "").includes("ndjson")) {
        // Bank mode streams progress lines, then the result (or an error).
        await readNdjson(res.body, (line) => {
          clearTimeout(timeoutId);
          timeoutId = setTimeout(() => controller.abort(), 350_000);
          if (line.type === "progress") {
            const p = line as unknown as ProgressLine;
            setProgress(p);
            setSteps((s) => (s[s.length - 1] === p.detail ? s : [...s, p.detail]));
          } else if (line.type === "result") data = line as Reply;
          else if (line.type === "error") data = { error: String(line.error ?? "") || tr("生成失败", "Generation failed") };
        });
        clearTimeout(timeoutId);
        if (data.error || !data.problems) throw new Error(data.error ?? tr("生成中断，请重试", "Generation was interrupted; please try again"));
      } else {
        data = (await res.json()) as Reply;
        clearTimeout(timeoutId);
        if (!res.ok) {
          throw new Error(data.error ?? tr("生成失败", "Generation failed"));
        }
      }
      const got = data.problems ?? [];
      setProblems(got);
      if (data.requested) setRequested(data.requested);
      const bankPassed = got.filter((p) => p.bank?.passed).length;
      onResults?.({
        mode: activeMode,
        requested: data.requested ?? asked,
        passed: activeMode === "bank" ? bankPassed : got.length,
        failed: activeMode === "bank" ? got.filter((p) => p.bank && !p.bank.passed).length : 0,
        label: data.template_label,
        at: Date.now(),
      });
      if (data.template_label) {
        setResultNote(
          [tr(`模板：${data.template_label}（${data.matched ?? 0} 道题库题）`, `Template: ${data.template_label} (${data.matched ?? 0} bank questions)`), data.note].filter(Boolean).join(" "),
        );
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        setError(tr("生成超时，请减少题目数量（建议1-2题）或选择标准难度后重试", "Generation timed out. Reduce the number of problems (1–2 recommended) or choose Standard difficulty, then try again."));
      } else {
        setError(e instanceof Error ? e.message : tr("生成失败", "Generation failed"));
      }
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <Card className="animate-slide-down">
      <CardContent className="p-5 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">{tr("题目生成器", "Problem generator")}</h2>
          </div>
          {!modeProp && <div role="radiogroup" aria-label={tr("出题方式", "Generation method")} className="inline-flex rounded-md border border-border/60 p-0.5 text-xs">
            {(
              [
                ["bank", <Library key="i" className="h-3.5 w-3.5" />, tr("以本地题库为模板", "Local bank as template")],
                ["builtin", <Wand2 key="i" className="h-3.5 w-3.5" />, tr("内置出题", "Built-in")],
              ] as const
            ).map(([m, icon, text]) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={activeMode === m}
                disabled={busy || (m === "bank" && !banks?.length)}
                title={m === "bank" && !banks?.length ? tr("题库中还没有题目：先在“题库”页面导入", "No bank questions yet: import some on the Bank page first") : undefined}
                onClick={() => {
                  setMode(m);
                  setProblems([]);
                  setResultNote(null);
                  setError(null);
                }}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded px-2.5 py-1 transition-colors disabled:opacity-40",
                  activeMode === m ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {icon}
                {text}
              </button>
            ))}
          </div>}
        </div>

        {/* Controls */}
        <div className="grid grid-cols-2 @lg:grid-cols-4 @3xl:grid-cols-5 gap-3">
          {activeMode === "bank" && banks?.length ? (
            <BankTemplateControls
              banks={banks}
              value={{ ...bankValue, bankId }}
              onChange={setBankValue}
              disabled={busy}
              onMatchChange={onMatchChange}
            />
          ) : (
            <>
          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              <GraduationCap className="h-3 w-3" />
              {tr("学段", "Level")}
            </label>
            <Select
              value={gradeLevel}
              onValueChange={(v) => setGradeLevel(v as GradeLevel)}
              disabled={busy}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GRADE_LEVELS.map((g) => (
                  <SelectItem key={g} value={g}>
                    {GRADE_LABELS[g]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              <BarChart3 className="h-3 w-3" />
              {tr("难度", "Difficulty")}
            </label>
            <Select
              value={difficulty}
              onValueChange={(v) => setDifficulty(v as DifficultyLevel)}
              disabled={busy}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DIFFICULTY_LEVELS.map((d) => (
                  <SelectItem key={d} value={d}>
                    {DIFFICULTY_LABELS[d]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              <FolderOpen className="h-3 w-3" />
              {tr("领域", "Topic")}
            </label>
            <Select
              value={domain}
              onValueChange={(v) => setDomain(v as CompetitionDomain)}
              disabled={busy}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COMPETITION_DOMAINS.map((d) => (
                  <SelectItem key={d} value={d}>
                    {DOMAIN_LABELS[d]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

            </>
          )}

          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              <Hash className="h-3 w-3" />
              {activeMode === "bank" && perQuestion(match?.exact) ? tr("每个模板", "Per template") : tr("数量", "Count")}
            </label>
            <Input
              type="number"
              min={1}
              max={10}
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              disabled={busy}
              className="w-full"
            />
          </div>

          <div className="flex items-end">
            <Button
              onClick={() => void generate()}
              disabled={busy || disabled || (activeMode === "bank" && (!bankId || match?.topic === 0))}
              loading={busy}
              className="w-full gap-1.5"
            >
              <Sparkles className="h-3.5 w-3.5" />
              {tr("生成", "Generate")}
            </Button>
          </div>
        </div>

        {activeMode === "bank" && banks?.length ? <MatchHint match={match} value={bankValue} /> : null}

        {busy && (
          <GenerationProgressView mode={activeMode} progress={progress} steps={steps} elapsed={elapsed} requested={requested} />
        )}

        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive animate-fade-in">
            {error}
          </div>
        )}

        {/* Problem cards */}
        {problems.length > 0 && (
          <div className="space-y-3 animate-slide-up">
            <Separator />
            <ResultSummary
              bank={isBankResult}
              requested={requested}
              total={problems.length}
              passed={passedBank.length}
              failed={failedBank.length}
              showFailed={showFailed || nonePassed}
              onToggleFailed={nonePassed ? undefined : () => setShowFailed(!showFailed)}
            />
            <div className="flex justify-end">
              <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" onClick={exportPdf} data-testid="export-pdf" title={tr("打开可打印的练习卷，在打印窗口选择“另存为 PDF”", "Open a printable worksheet; choose “Save as PDF” in the print window")}>
                <FileDown className="h-3.5 w-3.5" />
                {tr("导出 PDF", "Export PDF")}
              </Button>
            </div>
            {resultNote && (
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {resultNote}
              </p>
            )}
            {shown.map((problem) => (
              <ProblemCard
                key={problem.id}
                problem={problem}
                onUse={(figure) => onUseProblem(problem.statement, figure)}
                onFormalize={() => onFormalize(problem.statement)}
                disabled={disabled}
              />
            ))}
            {failedBank.length > 0 && !nonePassed && !showFailed && (
              <button
                type="button"
                className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border/70 py-2 text-xs text-muted-foreground hover:border-border hover:text-foreground"
                onClick={() => setShowFailed(true)}
              >
                <ChevronDown className="h-3.5 w-3.5" />
                {tr(`查看 ${failedBank.length} 道未通过的题和原因`, `Show the ${failedBank.length} question${failedBank.length === 1 ? "" : "s"} that failed, and why`)}
              </button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── ProblemCard ──────────────────────────────────────────────────────

function ProblemCard({
  problem,
  onUse,
  onFormalize,
  disabled,
}: {
  problem: GeneratedProblem;
  onUse: (figure?: UsedProblemFigure) => void;
  onFormalize: () => void;
  disabled?: boolean;
}) {
  const { tr } = useI18n();
  const { GRADE_LABELS, DIFFICULTY_LABELS, DOMAIN_LABELS } = getLabels(tr);
  const [showAnswer, setShowAnswer] = useState(false);
  const [showHints, setShowHints] = useState(false);
  const [figure, setFigure] = useState<SolvedFigure | undefined>(undefined);
  const bank = problem.bank;
  const [showChecks, setShowChecks] = useState(false);
  const [adopt, setAdopt] = useState<{ state: "idle" | "busy" | "done" | "error"; message?: string }>({ state: "idle" });

  async function addToBank() {
    if (!bank) return;
    setAdopt({ state: "busy" });
    try {
      const res = await fetch(`/api/banks/${encodeURIComponent(bank.bank_id)}/generations/${encodeURIComponent(bank.generation_id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidate_ids: [bank.candidate_id], category_id: bank.topic_category_id }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setAdopt({ state: "done" });
    } catch (e) {
      setAdopt({ state: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }
  const use = () =>
    onUse(
      bank?.figure
        ? { fallbackSvg: bank.figure.svg, description: bank.figure.description }
        : figure || problem.diagram_svg
          ? { figure, fallbackSvg: problem.diagram_svg }
          : undefined,
    );
  const status = bank ? cardStatus(bank) : undefined;
  const issues = bank ? checkIssues(bank) : [];
  const checkNames: Record<CheckKey, string> = {
    format: tr("格式", "Format"),
    answer: tr("答案", "Answer"),
    novelty: tr("查重", "Duplicate"),
    fit: tr("贴合模板", "Fit"),
    figure: tr("图形", "Figure"),
  };

  return (
    <Card className="border-border/60 hover:border-border transition-colors duration-200">
      <CardContent className="p-4 space-y-3">
        {/* Header */}
        {bank ? (
          <div className="flex flex-wrap items-center gap-2">
            {status === "ok" ? (
              <Badge variant="success" className="gap-1" data-testid="card-status">
                <CircleCheck className="h-3 w-3" />
                {tr("可用", "Ready to use")}
              </Badge>
            ) : status === "review" ? (
              <Badge variant="warning" className="gap-1" data-testid="card-status">
                <AlertTriangle className="h-3 w-3" />
                {tr("需人工看", "Needs a look")}
              </Badge>
            ) : (
              <Badge variant="destructive" className="gap-1" data-testid="card-status">
                <CircleX className="h-3 w-3" />
                {tr("未通过", "Failed")}
              </Badge>
            )}
            {bank.grade && <Badge variant="info">{bank.grade}</Badge>}
            {bank.difficulty ? (
              <span className="text-xs text-warning" title={tr(`难度 ${bank.difficulty}/5`, `Difficulty ${bank.difficulty}/5`)}>
                {"★".repeat(bank.difficulty)}
                <span className="opacity-30">{"★".repeat(5 - bank.difficulty)}</span>
              </span>
            ) : null}
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Library className="h-3 w-3" />
              {bank.template_label}
            </span>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Badge variant="info">
                {GRADE_LABELS[problem.grade_level]} · {DIFFICULTY_LABELS[problem.difficulty]}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {DOMAIN_LABELS[problem.domain]}
              </span>
            </div>
          </div>
        )}

        {/* Why it failed / what to look at: shown without opening the details */}
        {issues.length > 0 && (
          <ul className="space-y-1" data-testid="card-issues">
            {issues.map((i) => (
              <li
                key={`${i.kind}-${i.key}`}
                className={cn(
                  "flex items-start gap-1.5 rounded-md border px-2 py-1 text-xs leading-relaxed",
                  i.kind === "failed" ? "border-destructive/30 bg-destructive/5 text-destructive" : "border-warning/30 bg-warning/5 text-warning",
                )}
              >
                {i.kind === "failed" ? <CircleX className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                <span>
                  <span className="font-semibold">{checkNames[i.key]}</span>
                  {tr("：", ": ")}
                  <span className="text-foreground/80">{i.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        )}

        {/* Statement (bank problems: stem, then one option per line) */}
        <div className="text-sm leading-relaxed text-card-foreground">
          {bank?.options?.length ? (
            <>
              <MathText text={problem.statement.split("\n").slice(0, -bank.options.length).join("\n")} />
              <ol className="mt-1.5 space-y-0.5">
                {bank.options.map((o, i) => (
                  <li key={i} className="flex gap-1.5">
                    <span className="font-semibold">{String.fromCharCode(65 + i)}.</span>
                    <MathText text={o} />
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <MathText text={problem.statement} />
          )}
        </div>

        {/* Diagram */}
        {/* Computed + checked figure; the model's own SVG is only a fallback. */}
        {bank?.figure ? (
          <QuestionFigure svg={bank.figure.svg} source={bank.figure.source} verified={bank.figure.verified} compact />
        ) : (
          <FigurePanel key={problem.id} problemText={problem.statement} fallbackSvg={problem.diagram_svg} onFigure={setFigure} />
        )}

        {/* Bank checks: format, independent answer, duplicate vs the bank, fit to the template */}
        {bank && (
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {(Object.keys(checkNames) as Array<keyof typeof checkNames>).filter((k) => bank.checks[k]).map((k) => {
                const c = bank.checks[k]!;
                return (
                  <span
                    key={k}
                    title={c.detail}
                    className={cn(
                      "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px]",
                      c.skipped ? "border-border/60 text-muted-foreground" : c.ok ? "border-success/40 text-success" : "border-destructive/40 text-destructive",
                    )}
                  >
                    {c.skipped ? "–" : c.ok ? "✓" : "✗"} {checkNames[k]}
                  </span>
                );
              })}
              <button type="button" className="text-[11px] text-muted-foreground underline-offset-2 hover:underline" onClick={() => setShowChecks(!showChecks)}>
                {showChecks ? tr("隐藏详情", "Hide details") : tr("检查详情", "Check details")}
              </button>
            </div>
            {showChecks && (
              <ul className="space-y-0.5 rounded-md border border-border/50 p-2 text-xs text-muted-foreground">
                {(Object.keys(checkNames) as Array<keyof typeof checkNames>).filter((k) => bank.checks[k]).map((k) => (
                  <li key={k}>
                    <span className="font-medium text-foreground/80">{checkNames[k]}</span>: {bank.checks[k]!.detail}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Meta */}
        {!bank && (
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Lightbulb className="h-3 w-3" />
            {problem.source_inspiration}
          </span>
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {problem.estimated_solve_time}
          </span>
        </div>
        )}

        {/* Techniques */}
        {problem.suggested_techniques.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {problem.suggested_techniques.map((tech, i) => (
              <Badge key={i} variant="outline" className="text-[10px]">
                {tech}
              </Badge>
            ))}
          </div>
        )}

        {/* Actions: one main action (bank questions: add to the bank; otherwise: use it), the rest smaller */}
        <div className="flex flex-wrap items-center gap-2 pt-1" data-testid="card-actions">
          {bank && (
            <Button
              size="sm"
              onClick={() => void addToBank()}
              disabled={adopt.state === "done"}
              loading={adopt.state === "busy"}
              variant={adopt.state === "done" ? "outline" : "default"}
              className="gap-1.5"
              title={bank.passed ? undefined : tr("这道题未通过全部检查，加入后会标记为“未核对”", "This question did not pass all checks; it will be marked unchecked")}
            >
              {adopt.state === "done" ? <CircleCheck className="h-3.5 w-3.5" /> : <BookPlus className="h-3.5 w-3.5" />}
              {adopt.state === "done" ? tr("已加入题库", "Added to bank") : tr("加入题库", "Add to bank")}
            </Button>
          )}
          <Button size="sm" variant={bank ? "outline" : "default"} onClick={use} disabled={disabled} className="gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {tr("使用此题", "Use this problem")}
          </Button>
          <div className="ml-auto flex items-center gap-0.5">
            {problem.hints.length > 0 && (
              <IconToggle on={showHints} onClick={() => setShowHints(!showHints)} label={showHints ? tr("隐藏提示", "Hide hints") : tr("查看提示", "Show hints")}>
                <Lightbulb className="h-4 w-4" />
              </IconToggle>
            )}
            <IconToggle on={showAnswer} onClick={() => setShowAnswer(!showAnswer)} label={showAnswer ? tr("隐藏答案", "Hide answer") : tr("查看答案", "Show answer")}>
              {showAnswer ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </IconToggle>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" className="h-8 w-8 p-0" aria-label={tr("更多操作", "More actions")} title={tr("更多操作", "More actions")}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={onFormalize} disabled={disabled} className="gap-2">
                  <FileCode className="h-3.5 w-3.5" />
                  {tr("形式化（Lean 证明）", "Formalize (Lean proof)")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {adopt.state === "error" && <p className="text-xs text-destructive">{adopt.message}</p>}

        {/* Hints */}
        {showHints && (
          <div className="rounded-lg bg-primary/5 border border-primary/10 p-3 text-sm animate-slide-down">
            <p className="text-xs font-semibold text-primary mb-2">{tr("提示", "Hints")}</p>
            <ol className="list-inside list-decimal space-y-1 text-sm text-card-foreground">
              {problem.hints.map((hint, i) => (
                <li key={i}>
                  <MathText text={hint} />
                </li>
              ))}
            </ol>
          </div>
        )}

        {/* Answer */}
        {showAnswer && (
          <div className="rounded-lg bg-success/5 border border-success/20 p-3 text-sm animate-slide-down">
            <p className="text-xs font-semibold text-success mb-2 flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3" />
              {tr("答案", "Answer")}
            </p>
            <MathText text={problem.answer} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Generation progress and result summary ───────────────────────────

const STAGES = ["writing", "repairing", "rewording", "checking_figures", "solving"] as const;

function GenerationProgressView({
  mode,
  progress,
  steps,
  elapsed,
  requested,
}: {
  mode: "bank" | "builtin";
  progress: ProgressLine | null;
  steps: string[];
  elapsed: number;
  requested: number;
}) {
  const { tr } = useI18n();
  const stageNames: Record<(typeof STAGES)[number], string> = {
    writing: tr("写题", "Write"),
    repairing: tr("修图", "Fix figures"),
    rewording: tr("查重", "Duplicates"),
    checking_figures: tr("看图", "Check figures"),
    solving: tr("解题评审", "Solve & review"),
  };
  const time = elapsed >= 60 ? tr(`${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`, `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`) : tr(`${elapsed} 秒`, `${elapsed}s`);
  const current = progress && (STAGES as readonly string[]).includes(progress.stage) ? STAGES.indexOf(progress.stage as (typeof STAGES)[number]) : progress?.stage === "round_done" ? STAGES.length : -1;
  return (
    <div className="space-y-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2.5 animate-fade-in" data-testid="generation-progress" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="flex items-center gap-2 text-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          {progress?.detail ?? (mode === "bank" ? tr("正在准备…", "Getting ready…") : tr(`正在生成 ${requested} 道题…`, `Generating ${requested} problem${requested === 1 ? "" : "s"}…`))}
        </span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {progress?.round ? tr(`第 ${progress.round} / ${progress.rounds} 轮 · `, `Round ${progress.round} of ${progress.rounds} · `) : ""}
          {tr(`已用 ${time}`, `${time} elapsed`)}
        </span>
      </div>
      {mode === "bank" && progress?.round ? (
        <ol className="flex flex-wrap items-center gap-1 text-[11px]">
          {STAGES.map((st, i) => (
            <li
              key={st}
              className={cn(
                "rounded px-1.5 py-0.5",
                i < current ? "bg-success/10 text-success" : i === current ? "bg-primary/15 font-semibold text-primary" : "text-muted-foreground/70",
              )}
            >
              {i < current ? "✓ " : ""}
              {stageNames[st]}
            </li>
          ))}
        </ol>
      ) : null}
      {steps.length > 1 && (
        <details className="text-[11px] text-muted-foreground">
          <summary className="cursor-pointer select-none">{tr(`已完成 ${steps.length - 1} 步`, `${steps.length - 1} step${steps.length === 2 ? "" : "s"} done`)}</summary>
          <ol className="mt-1 list-inside list-decimal space-y-0.5">
            {steps.slice(0, -1).map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ol>
        </details>
      )}
      <p className="text-[11px] text-muted-foreground">
        {mode === "bank"
          ? tr("每道题都会经过独立解题、查重和图形检查，通常需要 1–5 分钟。", "Every question is solved independently and checked for duplicates and figures; this usually takes 1–5 minutes.")
          : tr("通常需要 30 秒到 2 分钟。", "This usually takes 30 seconds to 2 minutes.")}
      </p>
    </div>
  );
}

function ResultSummary({
  bank,
  requested,
  total,
  passed,
  failed,
  showFailed,
  onToggleFailed,
}: {
  bank: boolean;
  requested: number;
  total: number;
  passed: number;
  failed: number;
  showFailed: boolean;
  onToggleFailed?: () => void;
}) {
  const { tr } = useI18n();
  if (!bank) {
    const short = requested > 0 && total < requested;
    return (
      <p className={cn("text-xs", short ? "text-warning" : "text-muted-foreground")} data-testid="result-summary">
        <span className="font-bold uppercase tracking-wider">{tr("生成结果", "Results")}</span>{" "}
        {short ? tr(`要求 ${requested} 道，只生成了 ${total} 道`, `${requested} requested, only ${total} generated`) : `(${total})`}
      </p>
    );
  }
  const usable = Math.min(passed, requested || passed);
  const short = usable < requested;
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-3 py-2 text-sm",
        passed === 0 ? "border-destructive/30 bg-destructive/5" : short ? "border-warning/30 bg-warning/5" : "border-success/30 bg-success/5",
      )}
      data-testid="result-summary"
    >
      {passed === 0 ? <CircleX className="h-4 w-4 text-destructive" /> : short ? <AlertTriangle className="h-4 w-4 text-warning" /> : <CircleCheck className="h-4 w-4 text-success" />}
      <span className="font-medium text-foreground">
        {tr(`要求 ${requested} 道，通过 ${usable} 道`, `${requested} requested, ${usable} passed`)}
      </span>
      {failed > 0 && (
        <span className="text-muted-foreground">
          {tr(`另有 ${failed} 道未通过`, `${failed} more failed`)}
          {onToggleFailed && (
            <>
              {" "}
              <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={onToggleFailed}>
                {showFailed ? tr("（收起）", "(hide)") : tr("（查看）", "(show)")}
              </button>
            </>
          )}
        </span>
      )}
      {passed === 0 && (
        <span className="w-full text-xs text-muted-foreground">
          {tr("下面每道题都写了没通过的原因；可以换个主题或难度再生成。", "Each question below says why it failed; try another topic or difficulty and generate again.")}
        </span>
      )}
    </div>
  );
}

/** Small icon button that shows/hides something (hints, answer); the label is its tooltip. */
function IconToggle({ on, onClick, label, children }: { on: boolean; onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={onClick}
      aria-label={label}
      aria-pressed={on}
      title={label}
      className={cn("h-8 w-8 p-0", on && "bg-primary/10 text-primary")}
    >
      {children}
    </Button>
  );
}
