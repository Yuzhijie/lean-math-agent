"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, ClipboardCheck, Eye, EyeOff, Loader2, Pencil, Printer, RefreshCw, ShieldCheck, Square, Target, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { gradeLabel, kindLabel, sectionTitle, statusLabel, statusVariant } from "@/lib/exam/labels";
import { examTotal, missingByPart, orderQuestions, plannedTotal } from "@/lib/exam/types";
import { ErrorNote } from "../bank/ui";
import { DiagramSvg } from "../DiagramSvg";
import { MathText } from "../MathText";
import { api, errMsg, examPrintHref, examUrl, type Exam, type ExamQuestion } from "./api";

const POLL_MS = 2500;
const LETTERS = "ABCDEFGH";

/**
 * One exam: while it is written, the run's progress (polled); then the paper in sections — each
 * question with its points, answer (shown on demand), the checks it passed and its skills —, the
 * parts still short with “fill in”, the questions that failed their checks, printing (questions;
 * answers on a separate page) and marking a paper against it.
 */
export function ExamView({ id, onDeleted, onChanged }: { id: string; onDeleted: () => void; onChanged: () => void }) {
  const { tr } = useI18n();
  const [exam, setExam] = useState<Exam | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [showRejected, setShowRejected] = useState(false);
  const generating = exam?.status === "generating";

  useEffect(() => {
    let off = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      api<{ exam: Exam }>(examUrl(id))
        .then((r) => {
          if (off) return;
          setExam(r.exam);
          if (r.exam.status === "generating") timer = setTimeout(load, POLL_MS);
          else onChanged();
        })
        .catch((e) => !off && setError(errMsg(e, tr("读取失败", "Could not load"))));
    void load();
    return () => {
      off = true;
      if (timer) clearTimeout(timer);
    };
    // loaded again when a run starts (fill) or ends; onChanged is the parent's refresh, not a reason to reload
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, tr, generating]);

  const sections = useMemo(() => {
    if (!exam) return [];
    const out: { kind: ExamQuestion["kind"]; questions: ExamQuestion[] }[] = [];
    for (const q of orderQuestions(exam.questions, exam.parts)) {
      const last = out[out.length - 1];
      if (last?.kind === q.kind) last.questions.push(q);
      else out.push({ kind: q.kind, questions: [q] });
    }
    return out;
  }, [exam]);

  if (!exam) return error ? <ErrorNote message={error} /> : <Skeleton className="h-64" />;
  const missing = missingByPart(exam);
  const short = [...missing.values()].reduce((a, b) => a + b, 0);
  const planned = exam.parts.reduce((a, p) => a + p.count, 0);

  const change = async (body: Record<string, unknown>) => {
    setError(null);
    try {
      const r = await api<{ exam: Exam }>(examUrl(id), { method: "PATCH", json: body });
      setExam(r.exam);
      onChanged();
    } catch (e) {
      setError(errMsg(e, tr("操作失败", "Failed")));
    }
  };
  const fill = async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await api<{ exam: Exam }>(examUrl(id, "/fill"), { method: "POST" });
      setExam(r.exam);
      onChanged();
    } catch (e) {
      setError(errMsg(e, tr("补题失败", "Could not fill in")));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!window.confirm(tr("删除这张试卷？已经按它批改的答卷不受影响。", "Delete this exam? Papers already marked against it are kept."))) return;
    try {
      await api(examUrl(id), { method: "DELETE" });
      onDeleted();
    } catch (e) {
      setError(errMsg(e, tr("删除失败", "Deleting failed")));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {editing !== null ? (
          <form
            className="flex min-w-0 flex-1 items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void change({ title: editing }).then(() => setEditing(null));
            }}
          >
            <Input value={editing} maxLength={100} onChange={(e) => setEditing(e.target.value)} className="h-8 max-w-md" autoFocus />
            <Button size="sm" type="submit" className="h-8" disabled={!editing.trim()}>
              {tr("保存", "Save")}
            </Button>
            <Button size="sm" type="button" variant="ghost" className="h-8 w-8 p-0" aria-label={tr("取消", "Cancel")} onClick={() => setEditing(null)}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </form>
        ) : (
          <>
            <h2 className="text-lg font-semibold" data-testid="exam-title">
              {exam.title}
            </h2>
            <button type="button" className="text-muted-foreground hover:text-foreground" aria-label={tr("改名", "Rename")} onClick={() => setEditing(exam.title)}>
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </>
        )}
        <Badge variant={statusVariant(exam.status)} data-testid="exam-status">
          {statusLabel(exam.status, tr)}
        </Badge>
        <span className="text-sm text-muted-foreground">
          {gradeLabel(exam.grade_level, tr)} · {tr(`${exam.questions.length}/${planned} 题 · ${examTotal(exam.questions)} 分`, `${exam.questions.length}/${planned} questions · ${examTotal(exam.questions)} points`)}
        </span>
      </div>

      {exam.basis && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm" data-testid="exam-basis">
          <Target className="h-4 w-4 shrink-0 text-primary" />
          <span>
            {exam.basis.scope === "class"
              ? tr(`按全班的批改结果出的针对性试卷：依据 ${exam.basis.submissions} 道已批改的题`, `Targeted at the class from the marking: ${exam.basis.submissions} marked questions`)
              : tr(`为 ${exam.basis.name} 出的针对性试卷：依据 ${exam.basis.submissions} 道已批改的题`, `Targeted at ${exam.basis.name} from the marking: ${exam.basis.submissions} marked questions`)}
            {exam.basis.exam_ids.length > 0 && tr(`（含 ${exam.basis.exam_ids.length} 张试卷的答卷）`, ` (papers of ${exam.basis.exam_ids.length} exam(s) among them)`)}
            {" · "}
            {new Date(exam.basis.at).toLocaleDateString()}
          </span>
          {exam.basis.member_id && (
            <Link href={`/grading?member=${encodeURIComponent(exam.basis.member_id)}`} className="ml-auto text-xs text-primary hover:underline">
              {tr("看学情", "Learning record")}
            </Link>
          )}
        </div>
      )}

      {generating && (
        <div className="space-y-1.5 rounded-md border border-border/60 p-3" data-testid="exam-progress">
          <div className="flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <span className="min-w-0 flex-1 truncate">{exam.progress?.message ?? tr("生成中…", "Generating…")}</span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {exam.progress ? tr(`${exam.progress.part}/${exam.progress.parts} 部分`, `${exam.progress.part}/${exam.progress.parts} parts`) : ""}
            </span>
            <Button size="sm" variant="outline" className="h-7 shrink-0 gap-1 text-xs" onClick={() => void change({ cancel: true })}>
              <Square className="h-3 w-3" />
              {tr("停止", "Stop")}
            </Button>
          </div>
          <div className="h-1.5 overflow-hidden rounded bg-muted">
            <div className="h-full bg-primary transition-all" style={{ width: `${Math.round((100 * exam.questions.length) / Math.max(1, planned))}%` }} />
          </div>
          <p className="text-[11px] text-muted-foreground">{tr("每道题都会独立重解、在 Lean 里找反例，通过检查的才放进试卷；可以离开这个页面，回来再看。", "Every question is solved again independently and searched for a counterexample in Lean; only questions that pass go on the paper. You can leave this page and come back.")}</p>
        </div>
      )}

      {exam.note && !generating && <p className="whitespace-pre-line rounded-md bg-warning/10 px-3 py-2 text-xs">{exam.note}</p>}
      <ErrorNote message={error} onDismiss={() => setError(null)} />

      <div className="flex flex-wrap items-center gap-2">
        {exam.questions.length > 0 && (
          <>
            <a href={examPrintHref(exam.id)} target="_blank" rel="noreferrer" className={cn(buttonVariants({ size: "sm" }), "gap-1.5")}>
              <Printer className="h-3.5 w-3.5" />
              {tr("打印 / 导出 PDF", "Print / PDF")}
            </a>
            <a href={examPrintHref(exam.id, "end")} target="_blank" rel="noreferrer" className={cn(buttonVariants({ size: "sm", variant: "outline" }), "gap-1.5")}>
              {tr("答案另页", "With answers at the end")}
            </a>
            <Link href={`/grading?exam=${encodeURIComponent(exam.id)}${exam.basis?.member_id ? `&member=${encodeURIComponent(exam.basis.member_id)}` : ""}`} className={cn(buttonVariants({ size: "sm", variant: "outline" }), "gap-1.5")} title={tr("上传学生做完的这张卷：按题号对上答案、知识点和分值批改", "Upload a student's answered copy: marked by question number against its answers, skills and points")}>
              <ClipboardCheck className="h-3.5 w-3.5" />
              {tr("用这张卷批改", "Mark a paper of it")}
            </Link>
            <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => setAnswers((x) => !x)}>
              {answers ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              {answers ? tr("隐藏答案", "Hide answers") : tr("显示答案", "Show answers")}
            </Button>
          </>
        )}
        {!generating && short > 0 && (
          <Button size="sm" variant="outline" className="gap-1.5" disabled={busy} onClick={() => void fill()}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {tr(`补齐缺题（${short} 道）`, `Fill in the missing questions (${short})`)}
          </Button>
        )}
        <Button size="sm" variant="ghost" className="ml-auto gap-1 text-destructive" onClick={() => void remove()}>
          <Trash2 className="h-3.5 w-3.5" />
          {tr("删除试卷", "Delete exam")}
        </Button>
      </div>

      <details className="rounded-md border border-border/60 text-sm">
        <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">{tr(`试卷结构：${exam.parts.length} 个部分，计划 ${planned} 题 ${plannedTotal(exam.parts)} 分`, `Layout: ${exam.parts.length} parts, ${planned} questions planned, ${plannedTotal(exam.parts)} points`)}</summary>
        <ul className="space-y-1 border-t border-border/40 px-3 py-2 text-xs">
          {exam.parts.map((p, i) => (
            <li key={p.id} className="flex flex-wrap gap-x-2">
              <span className="font-medium">{tr(`第 ${i + 1} 部分`, `Part ${i + 1}`)}</span>
              <span>
                {kindLabel(p.kind, tr)} × {p.count} · {tr(`每题 ${p.points} 分`, `${p.points} points each`)} · {tr(`难度 ${p.difficulty}`, `difficulty ${p.difficulty}`)}
                {p.knowledge_points.length > 0 && ` · ${p.knowledge_points.join("、")}`}
                {p.source.kind === "bank" && ` · ${tr("题库", "bank")} ${p.source.bank_name ?? ""}`}
              </span>
              {missing.get(p.id) ? <span className="text-warning">{tr(`缺 ${missing.get(p.id)} 道`, `${missing.get(p.id)} missing`)}</span> : null}
              {p.reason && <span className="w-full text-muted-foreground">{p.reason}</span>}
            </li>
          ))}
        </ul>
      </details>

      {sections.map((s, si) => (
        <section key={`${s.kind}-${si}`} className="space-y-2">
          <h3 className="text-sm font-semibold" data-testid="exam-section">
            {sectionTitle(si, s.kind, s.questions.map((q) => q.points), tr)}
          </h3>
          {s.questions.map((q) => (
            <QuestionCard key={q.id} q={q} answer={answers} onRemove={generating ? undefined : () => void change({ remove_question: q.id })} />
          ))}
        </section>
      ))}
      {!exam.questions.length && !generating && <p className="text-sm text-muted-foreground">{tr("还没有通过检查的题。", "No question has passed its checks yet.")}</p>}

      {exam.rejected.length > 0 && (
        <div className="rounded-md border border-border/60">
          <button type="button" className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs text-muted-foreground" onClick={() => setShowRejected((x) => !x)}>
            {showRejected ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {tr(`没有通过检查、没放进试卷的题（${exam.rejected.length}）`, `Questions that failed their checks and were left out (${exam.rejected.length})`)}
          </button>
          {showRejected && (
            <ul className="space-y-2 border-t border-border/40 px-3 py-2 text-xs">
              {exam.rejected.map((r, i) => (
                <li key={i}>
                  <MathText text={r.stem} />
                  <p className="text-destructive">{r.reason}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function QuestionCard({ q, answer, onRemove }: { q: ExamQuestion; answer: boolean; onRemove?: () => void }) {
  const { tr } = useI18n();
  const [open, setOpen] = useState(false);
  const shown = answer || open;
  return (
    <div className="rounded-md border border-border/60 p-3" data-testid="exam-question">
      <div className="flex gap-2">
        <span className="shrink-0 font-semibold tabular-nums">{q.no}.</span>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="text-sm">
            <span className="mr-1 text-xs text-muted-foreground">{tr(`（${q.points} 分）`, `(${q.points} pts)`)}</span>
            <MathText text={q.stem} />
          </div>
          {q.figure_svg && <DiagramSvg svg={q.figure_svg} />}
          {q.options && (
            <ol className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              {q.options.map((o, i) => (
                <li key={i} className={cn(shown && q.answer === LETTERS[i] && "font-semibold text-success")}>
                  {LETTERS[i]}. <MathText text={o} />
                </li>
              ))}
            </ol>
          )}
          {shown && (
            <div className="space-y-1 rounded bg-muted/30 px-2 py-1.5 text-sm" data-testid="exam-answer">
              <p>
                <span className="font-medium">{tr("答案：", "Answer: ")}</span>
                <MathText text={q.answer} />
              </p>
              {q.solution && (
                <div className="text-xs text-muted-foreground">
                  <MathText text={q.solution} />
                </div>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            {q.knowledge_points.map((k) => (
              <Badge key={k} variant="outline" className="text-[10px]">
                {k}
              </Badge>
            ))}
            <span>{tr(`难度 ${q.difficulty}`, `difficulty ${q.difficulty}`)}</span>
            {q.checked && (
              <span className="inline-flex items-center gap-1">
                <ShieldCheck className={cn("h-3 w-3", q.lean_proved ? "text-success" : "")} />
                {q.checked}
              </span>
            )}
            <span className="ml-auto flex gap-1">
              {!answer && (
                <button type="button" className="hover:text-foreground" onClick={() => setOpen((x) => !x)}>
                  {open ? tr("收起答案", "Hide answer") : tr("看答案", "Answer")}
                </button>
              )}
              {onRemove && (
                <button type="button" className="text-destructive hover:underline" onClick={onRemove} title={tr("从试卷拿掉（之后可以“补齐缺题”换一道）", "Take it off the paper (“fill in” writes another)")}>
                  {tr("换掉", "Remove")}
                </button>
              )}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
