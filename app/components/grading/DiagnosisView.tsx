"use client";

import { useState } from "react";
import Link from "next/link";
import { FileText, Loader2, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { readNdjson } from "@/lib/bank/generation-view";
import { generationPrintHref } from "@/lib/bank/worksheet";
import type { GeneratedProblem } from "@/lib/types";
import { MathText } from "../MathText";
import { ErrorNote } from "../bank/ui";
import { api, errMsg, type Diagnosis } from "./api";

type Tr = (zh: string, en: string) => string;
type Level = Diagnosis["mastery"][number]["level"];
type Rec = Diagnosis["next"][number];

export function masteryLabel(level: Level, tr: Tr): string {
  return { mastered: tr("已掌握", "Mastered"), developing: tr("基本掌握", "Developing"), weak: tr("薄弱", "Weak"), not_yet: tr("未掌握", "Not yet") }[level];
}
const LEVEL_VARIANT: Record<Level, "success" | "info" | "warning" | "destructive"> = { mastered: "success", developing: "info", weak: "warning", not_yet: "destructive" };

/**
 * 学习诊断: how the student works, strengths / weaknesses, mastery per skill (levels computed by
 * the program), and what to test next — each recommendation with one-click practice: from the
 * teacher's bank when it matched one, else from the built-in generator.
 */
export function DiagnosisView({ diagnosis: d, role }: { diagnosis: Diagnosis; role: "teacher" | "student" }) {
  const { tr } = useI18n();
  if (!d.based_on) return <p className="text-sm text-muted-foreground">{tr("还没有可用于诊断的已批改题目。", "No marked questions to diagnose yet.")}</p>;
  return (
    <div className="space-y-4 text-sm">
      {d.summary && <p className="rounded-md bg-primary/5 px-3 py-2 font-medium">{d.summary}</p>}
      {d.approach && (
        <section className="space-y-1">
          <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{tr("解题思路", "How the student works")}</h4>
          <p className="leading-relaxed">{d.approach}</p>
        </section>
      )}
      {(d.strengths.length > 0 || d.weaknesses.length > 0) && (
        <div className="grid gap-3 sm:grid-cols-2">
          <section className="space-y-1">
            <h4 className="text-xs font-bold uppercase tracking-wider text-success">{tr("做得好的", "Strengths")}</h4>
            <ul className="list-disc space-y-0.5 pl-5">
              {d.strengths.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </section>
          <section className="space-y-1">
            <h4 className="text-xs font-bold uppercase tracking-wider text-warning">{tr("需要加强", "To work on")}</h4>
            <ul className="list-disc space-y-0.5 pl-5">
              {d.weaknesses.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </section>
        </div>
      )}
      {d.mastery.length > 0 && (
        <section className="space-y-1">
          <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{tr("知识点掌握", "Mastery by skill")}</h4>
          <div className="overflow-x-auto rounded-md border border-border/60">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-[11px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 text-left">{tr("知识点", "Skill")}</th>
                  <th className="px-3 py-1.5 text-right">{tr("全对/题数", "Correct / tried")}</th>
                  <th className="px-3 py-1.5 text-left">{tr("掌握程度", "Level")}</th>
                  <th className="px-3 py-1.5 text-left">{tr("说明", "Note")}</th>
                </tr>
              </thead>
              <tbody>
                {d.mastery.map((m) => (
                  <tr key={m.knowledge_point} className="border-t border-border/40">
                    <td className="px-3 py-1.5">{m.knowledge_point}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {m.correct}/{m.attempts}
                    </td>
                    <td className="px-3 py-1.5">
                      <Badge variant={LEVEL_VARIANT[m.level]}>{masteryLabel(m.level, tr)}</Badge>
                    </td>
                    <td className="px-3 py-1.5 text-xs text-muted-foreground">{m.note ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-muted-foreground">{tr("程度按得分率计算：全对记 1，答案对但过程有误或思路对但有失误记 0.5；≥80%（至少 2 题）已掌握，≥50% 基本掌握。", "Levels from the credit rate: fully correct 1, right answer with flawed working or right approach with a slip 0.5; ≥ 80 % (2+ questions) mastered, ≥ 50 % developing.")}</p>
        </section>
      )}
      {d.next.length > 0 && (
        <section className="space-y-2">
          <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{tr("下一步测试", "What to test next")}</h4>
          {d.next.map((r, i) => (
            <NextCard key={i} rec={r} role={role} />
          ))}
        </section>
      )}
      <p className="text-[11px] text-muted-foreground">
        {tr(`依据 ${d.based_on} 道已批改的题 · ${new Date(d.created_at).toLocaleString()}`, `From ${d.based_on} marked questions · ${new Date(d.created_at).toLocaleString()}`)}
      </p>
    </div>
  );
}

function NextCard({ rec, role }: { rec: Rec; role: "teacher" | "student" }) {
  const { tr } = useI18n();
  return (
    <div className="space-y-1.5 rounded-md border border-border/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{rec.question_type}</span>
        <Badge variant="outline">{tr(`难度 ${rec.difficulty}/5`, `Difficulty ${rec.difficulty}/5`)}</Badge>
        <Badge variant="outline">{tr(`${rec.count} 题`, `${rec.count} questions`)}</Badge>
      </div>
      {rec.knowledge_points.length > 0 && <p className="text-xs text-muted-foreground">{tr("知识点：", "Skills: ")}{rec.knowledge_points.join("、")}</p>}
      {rec.reason && <p className="text-xs">{rec.reason}</p>}
      <Practice rec={rec} useBank={role === "teacher" && !!rec.bank} />
    </div>
  );
}

/** One-click practice: a worksheet generated from the teacher's bank, or problems from the built-in generator. */
function Practice({ rec, useBank }: { rec: Rec; useBank: boolean }) {
  const { tr } = useI18n();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ href: string; label: string } | null>(null);
  const [problems, setProblems] = useState<GeneratedProblem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fromBank = async () => {
    const b = rec.bank!;
    const res = await fetch("/api/generate-problem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "bank", bank_id: b.bank_id, knowledge_point: b.knowledge_point, difficulty: rec.difficulty, count: rec.count, stream: true }),
    });
    if (!res.ok || !res.body) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }
    let result: { generation_id?: string; problems?: GeneratedProblem[] } | null = null;
    let failure: string | null = null;
    await readNdjson(res.body, (line) => {
      if (line.type === "progress" && typeof line.detail === "string") setProgress(line.detail);
      if (line.type === "result") result = line as typeof result;
      if (line.type === "error") failure = String(line.error);
    });
    if (failure) throw new Error(failure);
    const r = result as { generation_id?: string; problems?: GeneratedProblem[] } | null;
    if (!r?.generation_id) throw new Error(tr("没有生成出题目", "Nothing was generated"));
    setSheet({ href: generationPrintHref(b.bank_id, r.generation_id), label: tr(`打开练习卷（${r.problems?.length ?? 0} 题，可打印）`, `Open the worksheet (${r.problems?.length ?? 0} questions, printable)`) });
    setProblems(r.problems ?? []);
  };

  const fromBuiltin = async () => {
    const r = await api<{ problems: GeneratedProblem[] }>("/api/generate-problem", { method: "POST", json: { ...rec.builtin, count: rec.count } });
    setProblems(r.problems);
  };

  const run = async () => {
    setError(null);
    setBusy(true);
    setProgress(null);
    try {
      await (useBank ? fromBank() : fromBuiltin());
    } catch (e) {
      setError(errMsg(e, tr("出题失败", "Could not generate")));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <div className="space-y-1.5">
      {!problems && (
        <Button size="sm" variant="outline" className="gap-1.5" disabled={busy} onClick={() => void run()}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {busy
            ? (progress ?? tr("出题中…", "Generating…"))
            : useBank
              ? tr(`从题库「${rec.bank!.bank_name}」出 ${rec.count} 题`, `Generate ${rec.count} from bank “${rec.bank!.bank_name}”`)
              : tr(`一键出 ${rec.count} 道练习题`, `Generate ${rec.count} practice questions`)}
        </Button>
      )}
      {useBank && !problems && <p className="text-[11px] text-muted-foreground">{tr(`按知识点“${rec.bank!.knowledge_point}”匹配到 ${rec.bank!.matched} 道题库题作模板`, `Matched ${rec.bank!.matched} bank questions on “${rec.bank!.knowledge_point}” as templates`)}</p>}
      <ErrorNote message={error} onDismiss={() => setError(null)} />
      {sheet && (
        <Link href={sheet.href} target="_blank" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
          <FileText className="h-3.5 w-3.5" />
          {sheet.label}
        </Link>
      )}
      {problems && !sheet && (
        <ol className="list-decimal space-y-1.5 pl-5">
          {problems.map((p) => (
            <li key={p.id} className="space-y-0.5">
              <div className="whitespace-pre-wrap">
                <MathText text={p.statement} />
              </div>
              <Link href={`/?problem=${encodeURIComponent(p.statement)}`} className="text-xs text-primary hover:underline">
                {tr("使用此题", "Use this problem")}
              </Link>
            </li>
          ))}
          {!problems.length && <li className="list-none text-muted-foreground">{tr("没有生成出题目", "Nothing was generated")}</li>}
        </ol>
      )}
    </div>
  );
}
