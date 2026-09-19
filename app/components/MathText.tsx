"use client";

import { Fragment, useMemo } from "react";
import katex from "katex";
import { splitMathSegments } from "@/lib/math-segments";

function renderMath(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, { throwOnError: false, displayMode });
  } catch {
    // renderToString with throwOnError:false should not throw, but fall back
    // to the raw TeX rather than crashing the whole pane if it ever does.
    return tex;
  }
}

type Props = {
  text?: string | null;
  className?: string;
};

/**
 * Renders a string that may contain math delimiters ($...$, $$...$$,
 * \(...\), \[...\]) using KaTeX; non-math text is rendered verbatim.
 */
export function MathText({ text, className }: Props) {
  const nodes = useMemo(() => {
    if (!text) return null;
    return splitMathSegments(text).map((seg, i) =>
      seg.kind === "text" ? (
        <Fragment key={i}>{seg.content}</Fragment>
      ) : (
        <span
          key={i}
          className={seg.kind === "display" ? "math-display" : "math-inline"}
          dangerouslySetInnerHTML={{
            __html: renderMath(seg.content, seg.kind === "display"),
          }}
        />
      ),
    );
  }, [text]);

  if (!text) return null;
  return <span className={className}>{nodes}</span>;
}
