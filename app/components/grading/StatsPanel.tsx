"use client";

import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ERROR_TYPES, VERDICTS } from "@/lib/grading/types";
import type { LearningStats } from "./api";
import { errorTypeLabel, pct, verdictLabel, verdictVariant } from "./labels";

const BAR: Record<string, string> = {
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  secondary: "bg-muted-foreground/50",
};

/** A learning record: headline numbers, verdict mix, recurring mistakes, weakest skills, recent trend. */
export function StatsPanel({ stats, title }: { stats: LearningStats; title?: string }) {
  const { tr } = useI18n();
  if (!stats.marked) {
    return <p className="text-sm text-muted-foreground">{tr("还没有批改过的作答。", "No marked work yet.")}</p>;
  }
  const errors = ERROR_TYPES.map((e) => [e, stats.error_types[e]] as const).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const maxErr = Math.max(1, ...errors.map(([, n]) => n));
  return (
    <div className="space-y-4">
      {title && <h3 className="text-sm font-semibold">{title}</h3>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label={tr("已批改", "Marked")} value={String(stats.marked)} />
        <Stat label={tr("全对率", "Fully correct")} value={pct(stats.correct_rate)} />
        <Stat label={tr("答案正确率", "Right answer")} value={pct(stats.answer_rate)} />
        <Stat label={tr("平均分", "Mean score")} value={stats.mean_score === null ? "—" : String(stats.mean_score)} />
      </div>

      <div>
        <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{tr("批改结果", "Verdicts")}</p>
        <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
          {VERDICTS.filter((v) => stats.verdicts[v] > 0).map((v) => (
            <div key={v} className={BAR[verdictVariant(v)]} style={{ width: `${(100 * stats.verdicts[v]) / stats.marked}%` }} title={`${verdictLabel(v, tr)}: ${stats.verdicts[v]}`} />
          ))}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {VERDICTS.filter((v) => stats.verdicts[v] > 0).map((v) => (
            <Badge key={v} variant={verdictVariant(v)} className="text-[11px]">
              {verdictLabel(v, tr)} {stats.verdicts[v]}
            </Badge>
          ))}
        </div>
      </div>

      {errors.length > 0 && (
        <div>
          <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{tr("常见错误", "Recurring mistakes")}</p>
          <div className="space-y-1">
            {errors.map(([e, n]) => (
              <div key={e} className="flex items-center gap-2 text-xs">
                <span className="w-24 shrink-0 text-muted-foreground">{errorTypeLabel(e, tr)}</span>
                <div className="h-2 flex-1 rounded-full bg-muted">
                  <div className="h-2 rounded-full bg-destructive/70" style={{ width: `${(100 * n) / maxErr}%` }} />
                </div>
                <span className="w-6 text-right tabular-nums">{n}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {stats.knowledge.length > 0 && (
        <div>
          <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{tr("知识点（最薄弱的在前）", "Skills (weakest first)")}</p>
          <div className="flex flex-wrap gap-1.5">
            {stats.knowledge.slice(0, 12).map((k) => (
              <span
                key={k.name}
                className={cn(
                  "rounded-md border px-2 py-0.5 text-xs",
                  k.rate < 0.5 ? "border-destructive/40 bg-destructive/5 text-destructive" : k.rate < 1 ? "border-warning/40 bg-warning/5 text-warning" : "border-success/40 bg-success/5 text-success",
                )}
                title={tr(`${k.attempts} 题，全对 ${k.correct} 题`, `${k.attempts} problems, ${k.correct} fully correct`)}
              >
                {k.name} {k.correct}/{k.attempts}
              </span>
            ))}
          </div>
        </div>
      )}

      {stats.recent.length > 1 && (
        <div>
          <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{tr("最近的作答（从旧到新）", "Recent work (oldest first)")}</p>
          <div className="flex items-end gap-1">
            {[...stats.recent].reverse().map((r) => (
              <div
                key={r.id}
                className={cn("w-3 rounded-sm", BAR[verdictVariant(r.verdict)])}
                style={{ height: `${8 + Math.round(((r.score ?? 0) / 100) * 28)}px` }}
                title={`${new Date(r.at).toLocaleDateString()} · ${verdictLabel(r.verdict, tr)} · ${r.score ?? "—"}`}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}
