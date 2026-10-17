"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, CheckCircle2, ChevronDown, ChevronRight, FileDown, Image as ImageIcon, Loader2, Minus, RefreshCw, Sparkles, X, XCircle } from "lucide-react";
import { generationPrintHref } from "@/lib/bank/worksheet";
import { MAX_TEMPLATE_RUNS, templateRuns, type TemplateRun } from "@/lib/bank/template-runs";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { MathText } from "../MathText";
import { QuestionFigure } from "../QuestionFigure";
import { api, bankUrl, candidateHref, errMsg, letter, problemText, type Bank, type Candidate, type CategoryWithCount, type Generation, type Item, type TemplateProfile } from "./api";
import { KindIcon } from "./CategoryTree";
import { ErrorNote, FieldLabel, NativeSelect, typeLabel, useElapsed, type Tr } from "./ui";

export type GenerateTemplate = { kind: "category"; category: CategoryWithCount } | { kind: "items"; items: Item[] };

/** Wall-clock start of a generation (for the elapsed-time line). */
const nowMs = () => Date.now();

type RunState = { run: TemplateRun; item?: Item; status: "waiting" | "running" | "done" | "failed"; generation?: Generation; error?: string };

type Props = {
  bank: Bank;
  template: GenerateTemplate;
  categories: CategoryWithCount[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdopted: () => void;
};

type CheckName = keyof Candidate["checks"];
const CHECKS: CheckName[] = ["format", "answer", "novelty", "fit", "figure"];

function checkLabel(c: CheckName, tr: Tr) {
  return c === "format" ? tr("格式", "Format") : c === "answer" ? tr("答案", "Answer") : c === "novelty" ? tr("新颖", "Novelty") : c === "figure" ? tr("图形", "Figure") : tr("契合", "Fit");
}

export function GeneratePanel({ bank, template, categories, open, onOpenChange, onAdopted }: Props) {
  const { tr } = useI18n();
  const router = useRouter();
  const category = template.kind === "category" ? template.category : null;
  const [profile, setProfile] = useState<TemplateProfile | null>(null);
  const [profileBusy, setProfileBusy] = useState(!!category);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [count, setCount] = useState(3);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [runs, setRuns] = useState<RunState[] | null>(null);
  const elapsed = useElapsed(startedAt);
  const manualCats = categories.filter((c) => c.kind === "manual");
  const defaultCat = category && category.kind === "manual" ? category.id : "";

  useEffect(() => {
    if (!open || !category) return;
    let cancelled = false;
    (async () => {
      try {
        const q = new URLSearchParams({ category: category.id });
        if (refreshKey > 0) q.set("refresh", "1");
        const res = await api<{ profile: TemplateProfile }>(bankUrl(bank.id, `/profile?${q}`));
        if (!cancelled) setProfile(res.profile);
      } catch (e) {
        if (!cancelled) setProfileError(errMsg(e, tr("模板分析失败", "Template analysis failed")));
      } finally {
        if (!cancelled) setProfileBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, category, bank.id, refreshKey, tr]);

  // One run per template: a category is one template; each picked question is a template of its own.
  const items = template.kind === "items" ? template.items : [];
  const plan = category ? templateRuns({ kind: "category", categoryId: category.id }) : templateRuns({ kind: "items", itemIds: items.map((i) => i.id) });
  const itemById = new Map(items.map((i) => [i.id, i]));
  const several = plan.length > 1;

  async function generate() {
    setStartedAt(nowMs());
    setRuns(plan.map((run) => ({ run, item: run.itemId ? itemById.get(run.itemId) : undefined, status: "waiting" })));
    const update = (i: number, patch: Partial<RunState>) => setRuns((rs) => rs && rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    // One template after another: each run is a full generation (writing, re-solving, checks).
    for (let i = 0; i < plan.length; i++) {
      update(i, { status: "running" });
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 660_000);
      try {
        const res = await api<{ generation: Generation }>(bankUrl(bank.id, "/generate"), { method: "POST", json: { template: plan[i].ref, count }, signal: ctrl.signal });
        update(i, { status: "done", generation: res.generation });
      } catch (e) {
        const error = e instanceof DOMException && e.name === "AbortError" ? tr("生成超时，请减少数量后重试", "Generation timed out; try a smaller count") : errMsg(e, tr("生成失败", "Generation failed"));
        update(i, { status: "failed", error });
      } finally {
        clearTimeout(timer);
      }
    }
    setStartedAt(null);
  }

  const busy = startedAt !== null;
  const doneRuns = runs?.filter((r) => r.status === "done" || r.status === "failed").length ?? 0;
  const runningIndex = runs?.findIndex((r) => r.status === "running") ?? -1;

  return (
    <Sheet open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-3xl">
        <SheetHeader className="border-b border-border/60 px-5 pb-3 pt-5">
          <SheetTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" />
            {tr("按模板出题", "Generate from template")}
          </SheetTitle>
          <SheetDescription className="flex items-center gap-1.5 text-xs">
            {category ? (
              <>
                <KindIcon kind={category.kind} />
                {category.name}
              </>
            ) : (
              several
                ? tr(`选中的 ${plan.length} 道题各作为一个模板，分别出题`, `Each of the ${plan.length} selected questions is a template of its own`)
                : tr("以选中的题为模板", "Using the selected question as the template")
            )}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {!bank.allow_model && (
            <ErrorNote message={tr("此题库不允许发送给模型，无法出题。可在题库设置中开启。", "This bank does not allow sending content to the model, so generation is unavailable. Turn it on in the bank settings.")} />
          )}

          {/* Template profile */}
          {category ? (
            <div className="space-y-2 rounded-lg border border-border/60 bg-white/[0.02] p-3">
              <div className="flex items-center justify-between gap-2">
                <FieldLabel>{tr("模板画像", "Template profile")}</FieldLabel>
                {category.kind !== "style" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs"
                    disabled={profileBusy || busy}
                    onClick={() => {
                      setProfileBusy(true);
                      setProfileError(null);
                      setRefreshKey((k) => k + 1);
                    }}
                  >
                    <RefreshCw className={cn("h-3 w-3", profileBusy && "animate-spin")} />
                    {tr("重新分析", "Re-analyse")}
                  </Button>
                )}
              </div>
              {profileBusy && !profile ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {tr("正在分析这类题的共同特征…", "Analysing what these questions have in common…")}
                </p>
              ) : profileError ? (
                <ErrorNote message={profileError} />
              ) : profile ? (
                <ProfileView profile={profile} />
              ) : null}
            </div>
          ) : (
            template.kind === "items" && (
              <div className="space-y-1.5 rounded-lg border border-border/60 bg-white/[0.02] p-3">
                <FieldLabel>{several ? tr(`模板 ${plan.length} 个（每道题单独出题）`, `${plan.length} templates (one generation per question)`) : tr("模板题目", "Template question")}</FieldLabel>
                <ol className="list-inside list-decimal space-y-1 text-sm">
                  {plan.map((run) => {
                    const it = run.itemId ? itemById.get(run.itemId) : undefined;
                    return it ? (
                      <li key={run.key} className="line-clamp-1 break-words">
                        <MathText text={it.stem} />
                      </li>
                    ) : null;
                  })}
                </ol>
                {template.items.length > MAX_TEMPLATE_RUNS && (
                  <p className="text-xs text-muted-foreground">
                    {tr(`一次最多按 ${MAX_TEMPLATE_RUNS} 个模板出题，只用前 ${MAX_TEMPLATE_RUNS} 道。`, `At most ${MAX_TEMPLATE_RUNS} templates at a time; the first ${MAX_TEMPLATE_RUNS} are used.`)}
                  </p>
                )}
              </div>
            )
          )}

          {/* Controls */}
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-28 space-y-1.5">
              <FieldLabel>{several ? tr("每个模板", "Per template") : tr("数量", "Count")}</FieldLabel>
              <NativeSelect value={String(count)} onChange={(v) => setCount(Number(v))} disabled={busy} ariaLabel={tr("数量", "Count")}>
                {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <Button className="gap-1.5" onClick={() => void generate()} loading={busy} disabled={!bank.allow_model || (template.kind === "items" && template.items.length === 0)}>
              {!busy && <Sparkles className="h-3.5 w-3.5" />}
              {tr("生成", "Generate")}
            </Button>
            {busy && (
              <p className="text-xs text-muted-foreground" aria-live="polite">
                <span className="tabular-nums">{elapsed}s</span>
                {several && runningIndex >= 0 && <> · {tr(`第 ${runningIndex + 1}/${plan.length} 个模板`, `template ${runningIndex + 1} of ${plan.length}`)}</>} ·{" "}
                {several
                  ? tr("每个模板的出题、求解和校验通常需要一两分钟。", "Each template takes a minute or two to generate, re-solve and check.")
                  : tr("出题、求解和校验通常需要一两分钟。", "Generating, re-solving and checking usually takes a minute or two.")}
              </p>
            )}
          </div>

          {/* Candidates, one group per template */}
          {runs?.map((r, ri) => (
            <RunResult
              key={r.run.key}
              state={r}
              index={ri}
              several={several}
              bankId={bank.id}
              manualCats={manualCats}
              defaultCategory={defaultCat}
              onAdopted={(g) => {
                setRuns((rs) => rs && rs.map((x, j) => (j === ri ? { ...x, generation: g } : x)));
                onAdopted();
              }}
              onUse={(c, generationId) => router.push(candidateHref(c, bank.id, generationId))}
            />
          ))}
          {several && runs && !busy && doneRuns === runs.length && (
            <p className="text-xs text-muted-foreground">
              {tr(
                `${runs.length} 个模板已出完：共 ${runs.reduce((n, r) => n + (r.generation?.candidates.length ?? 0), 0)} 道候选题，通过 ${runs.reduce((n, r) => n + (r.generation?.candidates.filter((c) => c.passed).length ?? 0), 0)} 道。`,
                `${runs.length} templates done: ${runs.reduce((n, r) => n + (r.generation?.candidates.length ?? 0), 0)} candidates, ${runs.reduce((n, r) => n + (r.generation?.candidates.filter((c) => c.passed).length ?? 0), 0)} passed.`,
              )}
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** One template's generation: its candidates (or why it failed), with its own PDF export. */
function RunResult({
  state: r,
  index,
  several,
  bankId,
  manualCats,
  defaultCategory,
  onAdopted,
  onUse,
}: {
  state: RunState;
  index: number;
  several: boolean;
  bankId: string;
  manualCats: CategoryWithCount[];
  defaultCategory: string;
  onAdopted: (g: Generation) => void;
  onUse: (c: Candidate, generationId: string) => void;
}) {
  const { tr } = useI18n();
  const generation = r.generation;
  const passed = generation?.candidates.filter((c) => c.passed).length ?? 0;
  if (!several && r.status === "running") return null;
  return (
    <div className={cn("space-y-3 animate-slide-up", several && "rounded-lg border border-border/60 p-3")} data-testid="template-run">
      {several && (
        <div className="space-y-1">
          <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            {tr(`模板 ${index + 1}`, `Template ${index + 1}`)}
            {r.status === "waiting" && ` · ${tr("等待中", "waiting")}`}
          </p>
          {r.item && (
            <p className="line-clamp-2 break-words text-sm">
              <MathText text={r.item.stem} />
            </p>
          )}
          {r.status === "running" && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {tr("正在按这个模板出题…", "Generating from this template…")}
            </p>
          )}
        </div>
      )}
      {r.status === "failed" && <ErrorNote message={r.error ?? tr("生成失败", "Generation failed")} />}
      {generation && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              {tr(`候选题 ${generation.candidates.length} 道，通过 ${passed} 道`, `${generation.candidates.length} candidates, ${passed} passed`)}
            </p>
            {generation.candidates.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1.5 text-xs"
                onClick={() => window.open(generationPrintHref(bankId, generation.id), "_blank")}
                title={tr("打开可打印的练习卷，在打印窗口选择“另存为 PDF”", "Open a printable worksheet; choose “Save as PDF” in the print window")}
                data-testid="export-pdf"
              >
                <FileDown className="h-3.5 w-3.5" />
                {tr("导出 PDF", "Export PDF")}
              </Button>
            )}
          </div>
          {generation.note && <p className="text-xs text-muted-foreground">{generation.note}</p>}
          {generation.candidates.length === 0 && <p className="text-sm text-muted-foreground">{tr("没有生成候选题，请重试。", "No candidates were produced; try again.")}</p>}
          {generation.candidates.map((c, i) => (
            <CandidateCard
              key={c.id}
              index={i}
              candidate={c}
              bankId={bankId}
              generationId={generation.id}
              manualCats={manualCats}
              defaultCategory={defaultCategory}
              onAdopted={onAdopted}
              onUse={() => onUse(c, generation.id)}
            />
          ))}
        </>
      )}
    </div>
  );
}

function ProfileView({ profile }: { profile: TemplateProfile }) {
  const { tr } = useI18n();
  return (
    <div className="space-y-2 text-sm">
      <p className="leading-relaxed">
        <MathText text={profile.summary} />
      </p>
      <div className="flex flex-wrap gap-1.5 text-xs">
        <Badge variant="outline" className="font-medium">
          {typeLabel(profile.type, tr)}
          {profile.option_count ? tr(`（${profile.option_count} 个选项）`, ` (${profile.option_count} options)`) : ""}
        </Badge>
        {profile.grade && <Badge variant="outline" className="font-medium">{profile.grade}</Badge>}
        {profile.difficulty_range && (
          <Badge variant="outline" className="font-medium">
            {tr("难度", "Difficulty")} {profile.difficulty_range[0] === profile.difficulty_range[1] ? profile.difficulty_range[0] : `${profile.difficulty_range[0]}–${profile.difficulty_range[1]}`}
          </Badge>
        )}
        {profile.needs_figure && (
          <Badge variant="warning" className="gap-1">
            <ImageIcon className="h-3 w-3" />
            {tr("需要配图", "Needs a figure")}
          </Badge>
        )}
        <Badge variant="secondary">{tr(`范例 ${profile.exemplar_ids.length} 道`, `${profile.exemplar_ids.length} exemplar${profile.exemplar_ids.length === 1 ? "" : "s"}`)}</Badge>
      </div>
      {profile.knowledge_points.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {tr("知识点：", "Knowledge points: ")}
          {profile.knowledge_points.join(tr("、", ", "))}
        </p>
      )}
      {profile.answer_form && (
        <p className="text-xs text-muted-foreground">
          {tr("答案形式：", "Answer form: ")}
          {profile.answer_form}
        </p>
      )}
    </div>
  );
}

function CandidateCard({
  index,
  candidate: c,
  bankId,
  generationId,
  manualCats,
  defaultCategory,
  onAdopted,
  onUse,
}: {
  index: number;
  candidate: Candidate;
  bankId: string;
  generationId: string;
  manualCats: CategoryWithCount[];
  defaultCategory: string;
  onAdopted: (g: Generation) => void;
  onUse: () => void;
}) {
  const { tr } = useI18n();
  const [showSolution, setShowSolution] = useState(false);
  const [showChecks, setShowChecks] = useState(!c.passed);
  const [cat, setCat] = useState(defaultCategory);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function adopt() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ generation: Generation; items: Item[] }>(bankUrl(bankId, `/generations/${encodeURIComponent(generationId)}`), {
        method: "POST",
        json: { candidate_ids: [c.id], category_id: cat || undefined },
      });
      onAdopted(res.generation);
    } catch (e) {
      setError(errMsg(e, tr("采纳失败", "Could not adopt")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cn("space-y-3 rounded-lg border bg-white/[0.02] p-4", c.passed ? "border-border/60" : "border-warning/30")} data-testid="candidate-card">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-semibold tabular-nums text-muted-foreground">#{index + 1}</span>
        <Badge variant={c.passed ? "success" : "destructive"} className="gap-1">
          {c.passed ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
          {c.passed ? tr("通过", "Passed") : tr("未通过", "Not passed")}
        </Badge>
        <Badge variant="outline" className="font-medium">
          {typeLabel(c.type, tr)}
        </Badge>
        {c.difficulty && <span className="text-xs text-warning">{"★".repeat(c.difficulty)}</span>}
        {c.knowledge_points.slice(0, 3).map((k) => (
          <span key={k} className="text-xs text-muted-foreground">
            · {k}
          </span>
        ))}
      </div>

      <div className="break-words text-sm leading-relaxed">
        <MathText text={c.stem} />
      </div>
      {c.figure && <QuestionFigure svg={c.figure.svg} source={c.figure.source} verified={c.figure.verified} compact />}
      {c.options && c.options.length > 0 && (
        <ol className="space-y-0.5 text-sm">
          {c.options.map((o, i) => (
            <li key={i} className={cn("rounded px-1.5 py-0.5", c.answer.trim().toUpperCase() === letter(i) && "bg-success/10")}>
              <span className="mr-1.5 font-semibold">{letter(i)}.</span>
              <MathText text={o} />
            </li>
          ))}
        </ol>
      )}
      <div className="rounded-md border border-success/20 bg-success/5 px-3 py-2 text-sm">
        <span className="mr-1 text-xs font-semibold text-success">{tr("答案", "Answer")}</span>
        <MathText text={c.answer} />
      </div>
      {c.solution && (
        <div>
          <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowSolution(!showSolution)}>
            {showSolution ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {tr("解析", "Solution")}
          </button>
          {showSolution && (
            <div className="mt-1.5 whitespace-pre-wrap rounded-md border border-border/60 bg-muted/20 p-3 text-sm leading-relaxed">
              <MathText text={c.solution} />
            </div>
          )}
        </div>
      )}

      {/* Checks */}
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {CHECKS.filter((k) => c.checks[k]).map((k) => {
            const ch = c.checks[k]!;
            const state = ch.skipped ? "skipped" : ch.ok ? "ok" : "fail";
            return (
              <button
                key={k}
                type="button"
                title={ch.detail}
                onClick={() => setShowChecks(!showChecks)}
                className={cn(
                  "flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
                  state === "ok" && "border-success/30 bg-success/10 text-success",
                  state === "fail" && "border-destructive/30 bg-destructive/10 text-destructive",
                  state === "skipped" && "border-border/60 text-muted-foreground",
                )}
              >
                {state === "ok" ? <Check className="h-3 w-3" /> : state === "fail" ? <X className="h-3 w-3" /> : <Minus className="h-3 w-3" />}
                {checkLabel(k, tr)}
              </button>
            );
          })}
          <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => setShowChecks(!showChecks)}>
            {showChecks ? tr("隐藏详情", "Hide details") : tr("检查详情", "Check details")}
          </button>
        </div>
        {showChecks && (
          <ul className="space-y-1 rounded-md border border-border/60 bg-muted/20 p-2.5 text-xs">
            {CHECKS.filter((k) => c.checks[k]).map((k) => (
              <li key={k}>
                <span className="font-semibold">{checkLabel(k, tr)}</span>
                {c.checks[k]!.skipped && <span className="text-muted-foreground">{tr("（已跳过）", " (skipped)")}</span>}
                {tr("：", ": ")}
                <span className="text-muted-foreground">{c.checks[k]!.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border/40 pt-3">
        {c.adopted_item_id ? (
          <Badge variant="success" className="gap-1">
            <CheckCircle2 className="h-3 w-3" />
            {tr("已采纳", "Adopted")}
          </Badge>
        ) : (
          <>
            {manualCats.length > 0 && (
              <NativeSelect value={cat} onChange={setCat} className="h-8 w-auto max-w-[12rem] text-xs" ariaLabel={tr("采纳到分类", "Adopt into category")}>
                <option value="">{tr("（不加入分类）", "(no category)")}</option>
                {manualCats.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </NativeSelect>
            )}
            <Button size="sm" variant={c.passed ? "default" : "outline"} className="gap-1.5" loading={busy} onClick={() => void adopt()}>
              <CheckCircle2 className="h-3.5 w-3.5" />
              {tr("采纳入库", "Adopt into bank")}
            </Button>
          </>
        )}
        <Button size="sm" variant="ghost" className="gap-1.5" onClick={onUse}>
          <ArrowRight className="h-3.5 w-3.5" />
          {tr("使用此题", "Use this problem")}
        </Button>
      </div>
      {!c.passed && !c.adopted_item_id && (
        <p className="text-xs text-warning">{tr("未通过检查：采纳后将标记为“未校验”。", "This candidate failed a check: adopting it marks it as \"unchecked\".")}</p>
      )}
      <ErrorNote message={error} />
    </div>
  );
}
