"use client";

import { useMemo } from "react";
import type { MethodOption, MethodScore } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Star, Table2, Minimize2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { MathText } from "./MathText";
import { useI18n } from "@/lib/i18n";

type Props = {
  methods: MethodOption[];
  scores: MethodScore[];
  recommendedId?: string | null;
};

interface Dimension {
  key: keyof MethodScore;
  label: string;
  higherBetter: boolean;
}

function getDimensions(tr: (zh: string, en: string) => string): Dimension[] {
  return [
    { key: "feasibility", label: tr("可行性", "Feasibility"), higherBetter: true },
    { key: "elegance", label: tr("优雅度", "Elegance"), higherBetter: true },
    { key: "lean_difficulty", label: tr("Lean 难度", "Lean difficulty"), higherBetter: false },
    { key: "mathlib_coverage", label: tr("Mathlib 覆盖", "Mathlib coverage"), higherBetter: true },
    { key: "pedagogical_value", label: tr("教学价值", "Teaching value"), higherBetter: true },
    { key: "composite", label: tr("综合评分", "Overall score"), higherBetter: true },
  ];
}

// Dimension keys/directions (labels are locale-independent here).
const DIMENSIONS = getDimensions((zh) => zh);

export function MethodComparison({ methods, scores, recommendedId }: Props) {
  const { tr } = useI18n();
  const [compact, setCompact] = useState(false);

  const scoreMap = useMemo(() => {
    const map = new Map<string, MethodScore>();
    for (const s of scores) {
      map.set(s.method_id, s);
    }
    return map;
  }, [scores]);

  // For each dimension, find the best value
  const bestInDimension = useMemo(() => {
    const best = new Map<string, string>();
    for (const dim of DIMENSIONS) {
      let bestId = "";
      let bestVal = dim.higherBetter ? -1 : 2;
      for (const s of scores) {
        const v = s[dim.key] as number;
        if (dim.higherBetter ? v > bestVal : v < bestVal) {
          bestVal = v;
          bestId = s.method_id;
        }
      }
      best.set(dim.key, bestId);
    }
    return best;
  }, [scores]);

  // Rank methods by composite score
  const ranked = useMemo(() => {
    return [...scores].sort((a, b) => b.composite - a.composite);
  }, [scores]);

  if (scores.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          {tr(
            "暂无评分数据。运行评估后可查看方法对比。",
            "No score data yet. Run an evaluation to compare methods.",
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            {tr("方法对比", "Method comparison")}
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setCompact(!compact)}
          >
            {compact ? (
              <Table2 className="h-3.5 w-3.5 mr-1" />
            ) : (
              <Minimize2 className="h-3.5 w-3.5 mr-1" />
            )}
            {compact ? tr("详细", "Detailed") : tr("简洁", "Compact")}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {compact ? (
          // Compact summary view
          <div className="space-y-3">
            {ranked.map((s, i) => {
              const method = methods.find((m) => m.id === s.method_id);
              const isRecommended = s.method_id === recommendedId;
              return (
                <div
                  key={s.method_id}
                  className="flex items-center gap-3 p-2 rounded-md bg-muted/20"
                >
                  <span className="text-xs font-bold text-muted-foreground w-5">
                    #{i + 1}
                  </span>
                  {isRecommended && (
                    <Star className="h-3.5 w-3.5 text-warning fill-warning flex-shrink-0" />
                  )}
                  <span className="text-sm flex-1 min-w-0 truncate">
                    <MathText text={method?.title ?? s.method_id} />
                  </span>
                  <span className="text-xs font-mono text-primary font-semibold">
                    {Math.round(s.composite * 100)}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          // Full comparison table
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th className="text-left py-2 pr-3 text-muted-foreground font-medium">
                    {tr("维度", "Dimension")}
                  </th>
                  {ranked.map((s) => {
                    const method = methods.find((m) => m.id === s.method_id);
                    const isRecommended = s.method_id === recommendedId;
                    return (
                      <th
                        key={s.method_id}
                        className="text-center py-2 px-2 font-medium min-w-[80px]"
                      >
                        <div className="flex flex-col items-center gap-1">
                          {isRecommended && (
                            <Star className="h-3 w-3 text-warning fill-warning" />
                          )}
                          <span className="text-card-foreground truncate max-w-[100px]">
                            {method?.title ?? s.method_id}
                          </span>
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {getDimensions(tr).map((dim) => (
                  <tr key={dim.key} className="border-t border-border/50">
                    <td className="py-2 pr-3 text-muted-foreground">
                      {dim.label}
                    </td>
                    {ranked.map((s) => {
                      const val = s[dim.key] as number;
                      const displayVal =
                        dim.key === "lean_difficulty" ? 1 - val : val;
                      const isBest = bestInDimension.get(dim.key) === s.method_id;
                      return (
                        <td key={s.method_id} className="text-center py-2 px-2">
                          <div className="flex flex-col items-center gap-1">
                            <div className="w-12 h-1.5 rounded-full bg-muted/40 overflow-hidden">
                              <div
                                className={cn(
                                  "h-full rounded-full",
                                  isBest
                                    ? "bg-primary"
                                    : "bg-muted-foreground/40",
                                )}
                                style={{
                                  width: `${Math.round(displayVal * 100)}%`,
                                }}
                              />
                            </div>
                            <span
                              className={cn(
                                "font-mono",
                                isBest
                                  ? "text-primary font-bold"
                                  : "text-muted-foreground",
                              )}
                            >
                              {Math.round(val * 100)}
                            </span>
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
