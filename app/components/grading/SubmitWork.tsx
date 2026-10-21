"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, ImagePlus, Loader2, ScanText, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/lib/i18n";
import { MathText } from "../MathText";
import { ErrorNote, FieldLabel, NativeSelect } from "../bank/ui";
import { api, errMsg, type ProblemPrefill, type Submission } from "./api";

const MAX_PHOTOS = 6;

/**
 * Upload a student's handwritten work for marking: who it is from, the problem (typed, read from
 * a photo, or carried over from a solved problem / bank question), the teacher's answer
 * (optional) and 1–6 photos of the working.
 */
export function SubmitWork({
  students,
  isTeacher,
  prefill,
  onDone,
}: {
  students: { id: string; label: string }[];
  isTeacher: boolean;
  prefill?: ProblemPrefill;
  onDone: (submission: Submission) => void;
}) {
  const { tr } = useI18n();
  const [picked, setMemberId] = useState("");
  // With one student (a student's own page, or one roster entry) there is nothing to pick.
  const memberId = students.length === 1 ? students[0].id : students.some((s) => s.id === picked) ? picked : "";
  const [problem, setProblem] = useState(prefill?.problem ?? "");
  const [figure, setFigure] = useState("");
  const [answer, setAnswer] = useState("");
  const [photos, setPhotos] = useState<{ file: File; url: string }[]>([]);
  const [linked, setLinked] = useState<{ text: string; source: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [readingProblem, setReadingProblem] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const problemPhotoRef = useRef<HTMLInputElement>(null);

  // A solved problem or a bank question the marking starts from: show its text.
  useEffect(() => {
    let off = false;
    (async () => {
      try {
        if (prefill?.session_id) {
          const s = await api<{ problem_text: string }>(`/api/session/${encodeURIComponent(prefill.session_id)}`);
          if (!off) setLinked({ text: s.problem_text, source: tr("已求解的题（参考答案取自求解结果）", "a solved problem (the reference answer comes from solving it)") });
        } else if (prefill?.bank_id && prefill.item_id) {
          const r = await api<{ item: { stem: string; options?: string[] } }>(`/api/banks/${encodeURIComponent(prefill.bank_id)}/items/${encodeURIComponent(prefill.item_id)}`);
          const opts = (r.item.options ?? []).map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`);
          if (!off) setLinked({ text: [r.item.stem, ...opts].join("\n"), source: tr("题库题（参考答案取自题库）", "a bank question (the reference answer comes from the bank)") });
        }
      } catch (e) {
        if (!off) setError(errMsg(e, tr("读取题目失败", "Could not load the problem")));
      }
    })();
    return () => {
      off = true;
    };
  }, [prefill?.session_id, prefill?.bank_id, prefill?.item_id, tr]);

  useEffect(() => {
    if (!busy) return;
    const start = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(t);
  }, [busy]);

  // Object URLs of the previews: freed when a photo is removed or sent, and when the form goes away.
  const urls = useRef(new Set<string>());
  useEffect(() => {
    const all = urls.current;
    return () => all.forEach((u) => URL.revokeObjectURL(u));
  }, []);
  const dropPhotos = (keep: (p: { file: File; url: string }) => boolean) =>
    setPhotos((cur) =>
      cur.filter((p) => {
        if (keep(p)) return true;
        URL.revokeObjectURL(p.url);
        urls.current.delete(p.url);
        return false;
      }),
    );

  const addPhotos = (files: FileList | null) => {
    if (!files) return;
    const add = [...files].filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name));
    const next = add.slice(0, Math.max(0, MAX_PHOTOS - photos.length)).map((file) => {
      const url = URL.createObjectURL(file);
      urls.current.add(url);
      return { file, url };
    });
    setPhotos((cur) => [...cur, ...next]);
  };

  const readProblemPhoto = async (file: File | undefined) => {
    if (!file) return;
    setReadingProblem(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("image", file);
      const r = await api<{ text: string; figure?: string }>("/api/read-problem-image", { method: "POST", body: fd });
      setProblem(r.text);
      setFigure(r.figure ?? "");
    } catch (e) {
      setError(errMsg(e, tr("读题失败", "Could not read the problem")));
    } finally {
      setReadingProblem(false);
    }
  };

  const submit = async () => {
    setError(null);
    if (!memberId) return setError(tr("请选择学生", "Choose the student"));
    if (!linked && !problem.trim()) return setError(tr("请填写题目", "Enter the problem"));
    if (!photos.length) return setError(tr("请上传作答照片", "Add photos of the work"));
    const fd = new FormData();
    fd.append("member_id", memberId);
    if (problem.trim()) fd.append("problem_text", problem.trim());
    if (figure.trim()) fd.append("figure", figure.trim());
    if (answer.trim()) fd.append("answer", answer.trim());
    if (prefill?.session_id) fd.append("session_id", prefill.session_id);
    if (prefill?.bank_id && prefill.item_id) {
      fd.append("bank_id", prefill.bank_id);
      fd.append("item_id", prefill.item_id);
    }
    for (const p of photos) fd.append("images", p.file);
    setBusy(true);
    try {
      const res = await fetch("/api/grading/submissions", { method: "POST", body: fd });
      const data = (await res.json().catch(() => ({}))) as { submission?: Submission; error?: string };
      if (!res.ok && !data.submission) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (data.error) setError(data.error);
      if (data.submission) {
        dropPhotos(() => false);
        if (!linked) setProblem("");
        setFigure("");
        setAnswer("");
        onDone(data.submission);
      }
    } catch (e) {
      setError(errMsg(e, tr("提交失败", "Submitting failed")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {students.length !== 1 && (
        <div className="space-y-1">
          <FieldLabel>{tr("学生", "Student")}</FieldLabel>
          <NativeSelect value={memberId} onChange={setMemberId} ariaLabel={tr("学生", "Student")}>
            <option value="">{students.length ? tr("选择学生…", "Choose a student…") : tr("班级里还没有学生", "No students in this class yet")}</option>
            {students.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}

      <div className="space-y-1">
        <FieldLabel>{tr("题目", "Problem")}</FieldLabel>
        {linked ? (
          <div className="rounded-md border border-border/60 bg-muted/20 p-3 text-sm">
            <p className="mb-1 text-[11px] text-muted-foreground">{tr("来自", "From")} {linked.source}</p>
            <MathText text={linked.text} />
          </div>
        ) : (
          <>
            <Textarea
              value={problem}
              onChange={(e) => setProblem(e.target.value)}
              rows={4}
              placeholder={tr("输入题目（可用 $…$ 写公式），或拍一张题目的照片", "Type the problem (maths in $…$), or take a photo of it")}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="outline" className="gap-1.5" disabled={readingProblem} onClick={() => problemPhotoRef.current?.click()}>
                {readingProblem ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ScanText className="h-3.5 w-3.5" />}
                {tr("从照片读题", "Read the problem from a photo")}
              </Button>
              {figure && <span className="text-xs text-muted-foreground">{tr("已读到题目里的图形", "The problem's figure was read")}</span>}
              <input
                ref={problemPhotoRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  void readProblemPhoto(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </div>
          </>
        )}
      </div>

      {isTeacher && (
        <div className="space-y-1">
          <FieldLabel>{tr("参考答案（可选）", "Reference answer (optional)")}</FieldLabel>
          <Input
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder={
              linked
                ? tr("留空则用求解结果 / 题库答案", "Leave empty to use the solver's / bank's answer")
                : tr("留空则由模型独立解题后再批改（请核对）", "Leave empty and the model solves it first (check it)")
            }
          />
        </div>
      )}

      <div className="space-y-1">
        <FieldLabel>{tr(`作答照片（最多 ${MAX_PHOTOS} 张，按顺序）`, `Photos of the work (up to ${MAX_PHOTOS}, in order)`)}</FieldLabel>
        <div
          className="flex min-h-24 flex-wrap gap-2 rounded-md border border-dashed border-border p-2"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            addPhotos(e.dataTransfer.files);
          }}
        >
          {photos.map((p, i) => (
            <div key={p.url} className="relative h-24 w-20 overflow-hidden rounded border border-border/60">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.url} alt={tr(`第 ${i + 1} 张`, `Photo ${i + 1}`)} className="h-full w-full object-cover" />
              <button
                type="button"
                className="absolute right-0.5 top-0.5 rounded bg-black/60 p-0.5 text-white"
                aria-label={tr("移除", "Remove")}
                onClick={() => dropPhotos((x) => x !== p)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          {photos.length < MAX_PHOTOS && (
            <div className="flex flex-col justify-center gap-1.5">
              <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => cameraRef.current?.click()}>
                <Camera className="h-3.5 w-3.5" />
                {tr("拍照", "Take a photo")}
              </Button>
              <Button type="button" size="sm" variant="ghost" className="gap-1.5" onClick={() => fileRef.current?.click()}>
                <ImagePlus className="h-3.5 w-3.5" />
                {tr("选择图片（可拖入）", "Choose images (or drop)")}
              </Button>
            </div>
          )}
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              addPhotos(e.target.files);
              e.target.value = ""; // the same photo can be chosen again after removing it
            }}
          />
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              addPhotos(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      </div>

      <ErrorNote message={error} onDismiss={() => setError(null)} />

      <Button onClick={() => void submit()} disabled={busy} className="w-full gap-2 sm:w-auto">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        {busy ? tr(`正在读照片、批改…（${elapsed} 秒）`, `Reading the photos and marking… (${elapsed}s)`) : tr("提交批改", "Mark this work")}
      </Button>
    </div>
  );
}
