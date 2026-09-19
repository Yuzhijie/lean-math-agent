import type { ProofStep } from "@/lib/types";
import { MathText } from "./MathText";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { CheckCircle2, XCircle, Clock, AlertTriangle } from "lucide-react";

type Props = {
  steps: ProofStep[];
  selectedIndex?: number;
  onSelect: (index: number) => void;
};

const statusConfig: Record<
  ProofStep["status"],
  { label: string; variant: "success" | "destructive" | "secondary" | "warning"; icon: typeof CheckCircle2 }
> = {
  ok: { label: "完成", variant: "success", icon: CheckCircle2 },
  fail: { label: "失败", variant: "destructive", icon: XCircle },
  pending: { label: "待处理", variant: "secondary", icon: Clock },
  sorry: { label: "sorry", variant: "warning", icon: AlertTriangle },
};

export function StepPane({ steps, selectedIndex, onSelect }: Props) {
  if (steps.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted/40 mb-3">
          <Clock className="h-5 w-5 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium text-muted-foreground">证明步骤</p>
        <p className="mt-1 text-xs text-muted-foreground/70">
          选择解法并规划后，步骤将显示在此。
        </p>
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <div className="px-4 py-3 border-b border-border bg-muted/10">
        <h2 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
          证明步骤
          <span className="ml-2 text-primary">{steps.length}</span>
        </h2>
      </div>
      <ScrollArea className="max-h-[500px]">
        <div className="divide-y divide-border">
          {steps.map((step) => {
            const selected = step.index === selectedIndex;
            const config = statusConfig[step.status];
            const StatusIcon = config.icon;

            return (
              <button
                key={step.index}
                type="button"
                className={cn(
                  "w-full text-left px-4 py-3 transition-all duration-200 group",
                  "hover:bg-accent/5",
                  selected && "bg-primary/8",
                  !selected && "border-l-2 border-l-transparent",
                  selected && "border-l-2 border-l-primary"
                )}
                onClick={() => onSelect(step.index)}
              >
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <span className="font-mono text-xs text-muted-foreground">
                    #{step.index}
                  </span>
                  <Badge variant={config.variant} className="gap-1 text-[10px]">
                    <StatusIcon className="h-3 w-3" />
                    {config.label}
                  </Badge>
                </div>
                <p className="text-sm leading-relaxed text-card-foreground">
                  <MathText text={step.plain_goal} />
                </p>
                {step.plain_explanation && (
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                    <MathText text={step.plain_explanation} />
                  </p>
                )}
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
