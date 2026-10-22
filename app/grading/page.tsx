"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ClipboardCheck, Copy, FileStack, GraduationCap, Loader2, Plus, RefreshCw, Sparkles, Trash2, UserPlus, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { LocaleSwitcher } from "../components/LocaleSwitcher";
import { MathText } from "../components/MathText";
import { ErrorNote, FieldLabel } from "../components/bank/ui";
import { api, errMsg, paperImageUrl, type Diagnosis, type MeResponse, type MemberDetail, type PaperDetail, type PaperSummary, type ProblemPrefill, type SubmissionDetail, type SubmissionSummary } from "../components/grading/api";
import { DiagnosisView } from "../components/grading/DiagnosisView";
import { SubmitPaper } from "../components/grading/SubmitPaper";
import { errorTypeLabel, pct, verdictLabel, verdictVariant } from "../components/grading/labels";
import { StatsPanel } from "../components/grading/StatsPanel";
import { SubmissionView } from "../components/grading/SubmissionView";
import { SubmitWork } from "../components/grading/SubmitWork";

export default function GradingPage() {
  return (
    <Suspense fallback={<Skeleton className="m-6 h-64" />}>
      <Grading />
    </Suspense>
  );
}

/**
 * 批改 — marking students' handwritten work. A teacher keeps one list of students (added by name,
 * or joining with the teacher's invite code), uploads work for a student and sees each student's
 * and all students' learning record; a student joins a teacher with the code, uploads their own
 * work and sees their marking and record. There is no class level.
 * A whole answered paper (答卷) is split into questions, each marked, then diagnosed (approach,
 * mastery per skill, what to test next with one-click practice).
 * URL: ?member=<id> | ?submission=<id> | ?paper=<id>; a problem to mark can be passed as ?session=<id>,
 * ?bank=<id>&item=<id> or ?problem=<text> (from the solver and the bank).
 */
