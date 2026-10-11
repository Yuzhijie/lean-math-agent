"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { CheckCircle2, ChevronLeft, ChevronRight, ImageIcon, Loader2, RefreshCw, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { renderFigureSvg } from "@/lib/figure/render";
import type { SolvedFigure } from "@/lib/figure/spec";
import { strategySteps } from "@/lib/figure/strategy";
import { graphReadouts } from "@/lib/figure/strategy-render";
import { MathText } from "./MathText";
import { useI18n } from "@/lib/i18n";

/** Solution steps at which the figure changes (highlights, elements appearing, values revealed). */
export function figureSteps(fig: SolvedFigure): number[] {
  const s = new Set(fig.spec.step_highlights.map((h) => h.step));
  if (fig.spec.strategy) {
    for (const n of strategySteps(fig.spec.strategy)) s.add(n);
    // A picture that builds up step by step starts with step 1: only what is given.
    if (s.size && Math.min(...s) > 1) s.add(1);
  }
  return [...s].sort((a, b) => a - b);
}

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
export function FigurePanel({
  sessionId,
  problemText,
  initialFigure,
  fallbackSvg,
  onFigure,
  step: stepProp,
  onStepChange,
  stepTitles,
}: {
  /** Figure for a session (cached on it, step highlights from its solution) … */
  sessionId?: string;
  /** … or for a bare problem statement (problem generator). */
  problemText?: string;
  initialFigure?: SolvedFigure | null;
  /** Model-drawn SVG shown (marked unchecked) when no computed figure is available. */
  fallbackSvg?: string;
  /** Called with the computed figure once it has loaded (e.g. to carry it over when a problem is used). */
  onFigure?: (figure: SolvedFigure) => void;
  /** Controlled solution step (null = whole figure), e.g. linked to the solution's step cards. */
  step?: number | null;
  onStepChange?: (step: number | null) => void;
  /** Titles of the solution steps (1-based in the buttons), shown with the current step. */
  stepTitles?: string[];
}) {
  const [state, setState] = useState<State>(initialFigure ? { kind: "ready", figure: initialFigure } : { kind: "loading" });
  const [ownStep, setOwnStep] = useState<number | null>(null);
  const step = stepProp !== undefined ? stepProp : ownStep;
  const setStep = (s: number | null) => {
    setOwnStep(s);
    onStepChange?.(s);
  };
  const [param, setParam] = useState<number | null>(null);
  const [showChecks, setShowChecks] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [force, setForce] = useState(false);
  // Keep the latest callback without making it an effect dependency.
  const onFigureRef = useRef(onFigure);
  useEffect(() => {
    onFigureRef.current = onFigure;
  }, [onFigure]);
  const { tr, locale } = useI18n();
  // Same for tr: switching language must not refetch the figure.
  const trRef = useRef(tr);
  useEffect(() => {
    trRef.current = tr;
  }, [tr]);

  useEffect(() => {
    if (initialFigure && nonce === 0) return;
    if (!sessionId && !problemText) return;
    let cancelled = false;
    fetch("/api/figure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sessionId ? { session_id: sessionId, refresh: nonce > 0, force } : { problem_text: problemText, force }),
    })
      .then(async (res) => {
        const data = (await res.json()) as { figure?: SolvedFigure | null; reason?: string; error?: string };
        if (cancelled) return;
        if (!res.ok) setState({ kind: "error", message: data.error ?? trRef.current(`请求失败 (${res.status})`, `Request failed (${res.status})`) });
        else if (data.figure) {
          setState({ kind: "ready", figure: data.figure });
          onFigureRef.current?.(data.figure);
        }
        else if (data.reason === "not_needed") setState({ kind: "none" });
        else setState({ kind: "error", message: data.reason ?? trRef.current("无法作图", "Could not draw a figure") });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ kind: "error", message: e instanceof Error ? e.message : trRef.current("网络错误", "Network error") });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, problemText, nonce, initialFigure, force]);

  const figure = state.kind === "ready" ? state.figure : undefined;
  const steps = useMemo(() => (figure ? figureSteps(figure) : []), [figure]);
  const graph = figure?.spec.strategy?.type === "graph_explore" ? figure.spec.strategy : undefined;
  const paramValue = graph?.param ? (param ?? graph.param.start ?? graph.param.min) : undefined;
  const fallback = useMemo(() => {
    if (!fallbackSvg || typeof window === "undefined" || !DOMPurify.isSupported) return "";
    return DOMPurify.sanitize(fallbackSvg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ["foreignObject", "script", "style"] });
  }, [fallbackSvg]);
  const svg = useMemo(() => {
    if (!figure || typeof window === "undefined" || !DOMPurify.isSupported) return "";
    const highlight = step === null ? [] : figure.spec.step_highlights.filter((h) => h.step === step).flatMap((h) => h.ids);
    let raw = "";
    try {
      raw = renderFigureSvg(figure, { highlight, locale, step, param: paramValue });
    } catch {
      return "";
    }
    return DOMPurify.sanitize(raw, { USE_PROFILES: { svg: true }, FORBID_TAGS: ["foreignObject", "script", "style"] });
  }, [figure, step, locale, paramValue]);

  if ((state.kind === "none" || state.kind === "error") && fallback) {
    return (
      <div className="rounded-lg border border-border/60 bg-white/[0.02] p-3">
        <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            <ImageIcon className="h-4 w-4" />
            {tr("模型绘制的示意图（未经校验）", "Model-drawn sketch (unchecked)")}
          </span>
        </div>
        <div className="flex justify-center [&_svg]:h-auto [&_svg]:max-h-[320px] [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: fallback }} />
      </div>
    );
  }
  if (state.kind === "none") {
    // The problem looked like it needs no figure; let the user ask for one anyway.
    return (
      <div className="flex items-center justify-between rounded-lg border border-dashed border-border/60 p-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          <ImageIcon className="h-4 w-4" />
          {tr("本题未自动配图", "No figure was generated automatically for this problem")}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => {
            setState({ kind: "loading" });
            setForce(true);
            setNonce((n) => n + 1);
          }}
        >
          {tr("生成配图", "Generate figure")}
        </Button>
      </div>
    );
  }
  if (state.kind === "loading") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/10 p-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {tr("正在生成配图…", "Generating figure…")}
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/10 p-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          <ImageIcon className="h-4 w-4" />
          {tr("配图生成失败：", "Figure generation failed: ")}{state.message.slice(0, 120)}
        </span>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => {
            setState({ kind: "loading" });
            setNonce((n) => n + 1);
          }}>
          <RefreshCw className="mr-1 h-3.5 w-3.5" />
          {tr("重试", "Retry")}
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
          {fig.spec.title ?? tr("配图", "Figure")}
        </div>
        <button type="button" onClick={() => setShowChecks((v) => !v)} className="focus:outline-none">
          {fig.verified ? (
            <Badge variant="success" className="gap-1">
              <CheckCircle2 className="h-3.5 w-3.5" />
              {tr(`图形已按题目条件校验（${fig.claims.length} 项）`, `Figure checked against the problem's conditions (${fig.claims.length})`)}
            </Badge>
          ) : (
            <Badge variant="warning" className="gap-1">
              <TriangleAlert className="h-3.5 w-3.5" />
              {tr(`示意图（${failed.length} 项条件未满足）`, `Sketch (${failed.length} ${failed.length === 1 ? "condition" : "conditions"} not met)`)}
            </Badge>
          )}
        </button>
      </div>

      {steps.length > 0 && (
        <div className="mb-2 space-y-1.5" data-testid="figure-steps">
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              disabled={step === steps[0]}
              aria-label={tr("上一步", "Previous step")}
              title={tr("上一步", "Previous step")}
              onClick={() => setStep(step === null ? steps[steps.length - 1] : steps[Math.max(0, steps.indexOf(step) - 1)])}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            {steps.map((s) => (
              <Button key={s} variant={step === s ? "secondary" : "ghost"} size="sm" className="h-7 text-xs" onClick={() => setStep(s)} title={stepTitles?.[s - 1]}>
                {tr(`第 ${s} 步`, `Step ${s}`)}
              </Button>
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              disabled={step === null}
              aria-label={tr("下一步", "Next step")}
              title={tr("下一步", "Next step")}
              onClick={() => setStep(step === null ? null : steps.indexOf(step) + 1 < steps.length ? steps[steps.indexOf(step) + 1] : null)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button variant={step === null ? "secondary" : "ghost"} size="sm" className="h-7 text-xs" onClick={() => setStep(null)}>
              {tr("全图", "Full figure")}
            </Button>
          </div>
          {step !== null && stepTitles?.[step - 1] && (
            <p className="text-xs text-warning" data-testid="figure-step-title">
              {tr(`第 ${step} 步：`, `Step ${step}: `)}
              <MathText text={stepTitles[step - 1]} />
            </p>
          )}
        </div>
      )}

      {svg ? (
        <div className="flex justify-center overflow-x-auto [&_svg]:h-auto [&_svg]:max-h-[440px] [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <p className="text-xs text-muted-foreground">{tr("无法渲染配图", "Could not render the figure")}</p>
      )}

      {/* Slider: move the parameter and watch the graph and the values change */}
      {graph?.param && paramValue !== undefined && (
        <div className="mt-2 space-y-1.5 rounded-md border border-border/50 bg-muted/20 px-3 py-2" data-testid="figure-slider">
          <label className="flex items-center gap-3 text-xs text-muted-foreground">
            <SlidersHorizontal className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="shrink-0 font-medium text-foreground">{graph.param.label ?? graph.param.id}</span>
            <input
              type="range"
              min={graph.param.min}
              max={graph.param.max}
              step={graph.param.step ?? (graph.param.max - graph.param.min) / 100}
              value={paramValue}
              onChange={(e) => setParam(Number(e.target.value))}
              className="w-full accent-amber-500"
              aria-label={graph.param.label ?? graph.param.id}
            />
            <span className="w-14 shrink-0 text-right font-mono text-foreground">{Math.round(paramValue * 1000) / 1000}</span>
          </label>
          {graph.readouts.length > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 pl-6 text-xs">
              {graphReadouts(graph, paramValue).map((r) => (
                <span key={r.label}>
                  <span className="text-muted-foreground">{r.label} = </span>
                  <span className="font-mono font-semibold text-warning">{r.value}</span>
                </span>
              ))}
            </div>
          )}
        </div>
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
          <li className="pt-1 text-[11px]">{tr("图形校验只检查题目给出的数值条件，不代表证明经过 Lean 形式化验证。", "The figure check only tests the numerical conditions given in the problem; it does not mean the proof has been formally verified in Lean.")}</li>
        </ul>
      )}
    </div>
  );
}
