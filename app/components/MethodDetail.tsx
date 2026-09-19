import type { MethodOption, MethodScore } from "@/lib/types";
import { MathText } from "./MathText";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Lightbulb, ThumbsUp, ThumbsDown, Code } from "lucide-react";

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
  const dimensions: DimensionBar[] = [
    { label: "可行性", value: score.feasibility, color: "bg-blue-500" },
    { label: "优雅度", value: score.elegance, color: "bg-purple-500" },
    { label: "Lean 难度", value: score.lean_difficulty, color: "bg-orange-500", invert: true },
    { label: "Mathlib 覆盖", value: score.mathlib_coverage, color: "bg-green-500" },
    { label: "教学价值", value: score.pedagogical_value, color: "bg-teal-500" },
  ];

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
          评分
        </span>
        <span className="text-xs font-semibold text-primary">
          综合 {Math.round(score.composite * 100)}
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
  if (!method) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">灵感与权衡</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            选择一种解法以查看灵感、优缺点与草图。
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