function Grading() {
  const { tr } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const memberId = params.get("member");
  const submissionId = params.get("submission");
  const paperId = params.get("paper");
  const prefill = useMemo<ProblemPrefill | undefined>(() => {
    const p: ProblemPrefill = {
      session_id: params.get("session") ?? undefined,
      bank_id: params.get("bank") ?? undefined,
      item_id: params.get("item") ?? undefined,
      problem: params.get("problem") ?? undefined,
    };
    return p.session_id || (p.bank_id && p.item_id) || p.problem ? p : undefined;
  }, [params]);

  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let off = false;
    api<MeResponse>("/api/grading/me")
      .then((r) => !off && setMe(r))
      .catch((e) => !off && setError(errMsg(e, tr("读取失败", "Could not load"))));
    return () => {
      off = true;
    };
  }, [reload, tr]);

  /** Navigate within the page, keeping a problem being marked. */
  const go = useCallback(
    (q: Record<string, string>) => {
      const next = new URLSearchParams(q);
      if (prefill) for (const k of ["session", "bank", "item", "problem"]) if (params.get(k)) next.set(k, params.get(k)!);
      const qs = next.toString();
      router.push(qs ? `/grading?${qs}` : "/grading");
    },
    [router, params, prefill],
  );
  const refresh = () => setReload((n) => n + 1);
  const opened = !!(memberId || submissionId || paperId);

  return (
    <div className="relative z-10 min-h-screen">
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto max-w-screen-2xl px-4 sm:px-6">
          <div className="flex h-14 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
                <ClipboardCheck className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h1 className="truncate font-serif text-base font-bold leading-none tracking-tight">{tr("批改", "Marking")}</h1>
                <p className="truncate text-[11px] text-muted-foreground">{tr("学生作答 · 学情", "Students' work · learning record")}</p>
              </div>
            </div>
            <div className="flex items-center gap-1 sm:gap-3">
              <LocaleSwitcher />
              <Link href="/" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "gap-1.5")}>
                <ArrowLeft className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{tr("返回求解", "Back to solver")}</span>
              </Link>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-screen-2xl gap-5 px-4 py-5 sm:px-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        {/* On narrow screens the lists give way to what was opened. */}
        <aside className={cn("space-y-5", opened && "hidden lg:block")}>
          <ErrorNote message={error} onDismiss={() => setError(null)} />
          {!me ? (
            <Skeleton className="h-48" />
          ) : (
            <>
              <section className="space-y-2">
                <h2 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  <Users className="h-3.5 w-3.5" />
                  {tr("我的学生", "My students")}
                </h2>
                <button
                  type="button"
                  onClick={() => go({})}
                  className={cn("w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-muted/40", !opened ? "border-primary/60 bg-primary/5" : "border-border/60")}
                >
                  <span className="font-medium">{tr("全部学生", "All students")}</span>
                  <span className="block text-[11px] text-muted-foreground">
                    {tr(`${me.teacher?.students.length ?? 0} 名学生 · 已批改 ${me.teacher?.stats.marked ?? 0} 份`, `${me.teacher?.students.length ?? 0} students · ${me.teacher?.stats.marked ?? 0} marked`)}
                  </span>
                </button>
                {me.teacher?.students.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => go({ member: m.id })}
                    className={cn("flex w-full items-center justify-between rounded-md border px-3 py-1.5 text-left text-sm hover:bg-muted/40", memberId === m.id ? "border-primary/60 bg-primary/5" : "border-border/60")}
                  >
                    <span className="truncate">{m.name}</span>
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {m.stats.marked ? `${m.stats.marked} · ${pct(m.stats.correct_rate)}` : "—"}
                    </span>
                  </button>
                ))}
                <AddStudents onAdded={refresh} />
                <Invite teacher={me.teacher} onChanged={refresh} />
              </section>
              <section className="space-y-2">
                <h2 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  <GraduationCap className="h-3.5 w-3.5" />
                  {tr("我的老师", "My teachers")}
                </h2>
                {me.enrolled.map((e) => (
                  <button
                    key={e.member.id}
                    type="button"
                    onClick={() => go({ member: e.member.id })}
                    className={cn("w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-muted/40", memberId === e.member.id ? "border-primary/60 bg-primary/5" : "border-border/60")}
                  >
                    <span className="font-medium">{e.teacher}</span>
                    <span className="block text-[11px] text-muted-foreground">{tr(`我：${e.member.name}`, `Me: ${e.member.name}`)}</span>
                  </button>
                ))}
                <JoinTeacher onJoined={(id) => (refresh(), go({ member: id }))} />
              </section>
            </>
          )}
        </aside>

        <section className="min-w-0">
          {opened && (
            <Link href="/grading" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "mb-2 gap-1.5 lg:hidden")}>
              <ArrowLeft className="h-3.5 w-3.5" />
              {tr("全部学生", "All students")}
            </Link>
          )}
          {submissionId ? (
            <SubmissionPane key={submissionId} id={submissionId} onBack={(m) => go(m ? { member: m } : {})} onOpenPaper={(id) => go({ paper: id })} onChanged={refresh} />
          ) : paperId ? (
            <PaperPane key={paperId} id={paperId} onBack={(m) => go({ member: m })} onOpen={(id) => go({ submission: id })} onChanged={refresh} />
          ) : memberId ? (
            <MemberPane key={memberId} id={memberId} prefill={prefill} onOpen={(id) => go({ submission: id })} onOpenPaper={(id) => go({ paper: id })} onChanged={refresh} onRemoved={() => (refresh(), go({}))} />
          ) : (
            <Overview me={me} prefill={prefill} onOpenMember={(id) => go({ member: id })} onOpen={(id) => go({ submission: id })} onOpenPaper={(id) => go({ paper: id })} />
          )}
        </section>
      </main>
    </div>
  );
}

// ── Sidebar forms ────────────────────────────────────────────────────

function AddStudents({ onAdded }: { onAdded: () => void }) {
  const { tr } = useI18n();
  const [open, setOpen] = useState(false);
  const [names, setNames] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    try {
      await api("/api/grading/students", { method: "POST", json: { names } });
      setNames("");
      setOpen(false);
      onAdded();
    } catch (e) {
      setError(errMsg(e, tr("添加失败", "Could not add")));
    }
  };
  if (!open) {
    return (
      <Button size="sm" variant="outline" className="w-full gap-1.5" onClick={() => setOpen(true)}>
        <Plus className="h-3.5 w-3.5" />
        {tr("添加学生", "Add students")}
      </Button>
    );
  }
  return (
    <div className="space-y-1.5 rounded-md border border-border/60 p-2">
      <FieldLabel>{tr("姓名（每行一个，或用逗号分隔）", "Names (one per line, or comma-separated)")}</FieldLabel>
      <Textarea value={names} onChange={(e) => setNames(e.target.value)} rows={3} placeholder={tr("张三\n李四", "Alex\nSam")} autoFocus />
      <div className="flex gap-1.5">
        <Button size="sm" onClick={() => void add()} disabled={!names.trim()}>
          {tr("添加", "Add")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          {tr("取消", "Cancel")}
        </Button>
      </div>
      <ErrorNote message={error} onDismiss={() => setError(null)} />
    </div>
  );
}

