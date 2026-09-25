"use client";

import { useEffect, useMemo, useState } from "react";
import DOMPurify from "dompurify";
import { CheckCircle2, ImageIcon, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { renderFigureSvg } from "@/lib/figure/render";
import type { SolvedFigure } from "@/lib/figure/spec";

type State =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "error"; message: string }
  | { kind: "ready"; figure: SolvedFigure };

/**
 * Figure for the current problem: fetched from /api/figure (computed and
 * checked on the server, cached on the session) and rendered here, so the
 * step buttons re-highlight instantly. Renders nothing when the problem
 * does not need a figure.
 */
export function FigurePanel({ sessionId, initialFigure }: { sessionId: string; initialFigure?: SolvedFigure | null }) {
  const [state, setState] = useState<State>(initialFigure ? { kind: "ready", figure: initialFigure } : { kind: "loading" });
  const [step, setStep] = useState<number | null>(null);
  const [showChecks, setShowChecks] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (initialFigure && nonce === 0) return;
    let cancelled = false;
    fetch("/api/figure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, refresh: nonce > 0 }),
    })
      .then(async (res) => {
        const data = (await res.json()) as { figure?: SolvedFigure | null; reason?: string; error?: string };
        if (cancelled) return;
        if (!res.ok) setState({ kind: "error", message: data.error ?? `请求失败 (${res.status})` });
        else if (data.figure) setState({ kind: "ready", figure: data.figure });
        else if (data.reason === "not_needed") setState({ kind: "none" });
        else setState({ kind: "error", message: data.reason ?? "无法作图" });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ kind: "error", message: e instanceof Error ? e.message : "网络错误" });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, nonce, initialFigure]);

  const figure = state.kind === "ready" ? state.figure : undefined;
  const steps = useMemo(
    () => (figure ? [...new Set(figure.spec.step_highlights.map((h) => h.step))].sort((a, b) => a - b) : []),
    [figure],
  );
  const svg = useMemo(() => {
    if (!figure || typeof window === "undefined" || !DOMPurify.isSupported) return "";
    const highlight = step === null ? [] : figure.spec.step_highlights.filter((h) => h.step === step).flatMap((h) => h.ids);
    let raw = "";
    try {
      raw = renderFigureSvg(figure, { highlight });
    } catch {
      return "";
    }
    return DOMPurify.sanitize(raw, { USE_PROFILES: { svg: true }, FORBID_TAGS: ["foreignObject", "script", "style"] });
  }, [figure, step]);

  if (state.kind === "none") return null;
  if (state.kind === "loading") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/10 p-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        正在生成配图…
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/10 p-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          <ImageIcon className="h-4 w-4" />
          配图生成失败：{state.message.slice(0, 120)}
        </span>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => {
            setState({ kind: "loading" });
            setNonce((n) => n + 1);
          }}>
          <RefreshCw className="mr-1 h-3.5 w-3.5" />
          重试
        </Button>
      </div>
    );
  }

  const fig = state.figure;
  const failed = fig.claims.filter((c) => !c.ok);
  return (
    <div className="rounded-lg border border-border/60 bg-white/[0.02] p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ImageIcon className="h-4 w-4 text-primary" />
          {fig.spec.title ?? "配图"}
        </div>
        <button type="button" onClick={() => setShowChecks((v) => !v)} className="focus:outline-none">
          {fig.verified ? (
            <Badge variant="success" className="gap-1">
              <CheckCircle2 className="h-3.5 w-3.5" />
              图形已按题目条件校验（{fig.claims.length} 项）
            </Badge>
          ) : (
            <Badge variant="warning" className="gap-1">
              <TriangleAlert className="h-3.5 w-3.5" />
              示意图（{failed.length} 项条件未满足）
            </Badge>
          )}
        </button>
      </div>

      {steps.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          <Button variant={step === null ? "secondary" : "ghost"} size="sm" className="h-7 text-xs" onClick={() => setStep(null)}>
            全图
          </Button>
          {steps.map((s) => (
            <Button key={s} variant={step === s ? "secondary" : "ghost"} size="sm" className="h-7 text-xs" onClick={() => setStep(s)}>
              第 {s} 步
            </Button>
          ))}
        </div>
      )}

      {svg ? (
        <div className="flex justify-center [&_svg]:h-auto [&_svg]:max-h-[400px] [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <p className="text-xs text-muted-foreground">无法渲染配图</p>
      )}

      {showChecks && (
        <ul className="mt-2 space-y-1 border-t border-border/40 pt-2 text-xs text-muted-foreground">
          {fig.claims.map((c, i) => (
            <li key={i} className={c.ok ? "" : "text-warning"}>
              {c.ok ? "✓" : "✗"} {c.detail}
            </li>
          ))}
          {fig.warnings.map((w, i) => (
            <li key={`w${i}`}>· {w}</li>
          ))}
          <li className="pt-1 text-[11px]">图形校验只检查题目给出的数值条件，不代表证明经过 Lean 形式化验证。</li>
        </ul>
      )}
    </div>
  );
}
