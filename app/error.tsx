"use client";

import { AlertCircle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-8">
      <div className="flex flex-col items-center max-w-md text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10 mb-6">
          <AlertCircle className="h-8 w-8 text-destructive" />
        </div>
        <h2 className="text-xl font-serif font-bold text-foreground mb-2">
          出了点问题
        </h2>
        <p className="text-sm text-muted-foreground mb-1">
          应用遇到了意外错误。
        </p>
        {error.message && (
          <p className="text-xs text-muted-foreground/70 font-mono mb-6 max-w-sm break-words">
            {error.message}
          </p>
        )}
        <Button onClick={reset} className="gap-2">
          <RotateCcw className="h-4 w-4" />
          重试
        </Button>
      </div>
    </div>
  );
}
