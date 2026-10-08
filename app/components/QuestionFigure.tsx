"use client";

import { useMemo } from "react";
import DOMPurify from "dompurify";
import { Cpu, Sparkles } from "lucide-react";
import { useI18n } from "@/lib/i18n";

/**
 * The figure of a generated question (lib/figure/visual.ts): drawn by the
 * program from the question's data, or — when no kind fitted — the
 * model's own SVG. Shown on paper as it would be printed, with a note on
 * how it was made. The SVG is sanitised again here (DOMPurify SVG profile).
 */
export function QuestionFigure({ svg, source, verified }: { svg: string; source?: "program" | "model"; verified?: boolean }) {
  const { tr } = useI18n();
  const clean = useMemo(() => {
    if (typeof window === "undefined" || !DOMPurify.isSupported) return "";
    return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ["foreignObject", "script", "style"] });
  }, [svg]);
  if (!clean) return null;
  return (
    <figure className="space-y-1" data-testid="question-figure">
      <div
        className="overflow-x-auto rounded-md border border-border/60 bg-white p-2 [&_svg]:mx-auto [&_svg]:block [&_svg]:h-auto [&_svg]:max-h-[75vh] [&_svg]:max-w-full"
        dangerouslySetInnerHTML={{ __html: clean }}
      />
      {source && (
        <figcaption className="flex items-center gap-1 text-[11px] text-muted-foreground">
          {source === "program" ? <Cpu className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
          {source === "program"
            ? tr("程序按题目数据绘制", "Drawn by the program from the question's data")
            : verified
              ? tr("模型绘制，已经视觉模型核对", "Drawn by the model, checked by the vision model")
              : tr("模型绘制，未经校验，请核对", "Drawn by the model, not checked — please review")}
        </figcaption>
      )}
    </figure>
  );
}
