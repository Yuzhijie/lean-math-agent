"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ClipboardCheck, FileText, Library, Loader2, Plus, Sparkles, Target } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { gradeLabel, statusLabel, statusVariant } from "@/lib/exam/labels";
import { presetBlueprint } from "@/lib/exam/preset";
import { LocaleSwitcher } from "../components/LocaleSwitcher";
import { AuthButton } from "../components/AuthButton";
import { ErrorNote } from "../components/bank/ui";
import { BlueprintEditor, useBankChoices, type BankChoice } from "../components/exam/BlueprintEditor";
import { ExamView } from "../components/exam/ExamView";
import { PlanView } from "../components/exam/PlanView";
import { api, errMsg, type Blueprint, type Exam, type ExamSummary } from "../components/exam/api";

export default function ExamPage() {
  return (
    <Suspense fallback={<Skeleton className="m-6 h-64" />}>
      <Exams />
    </Suspense>
  );
}

/**
 * 试卷 — whole papers of generated questions, several kinds on one paper (choice, fill in the blank,
 * worked problems, proofs), every question checked like any generated one, printed in sections and
 * marked against its own answers (批改 → 整张答卷 → 按生成的试卷批改). The marking comes back here: a
 * targeted paper is planned from a student's or the class's marked work (?member=<id> / ?class=1),
 * and the next one from that paper's marking — question writing and marking close the loop.
 * URL: ?id=<exam> | ?new=1 | ?member=<id> | ?class=1.
 */
function Exams() {
  const { tr } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get("id");
  const memberId = params.get("member");
  const forClass = params.get("class") === "1";
  const isNew = params.get("new") === "1";
  const opened = !!(id || memberId || forClass || isNew);
  const banks = useBankChoices();
  const [exams, setExams] = useState<ExamSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((n) => n + 1), []);

  useEffect(() => {
    let off = false;
    api<{ exams: ExamSummary[] }>("/api/exams")
      .then((r) => !off && setExams(r.exams))
      .catch((e) => !off && setError(errMsg(e, tr("读取失败", "Could not load"))));
    return () => {
      off = true;
    };
  }, [reload, tr]);

  const open = (examId: string) => (refresh(), router.push(`/exam?id=${encodeURIComponent(examId)}`));

  return (
    <div className="relative z-10 min-h-screen">
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto max-w-screen-2xl px-4 sm:px-6">
          <div className="flex h-14 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
                <FileText className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h1 className="truncate font-serif text-base font-bold leading-none tracking-tight">{tr("试卷", "Exams")}</h1>
                <p className="truncate text-[11px] text-muted-foreground">{tr("组卷出题 · 按批改结果出针对性试卷", "Whole papers · targeted papers from the marking")}</p>
              </div>
            </div>
            <div className="flex items-center gap-1 sm:gap-3">
              <LocaleSwitcher />
              <Link href="/grading" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "gap-1.5")}>
                <ClipboardCheck className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{tr("批改", "Marking")}</span>
              </Link>
              <Link href="/bank" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "gap-1.5")}>
                <Library className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{tr("题库", "Bank")}</span>
              </Link>
              <Link href="/" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "gap-1.5")}>
                <ArrowLeft className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{tr("返回求解", "Back to solver")}</span>
              </Link>
              <AuthButton signedInOnly />
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-screen-2xl gap-5 px-4 py-5 sm:px-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className={cn("space-y-3", opened && "hidden lg:block")}>
          <Button className="w-full gap-1.5" onClick={() => router.push("/exam?new=1")}>
            <Plus className="h-4 w-4" />
            {tr("新建试卷", "New exam")}
          </Button>
          <ErrorNote message={error} onDismiss={() => setError(null)} />
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{tr("我的试卷", "My exams")}</h2>
          {!exams ? (
            <Skeleton className="h-32" />
          ) : exams.length === 0 ? (
            <p className="text-xs text-muted-foreground">{tr("还没有试卷。", "No exams yet.")}</p>
          ) : (
            <div className="space-y-1.5" data-testid="exam-list">
              {exams.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => router.push(`/exam?id=${encodeURIComponent(e.id)}`)}
                  className={cn("w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-muted/40", id === e.id ? "border-primary/60 bg-primary/5" : "border-border/60")}
                >
                  <span className="flex items-center gap-1.5">
                    {e.basis && <Target className="h-3.5 w-3.5 shrink-0 text-primary" aria-label={tr("针对性试卷", "Targeted")} />}
                    <span className="min-w-0 flex-1 truncate font-medium">{e.title}</span>
                    {e.status === "generating" ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" /> : e.status !== "ready" && <Badge variant={statusVariant(e.status)} className="shrink-0 text-[10px]">{statusLabel(e.status, tr)}</Badge>}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    {gradeLabel(e.grade_level, tr)} · {tr(`${e.questions}/${e.planned} 题 · ${e.total} 分`, `${e.questions}/${e.planned} q · ${e.total} pts`)} · {new Date(e.created_at).toLocaleDateString()}
                  </span>
                </button>
              ))}
            </div>
          )}
        </aside>

        <section className="min-w-0">
          {opened && (
            <Link href="/exam" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "mb-2 gap-1.5 lg:hidden")}>
              <ArrowLeft className="h-3.5 w-3.5" />
              {tr("我的试卷", "My exams")}
            </Link>
          )}
          {id ? (
            <ExamView key={id} id={id} onChanged={refresh} onDeleted={() => (refresh(), router.push("/exam"))} />
          ) : memberId || forClass ? (
            <PlanView key={memberId ?? "class"} memberId={memberId ?? undefined} banks={banks} onCreated={open} />
          ) : isNew ? (
            <NewExam banks={banks} onCreated={open} />
          ) : (
            <Intro />
          )}
        </section>
      </main>
    </div>
  );
}

