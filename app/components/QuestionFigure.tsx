"use client";

import { useMemo, useState } from "react";
import DOMPurify from "dompurify";
import * as Dialog from "@radix-ui/react-dialog";
import { Cpu, Maximize2, Sparkles, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";

/**
 * The figure of a generated question (lib/figure/visual.ts): drawn by the
 * program from the question's data, or — when no kind fitted — the
 * model's own SVG. Shown on paper as it would be printed, with a note on
 * how it was made. The SVG is sanitised again here (DOMPurify SVG profile).
 * `compact`: a thumbnail (lists of generated questions); a click opens the full-size figure.
 */
export function QuestionFigure({ svg, source, verified, compact }: { svg: string; source?: "program" | "model"; verified?: boolean; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const { tr } = useI18n();
  const clean = useMemo(() => {
    if (typeof window === "undefined" || !DOMPurify.isSupported) return "";
    return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ["foreignObject", "script", "style"] });
  }, [svg]);
  if (!clean) return null;
  return (
    <figure className="space-y-1" data-testid="question-figure">
      {compact ? (
        <Dialog.Root open={open} onOpenChange={setOpen}>
          <Dialog.Trigger asChild>
            <button
              type="button"
              className="group relative block w-full cursor-zoom-in rounded-md border border-border/60 bg-white p-2 text-left"
              aria-label={tr("查看大图", "Open full size")}
              title={tr("查看大图", "Open full size")}
              data-testid="figure-thumbnail"
            >
              <span
                className="block [&_svg]:mx-auto [&_svg]:block [&_svg]:h-auto [&_svg]:max-h-56 [&_svg]:max-w-full"
                dangerouslySetInnerHTML={{ __html: clean }}
              />
              <span className="absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white opacity-70 transition-opacity group-hover:opacity-100">
                <Maximize2 className="h-3 w-3" />
                {tr("放大", "Enlarge")}
              </span>
            </button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 animate-fade-in" />
            <Dialog.Content
              className="fixed left-1/2 top-1/2 z-50 max-h-[92vh] w-[min(96vw,1100px)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg bg-white p-4 shadow-2xl focus:outline-none"
              data-testid="figure-full"
            >
              <Dialog.Title className="sr-only">{tr("题目图形", "Question figure")}</Dialog.Title>
              <Dialog.Close
                className="absolute right-2 top-2 rounded-md p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
                aria-label={tr("关闭", "Close")}
              >
                <X className="h-4 w-4" />
              </Dialog.Close>
              <div
                className="[&_svg]:mx-auto [&_svg]:block [&_svg]:h-auto [&_svg]:max-h-[85vh] [&_svg]:w-full [&_svg]:max-w-full"
                dangerouslySetInnerHTML={{ __html: clean }}
              />
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      ) : (
        <div
          className="overflow-x-auto rounded-md border border-border/60 bg-white p-2 [&_svg]:mx-auto [&_svg]:block [&_svg]:h-auto [&_svg]:max-h-[75vh] [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: clean }}
        />
      )}
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
