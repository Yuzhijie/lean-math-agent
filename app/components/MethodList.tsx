"use client";

import { useState, useMemo } from "react";
import type { MethodOption, MethodScore } from "@/lib/types";
import { MathText } from "./MathText";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { Star, ArrowUpDown } from "lucide-react";

type SortKey = "confidence" | "composite" | "feasibility" | "elegance";

type Props = {
  methods: MethodOption[];
  scores?: MethodScore[];
  recommendedId?: string | null;
  selectedId?: string;
  disabled?: boolean;
  onSelect: (methodId: string) => void;
};

const sortLabels: Record<SortKey, string> = {
  confidence: "置信度",
  composite: "综合",
  feasibility: "可行性",
  elegance: "优雅度",
};

export function MethodList({
  methods,
  scores,
  recommendedId,
  selectedId,
  disabled,
  onSelect,
}: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("confidence");

  const scoreMap = useMemo(() => {
    const map = new Map<string, MethodScore>();
    for (const s of scores ?? []) {
      map.set(s.method_id, s);
    }
    return map;
  }, [scores]);

  const sorted = useMemo(() => {
    const copy = [...methods];
    copy.sort((a, b) => {
      if (sortKey === "confidence") return b.confidence - a.confidence;
      const sa = scoreMap.get(a.id);
      const sb = scoreMap.get(b.id);
      if (!sa && !sb) return 0;
      if (!sa) return 1;
      if (!sb) return -1;
      if (sortKey === "composite") return sb.composite - sa.composite;
      if (sortKey === "feasibility") return sb.feasibility - sa.feasibility;
      return sb.elegance - sa.elegance;
    });
    return copy;
  }, [methods, scoreMap, sortKey]);

  if (methods.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-dashed border-border p-8">
        <p className="text-sm text-muted-foreground">枚举解法后将显示方法列表。</p>
      </div>
    );
  }

  const sortKeys: SortKey[] = ["confidence", "composite", "feasibility", "elegance"];

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-muted/20 flex items-center justify-between">
        <h2 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
          解法
        </h2>
        {scores && scores.length > 0 && (
          <div className="flex items-center gap-1">
            <ArrowUpDown className="h-3 w-3 text-muted-foreground" />
            {sortKeys.map((k) => (
              <button
                key={k}
                type="button"
                className={cn(
                  "text-[10px] px-1.5 py-0.5 rounded transition-colors",
                  sortKey === k
                    ? "bg-primary/15 text-primary font-semibold"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setSortKey(k)}
              >
                {sortLabels[k]}
              </button>
            ))}
          </div>
        )}
      </div>
      <ScrollArea className="max-h-[400px]">
        <div className="divide-y divide-border">
          {sorted.map((m) => {
            const selected = m.id === selectedId;
            const score = scoreMap.get(m.id);
            const isRecommended = m.id === recommendedId;
            return (
              <button
                key={m.id}
                type="button"
                className={cn(
                  "w-full text-left px-4 py-3 transition-all duration-200",
                  "hover:bg-accent/5",
                  selected && "bg-primary/8 border-l-2 border-l-primary",
                  !selected && "border-l-2 border-l-transparent",
                  disabled && "opacity-50 cursor-not-allowed",
                )}
                disabled={disabled}
                onClick={() => onSelect(m.id)}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-medium text-card-foreground leading-snug flex items-center gap-1.5">
                    {isRecommended && (
                      <Star className="h-3.5 w-3.5 text-warning fill-warning flex-shrink-0" />
                    )}
                    <MathText text={m.title} />
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span>{m.category}</span>
                  <span className="h-1 w-1 rounded-full bg-muted-foreground/40" />
                  <span
                    className={cn(
                      "font-medium",
                      m.confidence >= 0.7 && "text-success",
                      m.confidence >= 0.4 && m.confidence < 0.7 && "text-warning",
                      m.confidence < 0.4 && "text-destructive",
                    )}
                  >
                    {(m.confidence * 100).toFixed(0)}%
                  </span>
                  {score && (
                    <>
                      <span className="h-1 w-1 rounded-full bg-muted-foreground/40" />
                      <span className="font-medium text-primary">
                        综合 {(score.composite * 100).toFixed(0)}
                      </span>
                    </>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
