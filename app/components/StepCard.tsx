"use client";

import { useState } from "react";
import type { NLStep } from "@/lib/types";
import { MathText } from "./MathText";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { ChevronDown, ChevronRight, ImageIcon, Sparkles } from "lucide-react";

type Props = {
  step: NLStep;
  index: number;
  defaultOpen?: boolean;
  /** The figure changes at this step: show it there. */
  onShowOnFigure?: () => void;
  /** This step is the one shown on the figure (same highlight colour). */
  active?: boolean;
};

export function StepCard({ step, index, defaultOpen = true, onShowOnFigure, active }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const { tr } = useI18n();

  return (
    <div
      className={cn(
        "relative rounded-lg border transition-colors duration-200",
        active
          ? "border-warning/70 bg-warning/5"
          : open
            ? "border-border bg-card"
            : "border-border/50 bg-muted/10 hover:border-border",
      )}
      data-active={active ? "true" : undefined}
    >
      {onShowOnFigure && (
        <button
          type="button"
          onClick={onShowOnFigure}
          className={cn(
            "absolute right-10 top-2.5 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors",
            active ? "bg-warning/15 text-warning" : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
          )}
          title={tr("在图上看这一步", "Show this step on the figure")}
          aria-label={tr("在图上看这一步", "Show this step on the figure")}
          aria-pressed={active}
        >
          <ImageIcon className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">{tr("看图", "Figure")}</span>
        </button>
      )}
      {/* Header — always visible, click to toggle */}
      <button
        type="button"
        className={cn("w-full flex items-center gap-3 px-4 py-3 text-left", onShowOnFigure && "pr-20")}
        onClick={() => setOpen(!open)}
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-xs font-bold text-primary flex-shrink-0">
          {index + 1}
        </span>
        <h3 className="text-sm font-semibold text-card-foreground flex-1 min-w-0">
          {step.title}
        </h3>
        {open ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0 transition-transform" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0 transition-transform" />
        )}
      </button>

      {/* Body — collapsible */}
      <div
        className={cn(
          "overflow-hidden transition-all duration-300 ease-in-out",
          open ? "max-h-[2000px] opacity-100" : "max-h-0 opacity-0",
        )}
      >
        <div className="px-4 pb-4 pl-14 space-y-3">
          {/* Main content */}
          <div className="text-sm leading-relaxed text-card-foreground">
            <MathText text={step.content} />
          </div>

          {/* Key formula highlight */}
          {step.key_formula && (
            <div className="flex items-start gap-2 rounded-md bg-primary/5 border border-primary/10 px-3 py-2">
              <Sparkles className="h-3.5 w-3.5 text-primary mt-0.5 flex-shrink-0" />
              <MathText text={step.key_formula} className="text-sm" />
            </div>
          )}

          {/* Sub-steps */}
          {step.substeps && step.substeps.length > 0 && (
            <div className="space-y-1.5 pl-2 border-l-2 border-border/40">
              {step.substeps.map((sub, i) => (
                <div key={i} className="text-sm text-muted-foreground leading-relaxed">
                  <span className="text-primary/60 font-medium mr-1.5">{i + 1}.</span>
                  <MathText text={sub} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