/** My invite code: students who enter it join my list (claiming their name, or adding themselves). */
function Invite({ teacher, onChanged }: { teacher: MeResponse["teacher"]; onChanged: () => void }) {
  const { tr } = useI18n();
  const [shown, setShown] = useState(false);
  const [code, setCode] = useState<string | null>(teacher?.invite_code ?? null);
  const [error, setError] = useState<string | null>(null);
  const call = async (regenerate = false) => {
    try {
      const r = await api<{ invite_code: string }>("/api/grading/invite", { method: "POST", json: regenerate ? { regenerate: true } : {} });
      setCode(r.invite_code);
      setShown(true);
      if (!teacher || regenerate) onChanged();
    } catch (e) {
      setError(errMsg(e, tr("操作失败", "Failed")));
    }
  };
  if (!shown) {
    return (
      <Button size="sm" variant="ghost" className="w-full gap-1.5" onClick={() => (code ? setShown(true) : void call())}>
        <UserPlus className="h-3.5 w-3.5" />
        {tr("邀请学生加入", "Invite students")}
      </Button>
    );
  }
  return (
    <div className="space-y-1 rounded-md border border-border/60 p-2 text-sm">
      <p className="text-[11px] text-muted-foreground">{tr("学生在“我的老师”里输入这个邀请码即可加入：", "Students enter this code under “My teachers” to join:")}</p>
      <div className="flex items-center gap-2">
        <span className="font-mono text-base font-semibold tracking-widest">{code}</span>
        <button type="button" aria-label={tr("复制", "Copy")} onClick={() => code && void navigator.clipboard?.writeText(code)}>
          <Copy className="h-3.5 w-3.5" />
        </button>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-7 gap-1 text-xs"
          title={tr("旧码作废，已加入的学生不受影响", "The old code stops working; students who joined stay")}
          onClick={() => void call(true)}
        >
          <RefreshCw className="h-3 w-3" />
          {tr("换一个", "New code")}
        </Button>
      </div>
      <ErrorNote message={error} onDismiss={() => setError(null)} />
    </div>
  );
}

function JoinTeacher({ onJoined }: { onJoined: (memberId: string) => void }) {
  const { tr } = useI18n();
  const [code, setCode] = useState("");
  const [found, setFound] = useState<{ teacher: string; joined: { id: string } | null; names: { id: string; name: string }[] } | null>(null);
  const [pick, setPick] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const look = async () => {
    setError(null);
    try {
      const r = await api<NonNullable<typeof found>>(`/api/grading/join?code=${encodeURIComponent(code.trim())}`);
      if (r.joined) return onJoined(r.joined.id);
      setFound(r);
    } catch (e) {
      setError(errMsg(e, tr("没有这个邀请码", "No teacher has this invite code")));
    }
  };
  const join = async () => {
    setError(null);
    try {
      const r = await api<{ member: { id: string } }>("/api/grading/join", { method: "POST", json: { code: code.trim(), ...(pick ? { member_id: pick } : { name }) } });
      setFound(null);
      setCode("");
      onJoined(r.member.id);
    } catch (e) {
      setError(errMsg(e, tr("加入失败", "Could not join")));
    }
  };
  return (
    <div className="space-y-1.5">
      <div className="flex gap-1.5">
        <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder={tr("老师的邀请码", "Teacher's invite code")} className="h-8 font-mono text-sm uppercase" onKeyDown={(e) => e.key === "Enter" && void look()} />
        <Button size="sm" variant="outline" className="h-8" onClick={() => void look()}>
          {tr("加入", "Join")}
        </Button>
      </div>
      {found && (
        <div className="space-y-1.5 rounded-md border border-border/60 p-2 text-sm">
          <p>{tr(`加入 ${found.teacher} 的学生名单`, `Join ${found.teacher}'s students`)}</p>
          {found.names.length > 0 && (
            <>
              <FieldLabel>{tr("我是", "I am")}</FieldLabel>
              <select value={pick} onChange={(e) => setPick(e.target.value)} className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm">
                <option value="">{tr("不在名单里，填写姓名", "Not on the list — type my name")}</option>
                {found.names.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name}
                  </option>
                ))}
              </select>
            </>
          )}
          {!pick && <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("我的姓名", "My name")} className="h-8 text-sm" />}
          <Button size="sm" className="w-full" onClick={() => void join()} disabled={!pick && !name.trim()}>
            {tr("确认加入", "Join")}
          </Button>
        </div>
      )}
      <ErrorNote message={error} onDismiss={() => setError(null)} />
    </div>
  );
}

