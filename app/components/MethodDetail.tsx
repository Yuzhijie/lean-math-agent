"use client";

import type { MethodOption, MethodScore } from "@/lib/types";
import { MathText } from "./MathText";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Lightbulb, ThumbsUp, ThumbsDown, Code } from "lucide-react";
import { useI18n } from "@/lib/i18n";

type Props = {
  method?: MethodOption;
  score?: MethodScore;
  comparisonSummary?: string;
};

const sections = [
  { key: "inspiration" as const, label: "Inspiration", icon: Lightbulb, color: "text-primary" },
  { key: "pros" as const, label: "Pros", icon: ThumbsUp, color: "text-success" },
  { key: "cons" as const, label: "Cons", icon: ThumbsDown, color: "text-destructive" },
] as const;

interface DimensionBar {
  label: string;
  value: number;
  color: string;
  invert?: boolean;
}

function ScoreBars({ score }: { score: MethodScore }) {
  const { tr } = useI18n();
  const dimensions: DimensionBar[] = [
    { label: tr("可行性", "Feasibility"), value: score.feasibility, color: "bg-blue-500" },
    { label: tr("优雅度", "Elegance"), value: score.elegance, color: "bg-purple-500" },
    { label: tr("Lean 难度", "Lean difficulty"), value: score.lean_difficulty, color: "bg-orange-500", invert: true },
    { label: tr("Mathlib 覆盖", "Mathlib coverage"), value: score.mathlib_coverage, color: "bg-green-500" },
    { label: tr("教学价值", "Teaching value"), value: score.pedagogical_value, color: "bg-teal-500" },
  ];

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
          {tr("评分", "Scores")}
        </span>
        <span className="text-xs font-semibold text-primary">
          {tr("综合", "Overall")} {Math.round(score.composite * 100)}
        </span>
      </div>
      {dimensions.map((d) => {
        const displayValue = d.invert ? 1 - d.value : d.value;
        const pct = Math.round(displayValue * 100);
        return (
          <div key={d.label} className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground w-20 flex-shrink-0 text-right">
              {d.label}
            </span>
            <div className="flex-1 h-2 rounded-full bg-muted/40 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${d.color}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-[11px] font-mono text-muted-foreground w-8 text-right">
              {Math.round(d.value * 100)}
            </span>
          </div>
        );
      })}
      {score.rationale && (
        <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
          {score.rationale}
        </p>
      )}
    </div>
  );
}

export function MethodDetail({ method, score, comparisonSummary }: Props) {
  const { tr } = useI18n();
  if (!method) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {tr("灵感与权衡", "Inspiration & trade-offs")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {tr(
              "选择一种解法以查看灵感、优缺点与草图。",
              "Select a method to see its inspiration, pros and cons, and sketch.",
            )}
          </p>
          {comparisonSummary && (
            <>
              <Separator className="my-4" />
              <div className="text-sm text-muted-foreground">
                <MathText text={comparisonSummary} />
              </div>
            </>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="animate-fade-in">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          <MathText text={method.title} />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {sections.map(({ key, label, icon: Icon, color }) => (
          <div key={key} className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Icon className={`h-3.5 w-3.5 ${color}`} />
              <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                {label}
              </span>
            </div>
            <div className="pl-5.5 text-sm leading-relaxed text-card-foreground">
              <MathText text={method[key]} />
            </div>
          </div>
        ))}

        {/* Lean sketch */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Code className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              Lean Sketch
            </span>
          </div>
          <pre className="lean-code-block max-h-40 text-xs">
            {method.lean_sketch}
          </pre>
        </div>

        {/* Score visualization */}
        {score && (
          <>
            <Separator />
            <ScoreBars score={score} />
          </>
        )}

        {/* Comparison summary */}
        {comparisonSummary && (
          <>
            <Separator />
            <div className="rounded-md bg-muted/30 p-3 text-sm text-muted-foreground">
              <MathText text={comparisonSummary} />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
