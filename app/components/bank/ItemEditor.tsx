"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, ExternalLink, FileText, Plus, Save, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/lib/i18n";
import { MathText } from "../MathText";
import { api, bankUrl, errMsg, letter, problemText, QUESTION_TYPE_LIST, type BankDetail, type CategoryWithCount, type Item, type QuestionType } from "./api";
import { CheckboxField, ErrorNote, FieldLabel, KnowledgePointInput, Modal, NativeSelect, originLabel, originVariant, splitList, typeLabel } from "./ui";

type Props = {
  bankId: string;
  item: Item;
  detail: BankDetail;
  categories: CategoryWithCount[];
  onSaved: (item: Item) => void;
  onDeleted: () => void;
  onClose: () => void;
};

type Form = {
  stem: string;
  type: QuestionType;
  options: string[];
  answer: string;
  solution: string;
  grade: string;
  difficulty: string;
  knowledge_points: string[];
  tags: string;
  category_ids: string[];
};

const toForm = (it: Item): Form => ({
  stem: it.stem,
  type: it.type,
  options: it.options ?? [],
  answer: it.answer ?? "",
  solution: it.solution ?? "",
  grade: it.grade ?? "",
  difficulty: it.difficulty ? String(it.difficulty) : "",
  knowledge_points: it.knowledge_points,
  tags: it.tags.join(", "),
  category_ids: it.category_ids,
});

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Link to the original file (PDF opens at the page) when the import batch kept it. */
function sourceLink(bankId: string, item: Item, detail: BankDetail): string | null {
  const file = item.source?.file;
  if (!file) return null;
  const batch = detail.batches.find((b) => b.file_name === file && b.assets.length > 0);
  const asset = batch?.assets.find((a) => /\.pdf$/i.test(a)) ?? batch?.assets[0];
  if (!asset) return null;
  const url = bankUrl(bankId, `/assets/${encodeURIComponent(asset)}`);
  return /\.pdf$/i.test(asset) && item.source?.page ? `${url}#page=${item.source.page}` : url;
}