// ── Main panes ───────────────────────────────────────────────────────

/** No student opened: mark work (any of my students), my students at a glance, all students' record. */
function Overview({
  me,
  prefill,
  onOpenMember,
  onOpen,
  onOpenPaper,
}: {
  me: MeResponse | null;
  prefill?: ProblemPrefill;
  onOpenMember: (id: string) => void;
  onOpen: (id: string) => void;
  onOpenPaper: (id: string) => void;
}) {
  const { tr } = useI18n();
  const students = me?.teacher?.students ?? [];
  const [tab, setTab] = useState<"mark" | "students" | "stats">(prefill || !students.some((s) => s.stats.marked) ? "mark" : "students");
  if (!me) return <Skeleton className="h-64" />;
  // Whom work can be uploaded for: my students, and myself where I joined a teacher.
  const choices = [
    ...students.map((m) => ({ id: m.id, label: m.name })),
    ...me.enrolled.map((e) => ({ id: e.member.id, label: tr(`我自己（${e.teacher} 的学生）`, `Me (${e.teacher}'s student)`) })),
  ];
  if (!choices.length) {
    return (
      <div className="max-w-2xl space-y-3 text-sm text-muted-foreground">
        <h2 className="text-base font-semibold text-foreground">{tr("拍照批改学生的作答", "Mark students' handwritten work from photos")}</h2>
        <p>{tr("老师：在左边“添加学生”，或点“邀请学生加入”把邀请码发给学生；然后选一个学生、上传作答照片即可批改。", "Teachers: “Add students” on the left, or share your invite code with “Invite students”; then pick a student and upload photos of their work.")}</p>
        <p>{tr("学生：在“我的老师”里输入老师给的邀请码，就可以自己上传作答、看批改和自己的学情。", "Students: enter your teacher's invite code under “My teachers” to upload your own work and see the marking and your record.")}</p>
        <p>{tr("系统会逐行读出解题过程和最终答案：答案先由程序比对，再由模型逐步判断思路，指出第一个出错的步骤、错误类型，并给出不泄露答案的提示。", "The working and the final answer are read line by line: the answer is compared by the program first, then each step is judged — the first wrong step, the kind of mistake, and a hint that does not give the answer away.")}</p>
        <p>{tr("也可以上传整张答卷（多页照片）：系统按题号拆开逐题批改，再给出整体的解题思路分析、各知识点掌握程度和下一步该测的题型，并能一键出练习题。", "You can also upload a whole answered paper (several page photos): it is split by question number and each question marked, then you get an analysis of how the student works, mastery per skill and what to test next — with one-click practice.")}</p>
        <p>{tr("在求解页解完一道题后，点“批改学生作答”就能用求解结果作参考答案。", "After solving a problem on the solver page, “Mark students' work” uses the result as the reference answer.")}</p>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-border/60">
        {(
          [
            ["mark", tr("批改作答", "Mark work")],
            ...(students.length ? ([["students", tr(`学生（${students.length}）`, `Students (${students.length})`)], ["stats", tr("全体学情", "All students' record")]] as const) : []),
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={cn("-mb-px border-b-2 px-3 py-1.5 text-sm", tab === k ? "border-primary text-foreground" : "border-transparent text-muted-foreground")}>
            {label}
          </button>
        ))}
      </div>

      {tab === "mark" && <MarkForm students={choices} isTeacher={students.length > 0} prefill={prefill} onDone={onOpen} onPaperDone={onOpenPaper} />}

      {tab === "students" && (
        <div className="overflow-x-auto rounded-md border border-border/60">
          <table className="w-full text-sm">
            <thead className="bg-muted/30 text-[11px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">{tr("姓名", "Name")}</th>
                <th className="px-3 py-2 text-right">{tr("作答", "Work")}</th>
                <th className="px-3 py-2 text-right">{tr("全对率", "Correct")}</th>
                <th className="px-3 py-2 text-right">{tr("均分", "Mean")}</th>
                <th className="px-3 py-2 text-left">{tr("最常见的错误", "Most common mistake")}</th>
                <th className="px-3 py-2 text-left">{tr("最弱的知识点", "Weakest skill")}</th>
              </tr>
            </thead>
            <tbody>
              {students.map((m) => {
                const topErr = Object.entries(m.stats.error_types).sort((a, b) => b[1] - a[1])[0];
                const weak = m.stats.knowledge.find((k) => k.rate < 1);
                return (
                  <tr key={m.id} className="cursor-pointer border-t border-border/40 hover:bg-muted/30" onClick={() => onOpenMember(m.id)}>
                    <td className="px-3 py-2">
                      {m.name}
                      {!m.linked && <span className="ml-1 text-[11px] text-muted-foreground">{tr("（未绑定账号）", "(no account)")}</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{m.stats.marked}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{m.stats.marked ? pct(m.stats.correct_rate) : "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{m.stats.mean_score ?? "—"}</td>
                    <td className="px-3 py-2 text-xs">{topErr && topErr[1] > 0 ? `${errorTypeLabel(topErr[0], tr)} ×${topErr[1]}` : "—"}</td>
                    <td className="px-3 py-2 text-xs">{weak ? `${weak.name} ${weak.correct}/${weak.attempts}` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {tab === "stats" && me.teacher && <StatsPanel stats={me.teacher.stats} />}
    </div>
  );
}

function MemberPane({
  id,
  prefill,
  onOpen,
  onOpenPaper,
  onChanged,
  onRemoved,
}: {
  id: string;
  prefill?: ProblemPrefill;
  onOpen: (id: string) => void;
  onOpenPaper: (id: string) => void;
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const { tr } = useI18n();
  const [d, setD] = useState<MemberDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let off = false;
    api<MemberDetail>(`/api/grading/members/${id}`)
      .then((r) => !off && setD(r))
      .catch((e) => !off && setError(errMsg(e, tr("读取失败", "Could not load"))));
    return () => {
      off = true;
    };
  }, [id, tr]);

  const remove = async () => {
    if (!d || !window.confirm(tr(`把 ${d.member.name} 从学生列表移除，并删除他/她的全部作答？`, `Remove ${d.member.name} from your students and delete all their work?`))) return;
    try {
      await api(`/api/grading/members/${id}`, { method: "DELETE" });
      onRemoved();
    } catch (e) {
      setError(errMsg(e, tr("删除失败", "Deleting failed")));
    }
  };

  if (!d) return error ? <ErrorNote message={error} /> : <Skeleton className="h-64" />;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{d.member.name}</h2>
        {d.role === "student" && <span className="text-sm text-muted-foreground">{tr(`老师：${d.teacher}`, `Teacher: ${d.teacher}`)}</span>}
        {d.role === "teacher" && d.member.linked && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 text-xs"
            title={tr("这个名字被认领了，但不是本人？解除后学生可以用邀请码重新认领", "Claimed by the wrong account? After unlinking, the student can claim the name again with your invite code")}
            onClick={() =>
              void api(`/api/grading/members/${id}`, { method: "PATCH", json: { unlink: true } })
                .then(() => setD({ ...d, member: { ...d.member, linked: false } }))
                .catch((e) => setError(errMsg(e, tr("操作失败", "Failed"))))
            }
          >
            {tr("解除账号绑定", "Unlink account")}
          </Button>
        )}
        {d.role === "teacher" && (
          <Button variant="ghost" size="sm" className={cn("h-7 gap-1 text-xs text-destructive", !d.member.linked && "ml-auto")} onClick={() => void remove()}>
            <Trash2 className="h-3 w-3" />
            {tr("移除学生", "Remove student")}
          </Button>
        )}
      </div>
      <ErrorNote message={error} onDismiss={() => setError(null)} />
      <div className="grid gap-5 xl:grid-cols-2">
        <div className="space-y-2 rounded-md border border-border/60 p-4">
          <h3 className="text-sm font-semibold">{d.role === "student" ? tr("提交我的作答", "Submit my work") : tr(`批改 ${d.member.name} 的作答`, `Mark ${d.member.name}'s work`)}</h3>
          <MarkForm
            students={[{ id: d.member.id, label: d.member.name }]}
            isTeacher={d.role === "teacher"}
            prefill={prefill}
            onDone={(sid) => (onChanged(), onOpen(sid))}
            onPaperDone={(pid) => (onChanged(), onOpenPaper(pid))}
          />
        </div>
        <div className="rounded-md border border-border/60 p-4">
          <StatsPanel stats={d.stats} title={tr("学情", "Learning record")} />
        </div>
      </div>
      <MemberDiagnosis key={d.diagnosis?.created_at ?? 0} memberId={d.member.id} role={d.role} initial={d.diagnosis} marked={d.stats.marked} />
      <PaperList items={d.papers} onOpen={onOpenPaper} />
      <SubmissionList items={d.submissions} onOpen={onOpen} />
    </div>
  );
}

function SubmissionList({ items, onOpen }: { items: SubmissionSummary[]; onOpen: (id: string) => void }) {
  const { tr } = useI18n();
  if (!items.length) return null;
  return (
    <div className="space-y-1.5">
      <h3 className="text-sm font-semibold">{tr("历次作答", "All work")}</h3>
      {items.map((s) => (
        <button key={s.id} type="button" onClick={() => onOpen(s.id)} className="flex w-full items-center gap-3 rounded-md border border-border/60 px-3 py-2 text-left text-sm hover:bg-muted/30">
          <Badge variant={s.status === "failed" ? "secondary" : verdictVariant(s.verdict)} className="shrink-0">
            {s.status === "failed" ? tr("批改失败", "Failed") : verdictLabel(s.verdict, tr)}
          </Badge>
          {s.needs_review && <Badge variant="warning" className="shrink-0">{tr("需确认", "Check")}</Badge>}
          <span className="min-w-0 flex-1 truncate">{s.problem}</span>
          {s.score !== null && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{s.score}</span>}
          <span className="shrink-0 text-xs text-muted-foreground">{new Date(s.created_at).toLocaleDateString()}</span>
        </button>
      ))}
    </div>
  );
}

function SubmissionPane({ id, onBack, onOpenPaper, onChanged }: { id: string; onBack: (memberId?: string) => void; onOpenPaper: (paperId: string) => void; onChanged: () => void }) {
  const { tr } = useI18n();
  const [d, setD] = useState<SubmissionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let off = false;
    api<SubmissionDetail>(`/api/grading/submissions/${id}`)
      .then((r) => !off && setD(r))
      .catch((e) => !off && setError(errMsg(e, tr("读取失败", "Could not load"))));
    return () => {
      off = true;
    };
  }, [id, tr]);
  if (!d) return error ? <ErrorNote message={error} /> : <Skeleton className="h-64" />;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1">
        <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => onBack(d.member.id)}>
          <ArrowLeft className="h-3.5 w-3.5" />
          {tr(`${d.member.name} 的学情`, `${d.member.name}'s record`)}
        </Button>
        {d.paper && (
          <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => onOpenPaper(d.paper!.id)}>
            <FileStack className="h-3.5 w-3.5" />
            {tr(`整张答卷：${d.paper.title}`, `Whole paper: ${d.paper.title}`)}
          </Button>
        )}
      </div>
      <SubmissionView key={d.submission.id} detail={d} onChanged={(x) => (setD(x), onChanged())} onDeleted={() => (onChanged(), onBack(d.member.id))} />
    </div>
  );
}

// ── Whole papers and diagnosis ───────────────────────────────────────

/** One question, or a whole answered paper. */
function MarkForm({
  students,
  isTeacher,
  prefill,
  onDone,
  onPaperDone,
}: {
  students: { id: string; label: string }[];
  isTeacher: boolean;
  prefill?: ProblemPrefill;
  onDone: (submissionId: string) => void;
  onPaperDone: (paperId: string) => void;
}) {
  const { tr } = useI18n();
  const [mode, setMode] = useState<"one" | "paper">("one");
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-3">
      <div className="inline-flex rounded-md border border-border/60 p-0.5 text-xs">
        {(
          [
            ["one", tr("单题", "One question")],
            ["paper", tr("整张答卷", "Whole paper")],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" disabled={busy} onClick={() => setMode(k)} className={cn("rounded px-3 py-1 disabled:cursor-not-allowed", mode === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
            {label}
          </button>
        ))}
      </div>
      {mode === "one" ? (
        <SubmitWork students={students} isTeacher={isTeacher} prefill={prefill} onDone={(s) => onDone(s.id)} />
      ) : (
        <SubmitPaper students={students} isTeacher={isTeacher} onDone={onPaperDone} onBusy={setBusy} />
      )}
    </div>
  );
}

function PaperList({ items, onOpen }: { items: PaperSummary[]; onOpen: (id: string) => void }) {
  const { tr } = useI18n();
  if (!items.length) return null;
  return (
    <div className="space-y-1.5">
      <h3 className="text-sm font-semibold">{tr("答卷", "Papers")}</h3>
      {items.map((p) => (
        <button key={p.id} type="button" onClick={() => onOpen(p.id)} className="flex w-full items-center gap-3 rounded-md border border-border/60 px-3 py-2 text-left text-sm hover:bg-muted/30">
          <FileStack className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="shrink-0 font-medium">{p.title}</span>
          {p.status !== "marked" && <Badge variant={p.status === "failed" ? "secondary" : "warning"}>{p.status === "failed" ? tr("批改失败", "Failed") : tr("部分完成", "Partly marked")}</Badge>}
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{p.summary ?? ""}</span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{tr(`${p.questions} 题`, `${p.questions} q`)}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{new Date(p.created_at).toLocaleDateString()}</span>
        </button>
      ))}
    </div>
  );
}

/** The student's learning diagnosis over all their marked work (run on demand; kept until rerun). */
function MemberDiagnosis({ memberId, role, initial, marked }: { memberId: string; role: "teacher" | "student"; initial: Diagnosis | null; marked: number }) {
  const { tr } = useI18n();
  const [d, setD] = useState<Diagnosis | null>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await api<{ diagnosis: Diagnosis }>(`/api/grading/members/${memberId}/diagnosis`, { method: "POST" });
      setD(r.diagnosis);
    } catch (e) {
      setError(errMsg(e, tr("诊断失败", "Diagnosis failed")));
    } finally {
      setBusy(false);
    }
  };
  if (!marked && !d) return null;
  return (
    <div className="space-y-3 rounded-md border border-border/60 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{tr("学习诊断", "Learning diagnosis")}</h3>
        <span className="text-[11px] text-muted-foreground">{tr("解题思路 · 知识点掌握 · 下一步测试", "Approach · mastery · what to test next")}</span>
        <Button size="sm" variant={d ? "ghost" : "default"} className="ml-auto h-7 gap-1.5 text-xs" disabled={busy} onClick={() => void run()}>
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
          {busy ? tr("分析中…", "Analysing…") : d ? tr("按最新作答重新诊断", "Diagnose again with the latest work") : tr("生成学习诊断", "Diagnose")}
        </Button>
      </div>
      <ErrorNote message={error} onDismiss={() => setError(null)} />
      {d ? <DiagnosisView diagnosis={d} role={role} /> : <p className="text-xs text-muted-foreground">{tr("根据最近批改的作答（最多 40 题）分析这名学生。", "Analyses the student from their latest marked work (up to 40 questions).")}</p>}
    </div>
  );
}