function NewExam({ banks, onCreated }: { banks: BankChoice[]; onCreated: (id: string) => void }) {
  const { tr } = useI18n();
  const [bp, setBp] = useState<Blueprint>(() => presetBlueprint("middle", tr("单元测验", "Unit test")));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await api<{ exam: Exam }>("/api/exams", { method: "POST", json: { blueprint: bp } });
      onCreated(r.exam.id);
    } catch (e) {
      setError(errMsg(e, tr("开始生成失败", "Could not start")));
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{tr("新建试卷", "New exam")}</h2>
        <p className="text-sm text-muted-foreground">
          {tr("一张试卷由若干部分组成，每部分一种题型（选择、填空、解答、证明），可以来自内置出题或你的题库。打印时按题型分大题、连续编号并标分值。", "A paper is made of parts, each one kind of question (choice, fill-in, worked, proof), from the built-in generator or your bank. It prints in sections by kind, numbered through, with points.")}
        </p>
      </div>
      <BlueprintEditor value={bp} onChange={setBp} banks={banks} disabled={busy} />
      <ErrorNote message={error} onDismiss={() => setError(null)} />
      <Button onClick={() => void start()} disabled={busy || !bp.title.trim()} className="gap-2" data-testid="exam-start">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
        {tr("开始生成", "Write the paper")}
      </Button>
    </div>
  );
}

function Intro() {
  const { tr } = useI18n();
  return (
    <div className="max-w-2xl space-y-3 text-sm text-muted-foreground">
      <h2 className="text-base font-semibold text-foreground">{tr("出整张试卷，按批改结果出针对性试卷", "Whole papers, and targeted papers from the marking")}</h2>
      <p>{tr("“新建试卷”：选学段，按部分组卷——每部分一种题型、内容或题库模板、难度、题数和分值。每道题都经过独立重解和 Lean 反例检查，通过的才放进试卷。", "“New exam”: pick the level and build the paper in parts — kind of question, subject or bank template, difficulty, count and points each. Every question is solved again independently and searched for a counterexample in Lean; only those that pass go on the paper.")}</p>
      <p>{tr("打印后让学生作答，在“批改 → 整张答卷”里选这张试卷上传照片：按题号对上答案、知识点和分值逐题批改，并给出得分。", "Print it, let students answer, then under “Marking → Whole paper” choose this exam and upload the photos: questions are matched by number to the answers, skills and points, marked one by one, and scored.")}</p>
      <p>{tr("批改结果回到这里：在学生页点“生成针对性试卷”，或在全体学情点“按全班薄弱点出卷”，程序按各知识点的掌握情况规划下一张试卷——没掌握的多出、降一级难度、做错的题出变式，已掌握的少出、升一级。出卷 → 批改 → 再出卷，形成闭环。", "The marking comes back here: “Targeted paper” on a student, or “Paper on the class's weak skills”, plans the next paper from each skill's mastery — more questions, one step easier and variants of what was got wrong where a skill is not mastered; fewer and one step harder where it is. Write → mark → write again: the loop is closed.")}</p>
      <Link href="/grading" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}>
        <ClipboardCheck className="h-3.5 w-3.5" />
        {tr("去批改", "Go to marking")}
      </Link>
    </div>
  );
}
