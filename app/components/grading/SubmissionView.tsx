"use client";

import { useState } from "react";
import { CheckCircle2, CircleAlert, CircleHelp, Lightbulb, Loader2, RotateCcw, Trash2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { effectiveScore, VERDICTS } from "@/lib/grading/types";
import { MathText } from "../MathText";
import { ErrorNote, FieldLabel, NativeSelect } from "../bank/ui";
import { api, errMsg, imageUrl, paperImageUrl, type SubmissionDetail } from "./api";
import { errorTypeLabel, referenceSourceLabel, verdictLabel, verdictVariant } from "./labels";

const STEP_STYLE = {
  correct: { icon: CheckCircle2, cls: "text-success" },
  error: { icon: XCircle, cls: "text-destructive" },
  unjustified: { icon: CircleAlert, cls: "text-warning" },
  unclear: { icon: CircleHelp, cls: "text-muted-foreground" },
} as const;

/** One marked piece of work: the photos beside what was read, step by step, and the marking. */
export function SubmissionView({ detail, onChanged, onDeleted }: { detail: SubmissionDetail; onChanged: (d: SubmissionDetail) => void; onDeleted: () => void }) {
  const { tr } = useI18n();
  const { submission: s, role, member } = detail;
  // A question of a whole paper shows the paper's pages.
  const photos = detail.paper ? detail.paper.images : s.images;
  const photoUrl = (name: string) => (detail.paper ? paperImageUrl(detail.paper.id, name) : imageUrl(s.id, name));
  const mk = s.marking;
  const verdict = s.teacher?.verdict ?? mk?.verdict;
  const [note, setNote] = useState(s.teacher?.note ?? "");
  const [override, setOverride] = useState(s.teacher?.verdict ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await api<{ submission: SubmissionDetail["submission"] }>(`/api/grading/submissions/${s.id}`, {
        method: "PATCH",
        json: { verdict: override || null, note },
      });
      onChanged({ ...detail, submission: r.submission });
    } catch (e) {
      setError(errMsg(e, tr("保存失败", "Saving failed")));
    } finally {
      setSaving(false);
    }
  };

  const [remarking, setRemarking] = useState(false);
  const remark = async () => {
    setRemarking(true);
    setError(null);
    try {
      const r = await api<{ submission: SubmissionDetail["submission"] }>(`/api/grading/submissions/${s.id}/remark`, { method: "POST" });
      onChanged({ ...detail, submission: r.submission });
    } catch (e) {
      setError(errMsg(e, tr("重新批改失败", "Marking again failed")));
    } finally {
      setRemarking(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(tr("删除这次作答和照片？", "Delete this work and its photos?"))) return;
    try {
      await api(`/api/grading/submissions/${s.id}`, { method: "DELETE" });
      onDeleted();
    } catch (e) {
      setError(errMsg(e, tr("删除失败", "Deleting failed")));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">{member.name}</h2>
        <span className="text-xs text-muted-foreground">{new Date(s.created_at).toLocaleString()}</span>
        <Badge variant={verdictVariant(verdict)}>{verdictLabel(verdict, tr)}</Badge>
        {mk && verdict !== "unreadable" && <Badge variant="outline">{tr(`${effectiveScore(s)} 分`, `${effectiveScore(s)} points`)}</Badge>}
        {mk?.needs_review && !s.teacher?.verdict && (
          <Badge variant="warning" title={tr("答案没能自动判定，或参考答案是模型解出的", "The answer could not be decided automatically, or the reference was solved by a model")}>
            {tr("需老师确认", "Teacher should check")}
          </Badge>
        )}
        {s.teacher?.verdict && <Badge variant="info">{tr("老师已改判", "Corrected by the teacher")}</Badge>}
        {(s.status === "failed" || role === "teacher") && (
          <Button variant="outline" size="sm" className="ml-auto gap-1.5" onClick={() => void remark()} disabled={remarking}>
            {remarking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
            {tr("重新批改", "Mark again")}
          </Button>
        )}
        {(role === "teacher" || detail.own) && (
          <Button variant="ghost" size="sm" className={cn("gap-1.5 text-destructive", !(s.status === "failed" || role === "teacher") && "ml-auto")} onClick={() => void remove()}>
            <Trash2 className="h-3.5 w-3.5" />
            {tr("删除", "Delete")}
          </Button>
        )}
      </div>

      <div className="rounded-md border border-border/60 bg-muted/20 p-3 text-sm">
        <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{tr("题目", "Problem")}</p>
        <MathText text={s.problem.text} />
        {s.problem.figure && <p className="mt-2 text-xs text-muted-foreground">{tr("图形：", "Figure: ")}{s.problem.figure}</p>}
      </div>

      {s.status === "failed" && <ErrorNote message={tr(`批改失败：${s.error ?? ""}`, `Marking failed: ${s.error ?? ""}`)} />}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Photos */}
        <div className="space-y-2">
          <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{detail.paper ? tr(`答卷照片（第 ${s.question_no ?? "?"} 题在其中）`, `Paper pages (question ${s.question_no ?? "?"} is on them)`) : tr("作答照片", "Photos")}</p>
          <div className="grid grid-cols-2 gap-2">
            {photos.map((name) => (
              <button key={name} type="button" onClick={() => setZoom(name)} className="overflow-hidden rounded border border-border/60">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photoUrl(name)} alt={name} className="w-full object-contain" />
              </button>
            ))}
          </div>
        </div>

        {/* What was read, step by step, with the marking */}
        {s.reading && (
        <div className="space-y-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{tr("读出的解题过程", "The working as read")}</p>
          {s.reading?.note && <p className="text-xs text-warning">{s.reading.note}</p>}
          <ol className="space-y-1.5">
            {(s.reading?.steps ?? []).map((st, i) => {
              const j = mk?.steps.find((x) => x.index === i + 1);
              const style = j ? STEP_STYLE[j.verdict] : null;
              const Icon = style?.icon;
              return (
                <li
                  key={i}
                  className={cn(
                    "rounded-md border px-2.5 py-1.5 text-sm",
                    mk?.first_error_step === i + 1 ? "border-destructive/50 bg-destructive/5" : "border-border/50",
                    st.crossed_out && "opacity-60 line-through",
                  )}
                >
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 w-5 shrink-0 text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                    {Icon && <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", style!.cls)} />}
                    <div className="min-w-0 flex-1">
                      <MathText text={st.text} />
                      {st.unclear && <span className="ml-1 text-[11px] text-muted-foreground">{tr("（字迹不清）", "(unclear)")}</span>}
                      {j?.comment && <p className={cn("mt-0.5 text-xs", style?.cls)}>{j.comment}</p>}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-md border border-border/60 p-2.5 text-sm">
              <p className="text-[11px] text-muted-foreground">{tr("学生的答案", "Student's answer")}</p>
              {s.reading?.final_answer ? <MathText text={s.reading.final_answer} /> : <span className="text-muted-foreground">{tr("（没有写答案）", "(no answer)")}</span>}
              {mk && mk.answer_correct !== null && (
                <p className={cn("mt-1 text-xs", mk.answer_correct ? "text-success" : "text-destructive")}>
                  {mk.answer_correct ? tr("答案正确", "Right answer") : tr("答案不对", "Wrong answer")}
                  {mk.answer_check === "program" ? tr("（程序比对）", " (checked by the program)") : mk.answer_check === "model" ? tr("（模型判断等价）", " (judged equivalent by the model)") : ""}
                </p>
              )}
            </div>
            <div className="rounded-md border border-border/60 p-2.5 text-sm">
              <p className="text-[11px] text-muted-foreground">
                {tr(`参考答案（${referenceSourceLabel(s.reference.source, tr)}）`, `Reference answer (${referenceSourceLabel(s.reference.source, tr)})`)}
              </p>
              {s.reference.answer ? <MathText text={s.reference.answer} /> : <span className="text-muted-foreground">—</span>}
            </div>
          </div>
        </div>
        )}
      </div>

      {mk && (
        <div className="space-y-3 rounded-md border border-border/60 p-3">
          {mk.approach && (
            <p className="text-sm">
              <span className="font-semibold">{tr("解题思路：", "Approach: ")}</span>
              {mk.approach}
              {mk.approach_valid !== null && (
                <span className={cn("ml-1 text-xs", mk.approach_valid ? "text-success" : "text-destructive")}>
                  {mk.approach_valid ? tr("（思路可行）", "(a workable approach)") : tr("（思路行不通）", "(this approach does not work)")}
                </span>
              )}
            </p>
          )}
          {mk.error_types.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {mk.error_types.map((e) => (
                <Badge key={e} variant="destructive" className="text-[11px]">
                  {errorTypeLabel(e, tr)}
                </Badge>
              ))}
            </div>
          )}
          <div className="text-sm">
            <MathText text={mk.feedback} />
          </div>
          {mk.hint && (
            <div className="flex items-start gap-2 rounded-md bg-primary/5 p-2.5 text-sm">
              <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <MathText text={mk.hint} />
            </div>
          )}
          {mk.knowledge_points.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {tr("知识点：", "Skills: ")}
              {mk.knowledge_points.join("、")}
            </p>
          )}
        </div>
      )}

      {s.teacher?.note && role === "student" && (
        <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
          <p className="text-[11px] font-bold uppercase tracking-wider text-primary">{tr("老师的话", "From your teacher")}</p>
          <p className="whitespace-pre-wrap">{s.teacher.note}</p>
        </div>
      )}

      {role === "teacher" && mk && (
        <div className="space-y-2 rounded-md border border-border/60 p-3">
          <p className="text-sm font-semibold">{tr("老师复核", "Teacher's review")}</p>
          <div className="grid gap-2 sm:grid-cols-[220px_minmax(0,1fr)]">
            <div className="space-y-1">
              <FieldLabel>{tr("改判", "Change the verdict")}</FieldLabel>
              <NativeSelect value={override} onChange={setOverride}>
                <option value="">{tr(`保持模型的判断（${verdictLabel(mk?.verdict, tr)}）`, `Keep the model's (${verdictLabel(mk?.verdict, tr)})`)}</option>
                {VERDICTS.map((v) => (
                  <option key={v} value={v}>
                    {verdictLabel(v, tr)}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <FieldLabel>{tr("给学生的留言", "Note to the student")}</FieldLabel>
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
            </div>
          </div>
          <ErrorNote message={error} />
          <Button size="sm" onClick={() => void save()} disabled={saving}>
            {tr("保存", "Save")}
          </Button>
        </div>
      )}
      {!(role === "teacher" && mk) && <ErrorNote message={error} />}

      {zoom && (
        <button type="button" className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setZoom(null)} aria-label={tr("关闭", "Close")}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photoUrl(zoom)} alt={zoom} className="max-h-full max-w-full object-contain" />
        </button>
      )}
    </div>
  );
}
