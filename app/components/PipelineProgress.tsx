"use client";

import { cn } from "@/lib/utils";
import { CheckCircle2, Loader2 } from "lucide-react";

type Props = {
  events: Array<{ stage: string; detail: string }>;
  busy: string | null;
};

// ── Stage labels (Chinese) ──────────────────────────────────────────────

const stageLabels: Record<string, string> = {
  classifying: "分析问题",
  extracting: "提取结构",
  optimizing: "搜索最优解",
  nl_solving: "生成解答",
  autoformalizing: "自动形式化",
  enumerating: "枚举解法",
  evaluating: "评估解法",
  selecting: "选择解法",
  planning: "规划步骤",
  solving: "证明搜索",
  computing: "计算求解",
  lean_attempting: "Lean 形式化",
  trivial_proof: "简单证明",
  preflight: "预检",
  reviewing: "回顾",
  complete: "完成",
  failed: "失败",
};

// ── Component ─────────────────────────────────────────────────────────────

export function PipelineProgress({ events, busy }: Props) {
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
          {isComplete ? "求解完成" : isFailed ? "求解失败" : "求解中..."}
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
