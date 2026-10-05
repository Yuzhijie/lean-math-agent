"use client";

import { cn } from "@/lib/utils";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";

type Props = {
  events: Array<{ stage: string; detail: string }>;
  busy: string | null;
};

// ── Stage labels ──────────────────────────────────────────────────────

function getStageLabels(tr: (zh: string, en: string) => string): Record<string, string> {
  return {
    reading_figure: tr("读取题目图形", "Read the figure"),
    classifying: tr("分析问题", "Analyze problem"),
    extracting: tr("提取结构", "Extract structure"),
    optimizing: tr("搜索最优解", "Search for optimum"),
    nl_solving: tr("生成解答", "Generate solution"),
    autoformalizing: tr("自动形式化", "Autoformalize"),
    enumerating: tr("枚举解法", "Enumerate methods"),
    evaluating: tr("评估解法", "Evaluate methods"),
    selecting: tr("选择解法", "Select method"),
    planning: tr("规划步骤", "Plan steps"),
    solving: tr("证明搜索", "Proof search"),
    computing: tr("计算求解", "Compute"),
    lean_attempting: tr("Lean 形式化", "Lean formalization"),
    trivial_proof: tr("简单证明", "Trivial proof"),
    preflight: tr("预检", "Preflight"),
    reviewing: tr("回顾", "Review"),
    complete: tr("完成", "Done"),
    failed: tr("失败", "Failed"),
  };
}

// ── Component ─────────────────────────────────────────────────────────────

export function PipelineProgress({ events, busy }: Props) {
  const { tr } = useI18n();
  const stageLabels = getStageLabels(tr);
  if (events.length === 0 && !busy) return null;

  // Group events by stage, keep last detail per stage
  const stageMap = new Map<string, string>();
  for (const evt of events) {
    stageMap.set(evt.stage, evt.detail);
  }

  // Determine which stages have been seen and which is current
  const stages = Array.from(stageMap.entries());
  const lastStage = stages.length > 0 ? stages[stages.length - 1][0] : null;
  const isComplete = lastStage === "complete";
  const isFailed = lastStage === "failed";

  return (
    <div className="rounded-lg border border-primary/20 bg-card animate-fade-in">
      <div className="px-4 py-3 border-b border-border/40">
        <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">
          {isComplete ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-success" />
          ) : isFailed ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-destructive" />
          ) : (
            <Loader2 className="h-3.5 w-3.5 text-primary animate-spin" />
          )}
          {isComplete ? tr("求解完成", "Solved") : isFailed ? tr("求解失败", "Solving failed") : tr("求解中...", "Solving...")}
        </h3>
      </div>
      <div className="p-4">
        <div className="space-y-0">
          {stages.map(([stage, detail], i) => {
            const isLast = i === stages.length - 1;
            const isActive = isLast && !isComplete && !isFailed;
            const isDone = !isLast || isComplete;
            const label = stageLabels[stage] ?? stage;

            return (
              <div key={`${stage}-${i}`} className="flex gap-3">
                {/* Timeline connector */}
                <div className="flex flex-col items-center">
                  <div
                    className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
                      isDone && "bg-success/15",
                      isActive && "bg-primary/15",
                      !isDone && !isActive && "bg-muted/30",
                    )}
                  >
                    {isDone ? (
                      <CheckCircle2 className="h-3 w-3 text-success" />
                    ) : isActive ? (
                      <Loader2 className="h-3 w-3 text-primary animate-spin" />
                    ) : (
                      <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
                    )}
                  </div>
                  {i < stages.length - 1 && (
                    <div className="w-px flex-1 bg-border/60 my-1" />
                  )}
                </div>

                {/* Content */}
                <div className={cn("pb-3 min-w-0", i === stages.length - 1 && "pb-0")}>
                  <p
                    className={cn(
                      "text-xs font-medium",
                      isDone && "text-success",
                      isActive && "text-primary",
                      !isDone && !isActive && "text-muted-foreground",
                    )}
                  >
                    {label}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground truncate">
                    {detail}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
