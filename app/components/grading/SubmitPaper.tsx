"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, ImagePlus, Loader2, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/lib/i18n";
import { readNdjson } from "@/lib/bank/generation-view";
import { ErrorNote, FieldLabel, NativeSelect } from "../bank/ui";

const MAX_PAGES = 12;

/** Bank and generation ids from a worksheet link (/print?bank=…&gen=…) or the two ids. */
export function worksheetFromLink(link: string): { bank_id: string; generation_id: string } | null {
  try {
    const u = new URL(link.trim(), "http://x");
    const bank = u.searchParams.get("bank");
    const gen = u.searchParams.get("gen");
    return bank && gen ? { bank_id: bank, generation_id: gen } : null;
  } catch {
    return null;
  }
}

/**
 * Upload a whole answered paper (答卷): who it is from, photos of every page in order, and — the
 * teacher's — an answer key or the link of the bank worksheet it was printed from. Marking streams
 * progress (reading → marking question by question → diagnosis); `onDone` gets the paper id.
 */
export function SubmitPaper({
  students,
  isTeacher,
  onDone,
  onBusy,
}: {
  students: { id: string; label: string }[];
  isTeacher: boolean;
  onDone: (paperId: string) => void;
  onBusy?: (busy: boolean) => void;
}) {
  const { tr } = useI18n();
  const [picked, setPicked] = useState("");
  const memberId = students.length === 1 ? students[0].id : students.some((s) => s.id === picked) ? picked : "";
  const [title, setTitle] = useState("");
  const [key, setKey] = useState("");
  const [sheet, setSheet] = useState("");
  const [pages, setPages] = useState<{ file: File; url: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const urls = useRef(new Set<string>());
  useEffect(() => {
    const all = urls.current;
    return () => all.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  const add = (files: FileList | null) => {
    if (!files) return;
    const next = [...files]
      .filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name))
      .slice(0, Math.max(0, MAX_PAGES - pages.length))
      .map((file) => {
        const url = URL.createObjectURL(file);
        urls.current.add(url);
        return { file, url };
      });
    setPages((cur) => [...cur, ...next]);
  };
  const drop = (p: { url: string }) => {
    URL.revokeObjectURL(p.url);
    urls.current.delete(p.url);
    setPages((cur) => cur.filter((x) => x.url !== p.url));
  };
  const move = (i: number, d: -1 | 1) =>
    setPages((cur) => {
      const j = i + d;
      if (j < 0 || j >= cur.length) return cur;
      const out = [...cur];
      [out[i], out[j]] = [out[j], out[i]];
      return out;
    });

  const submit = async () => {
    setError(null);
    if (!memberId) return setError(tr("请选择学生", "Choose the student"));
    if (!pages.length) return setError(tr("请上传答卷照片", "Add photos of the paper"));
    const ws = sheet.trim() ? worksheetFromLink(sheet) : null;
    if (sheet.trim() && !ws) return setError(tr("练习卷链接不对：应是“导出 PDF”打开的那个地址（含 bank= 和 gen=）", "That worksheet link is not right: use the address “Export PDF” opened (with bank= and gen=)"));
    const fd = new FormData();
    fd.append("member_id", memberId);
    if (title.trim()) fd.append("title", title.trim());
    if (isTeacher && key.trim()) fd.append("answer_key", key.trim());
    if (isTeacher && ws) {
      fd.append("bank_id", ws.bank_id);
      fd.append("generation_id", ws.generation_id);
    }
    const sent = new Set(pages.map((p) => p.url));
    for (const p of pages) fd.append("images", p.file);
    setBusy(true);
    onBusy?.(true);
    let streaming = false;
    setProgress(tr("正在上传…", "Uploading…"));
    try {
      const res = await fetch("/api/grading/papers", { method: "POST", body: fd });
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      streaming = true;
      let paperId: string | null = null;
      let failure: string | null = null;
      await readNdjson(res.body, (line) => {
        if (line.type === "progress" && typeof line.message === "string") setProgress(line.message);
        if (line.type === "result") paperId = (line.paper as { id: string }).id;
        if (line.type === "error") failure = String(line.error);
      });
      if (failure) throw new Error(failure);
      if (!paperId) throw new Error(tr("批改中断了，请重试", "Marking was interrupted; try again"));
      // Only the pages that were sent (not one added meanwhile); the key and link are kept for the next student's paper.
      sent.forEach((url) => {
        URL.revokeObjectURL(url);
        urls.current.delete(url);
      });
      setPages((cur) => cur.filter((x) => !sent.has(x.url)));
      setTitle("");
      onDone(paperId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // The connection can drop while the server goes on marking and stores the paper.
      setError(streaming ? `${msg} — ${tr("答卷可能仍在后台批改完成：重试前请先看看学生的答卷列表，避免重复。", "the paper may still be finished on the server: check the student's papers before trying again, to avoid a duplicate.")}` : msg);
    } finally {
      setBusy(false);
      onBusy?.(false);
      setProgress(null);
    }
  };

  return (
    <fieldset disabled={busy} className="space-y-4 disabled:opacity-90">
      {students.length !== 1 && (
        <div className="space-y-1">
          <FieldLabel>{tr("学生", "Student")}</FieldLabel>
          <NativeSelect value={memberId} onChange={setPicked} ariaLabel={tr("学生", "Student")}>
            <option value="">{students.length ? tr("选择学生…", "Choose a student…") : tr("还没有学生", "No students yet")}</option>
            {students.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}
      <div className="space-y-1">
        <FieldLabel>{tr("答卷名称（可选）", "Paper title (optional)")}</FieldLabel>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={tr("如：第三单元测验", "e.g. Unit 3 quiz")} />
      </div>
      {isTeacher && (
        <>
          <div className="space-y-1">
            <FieldLabel>{tr("答案（可选，每行一题）", "Answer key (optional, one per line)")}</FieldLabel>
            <Textarea value={key} onChange={(e) => setKey(e.target.value)} rows={3} placeholder={"1. 12\n2. C\n3. x=2"} />
          </div>
          <div className="space-y-1">
            <FieldLabel>{tr("或：题库练习卷的链接（可选）", "Or: link of the bank worksheet (optional)")}</FieldLabel>
            <Input value={sheet} onChange={(e) => setSheet(e.target.value)} placeholder="/print?bank=…&gen=…" />
            <p className="text-[11px] text-muted-foreground">
              {tr("答卷是从题库“导出 PDF”打印的，就贴那个地址：会按题目对上题库里的答案和解答。都不填时由模型先解题再批改（会标“需确认”）。", "If the paper was printed with “Export PDF” from the bank, paste that address: questions are matched to the bank's answers and solutions. With neither, the model solves each question first (marked “check”).")}
            </p>
          </div>
        </>
      )}
      <div className="space-y-1">
        <FieldLabel>{tr(`答卷照片（最多 ${MAX_PAGES} 页，按页码顺序）`, `Page photos (up to ${MAX_PAGES}, in page order)`)}</FieldLabel>
        <div
          className="flex min-h-24 flex-wrap gap-2 rounded-md border border-dashed border-border p-2"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (!busy) add(e.dataTransfer.files);
          }}
        >
          {pages.map((p, i) => (
            <div key={p.url} className="relative h-28 w-20 overflow-hidden rounded border border-border/60">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.url} alt={tr(`第 ${i + 1} 页`, `Page ${i + 1}`)} className="h-full w-full object-cover" />
              <span className="absolute left-0.5 top-0.5 rounded bg-black/60 px-1 text-[10px] text-white">{i + 1}</span>
              <button type="button" className="absolute right-0.5 top-0.5 rounded bg-black/60 p-0.5 text-white" aria-label={tr("移除", "Remove")} onClick={() => drop(p)}>
                <X className="h-3 w-3" />
              </button>
              <div className="absolute bottom-0 flex w-full justify-between bg-black/50 text-[10px] text-white">
                <button type="button" className="px-1.5" onClick={() => move(i, -1)} aria-label={tr("前移", "Earlier")}>
                  ‹
                </button>
                <button type="button" className="px-1.5" onClick={() => move(i, 1)} aria-label={tr("后移", "Later")}>
                  ›
                </button>
              </div>
            </div>
          ))}
          {pages.length < MAX_PAGES && (
            <div className="flex flex-col justify-center gap-1.5">
              <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => cameraRef.current?.click()}>
                <Camera className="h-3.5 w-3.5" />
                {tr("拍一页", "Photograph a page")}
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
              add(e.target.files);
              e.target.value = "";
            }}
          />
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              add(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      </div>
      <ErrorNote message={error} onDismiss={() => setError(null)} />
      <Button onClick={() => void submit()} disabled={busy} className="w-full gap-2 sm:w-auto">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        {busy ? (progress ?? tr("批改中…", "Marking…")) : tr("批改整张答卷", "Mark the whole paper")}
      </Button>
      {busy && <p className="text-xs text-muted-foreground">{tr("整张答卷要逐题批改，通常需要几分钟，请不要关闭页面。", "Every question is marked in turn; this usually takes a few minutes — keep the page open.")}</p>}
    </fieldset>
  );
}