export function ItemEditor({ bankId, item, detail, categories, onSaved, onDeleted, onClose }: Props) {
  const { tr } = useI18n();
  const router = useRouter();
  const [form, setForm] = useState<Form>(() => toForm(item));
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setSaved(false);
    setForm((f) => ({ ...f, [k]: v }));
  };

  const base = toForm(item);
  const dirty = !same(base, form);
  const manualCats = categories.filter((c) => c.kind === "manual");
  const link = sourceLink(bankId, item, detail);

  async function save() {
    if (!form.stem.trim()) {
      setError(tr("题干不能为空", "The question text cannot be empty"));
      return;
    }
    const patch: Record<string, unknown> = {};
    if (form.stem !== base.stem) patch.stem = form.stem;
    if (form.type !== base.type) patch.type = form.type;
    const opts = form.type === "multiple_choice" ? form.options.map((o) => o.trim()).filter(Boolean) : [];
    if (!same(opts, item.options ?? [])) patch.options = opts;
    if (form.answer !== base.answer) patch.answer = form.answer;
    if (form.solution !== base.solution) patch.solution = form.solution;
    if (form.grade !== base.grade) patch.grade = form.grade.trim();
    if (form.difficulty !== base.difficulty && form.difficulty) patch.difficulty = Number(form.difficulty);
    if (!same(form.knowledge_points, base.knowledge_points)) patch.knowledge_points = form.knowledge_points;
    const tags = splitList(form.tags);
    if (!same(tags, item.tags)) patch.tags = tags;
    if (!same(form.category_ids, base.category_ids)) patch.category_ids = form.category_ids;
    setBusy("save");
    setError(null);
    try {
      const res = await api<{ item: Item }>(bankUrl(bankId, `/items/${encodeURIComponent(item.id)}`), { method: "PATCH", json: patch });
      setForm(toForm(res.item));
      setSaved(true);
      onSaved(res.item);
    } catch (e) {
      setError(errMsg(e, tr("保存失败", "Save failed")));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("delete");
    setError(null);
    try {
      await api(bankUrl(bankId, `/items/${encodeURIComponent(item.id)}`), { method: "DELETE" });
      setConfirmDelete(false);
      onDeleted();
    } catch (e) {
      setError(errMsg(e, tr("删除失败", "Delete failed")));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={originVariant(item.origin)}>{originLabel(item.origin, tr)}</Badge>
          {item.generated_from && <span className="text-xs text-muted-foreground">{item.generated_from.template_label}</span>}
          {item.tags.includes("unchecked") && <Badge variant="warning">{tr("未校验", "Unchecked")}</Badge>}
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onClose} aria-label={tr("关闭详情", "Close details")}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Stem */}
      <div className="space-y-1.5">
        <FieldLabel htmlFor="ie-stem">{tr("题干", "Question")}</FieldLabel>
        <Textarea id="ie-stem" rows={4} value={form.stem} onChange={(e) => set("stem", e.target.value)} className="text-sm leading-relaxed" />
        <div className="rounded-md border border-border/60 bg-muted/30 p-2.5 text-sm leading-relaxed break-words">
          <MathText text={form.stem} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <FieldLabel>{tr("题型", "Type")}</FieldLabel>
          <NativeSelect value={form.type} onChange={(v) => set("type", v as QuestionType)} className="h-8" ariaLabel={tr("题型", "Type")}>
            {QUESTION_TYPE_LIST.map((t) => (
              <option key={t} value={t}>
                {typeLabel(t, tr)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <FieldLabel>{tr("难度", "Difficulty")}</FieldLabel>
          <NativeSelect value={form.difficulty} onChange={(v) => set("difficulty", v)} className="h-8" ariaLabel={tr("难度", "Difficulty")}>
            <option value="" disabled={!!base.difficulty}>
              {tr("未设置", "Not set")}
            </option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>

      {/* Options */}
      {form.type === "multiple_choice" && (
        <div className="space-y-1.5">
          <FieldLabel>{tr("选项", "Options")}</FieldLabel>
          {form.options.map((o, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="w-5 shrink-0 text-center text-sm font-semibold text-muted-foreground">{letter(i)}</span>
              <Input
                value={o}
                onChange={(e) => set("options", form.options.map((x, j) => (j === i ? e.target.value : x)))}
                className="h-8 text-sm"
                aria-label={tr(`选项 ${letter(i)}`, `Option ${letter(i)}`)}
              />
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => set("options", form.options.filter((_, j) => j !== i))} aria-label={tr(`删除选项 ${letter(i)}`, `Remove option ${letter(i)}`)}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          {form.options.length < 10 && (
            <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={() => set("options", [...form.options, ""])}>
              <Plus className="h-3 w-3" />
              {tr("添加选项", "Add option")}
            </Button>
          )}
          {form.options.some((o) => /\$|\\\(/.test(o)) && (
            <div className="space-y-0.5 rounded-md border border-border/60 bg-muted/30 p-2 text-sm">
              {form.options.map((o, i) => (
                <div key={i}>
                  <span className="font-semibold">{letter(i)}.</span> <MathText text={o} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="space-y-1.5">
        <FieldLabel htmlFor="ie-answer">{tr("答案", "Answer")}</FieldLabel>
        <Input id="ie-answer" value={form.answer} onChange={(e) => set("answer", e.target.value)} className="h-8 text-sm" />
      </div>
      <div className="space-y-1.5">
        <FieldLabel htmlFor="ie-solution">{tr("解析", "Solution")}</FieldLabel>
        <Textarea id="ie-solution" rows={3} value={form.solution} onChange={(e) => set("solution", e.target.value)} className="text-sm" />
        {form.solution && /\$|\\\(/.test(form.solution) && (
          <div className="rounded-md border border-border/60 bg-muted/30 p-2 text-sm">
            <MathText text={form.solution} />
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <FieldLabel htmlFor="ie-grade">{tr("年级", "Grade")}</FieldLabel>
          <Input id="ie-grade" value={form.grade} onChange={(e) => set("grade", e.target.value)} className="h-8 text-sm" list="ie-grades" />
          <datalist id="ie-grades">
            {detail.facets.grades.map((g) => (
              <option key={g.value} value={g.value} />
            ))}
          </datalist>
        </div>
        <div className="space-y-1.5">
          <FieldLabel htmlFor="ie-tags">{tr("标签（逗号分隔）", "Tags (comma-separated)")}</FieldLabel>
          <Input id="ie-tags" value={form.tags} onChange={(e) => set("tags", e.target.value)} className="h-8 text-sm" />
        </div>
      </div>
      <div className="space-y-1.5">
        <FieldLabel htmlFor="ie-kp">{tr("知识点", "Knowledge points")}</FieldLabel>
        <KnowledgePointInput id="ie-kp" value={form.knowledge_points} onChange={(v) => set("knowledge_points", v)} vocab={detail.vocab} />
      </div>
      {manualCats.length > 0 && (
        <div className="space-y-1.5">
          <FieldLabel>{tr("分类", "Categories")}</FieldLabel>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {manualCats.map((c) => (
              <CheckboxField
                key={c.id}
                checked={form.category_ids.includes(c.id)}
                onChange={(on) => set("category_ids", on ? [...form.category_ids, c.id] : form.category_ids.filter((x) => x !== c.id))}
              >
                {c.name}
              </CheckboxField>
            ))}
          </div>
        </div>
      )}

      {/* Source */}
      {item.source && (item.source.file || item.source.page || item.source.label) && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-white/[0.02] px-3 py-2 text-xs text-muted-foreground">
          <FileText className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-all">
            {item.source.file}
            {item.source.page ? tr(`，第 ${item.source.page} 页`, `, page ${item.source.page}`) : ""}
            {item.source.label ? tr(`，第 ${item.source.label} 题`, `, question ${item.source.label}`) : ""}
          </span>
          {link && (
            <a href={link} target="_blank" rel="noreferrer" className="ml-auto flex items-center gap-1 text-primary hover:underline">
              <ExternalLink className="h-3 w-3" />
              {tr("查看原文件", "Open original")}
            </a>
          )}
        </div>
      )}

      <ErrorNote message={error} onDismiss={() => setError(null)} />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" className="gap-1.5" onClick={() => void save()} disabled={!dirty} loading={busy === "save"}>
          <Save className="h-3.5 w-3.5" />
          {tr("保存", "Save")}
        </Button>
        {saved && !dirty && <span className="text-xs text-success">{tr("已保存", "Saved")}</span>}
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => router.push(`/?problem=${encodeURIComponent(problemText(item))}`)}>
          <ArrowRight className="h-3.5 w-3.5" />
          {tr("使用此题", "Use this problem")}
        </Button>
        <Button size="sm" variant="ghost" className="ml-auto gap-1.5 text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>
          <Trash2 className="h-3.5 w-3.5" />
          {tr("删除", "Delete")}
        </Button>
      </div>

      <Modal open={confirmDelete} onOpenChange={setConfirmDelete} title={tr("删除题目", "Delete question")} description={tr("删除这道题？此操作无法撤销。", "Delete this question? This cannot be undone.")}>
        <ErrorNote message={error} />
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
            {tr("取消", "Cancel")}
          </Button>
          <Button variant="destructive" loading={busy === "delete"} onClick={() => void remove()}>
            {tr("删除", "Delete")}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
