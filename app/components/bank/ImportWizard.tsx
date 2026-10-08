"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, FileUp, ImageIcon, Info, Loader2, Save, ScanText, Trash2, Upload } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { MathText } from "../MathText";
import {
  api,
  bankUrl,
  DRAFT_STATUS_LIST,
  errMsg,
  letter,
  QUESTION_TYPE_LIST,
  type Bank,
  type CategoryWithCount,
  type ColumnPreview,
  type DraftItem,
  type ImportBatch,
  type QuestionType,
} from "./api";
import { AssetImages, assetUrl, CheckboxField, ClassificationLine, ErrorNote, FieldLabel, NativeSelect, splitList, statusLabel, statusVariant, typeLabel, useElapsed } from "./ui";

const ACCEPT = ".pdf,.json,.jsonl,.csv,.xlsx,.md,.txt,.png,.jpg,.jpeg,.webp,.gif,.heic,image/*";
const MAP_FIELDS = ["stem", "type", "options", "answer", "solution", "grade", "difficulty", "knowledge_points", "tags", "label"] as const;

type Step = 1 | 2 | 3 | 4;
type Busy = "preview" | "upload" | "save" | "commit" | "discard" | "load" | null;

type Props = {
  bank: Bank;
  categories: CategoryWithCount[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Continue reviewing an existing draft batch instead of uploading. */
  resumeBatchId?: string | null;
  /** Called after a commit or discard (the bank changed). */
  onFinished: () => void;
};

const isTabular = (name: string) => /\.(csv|xlsx)$/i.test(name);
const isPdf = (name: string) => /\.pdf$/i.test(name);
const isImage = (f: File) => /\.(png|jpe?g|webp|gif|heic|heif)$/i.test(f.name) || f.type.startsWith("image/");
/** Pages of one paper in file-name order ("page 2" before "page 10"). */
const byName = (a: File, b: File) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

export function ImportWizard({ bank, categories, open, onOpenChange, resumeBatchId, onFinished }: Props) {
  const { tr } = useI18n();
  const [step, setStep] = useState<Step>(1);
  const [files, setFiles] = useState<File[]>([]);
  const file = files[0] ?? null;
  const images = files.length > 0 && files.every(isImage);
  const mixed = files.length > 1 && !images;
  const [useModel, setUseModel] = useState(bank.allow_model);
  // The model decides catalogue place, grade, knowledge points and difficulty (editable in review).
  const [classify, setClassify] = useState(bank.allow_model);
  const [preview, setPreview] = useState<ColumnPreview | null>(null);
  const [columnMap, setColumnMap] = useState<Record<string, string>>({});
  const [batch, setBatch] = useState<ImportBatch | null>(null);
  const [drafts, setDrafts] = useState<DraftItem[]>([]);
  const [dirty, setDirty] = useState(false);
  const [statusFilter, setStatusFilter] = useState<DraftItem["status"] | "all">("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Busy>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targetCategory, setTargetCategory] = useState("");
  const [rights, setRights] = useState(false);
  const [committed, setCommitted] = useState<number | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const elapsed = useElapsed(startedAt);
  const fileInput = useRef<HTMLInputElement>(null);

  // Resume a pending batch.
  useEffect(() => {
    if (!open || !resumeBatchId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api<{ batch: ImportBatch }>(bankUrl(bank.id, `/imports/${encodeURIComponent(resumeBatchId)}`));
        if (cancelled) return;
        setBatch(res.batch);
        setDrafts(res.batch.drafts);
        setStep(3);
      } catch (e) {
        if (!cancelled) setError(errMsg(e, tr("无法读取导入批次", "Could not load the import batch")));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, resumeBatchId, bank.id, tr]);

  const run = async <T,>(kind: Exclude<Busy, null>, fn: () => Promise<T>, fallback: string): Promise<T | undefined> => {
    setBusy(kind);
    setStartedAt(Date.now());
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof DOMException && e.name === "AbortError" ? tr("请求超时，请稍后重试", "The request timed out; try again later") : errMsg(e, fallback));
      return undefined;
    } finally {
      setBusy(null);
      setStartedAt(null);
    }
  };

  async function next() {
    if (!file || mixed) return;
    if (isTabular(file.name)) {
      const fd = new FormData();
      fd.append("file", file);
      const res = await run("preview", () => api<ColumnPreview>(bankUrl(bank.id, "/imports?preview=columns"), { method: "POST", body: fd }), tr("无法读取表格", "Could not read the sheet"));
      if (res) {
        setPreview(res);
        setColumnMap({ ...res.suggested });
        setStep(2);
      }
      return;
    }
    await upload();
  }

  async function upload() {
    if (!file) return;
    const fd = new FormData();
    for (const f of files) fd.append("file", f);
    if (!useModel || !bank.allow_model) fd.append("use_model", "false");
    if (!classify || !bank.allow_model) fd.append("classify", "false");
    if (preview) {
      const cm = Object.fromEntries(Object.entries(columnMap).filter(([, f]) => f && f !== "ignore"));
      fd.append("column_map", JSON.stringify(cm));
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 540_000);
    const res = await run(
      "upload",
      () => api<{ batch: ImportBatch }>(bankUrl(bank.id, "/imports"), { method: "POST", body: fd, signal: ctrl.signal }),
      tr("导入失败", "Import failed"),
    );
    clearTimeout(timer);
    if (res) {
      setBatch(res.batch);
      setDrafts(res.batch.drafts);
      setDirty(false);
      setStep(3);
    }
  }

  async function saveDrafts(): Promise<boolean> {
    if (!batch) return false;
    const res = await run(
      "save",
      () => api<{ batch: ImportBatch }>(bankUrl(bank.id, `/imports/${encodeURIComponent(batch.id)}`), { method: "PATCH", json: { drafts } }),
      tr("保存失败", "Save failed"),
    );
    if (!res) return false;
    setBatch(res.batch);
    setDrafts(res.batch.drafts);
    setDirty(false);
    return true;
  }

  async function goCommitStep() {
    if (dirty && !(await saveDrafts())) return;
    setStep(4);
  }

  async function commit() {
    if (!batch || !rights) return;
    const res = await run(
      "commit",
      () =>
        api<{ batch: ImportBatch; committed: number }>(bankUrl(bank.id, `/imports/${encodeURIComponent(batch.id)}`), {
          method: "POST",
          json: { action: "commit", rights_confirmed: true, category_id: targetCategory || undefined },
        }),
      tr("提交失败", "Commit failed"),
    );
    if (res) {
      setBatch(res.batch);
      setCommitted(res.committed);
      onFinished();
    }
  }

  async function discard() {
    if (!batch) return;
    const res = await run(
      "discard",
      () => api<{ batch: ImportBatch }>(bankUrl(bank.id, `/imports/${encodeURIComponent(batch.id)}`), { method: "POST", json: { action: "discard" } }),
      tr("放弃失败", "Discard failed"),
    );
    if (res) {
      setConfirmDiscard(false);
      onFinished();
      onOpenChange(false);
    }
  }

  const updateDraft = (id: string, patch: Partial<DraftItem>) => {
    setDrafts((ds) => ds.map((d) => (d.draft_id === id ? { ...d, ...patch } : d)));
    setDirty(true);
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const d of drafts) c[d.status] = (c[d.status] ?? 0) + 1;
    return c;
  }, [drafts]);
  const shown = statusFilter === "all" ? drafts : drafts.filter((d) => d.status === statusFilter);
  const toCommit = drafts.filter((d) => d.include && d.status !== "error" && d.status !== "duplicate").length;
  const pdfTidy = !!file && (isPdf(file.name) || images);
  const chooseFiles = (list: FileList | null | undefined) => {
    const all = Array.from(list ?? []);
    setFiles(all.length > 1 && all.every(isImage) ? all.sort(byName) : all);
    setPreview(null);
    setError(null);
  };

  const steps: Array<{ n: Step; label: string }> = [
    { n: 1, label: tr("选择文件", "Choose file") },
    { n: 2, label: tr("列映射", "Map columns") },
    { n: 3, label: tr("复核", "Review") },
    { n: 4, label: tr("提交", "Commit") },
  ];

  return (
    <Sheet open={open} onOpenChange={(o) => busy === null && onOpenChange(o)}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-3xl">
        <SheetHeader className="border-b border-border/60 px-5 pb-3 pt-5">
          <SheetTitle className="flex items-center gap-2 text-base">
            <FileUp className="h-4 w-4 text-primary" />
            {tr("导入题目", "Import questions")}
          </SheetTitle>
          <SheetDescription className="text-xs">{tr(`导入到“${bank.name}”`, `Into "${bank.name}"`)}</SheetDescription>
          <ol className="flex flex-wrap items-center gap-1 pt-1 text-xs">
            {steps.map((s, i) => (
              <li key={s.n} className="flex items-center gap-1">
                {i > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground/50" />}
                <span
                  className={cn(
                    "flex items-center gap-1 rounded-full px-2 py-0.5",
                    step === s.n ? "bg-primary/15 font-medium text-primary" : step > s.n ? "text-foreground" : "text-muted-foreground",
                    s.n === 2 && !preview && step > 2 && "line-through opacity-50",
                  )}
                >
                  <span className="tabular-nums">{s.n}</span>
                  {s.label}
                </span>
              </li>
            ))}
          </ol>
        </SheetHeader>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <ErrorNote message={error} onDismiss={() => setError(null)} />

          {/* ── Step 1: file ───────────────────────────────────────── */}
          {step === 1 && (
            <div className="space-y-4">
              <div
                className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-white/[0.02] px-4 py-8 text-center transition-colors hover:border-primary/50"
                onClick={() => fileInput.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  chooseFiles(e.dataTransfer.files);
                }}
              >
                {images ? <ImageIcon className="h-6 w-6 text-muted-foreground" /> : <Upload className="h-6 w-6 text-muted-foreground" />}
                <p className="text-sm">
                  {files.length > 1
                    ? images
                      ? tr(`${files.length} 张图片（按文件名排序作为第 1–${files.length} 页）`, `${files.length} images (pages 1–${files.length} in file-name order)`)
                      : tr(`${files.length} 个文件`, `${files.length} files`)
                    : file
                      ? file.name
                      : tr("点击选择或拖入文件", "Click to choose or drop a file")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {file
                    ? `${(files.reduce((n, f) => n + f.size, 0) / 1024).toFixed(1)} KB`
                    : tr("PDF（含扫描件）· 图片 / 照片 · JSON · CSV · Excel (.xlsx) · Markdown · TXT", "PDF (incl. scans) · images / photos · JSON · CSV · Excel (.xlsx) · Markdown · TXT")}
                </p>
                <input
                  ref={fileInput}
                  type="file"
                  accept={ACCEPT}
                  multiple
                  className="hidden"
                  data-testid="import-file"
                  onChange={(e) => chooseFiles(e.target.files)}
                />
              </div>
              {files.length > 1 && images && (
                <ol className="max-h-32 list-inside list-decimal overflow-y-auto rounded-md border border-border/60 bg-white/[0.02] px-3 py-2 text-xs text-muted-foreground">
                  {files.map((f) => (
                    <li key={f.name + f.size} className="truncate">
                      {f.name}
                    </li>
                  ))}
                </ol>
              )}
              {mixed && (
                <p className="text-xs text-destructive">
                  {tr("一次只能选一个文件；多选只适用于图片（同一份试卷的多页照片）。", "Choose one file at a time; several files are only accepted as images (pages of the same paper).")}
                </p>
              )}
              {images && (
                <div className={cn("flex items-start gap-2 rounded-md border px-3 py-2 text-xs", bank.allow_model ? "border-primary/20 bg-primary/5 text-muted-foreground" : "border-warning/30 bg-warning/5 text-warning")}>
                  <ScanText className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    {bank.allow_model
                      ? tr(
                          "图片会逐页发送给模型识别文字、公式和图形；图形会裁剪后附在对应题目上。识别结果都需要对照原图复核。HEIC 照片请先导出为 JPEG。",
                          "Each image is sent to the model, which reads the text, formulas and figures; figures are cut out and attached to their question. Everything read from images must be checked against the original in review. Export HEIC photos as JPEG first.",
                        )
                      : tr("识别图片需要把图片发送给模型，而此题库不允许发送给模型。", "Reading images means sending them to the model, and this bank does not allow that.")}
                  </span>
                </div>
              )}
              <CheckboxField
                checked={useModel && bank.allow_model}
                onChange={setUseModel}
                disabled={!bank.allow_model}
                hint={
                  bank.allow_model
                    ? tr("对 PDF 和图片生效：模型会修正断行、公式和选项识别。", "PDF and images: the model fixes broken lines, formulas and option detection.")
                    : tr("此题库不允许发送给模型。", "This bank does not allow sending content to the model.")
                }
              >
                {tr("用模型整理 PDF / 图片中的题目", "Use the model to tidy PDF / image questions")}
              </CheckboxField>
              <CheckboxField
                checked={classify && bank.allow_model}
                onChange={setClassify}
                disabled={!bank.allow_model}
                hint={
                  bank.allow_model
                    ? tr("模型为每道题确定目录位置（如“数与代数 › 分数”）、年级、知识点和难度；缺少的分类在提交时自动创建，审核时可修改。", "The model decides each question's place in the catalogue (e.g. Number › Fractions), grade, knowledge points and difficulty; missing categories are created on commit, and you can change everything in review.")
                    : tr("此题库不允许发送给模型。", "This bank does not allow sending content to the model.")
                }
              >
                {tr("由模型决定目录、分类和难度", "Let the model decide category, classification and difficulty")}
              </CheckboxField>
              {busy === "upload" && <Progress elapsed={elapsed} slow={((pdfTidy && useModel) || classify || images) && bank.allow_model} ocr={images} />}
            </div>
          )}

          {/* ── Step 2: column mapping ─────────────────────────────── */}
          {step === 2 && preview && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {tr("为每一列选择对应的字段。可以把多列映射为“选项”（每列一个选项）。", "Choose the field for each column. Several columns can map to Options (one option per column).")}
              </p>
              <div className="overflow-x-auto rounded-lg border border-border/60">
                <table className="w-full text-sm">
                  <thead className="bg-white/[0.03] text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-bold">{tr("列", "Column")}</th>
                      <th className="px-3 py-2 font-bold">{tr("字段", "Field")}</th>
                      <th className="px-3 py-2 font-bold">{tr("示例", "Sample")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40">
                    {preview.headers.map((h, i) => (
                      <tr key={h + i}>
                        <td className="px-3 py-2 font-medium">{h}</td>
                        <td className="px-3 py-2">
                          <NativeSelect value={columnMap[h] ?? "ignore"} onChange={(v) => setColumnMap({ ...columnMap, [h]: v })} className="h-8 min-w-[9rem] text-xs" ariaLabel={tr(`${h} 对应字段`, `Field for ${h}`)}>
                            <option value="ignore">{tr("（忽略）", "(ignore)")}</option>
                            {MAP_FIELDS.map((f) => (
                              <option key={f} value={f}>
                                {fieldLabel(f, tr)}
                              </option>
                            ))}
                          </NativeSelect>
                        </td>
                        <td className="max-w-[16rem] px-3 py-2 text-xs text-muted-foreground">
                          <span className="line-clamp-2 break-words">{preview.sample.map((row) => row[i]).filter(Boolean).slice(0, 2).join(" | ")}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!Object.values(columnMap).includes("stem") && (
                <p className="text-xs text-warning">{tr("请至少把一列映射为“题干”。", "Map at least one column to Question text.")}</p>
              )}
              {busy === "upload" && <Progress elapsed={elapsed} slow={false} />}
            </div>
          )}

          {/* ── Step 3: review ─────────────────────────────────────── */}
          {step === 3 && batch && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <FilterChip active={statusFilter === "all"} onClick={() => setStatusFilter("all")}>
                  {tr("全部", "All")} {drafts.length}
                </FilterChip>
                {DRAFT_STATUS_LIST.filter((s) => counts[s]).map((s) => (
                  <FilterChip key={s} active={statusFilter === s} onClick={() => setStatusFilter(s)}>
                    <Badge variant={statusVariant(s)} className="px-1.5 py-0 text-[10px]">
                      {statusLabel(s, tr)}
                    </Badge>
                    {counts[s]}
                  </FilterChip>
                ))}
              </div>
              {batch.ocr && (
                <div className="flex items-start gap-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
                  <ScanText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                  <span>
                    {tr(
                      "这些题目是由模型从图片识别的，可能有错字、漏字或公式错误。展开每道题可对照原页面图像修改；图形已尽量裁剪并附在题目上。",
                      "These questions were read from images by the model and may contain misread words or formulas. Expand a question to compare it with its page image; figures were cut out and attached where possible.",
                    )}
                  </span>
                </div>
              )}
              {(batch.notes?.length ?? 0) > 0 && (
                <ul className="space-y-0.5 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning" data-testid="batch-notes">
                  {batch.notes!.map((n, i) => (
                    <li key={i} className="flex items-start gap-1.5">
                      <Info className="mt-0.5 h-3 w-3 shrink-0" />
                      {n}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-muted-foreground">
                {tr(
                  `文件：${batch.file_name}。“重复”和“错误”的题不会入库；可修改后保存，服务器会重新检查。`,
                  `File: ${batch.file_name}. Duplicates and errors are not committed; edit and save to have them re-checked.`,
                )}
              </p>
              <ul className="space-y-2">
                {shown.map((d) => {
                  const idx = drafts.indexOf(d);
                  const open = expanded.has(d.draft_id);
                  return (
                    <li key={d.draft_id} className={cn("rounded-lg border border-border/60 bg-white/[0.02]", !d.include && "opacity-60")} data-testid="draft-row">
                      <div className="flex items-start gap-2.5 p-3">
                        <input
                          type="checkbox"
                          className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-primary)]"
                          checked={d.include}
                          onChange={(e) => updateDraft(d.draft_id, { include: e.target.checked })}
                          aria-label={tr("包含此题", "Include this question")}
                        />
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-xs font-semibold tabular-nums text-muted-foreground">#{d.source?.label ?? idx + 1}</span>
                            <Badge variant={statusVariant(d.status)} className="px-1.5 py-0 text-[10px]">
                              {statusLabel(d.status, tr)}
                            </Badge>
                            <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-medium">
                              {typeLabel(d.type, tr)}
                            </Badge>
                            {d.answer && <span className="text-[10px] text-muted-foreground">{tr("答案", "Answer")}: {d.answer}</span>}
                            {d.source?.page && <span className="text-[10px] text-muted-foreground">{tr(`第 ${d.source.page} 页`, `p. ${d.source.page}`)}</span>}
                          {d.source?.page_image && (
                            <a href={assetUrl(bank.id, d.source.page_image)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-[10px] text-primary hover:underline">
                              <ImageIcon className="h-3 w-3" />
                              {tr("原图", "Page image")}
                            </a>
                          )}
                          </div>
                          <div className={cn("break-words text-sm leading-relaxed", !open && "line-clamp-2")}>
                            <MathText text={d.stem} />
                          </div>
                          <ClassificationLine fields={d} />
                          {!open && <AssetImages bankId={bank.id} images={d.images} size="sm" />}
                          {d.issues.length > 0 && (
                            <ul className="space-y-0.5 text-xs text-warning">
                              {d.issues.map((x, i) => (
                                <li key={i}>• {x}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 shrink-0 gap-1 px-2 text-xs"
                          onClick={() => {
                            const n = new Set(expanded);
                            if (open) n.delete(d.draft_id);
                            else n.add(d.draft_id);
                            setExpanded(n);
                          }}
                        >
                          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                          {open ? tr("收起", "Collapse") : tr("编辑", "Edit")}
                        </Button>
                      </div>
                      {open && <DraftEditor key={d.knowledge_points.join("|")} bankId={bank.id} draft={d} onChange={(p) => updateDraft(d.draft_id, p)} />}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* ── Step 4: commit ─────────────────────────────────────── */}
          {step === 4 && batch && (
            <div className="space-y-4">
              {committed === null ? (
                <>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Stat label={tr("将入库", "To commit")} value={toCommit} tone="success" />
                    <Stat label={tr("总数", "Total")} value={batch.report?.total ?? drafts.length} />
                    <Stat label={tr("重复（跳过）", "Duplicates (skipped)")} value={counts.duplicate ?? 0} />
                    <Stat label={tr("错误（跳过）", "Errors (skipped)")} value={counts.error ?? 0} tone={counts.error ? "destructive" : undefined} />
                  </div>
                  <div className="space-y-1.5">
                    <FieldLabel>{tr("加入分类（可选）", "Add to category (optional)")}</FieldLabel>
                    <NativeSelect value={targetCategory} onChange={setTargetCategory} ariaLabel={tr("目标分类", "Target category")}>
                      <option value="">{tr("（不加入分类）", "(no category)")}</option>
                      {categories
                        .filter((c) => c.kind === "manual")
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                    </NativeSelect>
                  </div>
                  <div className="rounded-lg border border-warning/30 bg-warning/5 p-3">
                    <CheckboxField checked={rights} onChange={setRights}>
                      {tr(
                        "我确认有权在本系统中使用这些题目（第三方试卷需出版方书面授权，例如 ICAS）",
                        "I confirm I have the right to use these questions in this system (third-party papers such as ICAS require the publisher's written permission)",
                      )}
                    </CheckboxField>
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center gap-2 rounded-lg border border-success/30 bg-success/5 px-4 py-8 text-center">
                  <CheckCircle2 className="h-8 w-8 text-success" />
                  <p className="text-base font-semibold" data-testid="import-committed">
                    {tr(`已导入 ${committed} 道题`, `Imported ${committed} question${committed === 1 ? "" : "s"}`)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {tr(
                      `共 ${batch.report?.total ?? 0} 条：正常 ${batch.report?.ok ?? 0}，需复核 ${batch.report?.needs_review ?? 0}，重复 ${batch.report?.duplicate ?? 0}，错误 ${batch.report?.error ?? 0}`,
                      `${batch.report?.total ?? 0} total: ${batch.report?.ok ?? 0} OK, ${batch.report?.needs_review ?? 0} needs review, ${batch.report?.duplicate ?? 0} duplicate, ${batch.report?.error ?? 0} error`,
                    )}
                  </p>
                </div>
              )}
            </div>
          )}

          {!batch && step >= 3 && busy === null && !error && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {tr("加载中…", "Loading…")}
            </div>
          )}
        </div>

        {/* ── Footer actions ───────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-5 py-3">
          {(step === 3 || step === 4) && batch?.status === "draft" && committed === null && (
            confirmDiscard ? (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-destructive">{tr("放弃整批？", "Discard the whole batch?")}</span>
                <Button size="sm" variant="destructive" loading={busy === "discard"} onClick={() => void discard()}>
                  {tr("确认放弃", "Confirm discard")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDiscard(false)}>
                  {tr("取消", "Cancel")}
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="ghost" className="gap-1.5 text-destructive hover:text-destructive" onClick={() => setConfirmDiscard(true)} disabled={busy !== null}>
                <Trash2 className="h-3.5 w-3.5" />
                {tr("放弃", "Discard")}
              </Button>
            )
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {step === 1 && (
              <Button size="sm" disabled={!file} loading={busy === "preview" || busy === "upload"} onClick={() => void next()}>
                {file && isTabular(file.name) ? tr("下一步", "Next") : tr("上传并解析", "Upload and parse")}
              </Button>
            )}
            {step === 2 && (
              <>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setStep(1)}>
                  {tr("上一步", "Back")}
                </Button>
                <Button size="sm" disabled={!Object.values(columnMap).includes("stem")} loading={busy === "upload"} onClick={() => void upload()}>
                  {tr("导入", "Import")}
                </Button>
              </>
            )}
            {step === 3 && (
              <>
                {dirty && <span className="text-xs text-warning">{tr("有未保存的修改", "Unsaved changes")}</span>}
                <Button size="sm" variant="outline" className="gap-1.5" disabled={!dirty} loading={busy === "save"} onClick={() => void saveDrafts()}>
                  <Save className="h-3.5 w-3.5" />
                  {tr("保存修改", "Save changes")}
                </Button>
                <Button size="sm" disabled={busy !== null} onClick={() => void goCommitStep()}>
                  {tr("下一步", "Next")}
                </Button>
              </>
            )}
            {step === 4 && committed === null && (
              <>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setStep(3)}>
                  {tr("返回复核", "Back to review")}
                </Button>
                <Button size="sm" disabled={!rights || toCommit === 0} loading={busy === "commit"} onClick={() => void commit()}>
                  {tr(`提交 ${toCommit} 道题`, `Commit ${toCommit} question${toCommit === 1 ? "" : "s"}`)}
                </Button>
              </>
            )}
            {committed !== null && (
              <Button size="sm" onClick={() => onOpenChange(false)}>
                {tr("完成", "Done")}
              </Button>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function fieldLabel(f: (typeof MAP_FIELDS)[number], tr: (zh: string, en: string) => string): string {
  const m: Record<(typeof MAP_FIELDS)[number], string> = {
    stem: tr("题干", "Question text"),
    type: tr("题型", "Type"),
    options: tr("选项", "Options"),
    answer: tr("答案", "Answer"),
    solution: tr("解析", "Solution"),
    grade: tr("年级", "Grade"),
    difficulty: tr("难度", "Difficulty"),
    knowledge_points: tr("知识点", "Knowledge points"),
    tags: tr("标签", "Tags"),
    label: tr("题号", "Label / number"),
  };
  return m[f];
}

function Progress({ elapsed, slow, ocr }: { elapsed: number; slow: boolean; ocr?: boolean }) {
  const { tr } = useI18n();
  return (
    <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5 text-sm">
      <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />
      <div>
        <p>
          {tr("正在解析文件…", "Parsing the file…")} <span className="tabular-nums text-muted-foreground">{elapsed}s</span>
        </p>
        {slow && (
          <p className="text-xs text-muted-foreground">
            {ocr
              ? tr("模型正在逐页识别图片，每页约需 10–40 秒，请勿关闭。", "The model is reading the images page by page (about 10–40 s per page); keep this open.")
              : tr("经模型整理可能需要几分钟（扫描版 PDF 会逐页识别），请勿关闭。", "Tidying with the model can take a few minutes (scanned PDFs are read page by page); keep this open.")}
          </p>
        )}
      </div>
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs tabular-nums transition-colors",
        active ? "border-primary/50 bg-primary/10 text-foreground" : "border-border/60 text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "success" | "destructive" }) {
  return (
    <div className="rounded-lg border border-border/60 bg-white/[0.02] p-2.5">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={cn("text-lg font-semibold tabular-nums", tone === "success" && "text-success", tone === "destructive" && "text-destructive")}>{value}</p>
    </div>
  );
}

function DraftEditor({ bankId, draft, onChange }: { bankId: string; draft: DraftItem; onChange: (p: Partial<DraftItem>) => void }) {
  const { tr } = useI18n();
  const pageImage = draft.source?.page_image;
  return (
    <div className="grid gap-3 border-t border-border/40 p-3 md:grid-cols-2">
      <div className="space-y-1.5">
        {pageImage && (
          <>
            <FieldLabel>{tr(`原图（第 ${draft.source?.page ?? "?"} 页）`, `Page image (page ${draft.source?.page ?? "?"})`)}</FieldLabel>
            <a href={assetUrl(bankId, pageImage)} target="_blank" rel="noreferrer" className="block max-h-[28rem] overflow-auto rounded-md border border-border/60 bg-white" title={tr("在新窗口打开原图", "Open the page image in a new window")}>
              {/* eslint-disable-next-line @next/next/no-img-element -- bank assets are served by our API */}
              <img src={assetUrl(bankId, pageImage)} alt={tr("原页面", "Original page")} className="block w-full" data-testid="page-image" />
            </a>
          </>
        )}
        <FieldLabel>{pageImage ? tr("识别出的文字", "Text read from the image") : tr("原文", "Original text")}</FieldLabel>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-code-bg p-2.5 font-mono text-xs leading-relaxed text-muted-foreground">
          {draft.raw || tr("（无）", "(none)")}
        </pre>
        {draft.images.length > 0 && (
          <>
            <FieldLabel>{tr("题目图形（悬停可移除错配的图）", "Figures (hover to remove a wrong one)")}</FieldLabel>
            <AssetImages bankId={bankId} images={draft.images} onRemove={(i) => onChange({ images: draft.images.filter((_, k) => k !== i) })} />
          </>
        )}
      </div>
      <div className="space-y-2.5">
        <div className="space-y-1">
          <FieldLabel>{tr("题干", "Question")}</FieldLabel>
          <Textarea rows={4} value={draft.stem} onChange={(e) => onChange({ stem: e.target.value })} className="text-sm" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <FieldLabel>{tr("题型", "Type")}</FieldLabel>
            <NativeSelect value={draft.type} onChange={(v) => onChange({ type: v as QuestionType })} className="h-8 text-xs" ariaLabel={tr("题型", "Type")}>
              {QUESTION_TYPE_LIST.map((t) => (
                <option key={t} value={t}>
                  {typeLabel(t, tr)}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <FieldLabel>{tr("难度", "Difficulty")}</FieldLabel>
            <NativeSelect value={draft.difficulty ? String(draft.difficulty) : ""} onChange={(v) => onChange({ difficulty: v ? Number(v) : undefined })} className="h-8 text-xs" ariaLabel={tr("难度", "Difficulty")}>
              <option value="">{tr("未设置", "Not set")}</option>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
        {draft.type === "multiple_choice" && (
          <div className="space-y-1">
            <FieldLabel>{tr("选项（每行一个，按 A、B、C… 顺序）", "Options (one per line, in A, B, C… order)")}</FieldLabel>
            <Textarea
              rows={Math.max(3, (draft.options?.length ?? 0) + 1)}
              value={(draft.options ?? []).join("\n")}
              onChange={(e) => onChange({ options: e.target.value.split("\n") })}
              onBlur={() => onChange({ options: (draft.options ?? []).map((o) => o.trim()).filter(Boolean) })}
              className="text-sm"
            />
            {(draft.options ?? []).some((o) => /\$|\\\(/.test(o)) && (
              <div className="space-y-0.5 text-xs text-muted-foreground">
                {(draft.options ?? []).filter(Boolean).map((o, i) => (
                  <div key={i}>
                    <span className="font-semibold">{letter(i)}.</span> <MathText text={o} />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="space-y-1">
          <FieldLabel>{tr("答案", "Answer")}</FieldLabel>
          <Input value={draft.answer ?? ""} onChange={(e) => onChange({ answer: e.target.value })} className="h-8 text-sm" />
        </div>
        <div className="grid grid-cols-[2fr_1fr] gap-2">
          <div className="space-y-1">
            <FieldLabel>{tr("目录（用 > 分隔层级）", "Category (levels separated by >)")}</FieldLabel>
            <Input
              defaultValue={(draft.category_path ?? []).join(" > ")}
              placeholder={tr("如：数与代数 > 分数", "e.g. Number > Fractions")}
              onBlur={(e) => {
                const next = e.target.value.split(/\s*[>›/]\s*/).map((x) => x.trim()).filter(Boolean).slice(0, 4);
                if (next.join("\n") !== (draft.category_path ?? []).join("\n")) onChange({ category_path: next.length ? next : undefined });
              }}
              className="h-8 text-sm"
            />
          </div>
          <div className="space-y-1">
            <FieldLabel>{tr("年级", "Grade")}</FieldLabel>
            <Input value={draft.grade ?? ""} onChange={(e) => onChange({ grade: e.target.value || undefined })} className="h-8 text-sm" />
          </div>
        </div>
        <div className="space-y-1">
          <FieldLabel>{tr("知识点（逗号分隔）", "Knowledge points (comma-separated)")}</FieldLabel>
          <Input
            defaultValue={draft.knowledge_points.join(", ")}
            onBlur={(e) => {
              const next = splitList(e.target.value);
              if (next.join("\n") !== draft.knowledge_points.join("\n")) onChange({ knowledge_points: next });
            }}
            className="h-8 text-sm"
          />
        </div>
        <div className="space-y-1">
          <FieldLabel>{tr("模型对这道题的理解（作模板出题时使用，可修改）", "The model's reading of this question as a template (used for generation; editable)")}</FieldLabel>
          <Textarea
            rows={4}
            maxLength={1000}
            defaultValue={draft.template_hint ?? ""}
            onBlur={(e) => {
              const next = e.target.value.trim() || undefined;
              if (next !== draft.template_hint) onChange({ template_hint: next });
            }}
            className="text-sm"
          />
        </div>
      </div>
    </div>
  );
}
