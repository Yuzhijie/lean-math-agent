"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight, FolderInput, FolderTree, Palette, Search, SearchX, Sparkles, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { MathText } from "../MathText";
import { api, bankUrl, errMsg, QUESTION_TYPE_LIST, type BankDetail, type CategoryWithCount, type Item } from "./api";
import { ErrorNote, Modal, NativeSelect, originLabel, originVariant, typeLabel } from "./ui";

export interface ListFilters {
  q: string;
  type: string;
  grade: string;
  kp: string;
  origin: string;
  dmin: string;
  dmax: string;
}

export const EMPTY_FILTERS: ListFilters = { q: "", type: "", grade: "", kp: "", origin: "", dmin: "", dmax: "" };

export const PAGE_SIZE = 20;

type Props = {
  bankId: string;
  detail: BankDetail;
  categories: CategoryWithCount[];
  activeCategory: CategoryWithCount | null;
  filters: ListFilters;
  onFiltersChange: (f: ListFilters) => void;
  result: { total: number; items: Item[] } | null;
  loading: boolean;
  error: string | null;
  page: number;
  onPageChange: (p: number) => void;
  selection: Map<string, Item>;
  onSelectionChange: (s: Map<string, Item>) => void;
  openItemId: string | null;
  onOpenItem: (item: Item) => void;
  onChanged: () => void;
  onGenerateFromItems: (items: Item[]) => void;
  onGenerateFromCategory: (cat: CategoryWithCount) => void;
};