function PaperPane({ id, onBack, onOpen, onChanged }: { id: string; onBack: (memberId: string) => void; onOpen: (submissionId: string) => void; onChanged: () => void }) {
  const { tr } = useI18n();
  const [d, setD] = useState<PaperDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let off = false;
    api<PaperDetail>(`/api/grading/papers/${id}`)
      .then((r) => !off && setD(r))
      .catch((e) => !off && setError(errMsg(e, tr("读取失败", "Could not load"))));
    return () => {
      off = true;
    };
  }, [id, tr]);
  if (!d) return error ? <ErrorNote message={error} /> : <Skeleton className="h-64" />;
  const p = d.paper;
  const total = d.questions.reduce((a, q) => a + (q.score ?? 0), 0);
  const scored = d.questions.filter((q) => q.score !== null).length;

  const rediagnose = async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await api<{ paper: PaperDetail["paper"] }>(`/api/grading/papers/${id}/diagnosis`, { method: "POST" });
      setD({ ...d, paper: r.paper });
    } catch (e) {
      setError(errMsg(e, tr("诊断失败", "Diagnosis failed")));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!window.confirm(tr("删除这张答卷和其中每道题的批改？", "Delete this paper and the marking of all its questions?"))) return;
    try {
      await api(`/api/grading/papers/${id}`, { method: "DELETE" });
      onChanged();
      onBack(d.member.id);
    } catch (e) {
      setError(errMsg(e, tr("删除失败", "Deleting failed")));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => onBack(d.member.id)}>
          <ArrowLeft className="h-3.5 w-3.5" />
          {tr(`${d.member.name} 的学情`, `${d.member.name}'s record`)}
        </Button>
        {(d.role === "teacher" || d.own) && (
          <Button variant="ghost" size="sm" className="ml-auto h-7 gap-1 text-xs text-destructive" onClick={() => void remove()}>
            <Trash2 className="h-3 w-3" />
            {tr("删除答卷", "Delete paper")}
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-lg font-semibold">{p.title}</h2>
        <span className="text-sm text-muted-foreground">
          {d.member.name} · {new Date(p.created_at).toLocaleString()}
        </span>
        {p.status !== "marked" && <Badge variant={p.status === "failed" ? "destructive" : "warning"}>{p.status === "failed" ? tr("批改失败", "Failed") : tr("部分题目未能批改", "Some questions could not be marked")}</Badge>}
      </div>
      {p.error && <p className="text-sm text-destructive">{p.error}</p>}
      {p.note && <p className="rounded-md bg-warning/10 px-3 py-2 text-xs">{tr("读卷备注：", "Note from reading: ")}{p.note}</p>}
      <ErrorNote message={error} onDismiss={() => setError(null)} />

      <div className="flex gap-2 overflow-x-auto pb-1">
        {p.images.map((name, i) => (
          <a key={name} href={paperImageUrl(p.id, name)} target="_blank" rel="noreferrer" className="shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={paperImageUrl(p.id, name)} alt={tr(`第 ${i + 1} 页`, `Page ${i + 1}`)} className="h-40 rounded border border-border/60 object-cover" />
          </a>
        ))}
      </div>

      {d.questions.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">
            {tr(`逐题批改（${d.questions.length} 题）`, `Question by question (${d.questions.length})`)}
            {scored > 0 && <span className="ml-2 text-xs font-normal text-muted-foreground">{tr(`均分 ${Math.round(total / scored)}`, `mean ${Math.round(total / scored)}`)}</span>}
          </h3>
          <div className="overflow-x-auto rounded-md border border-border/60">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-[11px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 text-left">{tr("题号", "No.")}</th>
                  <th className="px-3 py-1.5 text-left">{tr("结果", "Result")}</th>
                  <th className="px-3 py-1.5 text-right">{tr("得分", "Score")}</th>
                  <th className="px-3 py-1.5 text-left">{tr("学生答案", "Student's answer")}</th>
                  <th className="px-3 py-1.5 text-left">{tr("题目", "Question")}</th>
                </tr>
              </thead>
              <tbody>
                {d.questions.map((q) => (
                  <tr key={q.id} className="cursor-pointer border-t border-border/40 hover:bg-muted/30" onClick={() => onOpen(q.id)}>
                    <td className="px-3 py-1.5 tabular-nums">{q.question_no ?? ""}</td>
                    <td className="px-3 py-1.5">
                      <span className="flex flex-wrap gap-1">
                        <Badge variant={q.status === "failed" ? "secondary" : verdictVariant(q.verdict)}>{q.status === "failed" ? tr("批改失败", "Failed") : verdictLabel(q.verdict, tr)}</Badge>
                        {q.needs_review && <Badge variant="warning">{tr("需确认", "Check")}</Badge>}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{q.score ?? "—"}</td>
                    <td className="max-w-[10rem] truncate px-3 py-1.5">{q.final_answer ? <MathText text={q.final_answer} /> : "—"}</td>
                    <td className="max-w-[20rem] truncate px-3 py-1.5 text-xs text-muted-foreground">
                      <MathText text={q.problem} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {d.questions.some((q) => q.reference_source === "model") && (
            <p className="text-[11px] text-muted-foreground">{tr("没有给答案的题由模型先解题作为参考答案，标“需确认”的请老师看一下。", "Questions without a given answer were solved by the model first; please check those marked “Check”.")}</p>
          )}
        </div>
      )}

      <div className="space-y-3 rounded-md border border-border/60 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">{tr("这张答卷的诊断", "Diagnosis of this paper")}</h3>
          {d.role === "teacher" && scored > 0 && (
            <Button size="sm" variant="ghost" className="ml-auto h-7 gap-1.5 text-xs" disabled={busy} onClick={() => void rediagnose()}>
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              {busy ? tr("分析中…", "Analysing…") : tr("重新分析（含老师的改判）", "Analyse again (with your corrections)")}
            </Button>
          )}
        </div>
        {p.diagnosis ? <DiagnosisView diagnosis={p.diagnosis} role={d.role} /> : <p className="text-xs text-muted-foreground">{tr("还没有诊断。", "No diagnosis yet.")}</p>}
      </div>
    </div>
  );
}
