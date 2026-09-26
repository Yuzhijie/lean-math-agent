import { cn } from "@/lib/utils";
import { FileCode } from "lucide-react";
import { useI18n } from "@/lib/i18n";

type Props = {
  leanSource: string;
  selectedStepCode?: string;
  view: "full" | "step";
  onViewChange: (view: "full" | "step") => void;
};

export function LeanPane({
  leanSource,
  selectedStepCode,
  view,
  onViewChange,
}: Props) {
  const { tr } = useI18n();
  const text =
    view === "step"
      ? selectedStepCode?.trim()
        ? selectedStepCode
        : tr("// 本步尚无 Lean 代码", "// No Lean code for this step yet")
      : leanSource.trim()
        ? leanSource
        : "";

  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/10">
        <h2 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
          <FileCode className="h-3.5 w-3.5" />
          Lean
        </h2>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => onViewChange("full")}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-all duration-200",
              view === "full"
                ? "bg-primary/15 text-primary shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
            )}
          >
            {tr("全文", "Full")}
          </button>
          <button
            type="button"
            onClick={() => onViewChange("step")}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-all duration-200",
              view === "step"
                ? "bg-primary/15 text-primary shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
            )}
          >
            {tr("本步", "Step")}
          </button>
        </div>
      </div>

      {text ? (
        <pre className="lean-code-block m-3 max-h-[450px] text-xs animate-fade-in">
          {text}
        </pre>
      ) : (
        <div className="flex flex-col items-center justify-center p-8 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted/40 mb-3">
            <FileCode className="h-5 w-5 text-muted-foreground" />
          </div>
          <p className="text-sm text-muted-foreground">
            {tr("证明步骤后，组装的 Lean 源码将显示在此。", "The assembled Lean source will appear here once steps are proved.")}
          </p>
        </div>
      )}
    </div>
  );
}
