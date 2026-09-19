"use client";

import { useMemo } from "react";
import DOMPurify from "dompurify";

/**
 * Renders an LLM-generated SVG diagram.
 *
 * The markup is model output derived from user text, so it is untrusted:
 * it is passed through DOMPurify's SVG profile (scripts, event handlers,
 * foreignObject, external references etc. are stripped) before being
 * injected. DOMPurify needs a DOM, so on the server nothing is rendered;
 * the component only ever receives content after a client-side fetch.
 */
export function DiagramSvg({ svg }: { svg: string }) {
  const clean = useMemo(() => {
    if (typeof window === "undefined" || !DOMPurify.isSupported) return "";
    return DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ["foreignObject", "script", "style"],
    });
  }, [svg]);

  if (!clean) return null;

  return (
    <div className="my-3 flex items-center justify-center rounded-lg border border-border/60 bg-white/[0.02] p-3">
      <div
        className="max-w-full [&_svg]:max-w-full [&_svg]:h-auto [&_svg]:max-h-[280px]"
        dangerouslySetInnerHTML={{ __html: clean }}
      />
    </div>
  );
}
