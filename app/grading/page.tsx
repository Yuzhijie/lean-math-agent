"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ClipboardCheck, Copy, GraduationCap, Plus, RefreshCw, Trash2, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { LocaleSwitcher } from "../components/LocaleSwitcher";
import { ErrorNote, FieldLabel } from "../components/bank/ui";
import { api, errMsg, type ClassDetail, type ClassesResponse, type MemberDetail, type ProblemPrefill, type SubmissionDetail, type SubmissionSummary } from "../components/grading/api";
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
 * 批改 — marking students' handwritten work. Teachers make classes (a join code), keep a roster,
 * upload work for a student and see each student's and the class's learning record; students join
 * with the code, upload their own work and see their marking and record.
 * URL: ?class=<id> | ?member=<id> | ?submission=<id>; a problem to mark can be passed as
 * ?session=<id>, ?bank=<id>&item=<id> or ?problem=<text> (from the solver and the bank).
 */
function Grading() {
  const { tr } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const classId = params.get("class");
  const memberId = params.get("member");
  const submissionId = params.get("submission");
  const prefill = useMemo<ProblemPrefill | undefined>(() => {
    const p: ProblemPrefill = {
      session_id: params.get("session") ?? undefined,
      bank_id: params.get("bank") ?? undefined,
      item_id: params.get("item") ?? undefined,
      problem: params.get("problem") ?? undefined,
    };
    return p.session_id || (p.bank_id && p.item_id) || p.problem ? p : undefined;
  }, [params]);

  const [classes, setClasses] = useState<ClassesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let off = false;
    api<ClassesResponse>("/api/grading/classes")
      .then((r) => !off && setClasses(r))
      .catch((e) => !off && setError(errMsg(e, tr("读取班级失败", "Could not load classes"))));
    return () => {
      off = true;
    };
  }, [reload, tr]);

  /** Navigate within the page, keeping a problem being marked. */
  const go = useCallback(
    (q: Record<string, string>) => {
      const next = new URLSearchParams(q);
      if (prefill) for (const k of ["session", "bank", "item", "problem"]) if (params.get(k)) next.set(k, params.get(k)!);
      router.push(`/grading?${next.toString()}`);
    },
    [router, params, prefill],
  );
  const refresh = () => setReload((n) => n + 1);

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
        <aside className={cn("space-y-5", (classId || memberId || submissionId) && "hidden lg:block")}>
          <ErrorNote message={error} onDismiss={() => setError(null)} />
          {!classes ? (
            <Skeleton className="h-48" />
          ) : (
            <>
              <section className="space-y-2">
                <h2 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  <Users className="h-3.5 w-3.5" />
                  {tr("我教的班级", "Classes I teach")}
                </h2>
                {classes.teaching.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => go({ class: c.id })}
                    className={cn("w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-muted/40", classId === c.id ? "border-primary/60 bg-primary/5" : "border-border/60")}
                  >
                    <span className="font-medium">{c.name}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {tr(`${c.members} 名学生 · ${c.submissions} 份作答`, `${c.members} students · ${c.submissions} pieces of work`)}
                    </span>
                  </button>
                ))}
                <NewClass onCreated={(id) => (refresh(), go({ class: id }))} />
              </section>
              <section className="space-y-2">
                <h2 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  <GraduationCap className="h-3.5 w-3.5" />
                  {tr("我加入的班级", "Classes I joined")}
                </h2>
                {classes.enrolled.map((e) => (
                  <button
                    key={e.member.id}
                    type="button"
                    onClick={() => go({ member: e.member.id })}
                    className={cn("w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-muted/40", memberId === e.member.id ? "border-primary/60 bg-primary/5" : "border-border/60")}
                  >
                    <span className="font-medium">{e.class.name}</span>
                    <span className="block text-[11px] text-muted-foreground">{e.member.name}</span>
                  </button>
                ))}
                <JoinClass onJoined={(id) => (refresh(), go({ member: id }))} />
              </section>
            </>
          )}
        </aside>

        <section className="min-w-0">
          {(classId || memberId || submissionId) && (
            <Link href="/grading" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "mb-2 gap-1.5 lg:hidden")}>
              <ArrowLeft className="h-3.5 w-3.5" />
              {tr("全部班级", "All classes")}
            </Link>
          )}
          {submissionId ? (
            <SubmissionPane key={submissionId} id={submissionId} onBack={(m) => go(m ? { member: m } : {})} onChanged={refresh} />
          ) : memberId ? (
            <MemberPane key={memberId} id={memberId} prefill={prefill} onOpen={(id) => go({ submission: id })} onChanged={refresh} onRemoved={(c) => (refresh(), go({ class: c }))} />
          ) : classId ? (
            <ClassPane key={classId} id={classId} prefill={prefill} reload={reload} onOpenMember={(id) => go({ member: id })} onOpen={(id) => go({ submission: id })} onChanged={refresh} onDeleted={() => (refresh(), go({}))} />
          ) : (
            <Home classes={classes} prefill={prefill} onOpen={(id) => go({ submission: id })} />
          )}
        </section>
      </main>
    </div>
  );
}

