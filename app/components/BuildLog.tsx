"use client";

import { useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ChevronRight, Terminal } from "lucide-react";

type Props = {
  log: string;
  defaultOpen?: boolean;
};

export function BuildLog({ log, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);

  if (!log.trim()) {
    return null;
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-3">
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-card/80 transition-all duration-200">
        <ChevronRight
          className={cn(
            "h-4 w-4 transition-transform duration-200",
            open && "rotate-90"
          )}
        />
        <Terminal className="h-3.5 w-3.5" />
        Build log
      </CollapsibleTrigger>
      <CollapsibleContent className="animate-slide-down">
        <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-code-bg border border-border p-4 font-mono text-xs leading-relaxed text-muted-foreground">
          {log}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
