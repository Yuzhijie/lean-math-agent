"use client";

import { useEffect, useState, type ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AlertCircle, ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type { DraftItem, Item, QuestionType } from "./api";

export type Tr = (zh: string, en: string) => string;

// ── Labels ───────────────────────────────────────────────────────────

export function typeLabel(t: QuestionType | string, tr: Tr): string {
  switch (t) {
    case "multiple_choice":
      return tr("选择题", "Multiple choice");
    case "numeric":
      return tr("数值题", "Numeric");
    case "short_answer":
      return tr("简答题", "Short answer");
    case "proof":
      return tr("证明题", "Proof");
    default:
      return tr("其他", "Other");
  }
}

export function originLabel(o: Item["origin"] | string, tr: Tr): string {
  return o === "imported" ? tr("导入", "Imported") : o === "generated" ? tr("生成", "Generated") : tr("手动", "Manual");
}

export function languageLabel(l: string, tr: Tr): string {
  return l === "zh" ? tr("中文", "Chinese") : l === "en" ? tr("英文", "English") : tr("中英混合", "Mixed");
}

export function statusLabel(s: DraftItem["status"], tr: Tr): string {
  switch (s) {
    case "ok":
      return tr("正常", "OK");
    case "needs_review":
      return tr("需复核", "Needs review");
    case "duplicate":
      return tr("重复", "Duplicate");
    case "near_duplicate":
      return tr("近似重复", "Near duplicate");
    default:
      return tr("错误", "Error");
  }
}

export function statusVariant(s: DraftItem["status"]): "success" | "warning" | "destructive" | "secondary" | "info" {
  return s === "ok" ? "success" : s === "needs_review" ? "warning" : s === "error" ? "destructive" : s === "duplicate" ? "secondary" : "info";
}

export function originVariant(o: string): "info" | "secondary" | "outline" {
  return o === "generated" ? "info" : o === "imported" ? "secondary" : "outline";
}

// ── Small building blocks ────────────────────────────────────────────

export function FieldLabel({ children, className, htmlFor }: { children: ReactNode; className?: string; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className={cn("block text-[11px] font-bold uppercase tracking-wider text-muted-foreground", className)}>
      {children}
    </label>
  );
}

export function CheckboxField({
  checked,
  onChange,
  children,
  disabled,
  className,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
  hint?: ReactNode;
}) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-2 text-sm", disabled && "cursor-not-allowed opacity-60", className)}>
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-primary)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0">
        {children}
        {hint && <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}

export function ErrorNote({ message, onDismiss }: { message: string | null; onDismiss?: () => void }) {
  if (!message) return null;
  return (
    <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive animate-fade-in">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 break-words">{message}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="shrink-0 opacity-70 hover:opacity-100" aria-label="dismiss">
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/** Native select styled like the app's inputs (dense forms and tables, where Radix Select is heavy). */
export function NativeSelect({
  value,
  onChange,
  children,
  className,
  disabled,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
        className,
      )}
    >
      {children}
    </select>
  );
}

// ── Modal ────────────────────────────────────────────────────────────

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const { tr } = useI18n();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-fade-in" />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-card p-5 shadow-2xl focus:outline-none",
            className,
          )}
        >
          <div className="mb-4 pr-6">
            <DialogPrimitive.Title className="text-base font-semibold text-foreground">{title}</DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="mt-1 text-sm text-muted-foreground">{description}</DialogPrimitive.Description>
            ) : (
              <DialogPrimitive.Description className="sr-only">{typeof title === "string" ? title : ""}</DialogPrimitive.Description>
            )}
          </div>
          {children}
          <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100" aria-label={tr("关闭", "Close")}>
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

// ── Knowledge points ─────────────────────────────────────────────────

/**
 * Chips + free text input with suggestions from the vocabulary; "Browse"
 * shows the bank's own vocabulary and the built-in curriculum groups.
 */
export function KnowledgePointInput({
  value,
  onChange,
  vocab,
  placeholder,
  id,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  vocab?: { own: string[]; builtin: Array<{ strand: string; points: string[] }> };
  placeholder?: string;
  id?: string;
}) {
  const { tr } = useI18n();
  const [text, setText] = useState("");
  const [browse, setBrowse] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const listId = `${id ?? "kp"}-list`;
  const all = vocab ? [...vocab.own, ...vocab.builtin.flatMap((g) => g.points)] : [];
  const add = (raw: string) => {
    const parts = raw
      .split(/[,，;；\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const next = [...value];
    for (const p of parts) if (!next.includes(p) && next.length < 20) next.push(p.slice(0, 80));
    onChange(next);
    setText("");
  };
  const toggle = (p: string) => (value.includes(p) ? onChange(value.filter((x) => x !== p)) : add(p));
  const groups = vocab ? [...(vocab.own.length ? [{ strand: tr("本题库词表", "This bank's vocabulary"), points: vocab.own }] : []), ...vocab.builtin] : [];

  return (
    <div className="space-y-1.5">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((k) => (
            <Badge key={k} variant="outline" className="gap-1 pr-1 font-normal">
              {k}
              <button type="button" onClick={() => onChange(value.filter((x) => x !== k))} aria-label={tr(`移除 ${k}`, `Remove ${k}`)} className="opacity-60 hover:opacity-100">
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <div className="flex gap-1.5">
        <Input
          id={id}
          value={text}
          list={all.length ? listId : undefined}
          placeholder={placeholder ?? tr("输入知识点，回车添加", "Type a knowledge point, press Enter")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (text.trim()) add(text);
            }
          }}
          onBlur={() => text.trim() && add(text)}
          className="h-8 text-xs"
        />
        {groups.length > 0 && (
          <Button type="button" variant="outline" size="sm" className="h-8 shrink-0 gap-1 px-2 text-xs" onClick={() => setBrowse(!browse)}>
            {browse ? <ChevronDown className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
            {tr("浏览", "Browse")}
          </Button>
        )}
      </div>
      {all.length > 0 && (
        <datalist id={listId}>
          {[...new Set(all)].map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      )}
      {browse && (
        <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border/60 bg-white/[0.02] p-2">
          {groups.map((g) => (
            <div key={g.strand}>
              <button
                type="button"
                className="flex w-full items-center gap-1 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
                onClick={() => setOpenGroup(openGroup === g.strand ? null : g.strand)}
              >
                {openGroup === g.strand ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                {g.strand}
                <span className="text-[10px] opacity-70">({g.points.length})</span>
              </button>
              {openGroup === g.strand && (
                <div className="mt-1 flex flex-wrap gap-1 pl-4">
                  {g.points.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => toggle(p)}
                      className={cn(
                        "rounded border px-1.5 py-0.5 text-[11px] transition-colors",
                        value.includes(p) ? "border-primary/50 bg-primary/15 text-primary" : "border-border/60 text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Comma-separated tags editor (plain input). */
export function splitList(s: string): string[] {
  return s
    .split(/[,，;；\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Whole seconds since `since` (null = not running), ticking once a second. */
export function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  return since ? Math.max(0, Math.floor((now - since) / 1000)) : 0;
}