// ── Sidebar forms ────────────────────────────────────────────────────

function NewClass({ onCreated }: { onCreated: (id: string) => void }) {
  const { tr } = useI18n();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    if (!name.trim()) return;
    try {
      const r = await api<{ class: { id: string } }>("/api/grading/classes", { method: "POST", json: { name } });
      setName("");
      onCreated(r.class.id);
    } catch (e) {
      setError(errMsg(e, tr("创建失败", "Could not create the class")));
    }
  };
  return (
    <div className="space-y-1">
      <div className="flex gap-1.5">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("新班级名称", "New class name")} className="h-8 text-sm" onKeyDown={(e) => e.key === "Enter" && void create()} />
        <Button size="sm" variant="outline" className="h-8 gap-1" onClick={() => void create()} aria-label={tr("新建班级", "New class")}>
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
      <ErrorNote message={error} onDismiss={() => setError(null)} />
    </div>
  );
}

function JoinClass({ onJoined }: { onJoined: (memberId: string) => void }) {
  const { tr } = useI18n();
  const [code, setCode] = useState("");
  const [found, setFound] = useState<{ class: { id: string; name: string }; joined: { id: string } | null; names: { id: string; name: string }[] } | null>(null);
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
      setError(errMsg(e, tr("没有这个班级码", "No class has this code")));
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
        <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder={tr("班级码", "Class code")} className="h-8 font-mono text-sm uppercase" onKeyDown={(e) => e.key === "Enter" && void look()} />
        <Button size="sm" variant="outline" className="h-8" onClick={() => void look()}>
          {tr("加入", "Join")}
        </Button>
      </div>
      {found && (
        <div className="space-y-1.5 rounded-md border border-border/60 p-2 text-sm">
          <p>
            {tr("加入", "Join")} <span className="font-medium">{found.class.name}</span>
          </p>
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
            {tr("确认加入", "Join the class")}
          </Button>
        </div>
      )}
      <ErrorNote message={error} onDismiss={() => setError(null)} />
    </div>
  );
}

// ── Main panes ───────────────────────────────────────────────────────

function Home({ classes, prefill, onOpen }: { classes: ClassesResponse | null; prefill?: ProblemPrefill; onOpen: (id: string) => void }) {
  const { tr } = useI18n();
  const [rosters, setRosters] = useState<{ id: string; label: string }[] | null>(null);
  useEffect(() => {
    if (!prefill || !classes) return;
    let off = false;
    (async () => {
      const out = classes.enrolled.map((e) => ({ id: e.member.id, label: tr(`我自己（${e.class.name}）`, `Me (${e.class.name})`) }));
      for (const c of classes.teaching) {
        try {
          const d = await api<ClassDetail>(`/api/grading/classes/${c.id}`);
          out.push(...d.members.map((m) => ({ id: m.id, label: `${m.name}（${c.name}）` })));
        } catch {
          /* skip */
        }
      }
      if (!off) setRosters(out);
    })();
    return () => {
      off = true;
    };
  }, [prefill, classes, tr]);

  if (prefill) {
    return (
      <div className="space-y-4">
        <h2 className="text-base font-semibold">{tr("批改这道题的作答", "Mark work on this problem")}</h2>
        {!rosters ? (
          <Skeleton className="h-40" />
        ) : rosters.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tr("先在左边新建班级并添加学生，或用班级码加入一个班级。", "First create a class and add students on the left, or join a class with its code.")}</p>
        ) : (
          <SubmitWork students={rosters} isTeacher={!!classes?.teaching.length} prefill={prefill} onDone={(s) => onOpen(s.id)} />
        )}
      </div>
    );
  }
  return (
    <div className="max-w-2xl space-y-3 text-sm text-muted-foreground">
      <h2 className="text-base font-semibold text-foreground">{tr("拍照批改学生的作答", "Mark students' handwritten work from photos")}</h2>
      <p>{tr("老师：在左边新建班级，把班级码发给学生，或者直接把学生名单加进班级；然后选一个学生、上传作答照片即可批改。", "Teachers: create a class on the left and give students its code, or add the names yourself; then pick a student and upload photos of their work.")}</p>
      <p>{tr("学生：输入老师给的班级码加入班级，就可以自己上传作答、看批改和自己的学情。", "Students: join with the code from your teacher to upload your own work and see the marking and your record.")}</p>
      <p>{tr("系统会逐行读出解题过程和最终答案：答案先由程序比对，再由模型逐步判断思路，指出第一个出错的步骤、错误类型，并给出不泄露答案的提示。", "The working and the final answer are read line by line: the answer is compared by the program first, then each step is judged — the first wrong step, the kind of mistake, and a hint that does not give the answer away.")}</p>
      <p>{tr("在求解页解完一道题后，点“批改学生作答”就能用求解结果作参考答案。", "After solving a problem on the solver page, “Mark students' work” uses the result as the reference answer.")}</p>
    </div>
  );
}

