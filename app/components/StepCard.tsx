"use client";

import { useState } from "react";
import type { NLStep } from "@/lib/types";
import { MathText } from "./MathText";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight, Sparkles } from "lucide-react";

type Props = {
  step: NLStep;
  index: number;
  defaultOpen?: boolean;
};

export function StepCard({ step, index, defaultOpen = true }: Props) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div
      className={cn(
        "rounded-lg border transition-colors duration-200",
        open
          ? "border-border bg-card"
          : "border-border/50 bg-muted/10 hover:border-border",
      )}
    >
      {/* Header — always visible, click to toggle */}
      <button
        type="button"
        className="w-full flex items-center gap-3 px-4 py-3 text-left"
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
