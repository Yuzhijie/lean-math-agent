"use client";

import { AlertCircle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { tr } = useI18n();
  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-8">
      <div className="flex flex-col items-center max-w-md text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10 mb-6">
          <AlertCircle className="h-8 w-8 text-destructive" />
        </div>
        <h2 className="text-xl font-serif font-bold text-foreground mb-2">
          {tr("出了点问题", "Something went wrong")}
        </h2>
        <p className="text-sm text-muted-foreground mb-1">
          {tr("应用遇到了意外错误。", "The app ran into an unexpected error.")}
        </p>
        {error.message && (
          <p className="text-xs text-muted-foreground/70 font-mono mb-6 max-w-sm break-words">
            {error.message}
          </p>
        )}
        <Button onClick={reset} className="gap-2">
          <RotateCcw className="h-4 w-4" />
          {tr("重试", "Retry")}
        </Button>
      </div>
    </div>
  );
}