function ClassPane({
  id,
  prefill,
  reload,
  onOpenMember,
  onOpen,
  onChanged,
  onDeleted,
}: {
  id: string;
  prefill?: ProblemPrefill;
  reload: number;
  onOpenMember: (id: string) => void;
  onOpen: (id: string) => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const { tr } = useI18n();
  const [d, setD] = useState<ClassDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [names, setNames] = useState("");
  const [tab, setTab] = useState<"mark" | "students" | "stats">(prefill ? "mark" : "students");
  const [n, setN] = useState(0);
  useEffect(() => {
    let off = false;
    api<ClassDetail>(`/api/grading/classes/${id}`)
      .then((r) => !off && setD(r))
      .catch((e) => !off && setError(errMsg(e, tr("读取班级失败", "Could not load the class"))));
    return () => {
      off = true;
    };
  }, [id, reload, n, tr]);

  const addNames = async () => {
    try {
      await api(`/api/grading/classes/${id}/members`, { method: "POST", json: { names } });
      setNames("");
      setN((x) => x + 1);
      onChanged();
    } catch (e) {
      setError(errMsg(e, tr("添加失败", "Could not add")));
    }
  };
  const newCode = async () => {
    await api(`/api/grading/classes/${id}`, { method: "PATCH", json: { regenerate_code: true } }).catch(() => undefined);
    setN((x) => x + 1);
  };
  const del = async () => {
    if (!window.confirm(tr("删除这个班级，以及全部学生作答和照片？此操作不能撤销。", "Delete this class with all students' work and photos? This cannot be undone."))) return;
    try {
      await api(`/api/grading/classes/${id}`, { method: "DELETE" });
      onDeleted();
    } catch (e) {
      setError(errMsg(e, tr("删除失败", "Deleting failed")));
    }
  };

  if (!d) return error ? <ErrorNote message={error} /> : <Skeleton className="h-64" />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{d.class.name}</h2>
        <Badge variant="outline" className="gap-1 font-mono text-sm">
          {tr("班级码", "Code")} {d.class.join_code}
          <button type="button" aria-label={tr("复制", "Copy")} onClick={() => void navigator.clipboard?.writeText(d.class.join_code)}>
            <Copy className="h-3 w-3" />
          </button>
        </Badge>
        <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={() => void newCode()} title={tr("旧码作废，已加入的学生不受影响", "The old code stops working; students who joined stay")}>
          <RefreshCw className="h-3 w-3" />
          {tr("换一个码", "New code")}
        </Button>
        <Button variant="ghost" size="sm" className="ml-auto h-7 gap-1 text-xs text-destructive" onClick={() => void del()}>
          <Trash2 className="h-3 w-3" />
          {tr("删除班级", "Delete class")}
        </Button>
      </div>
      <ErrorNote message={error} onDismiss={() => setError(null)} />
      <div className="flex gap-1 border-b border-border/60">
        {(
          [
            ["mark", tr("批改作答", "Mark work")],
            ["students", tr(`学生（${d.members.length}）`, `Students (${d.members.length})`)],
            ["stats", tr("班级学情", "Class record")],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={cn("-mb-px border-b-2 px-3 py-1.5 text-sm", tab === k ? "border-primary text-foreground" : "border-transparent text-muted-foreground")}>
            {label}
          </button>
        ))}
      </div>

      {tab === "mark" && (
        <SubmitWork students={d.members.map((m) => ({ id: m.id, label: m.name }))} isTeacher prefill={prefill} onDone={(s) => onOpen(s.id)} />
      )}

      {tab === "students" && (
        <div className="space-y-3">
          {d.members.length > 0 && (
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
                  {d.members.map((m) => {
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
          <div className="space-y-1">
            <FieldLabel>{tr("添加学生（每行一个，或用逗号分隔）", "Add students (one per line, or comma-separated)")}</FieldLabel>
            <Textarea value={names} onChange={(e) => setNames(e.target.value)} rows={3} placeholder={tr("张三\n李四", "Alex\nSam")} />
            <Button size="sm" onClick={() => void addNames()} disabled={!names.trim()} className="gap-1">
              <Plus className="h-3.5 w-3.5" />
              {tr("添加", "Add")}
            </Button>
            <p className="text-xs text-muted-foreground">
              {tr(`学生用班级码 ${d.class.join_code} 加入时，可以从名单里选自己的名字绑定账号。`, `When students join with code ${d.class.join_code}, they can pick their name from this list to link their account.`)}
            </p>
          </div>
        </div>
      )}

      {tab === "stats" && <StatsPanel stats={d.stats} />}
    </div>
  );
}

function MemberPane({
  id,
  prefill,
  onOpen,
  onChanged,
  onRemoved,
}: {
  id: string;
  prefill?: ProblemPrefill;
  onOpen: (id: string) => void;
  onChanged: () => void;
  onRemoved: (classId: string) => void;
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
    if (!d || !window.confirm(tr(`把 ${d.member.name} 移出班级，并删除他/她的全部作答？`, `Remove ${d.member.name} from the class and delete all their work?`))) return;
    try {
      await api(`/api/grading/members/${id}`, { method: "DELETE" });
      onRemoved(d.class.id);
    } catch (e) {
      setError(errMsg(e, tr("删除失败", "Deleting failed")));
    }
  };

  if (!d) return error ? <ErrorNote message={error} /> : <Skeleton className="h-64" />;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{d.member.name}</h2>
        <span className="text-sm text-muted-foreground">{d.class.name}</span>
        {d.role === "teacher" && d.member.linked && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 text-xs"
            title={tr("这个名字被认领了，但不是本人？解除后学生可以用班级码重新认领", "Claimed by the wrong account? After unlinking, the student can claim the name again with the class code")}
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
            {tr("移出班级", "Remove from class")}
          </Button>
        )}
      </div>
      <ErrorNote message={error} onDismiss={() => setError(null)} />
      <div className="grid gap-5 xl:grid-cols-2">
        <div className="space-y-2 rounded-md border border-border/60 p-4">
          <h3 className="text-sm font-semibold">{d.role === "student" ? tr("提交我的作答", "Submit my work") : tr(`批改 ${d.member.name} 的作答`, `Mark ${d.member.name}'s work`)}</h3>
          <SubmitWork
            students={[{ id: d.member.id, label: d.member.name }]}
            isTeacher={d.role === "teacher"}
            prefill={prefill}
            onDone={(s) => (onChanged(), onOpen(s.id))}
          />
        </div>
        <div className="rounded-md border border-border/60 p-4">
          <StatsPanel stats={d.stats} title={tr("学情", "Learning record")} />
        </div>
      </div>
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

function SubmissionPane({ id, onBack, onChanged }: { id: string; onBack: (memberId?: string) => void; onChanged: () => void }) {
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
      <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => onBack(d.member.id)}>
        <ArrowLeft className="h-3.5 w-3.5" />
        {tr(`${d.member.name} 的学情`, `${d.member.name}'s record`)}
      </Button>
      <SubmissionView key={d.submission.id} detail={d} onChanged={(x) => (setD(x), onChanged())} onDeleted={() => (onChanged(), onBack(d.member.id))} />
    </div>
  );
}
