"use client";

import { Fragment, useMemo } from "react";
import katex from "katex";
import { splitMathSegments } from "@/lib/math-segments";
import { splitTables } from "@/lib/markdown-table";

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

function mathNodes(text: string, keyPrefix = ""): React.ReactNode[] {
  return splitMathSegments(text).map((seg, i) =>
    seg.kind === "text" ? (
      <Fragment key={keyPrefix + i}>{seg.content}</Fragment>
    ) : (
      <span
        key={keyPrefix + i}
        className={seg.kind === "display" ? "math-display" : "math-inline"}
        dangerouslySetInnerHTML={{
          __html: renderMath(seg.content, seg.kind === "display"),
        }}
      />
    ),
  );
}

/**
 * Renders a string that may contain math delimiters ($...$, $$...$$,
 * \(...\), \[...\]) using KaTeX; non-math text is rendered verbatim.
 * Markdown tables in the text (questions read from scans keep their tables
 * that way) are shown as tables. They are built from spans styled as a
 * table, so MathText stays valid inside a paragraph.
 */
export function MathText({ text, className }: Props) {
  const nodes = useMemo(() => {
    if (!text) return null;
    if (!text.includes("|")) return mathNodes(text);
    return splitTables(text).map((seg, i) =>
      seg.kind === "text" ? (
        <Fragment key={i}>{mathNodes(seg.text, `${i}-`)}</Fragment>
      ) : (
        <span key={i} className="my-2 block overflow-x-auto" data-testid="md-table">
          <span className="table border-collapse text-sm" role="table">
            <span className="table-row bg-muted/40 font-semibold" role="row">
              {seg.table.headers.map((h, c) => (
                <span key={c} className="table-cell border border-border/70 px-2.5 py-1 text-center" role="columnheader">
                  {mathNodes(h, `${i}-h${c}-`)}
                </span>
              ))}
            </span>
            {seg.table.rows.map((row, r) => (
              <span key={r} className="table-row" role="row">
                {row.map((cell, c) => (
                  <span key={c} className="table-cell border border-border/70 px-2.5 py-1 text-center" role="cell">
                    {mathNodes(cell, `${i}-${r}-${c}-`)}
                  </span>
                ))}
              </span>
            ))}
          </span>
        </span>
      ),
    );
  }, [text]);

  if (!text) return null;
  return <span className={className}>{nodes}</span>;
}