export function ItemList(props: Props) {
  const { tr } = useI18n();
  const { bankId, detail, categories, activeCategory, filters, onFiltersChange, result, loading, page, selection, onSelectionChange } = props;
  const [assignTo, setAssignTo] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState<"assign" | "delete" | "classify" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const set = (patch: Partial<ListFilters>) => onFiltersChange({ ...filters, ...patch });
  const anyFilter = Object.entries(filters).some(([, v]) => v);
  const items = result?.items ?? [];
  const pageCount = Math.max(1, Math.ceil((result?.total ?? 0) / PAGE_SIZE));
  const allOnPage = items.length > 0 && items.every((i) => selection.has(i.id));
  const manualCats = categories.filter((c) => c.kind === "manual");
  const selected = [...selection.values()];

  const toggle = (it: Item) => {
    const next = new Map(selection);
    if (next.has(it.id)) next.delete(it.id);
    else next.set(it.id, it);
    onSelectionChange(next);
  };
  const togglePage = () => {
    const next = new Map(selection);
    if (allOnPage) for (const i of items) next.delete(i.id);
    else for (const i of items) next.set(i.id, i);
    onSelectionChange(next);
  };

  async function assign() {
    if (!assignTo) return;
    setBusy("assign");
    setError(null);
    setNotice(null);
    try {
      for (const it of selected) {
        if (it.category_ids.includes(assignTo)) continue;
        await api(bankUrl(bankId, `/items/${encodeURIComponent(it.id)}`), { method: "PATCH", json: { category_ids: [...it.category_ids, assignTo] } });
      }
      const name = categories.find((c) => c.id === assignTo)?.name ?? "";
      setNotice(tr(`已将 ${selected.length} 道题加入“${name}”`, `Added ${selected.length} question(s) to "${name}"`));
      setAssignTo("");
      onSelectionChange(new Map());
      props.onChanged();
    } catch (e) {
      setError(errMsg(e, tr("操作失败", "Action failed")));
      props.onChanged();
    } finally {
      setBusy(null);
    }
  }

  /** Let the model decide catalogue place, grade, knowledge points and difficulty for the selected questions. */
  async function classifySelected() {
    setBusy("classify");
    setError(null);
    setNotice(null);
    try {
      const r = await api<{ classified: number; failed: number; categories_created: number }>(bankUrl(bankId, "/classify"), {
        method: "POST",
        json: { item_ids: selected.map((it) => it.id) },
      });
      setNotice(
        tr(
          `模型已分类 ${r.classified} 道题${r.categories_created ? `，新建 ${r.categories_created} 个分类` : ""}${r.failed ? `；${r.failed} 道未能分类` : ""}`,
          `The model classified ${r.classified} question(s)${r.categories_created ? ` and created ${r.categories_created} categories` : ""}${r.failed ? `; ${r.failed} could not be classified` : ""}`,
        ),
      );
      onSelectionChange(new Map());
      props.onChanged();
    } catch (e) {
      setError(errMsg(e, tr("模型分类失败", "Model classification failed")));
    } finally {
      setBusy(null);
    }
  }

  async function removeSelected() {
    setBusy("delete");
    setError(null);
    try {
      for (const it of selected) await api(bankUrl(bankId, `/items/${encodeURIComponent(it.id)}`), { method: "DELETE" });
      setConfirmDelete(false);
      onSelectionChange(new Map());
      props.onChanged();
    } catch (e) {
      setError(errMsg(e, tr("删除失败", "Delete failed")));
      props.onChanged();
    } finally {
      setBusy(null);
    }
  }

  const facetOptions = (list: { value: string; count: number }[], label: (v: string) => string = (v) => v) =>
    list.map((f) => (
      <option key={f.value} value={f.value}>
        {label(f.value)} ({f.count})
      </option>
    ));

  return (
    <div className="space-y-3">
      {/* Search + filters */}
      <div className="space-y-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filters.q}
            onChange={(e) => set({ q: e.target.value })}
            placeholder={tr("搜索题干、答案、知识点……", "Search stems, answers, knowledge points…")}
            className="h-9 pl-8"
            aria-label={tr("搜索题目", "Search questions")}
          />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 2xl:grid-cols-6">
          <NativeSelect value={filters.type} onChange={(v) => set({ type: v })} className="h-8 text-xs" ariaLabel={tr("题型", "Type")}>
            <option value="">{tr("全部题型", "All types")}</option>
            {detail.facets.types.length
              ? facetOptions(detail.facets.types, (v) => typeLabel(v, tr))
              : QUESTION_TYPE_LIST.map((t) => (
                  <option key={t} value={t}>
                    {typeLabel(t, tr)}
                  </option>
                ))}
          </NativeSelect>
          <NativeSelect value={filters.grade} onChange={(v) => set({ grade: v })} className="h-8 text-xs" ariaLabel={tr("年级", "Grade")}>
            <option value="">{tr("全部年级", "All grades")}</option>
            {facetOptions(detail.facets.grades)}
          </NativeSelect>
          <NativeSelect value={filters.kp} onChange={(v) => set({ kp: v })} className="h-8 text-xs" ariaLabel={tr("知识点", "Knowledge point")}>
            <option value="">{tr("全部知识点", "All knowledge points")}</option>
            {facetOptions(detail.facets.knowledge_points)}
          </NativeSelect>
          <NativeSelect value={filters.origin} onChange={(v) => set({ origin: v })} className="h-8 text-xs" ariaLabel={tr("来源", "Origin")}>
            <option value="">{tr("全部来源", "All origins")}</option>
            {(["imported", "generated", "manual"] as const).map((o) => (
              <option key={o} value={o}>
                {originLabel(o, tr)}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect value={filters.dmin} onChange={(v) => set({ dmin: v })} className="h-8 text-xs" ariaLabel={tr("最低难度", "Min difficulty")}>
            <option value="">{tr("难度 ≥ 任意", "Difficulty ≥ any")}</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {tr(`难度 ≥ ${n}`, `Difficulty ≥ ${n}`)}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect value={filters.dmax} onChange={(v) => set({ dmax: v })} className="h-8 text-xs" ariaLabel={tr("最高难度", "Max difficulty")}>
            <option value="">{tr("难度 ≤ 任意", "Difficulty ≤ any")}</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {tr(`难度 ≤ ${n}`, `Difficulty ≤ ${n}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
        {anyFilter && (
          <button type="button" onClick={() => onFiltersChange(EMPTY_FILTERS)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <X className="h-3 w-3" />
            {tr("清除筛选", "Clear filters")}
          </button>
        )}
      </div>

      {/* Style category: no member questions */}
      {activeCategory?.kind === "style" && (
        <div className="flex flex-col gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <span className="flex items-start gap-2 text-muted-foreground">
            <Palette className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            {tr("风格模板只描述题目类型，没有成员题目。可以直接按此模板出题。", "A style template describes a type of question and has no member questions. Generate from it directly.")}
          </span>
        </div>
      )}

      {/* Bulk actions */}
      {selection.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm animate-fade-in">
          <span className="font-medium">{tr(`已选 ${selection.size} 题`, `${selection.size} selected`)}</span>
          <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => onSelectionChange(new Map())}>
            {tr("取消选择", "Clear")}
          </button>
          <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
            {manualCats.length > 0 && (
              <div className="flex items-center gap-1">
                <NativeSelect value={assignTo} onChange={setAssignTo} className="h-8 w-40 text-xs" ariaLabel={tr("加入分类", "Assign to category")}>
                  <option value="">{tr("加入分类…", "Assign to…")}</option>
                  {manualCats.map((c) => (
                    <option key={c.id} value={c.id}>
                      {pathName(c, categories)}
                    </option>
                  ))}
                </NativeSelect>
                <Button size="sm" variant="outline" className="h-8 gap-1" disabled={!assignTo} loading={busy === "assign"} onClick={() => void assign()}>
                  <FolderInput className="h-3.5 w-3.5" />
                  {tr("加入", "Assign")}
                </Button>
              </div>
            )}
            {detail.bank.allow_model && (
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1"
                loading={busy === "classify"}
                title={tr("由模型决定所选题目的目录、年级、知识点和难度（已有的年级、难度、知识点保留）", "Let the model decide category, grade, knowledge points and difficulty for the selected questions (existing grade, difficulty and knowledge points are kept)")}
                onClick={() => void classifySelected()}
              >
                <FolderTree className="h-3.5 w-3.5" />
                {tr("AI 分类", "AI classify")}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1"
              disabled={selection.size > 10}
              title={selection.size > 10 ? tr("最多选 10 道题作为模板", "Pick at most 10 questions as the template") : undefined}
              onClick={() => props.onGenerateFromItems(selected)}
            >
              <Sparkles className="h-3.5 w-3.5" />
              {tr("以此为模板出题", "Generate from these")}
            </Button>
            <Button size="sm" variant="ghost" className="h-8 gap-1 text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="h-3.5 w-3.5" />
              {tr("删除", "Delete")}
            </Button>
          </div>
        </div>
      )}
      <ErrorNote message={error ?? props.error} onDismiss={error ? () => setError(null) : undefined} />
      {notice && <p className="text-xs text-success">{notice}</p>}

      {/* List */}
      <div className="overflow-hidden rounded-lg border border-border/60 bg-white/[0.02]">
        <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
          <input type="checkbox" className="h-4 w-4 accent-[var(--color-primary)]" checked={allOnPage} onChange={togglePage} aria-label={tr("选择本页", "Select this page")} disabled={!items.length} />
          <span>
            {result
              ? result.total === 0
                ? tr("没有题目", "No questions")
                : tr(
                    `第 ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, result.total)} 题，共 ${result.total} 题`,
                    `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, result.total)} of ${result.total}`,
                  )
              : "…"}
          </span>
          {loading && <span className="ml-auto h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />}
        </div>
        {!result && loading ? (
          <div className="space-y-3 p-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground">
            <SearchX className="h-6 w-6 opacity-60" />
            {detail.item_count === 0
              ? tr("题库还是空的。用“导入”添加题目。", "The bank is empty. Use Import to add questions.")
              : tr("没有符合条件的题目。", "No questions match.")}
          </div>
        ) : (
          <ul className="divide-y divide-border/40">
            {items.map((it) => (
              <li
                key={it.id}
                className={cn(
                  "flex cursor-pointer items-start gap-2.5 px-3 py-2.5 transition-colors hover:bg-white/[0.03]",
                  props.openItemId === it.id && "bg-primary/[0.07]",
                )}
                onClick={() => props.onOpenItem(it)}
                data-testid="bank-item-row"
              >
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-primary)]"
                  checked={selection.has(it.id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggle(it)}
                  aria-label={tr("选择此题", "Select question")}
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="line-clamp-2 break-words text-sm leading-relaxed">
                    <MathText text={it.stem} />
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-medium">
                      {typeLabel(it.type, tr)}
                    </Badge>
                    <Badge variant={originVariant(it.origin)} className="px-1.5 py-0 text-[10px] font-medium">
                      {originLabel(it.origin, tr)}
                    </Badge>
                    {it.difficulty && (
                      <span className="text-[10px] text-warning" title={tr(`难度 ${it.difficulty}`, `Difficulty ${it.difficulty}`)}>
                        {"★".repeat(it.difficulty)}
                        <span className="opacity-30">{"★".repeat(5 - it.difficulty)}</span>
                      </span>
                    )}
                    {it.tags.includes("unchecked") && (
                      <Badge variant="warning" className="px-1.5 py-0 text-[10px]">
                        {tr("未校验", "Unchecked")}
                      </Badge>
                    )}
                    {it.knowledge_points.slice(0, 3).map((k) => (
                      <span key={k} className="max-w-[10rem] truncate text-[10px] text-muted-foreground">
                        · {k}
                      </span>
                    ))}
                    {it.knowledge_points.length > 3 && <span className="text-[10px] text-muted-foreground">+{it.knowledge_points.length - 3}</span>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        {pageCount > 1 && (
          <div className="flex items-center justify-between border-t border-border/60 px-3 py-1.5">
            <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" disabled={page <= 1} onClick={() => props.onPageChange(page - 1)}>
              <ChevronLeft className="h-3.5 w-3.5" />
              {tr("上一页", "Previous")}
            </Button>
            <span className="text-xs text-muted-foreground">
              {page} / {pageCount}
            </span>
            <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" disabled={page >= pageCount} onClick={() => props.onPageChange(page + 1)}>
              {tr("下一页", "Next")}
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>

      <Modal
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={tr("删除题目", "Delete questions")}
        description={tr(`删除选中的 ${selection.size} 道题？此操作无法撤销。`, `Delete the ${selection.size} selected question(s)? This cannot be undone.`)}
      >
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
            {tr("取消", "Cancel")}
          </Button>
          <Button variant="destructive" loading={busy === "delete"} onClick={() => void removeSelected()}>
            {tr("删除", "Delete")}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

/** "Parent › Child" name of a category, so same-named categories under different parents can be told apart. */
function pathName(c: { name: string; parent_id: string | null }, all: Array<{ id: string; name: string; parent_id: string | null }>): string {
  const names = [c.name];
  let parent = c.parent_id;
  for (let i = 0; parent && i < 5; i++) {
    const p = all.find((x) => x.id === parent);
    if (!p) break;
    names.unshift(p.name);
    parent = p.parent_id;
  }
  return names.join(" › ");
}
