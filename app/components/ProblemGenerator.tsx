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
import { DiagramSvg } from "./DiagramSvg";
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

type Props = {
  onUseProblem: (problemText: string) => void;
  onFormalize: (problemText: string) => void;
  disabled?: boolean;
};

const GRADE_LABELS: Record<GradeLevel, string> = {
  elementary: "小学",
  middle: "初中",
  high: "高中",
  university: "大学",
};

const DIFFICULTY_LABELS: Record<DifficultyLevel, string> = {
  standard: "标准",
  advanced: "提高",
  competition: "竞赛",
};

const DOMAIN_LABELS: Record<CompetitionDomain, string> = {
  competition_elementary: "竞赛初等",
  competition_inequality: "竞赛不等式",
  competition_number_theory: "竞赛数论",
  competition_combinatorics: "竞赛组合",
  competition_set_theory: "竞赛集合",
  number_theory: "数论",
  combinatorics: "组合",
  set_theory: "集合",
  algebra: "代数",
  geometry: "几何",
  inequality: "不等式",
  logic: "逻辑",
  computation: "计算",
};

export function ProblemGenerator({ onUseProblem, onFormalize, disabled }: Props) {
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
        throw new Error(data.error ?? "生成失败");
      }
      setProblems(data.problems ?? []);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        setError("生成超时，请减少题目数量（建议1-2题）或选择标准难度后重试");
      } else {
        setError(e instanceof Error ? e.message : "生成失败");
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
          <h2 className="text-sm font-semibold text-foreground">题目生成器</h2>
        </div>

        {/* Controls */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3">
          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              <GraduationCap className="h-3 w-3" />
              学段
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
              难度
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
              领域
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
              数量
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
              生成
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
              生成结果 ({problems.length})
            </p>
            {problems.map((problem) => (
              <ProblemCard
                key={problem.id}
                problem={problem}
                onUse={() => onUseProblem(problem.statement)}
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
  onUse: () => void;
  onFormalize: () => void;
  disabled?: boolean;
}) {
  const [showAnswer, setShowAnswer] = useState(false);
  const [showHints, setShowHints] = useState(false);

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
        {problem.diagram_svg && <DiagramSvg svg={problem.diagram_svg} />}

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
          <Button size="sm" onClick={onUse} disabled={disabled} className="gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5" />
            使用此题
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowHints(!showHints)}
            className="gap-1.5"
          >
            {showHints ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            {showHints ? "隐藏提示" : "查看提示"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowAnswer(!showAnswer)}
            className="gap-1.5"
          >
            {showAnswer ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            {showAnswer ? "隐藏答案" : "查看答案"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onFormalize}
            disabled={disabled}
            className="gap-1.5"
          >
            <FileCode className="h-3.5 w-3.5" />
            形式化
          </Button>
        </div>

        {/* Hints */}
        {showHints && (
          <div className="rounded-lg bg-primary/5 border border-primary/10 p-3 text-sm animate-slide-down">
            <p className="text-xs font-semibold text-primary mb-2">提示</p>
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
              答案
            </p>
            <MathText text={problem.answer} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
