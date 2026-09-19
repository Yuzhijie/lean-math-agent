"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  AlertCircle,
  AlertTriangle,
  X,
  RotateCcw,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

type Props = {
  error: string | null;
  detail?: string | null;
  validationResults?: Array<{ layer: number; pass: boolean; detail: string }> | null;
  onRetry?: () => void;
  onDismiss?: () => void;
};

export function ErrorBanner({
  error,
  detail,
  validationResults,
  onRetry,
  onDismiss,
}: Props) {
  const [expanded, setExpanded] = useState(false);

  if (!error) return null;

  const isAutoformalizeError = error === "autoformalize_failed";
  const Icon = isAutoformalizeError ? AlertTriangle : AlertCircle;
  const displayMessage = isAutoformalizeError
    ? "自动形式化失败"
    : error;

  const hasDetails = detail || (validationResults && validationResults.length > 0);

  return (
    <div
      className={cn(
        "rounded-lg border px-4 py-3 animate-fade-in",
        isAutoformalizeError
          ? "border-warning/30 bg-warning/5"
          : "border-destructive/30 bg-destructive/5",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          <Icon
            className={cn(
              "mt-0.5 h-4 w-4 shrink-0",
              isAutoformalizeError ? "text-warning" : "text-destructive",
            )}
          />
          <div className="min-w-0">
            <p
              className={cn(
                "text-sm font-medium",
                isAutoformalizeError ? "text-warning" : "text-destructive",
              )}
            >
              {displayMessage}
            </p>

            {/* Inline detail (always shown if short) */}
            {detail && !expanded && detail.length < 100 && (
              <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {hasDetails && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpanded(!expanded)}
              className="h-7 px-2 text-xs gap-1"
            >
              {expanded ? (
                <ChevronUp className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
              详情
            </Button>
          )}
          {onRetry && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onRetry}
              className="h-7 px-2 text-xs gap-1"
            >
              <RotateCcw className="h-3 w-3" />
              重试
            </Button>
          )}
          {onDismiss && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onDismiss}
              className="h-7 w-7 p-0"
            >
              <X className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>

      {/* Expanded details */}
      {expanded && hasDetails && (
        <div className="mt-3 space-y-2 border-t border-border/40 pt-3 animate-slide-down">
          {detail && detail.length >= 100 && (
            <p className="text-xs text-muted-foreground">{detail}</p>
          )}
          {validationResults && validationResults.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                验证层级结果：
              </p>
              {validationResults.map((v) => (
                <div
                  key={v.layer}
                  className="flex items-start gap-2 text-xs"
                >
                  <span
                    className={`mt-0.5 shrink-0 ${
                      v.pass ? "text-green-500" : "text-destructive"
                    }`}
                  >
                    {v.pass ? "✓" : "✗"}
                  </span>
                  <span className="text-muted-foreground">
                    第{v.layer}层：{v.detail}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
