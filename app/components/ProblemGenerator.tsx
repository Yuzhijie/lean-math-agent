"use client";

import { useState } from "react";
import type {
  GradeLevel,
  DifficultyLevel,
  CompetitionDomain,
  GeneratedProblem,
} from "@/lib/types";
import { GRADE_LEVELS, DIFFICULTY_LEVELS, COMPETITION_DOMAINS } from "@/lib/types";
import { MathText } from "./MathText";
import { FigurePanel } from "./FigurePanel";
import type { SolvedFigure } from "@/lib/figure/spec";
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
} from "lucide-react";

/** What a generated problem carries over when it is used: its computed figure, or the model's SVG. */
export interface UsedProblemFigure {
  figure?: SolvedFigure;
  fallbackSvg?: string;
}

type Props = {
  onUseProblem: (problemText: string, figure?: UsedProblemFigure) => void;
  onFormalize: (problemText: string) => void;
  disabled?: boolean;
};

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

export function ProblemGenerator({ onUseProblem, onFormalize, disabled }: Props) {
  const { tr } = useI18n();
  const { GRADE_LABELS, DIFFICULTY_LABELS, DOMAIN_LABELS } = getLabels(tr);
  const [gradeLevel, setGradeLevel] = useState<GradeLevel>("high");
  const [difficulty, setDifficulty] = useState<DifficultyLevel>("competition");
  const [domain, setDomain] = useState<CompetitionDomain>("competition_number_theory");
  const [count, setCount] = useState(1);
  const [problems, setProblems] = useState<GeneratedProblem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setError(null);
    setBusy(true);
    setProblems([]);
    try {
      // Client-side timeout: generous enough for server maxDuration (330s)
      // plus network overhead. The server's deadline-aware retry loop will
      // return a proper error well before this fires in most cases.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 350_000);

      const res = await fetch("/api/generate-problem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grade_level: gradeLevel,
          difficulty,
          domain,
          count,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const data = (await res.json()) as {
        problems?: GeneratedProblem[];
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? tr("生成失败", "Generation failed"));
      }
      setProblems(data.problems ?? []);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        setError(tr("生成超时，请减少题目数量（建议1-2题）或选择标准难度后重试", "Generation timed out. Reduce the number of problems (1–2 recommended) or choose Standard difficulty, then try again."));
      } else {
        setError(e instanceof Error ? e.message : tr("生成失败", "Generation failed"));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="animate-slide-down">
      <CardContent className="p-5 space-y-5">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">{tr("题目生成器", "Problem generator")}</h2>
        </div>

        {/* Controls */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3">
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

          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              <Hash className="h-3 w-3" />
              {tr("数量", "Count")}
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
              disabled={busy || disabled}
              loading={busy}
              className="w-full gap-1.5"
            >
              <Sparkles className="h-3.5 w-3.5" />
              {tr("生成", "Generate")}
            </Button>
          </div>
        </div>

        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive animate-fade-in">
            {error}
          </div>
        )}

        {/* Problem cards */}
        {problems.length > 0 && (
          <div className="space-y-3 animate-slide-up">
            <Separator />
            <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              {tr("生成结果", "Results")} ({problems.length})
            </p>
            {problems.map((problem) => (
              <ProblemCard
                key={problem.id}
                problem={problem}
                onUse={(figure) => onUseProblem(problem.statement, figure)}
                onFormalize={() => onFormalize(problem.statement)}
                disabled={disabled}
              />
            ))}
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

  return (
    <Card className="border-border/60 hover:border-border transition-colors duration-200">
      <CardContent className="p-4 space-y-3">
        {/* Header */}
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

        {/* Statement */}
        <div className="text-sm leading-relaxed text-card-foreground">
          <MathText text={problem.statement} />
        </div>

        {/* Diagram */}
        {/* Computed + checked figure; the model's own SVG is only a fallback. */}
        <FigurePanel key={problem.id} problemText={problem.statement} fallbackSvg={problem.diagram_svg} onFigure={setFigure} />

        {/* Meta */}
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

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            size="sm"
            onClick={() => onUse(figure || problem.diagram_svg ? { figure, fallbackSvg: problem.diagram_svg } : undefined)}
            disabled={disabled}
            className="gap-1.5"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            {tr("使用此题", "Use this problem")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowHints(!showHints)}
            className="gap-1.5"
          >
            {showHints ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            {showHints ? tr("隐藏提示", "Hide hints") : tr("查看提示", "Show hints")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowAnswer(!showAnswer)}
            className="gap-1.5"
          >
            {showAnswer ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            {showAnswer ? tr("隐藏答案", "Hide answer") : tr("查看答案", "Show answer")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onFormalize}
            disabled={disabled}
            className="gap-1.5"
          >
            <FileCode className="h-3.5 w-3.5" />
            {tr("形式化", "Formalize")}
          </Button>
        </div>

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
