"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, RefreshCw, Sparkles, Target } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/lib/i18n";
import { masteryLabel, masteryVariant } from "@/lib/exam/labels";
import type { GradeLevel } from "@/lib/types";
import { ErrorNote, FieldLabel } from "../bank/ui";
import { BlueprintEditor, type BankChoice } from "./BlueprintEditor";
import { api, errMsg, type Blueprint, type Exam, type PlanResponse, type SkillRow } from "./api";

/**
 * The next paper planned from marked work — the student's (`memberId`) or the whole class's: what
 * the marking says per skill (the teacher's corrections count), the paper the program plans from it
 * (weak skills get more questions, one step easier, variants of the questions got wrong; mastered
 * ones fewer, one step harder), editable before it is written.
 */
export function PlanView({ memberId, banks, onCreated }: { memberId?: string; banks: BankChoice[]; onCreated: (examId: string) => void }) {
  const { tr } = useI18n();
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [blueprint, setBlueprint] = useState<Blueprint | null>(null);
  const [questions, setQuestions] = useState(10);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);

  const request = useCallback(
    (opts: { questions?: number; grade_level?: GradeLevel; title?: string } = {}) =>
      api<PlanResponse>("/api/exams/plan", { method: "POST", json: { ...(memberId ? { member_id: memberId } : { scope: "class" }), ...opts } })
        .then((r) => {
          setPlan(r);
          setBlueprint(r.blueprint);
          setQuestions(r.blueprint.parts.reduce((a, p) => a + p.count, 0));
        })
        .catch((e) => setError(errMsg(e, tr("规划失败", "Could not plan the paper"))))
        .finally(() => setLoading(false)),
    [memberId, tr],
  );
  useEffect(() => {
    void request();
  }, [request]);
  const load = (opts: { questions?: number; grade_level?: GradeLevel; title?: string }) => {
    setError(null);
    setLoading(true);
    void request(opts);
  };

  const start = async () => {
    if (!blueprint || !plan) return;
    setError(null);
    setStarting(true);
    try {
      const r = await api<{ exam: Exam }>("/api/exams", { method: "POST", json: { blueprint, basis: plan.basis } });
      onCreated(r.exam.id);
    } catch (e) {
      setError(errMsg(e, tr("开始生成失败", "Could not start")));
      setStarting(false);
    }
  };

  if (loading && !plan) return error ? <ErrorNote message={error} /> : <Skeleton className="h-64" />;
  if (!plan || !blueprint) {
    return (
      <div className="space-y-2">
        <ErrorNote message={error} />
        <Link href={memberId ? `/grading?member=${encodeURIComponent(memberId)}` : "/grading"} className="text-sm text-primary hover:underline">
          {tr("去批改作答", "Go to marking")}
        </Link>
      </div>
    );
  }
  const who = plan.basis.scope === "class" ? tr("全班", "the class") : plan.basis.name;
  const planFor = (k: string) => blueprint.parts.filter((p) => p.target?.knowledge_point === k || (!p.target && p.knowledge_points[0] === k));

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Target className="h-5 w-5 text-primary" />
          {tr(`为${who}出针对性试卷`, `A targeted paper for ${who}`)}
        </h2>
        <p className="text-sm text-muted-foreground">
          {tr(
            `依据最近 ${plan.basis.submissions} 道已批改的题（老师改判的以老师为准）。没掌握的知识点多出题、降一级难度，做错的题出变式；已掌握的少出、升一级难度。生成前可以改。`,
            `From the latest ${plan.basis.submissions} marked questions (your corrections count). Skills not yet mastered get more questions, one step easier, and variants of the questions got wrong; mastered ones fewer, one step harder. Edit before it is written.`,
          )}
        </p>
      </div>
      <ErrorNote message={error} onDismiss={() => setError(null)} />

      <div className="overflow-x-auto rounded-md border border-border/60">
        <table className="w-full text-sm" data-testid="plan-skills">
          <thead className="bg-muted/30 text-[11px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5 text-left">{tr("知识点", "Skill")}</th>
              <th className="px-3 py-1.5 text-left">{tr("掌握", "Mastery")}</th>
              <th className="px-3 py-1.5 text-right">{tr("答对", "Right")}</th>
              {plan.basis.scope === "class" && <th className="px-3 py-1.5 text-right">{tr("薄弱学生", "Students weak")}</th>}
              <th className="px-3 py-1.5 text-left">{tr("这张卷", "On this paper")}</th>
            </tr>
          </thead>
          <tbody>
            {plan.records.map((r) => (
              <SkillLine key={r.knowledge_point} r={r} cls={plan.basis.scope === "class"} parts={planFor(r.knowledge_point)} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-end gap-2 rounded-md border border-border/60 p-3">
        <div className="w-28 space-y-1">
          <FieldLabel>{tr("题量（4–20）", "Questions (4–20)")}</FieldLabel>
          <Input type="number" min={4} max={20} value={questions} onChange={(e) => setQuestions(Math.max(4, Math.min(20, Math.round(Number(e.target.value)) || 10)))} className="h-9 tabular-nums" />
        </div>
        <Button variant="outline" size="sm" className="h-9 gap-1.5" disabled={loading} onClick={() => load({ questions, grade_level: blueprint.grade_level, title: blueprint.title })}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {tr("按这个题量重新规划", "Plan again with this many")}
        </Button>
        <span className="text-[11px] text-muted-foreground">{tr("重新规划会替换下面对各部分的修改。", "Planning again replaces your edits below.")}</span>
      </div>

      <BlueprintEditor value={blueprint} onChange={setBlueprint} banks={banks} disabled={starting} presets={false} />

      <Button onClick={() => void start()} disabled={starting || !blueprint.title.trim()} className="gap-2" data-testid="plan-start">
        {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
        {tr("开始生成这张试卷", "Write this paper")}
      </Button>
    </div>
  );
}

function SkillLine({ r, cls, parts }: { r: SkillRow; cls: boolean; parts: Blueprint["parts"] }) {
  const { tr } = useI18n();
  const n = parts.reduce((a, p) => a + p.count, 0);
  const variants = parts.filter((p) => p.like.length).reduce((a, p) => a + p.count, 0);
  return (
    <tr className="border-t border-border/40">
      <td className="px-3 py-1.5">{r.knowledge_point}</td>
      <td className="px-3 py-1.5">
        <Badge variant={masteryVariant(r.level)} className="whitespace-nowrap">{masteryLabel(r.level, tr)}</Badge>
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums">
        {r.correct}/{r.attempts}
      </td>
      {cls && <td className="px-3 py-1.5 text-right tabular-nums">{r.students ?? 0}</td>}
      <td className="px-3 py-1.5 text-xs text-muted-foreground">
        {n
          ? tr(`${n} 题${variants ? `（其中 ${variants} 道变式）` : ""}，难度 ${[...new Set(parts.map((p) => p.difficulty))].join("/")}`, `${n} question(s)${variants ? ` (${variants} variants)` : ""}, difficulty ${[...new Set(parts.map((p) => p.difficulty))].join("/")}`)
          : tr("这次不出", "not this time")}
      </td>
    </tr>
  );
}
