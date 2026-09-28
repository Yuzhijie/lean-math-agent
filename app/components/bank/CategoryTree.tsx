"use client";

import { useMemo, useState } from "react";
import { Filter, Folder, Layers, MoreHorizontal, Palette, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import {
  api,
  bankUrl,
  errMsg,
  QUESTION_TYPE_LIST,
  type BankDetail,
  type Category,
  type CategoryWithCount,
  type ItemFilter,
  type QuestionType,
  type StyleTemplate,
} from "./api";
import { CheckboxField, ErrorNote, FieldLabel, KnowledgePointInput, Modal, NativeSelect, originLabel, typeLabel, type Tr } from "./ui";

export function KindIcon({ kind, className }: { kind: Category["kind"]; className?: string }) {
  const Icon = kind === "filter" ? Filter : kind === "style" ? Palette : Folder;
  return <Icon className={cn("h-3.5 w-3.5 shrink-0", kind === "style" ? "text-primary" : kind === "filter" ? "text-warning" : "text-muted-foreground", className)} />;
}

export function kindLabel(kind: Category["kind"], tr: Tr) {
  return kind === "filter" ? tr("筛选", "Filter") : kind === "style" ? tr("风格模板", "Style template") : tr("手动分组", "Manual group");
}

/** Short human-readable description of a saved filter. */
export function filterSummary(f: ItemFilter | undefined, tr: Tr): string {
  if (!f) return tr("（无条件）", "(no conditions)");
  const parts: string[] = [];
  if (f.query) parts.push(`"${f.query}"`);
  if (f.types?.length) parts.push(f.types.map((t) => typeLabel(t, tr)).join("/"));
  if (f.grades?.length) parts.push(f.grades.join("/"));
  if (f.knowledge_points?.length) parts.push(f.knowledge_points.join("/"));
  if (f.tags?.length) parts.push(f.tags.map((t) => `#${t}`).join(" "));
  if (f.difficulty_min || f.difficulty_max) parts.push(`${tr("难度", "difficulty")} ${f.difficulty_min ?? 1}–${f.difficulty_max ?? 5}`);
  if (f.origin) parts.push(originLabel(f.origin, tr));
  return parts.length ? parts.join(" · ") : tr("（无条件）", "(no conditions)");
}

type Props = {
  bankId: string;
  detail: BankDetail;
  categories: CategoryWithCount[];
  activeId: string | null;
  onSelect: (id: string | null) => void;
  /** Filters currently applied to the item list (used to create a filter category). */
  currentFilter: ItemFilter;
  onChanged: () => void;
  onGenerate: (cat: CategoryWithCount) => void;
};

export function CategoryTree({ bankId, detail, categories, activeId, onSelect, currentFilter, onChanged, onGenerate }: Props) {
  const { tr } = useI18n();
  const [editing, setEditing] = useState<CategoryWithCount | "new" | null>(null);
  const [deleting, setDeleting] = useState<CategoryWithCount | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const children = useMemo(() => {
    const m = new Map<string | null, CategoryWithCount[]>();
    const ids = new Set(categories.map((c) => c.id));
    for (const c of categories) {
      const p = c.parent_id && ids.has(c.parent_id) ? c.parent_id : null;
      m.set(p, [...(m.get(p) ?? []), c]);
    }
    for (const list of m.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return m;
  }, [categories]);

  async function remove(cat: CategoryWithCount) {
    setBusy(true);
    setError(null);
    try {
      await api(bankUrl(bankId, `/categories/${encodeURIComponent(cat.id)}`), { method: "DELETE" });
      if (activeId === cat.id) onSelect(null);
      setDeleting(null);
      onChanged();
    } catch (e) {
      setError(errMsg(e, tr("删除失败", "Delete failed")));
    } finally {
      setBusy(false);
    }
  }

  const renderNode = (c: CategoryWithCount, depth: number) => (
    <div key={c.id}>
      <div
        className={cn(
          "group flex items-center gap-1.5 rounded-md py-1 pr-1 text-sm transition-colors",
          activeId === c.id ? "bg-primary/10 text-primary" : "text-foreground hover:bg-white/[0.04]",
        )}
        style={{ paddingLeft: 6 + depth * 14 }}
      >
        <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => onSelect(c.id)} title={kindLabel(c.kind, tr)}>
          <KindIcon kind={c.kind} />
          <span className="truncate">{c.name}</span>
          <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">{c.kind === "style" ? "" : c.member_count}</span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0 opacity-70 hover:opacity-100" aria-label={tr(`${c.name} 的操作`, `Actions for ${c.name}`)}>
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[200px]">
            <DropdownMenuItem onSelect={() => onGenerate(c)} className="gap-2">
              <Sparkles className="h-3.5 w-3.5" />
              {tr("按此类出题", "Generate from this type")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setEditing(c)} className="gap-2">
              <Pencil className="h-3.5 w-3.5" />
              {tr("编辑 / 重命名", "Edit / rename")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setDeleting(c)} className="gap-2 text-destructive">
              <Trash2 className="h-3.5 w-3.5" />
              {tr("删除", "Delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {(children.get(c.id) ?? []).map((ch) => renderNode(ch, depth + 1))}
    </div>
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <FieldLabel>{tr("分类", "Categories")}</FieldLabel>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => setEditing("new")}>
          <Plus className="h-3 w-3" />
          {tr("新建分类", "New category")}
        </Button>
      </div>
      <div className="space-y-0.5">
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={cn(
            "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm transition-colors",
            activeId === null ? "bg-primary/10 text-primary" : "hover:bg-white/[0.04]",
          )}
        >
          <Layers className="h-3.5 w-3.5 text-muted-foreground" />
          {tr("全部题目", "All questions")}
          <span className="ml-auto pr-8 text-[10px] tabular-nums text-muted-foreground">{detail.item_count}</span>
        </button>
        {(children.get(null) ?? []).map((c) => renderNode(c, 0))}
        {categories.length === 0 && (
          <p className="px-1.5 py-2 text-xs text-muted-foreground">
            {tr("还没有分类。分类可以是手动分组、保存的筛选条件或风格模板（如 ICAS 风格）。", "No categories yet. A category can be a manual group, a saved filter or a style template (e.g. ICAS-style).")}
          </p>
        )}
      </div>

      {editing && (
        <CategoryForm
          key={editing === "new" ? "new" : editing.id}
          bankId={bankId}
          detail={detail}
          categories={categories}
          category={editing === "new" ? null : editing}
          currentFilter={currentFilter}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}

      <Modal
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={tr("删除分类", "Delete category")}
        description={
          deleting
            ? tr(`删除“${deleting.name}”？题目本身不会被删除。`, `Delete "${deleting.name}"? The questions themselves are not deleted.`)
            : undefined
        }
      >
        <ErrorNote message={error} />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDeleting(null)}>
            {tr("取消", "Cancel")}
          </Button>
          <Button variant="destructive" loading={busy} onClick={() => deleting && void remove(deleting)}>
            {tr("删除", "Delete")}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

// ── Create / edit form ───────────────────────────────────────────────

function descendants(categories: Category[], id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of categories) if (c.parent_id && out.has(c.parent_id) && !out.has(c.id)) (out.add(c.id), (grew = true));
  }
  return out;
}

function CategoryForm({
  bankId,
  detail,
  categories,
  category,
  currentFilter,
  onClose,
  onSaved,
}: {
  bankId: string;
  detail: BankDetail;
  categories: CategoryWithCount[];
  category: CategoryWithCount | null;
  currentFilter: ItemFilter;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { tr } = useI18n();
  const [name, setName] = useState(category?.name ?? "");
  const [parent, setParent] = useState(category?.parent_id ?? "");
  const [kind, setKind] = useState<Category["kind"]>(category?.kind ?? "manual");
  const [useCurrentFilter, setUseCurrentFilter] = useState(!category);
  const s = category?.style;
  const [style, setStyle] = useState<StyleTemplate>({
    grade: s?.grade ?? "",
    knowledge_points: s?.knowledge_points ?? [],
    type: s?.type ?? "multiple_choice",
    option_count: s?.option_count ?? 5,
    difficulty: s?.difficulty ?? 3,
    with_figure: s?.with_figure ?? false,
    language: s?.language ?? (detail.bank.language === "mixed" ? undefined : detail.bank.language),
    notes: s?.notes ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const excluded = category ? descendants(categories, category.id) : new Set<string>();

  async function save() {
    if (!name.trim()) {
      setError(tr("请填写名称", "Enter a name"));
      return;
    }
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = { name: name.trim(), parent_id: parent || null, kind };
    if (category) body.id = category.id;
    if (kind === "filter") body.filter = useCurrentFilter || !category?.filter ? currentFilter : category.filter;
    if (kind === "style") {
      body.style = {
        ...style,
        grade: style.grade?.trim() || undefined,
        notes: style.notes?.trim() || undefined,
        option_count: style.type === "multiple_choice" ? style.option_count : undefined,
      };
    }
    try {
      await api(bankUrl(bankId, "/categories"), { method: "POST", json: body });
      onSaved();
    } catch (e) {
      setError(errMsg(e, tr("保存失败", "Save failed")));
    } finally {
      setBusy(false);
    }
  }

  const kinds: Category["kind"][] = ["manual", "filter", "style"];

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={category ? tr("编辑分类", "Edit category") : tr("新建分类", "New category")}
      className="max-w-xl"
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <FieldLabel htmlFor="cat-name">{tr("名称", "Name")}</FieldLabel>
          <Input id="cat-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus />
        </div>
        <div className="space-y-1.5">
          <FieldLabel>{tr("上级分类", "Parent")}</FieldLabel>
          <NativeSelect value={parent} onChange={setParent} ariaLabel={tr("上级分类", "Parent")}>
            <option value="">{tr("（无，顶层）", "(none — top level)")}</option>
            {categories
              .filter((c) => !excluded.has(c.id))
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <FieldLabel>{tr("类型", "Kind")}</FieldLabel>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {kinds.map((k) => (
              <button
                key={k}
                type="button"
                disabled={!!category && category.kind !== k}
                onClick={() => setKind(k)}
                className={cn(
                  "flex items-start gap-2 rounded-lg border p-2.5 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                  kind === k ? "border-primary/60 bg-primary/10" : "border-border/60 bg-white/[0.02] hover:border-border",
                )}
              >
                <KindIcon kind={k} className="mt-0.5" />
                <span>
                  <span className="block text-sm font-medium text-foreground">{kindLabel(k, tr)}</span>
                  <span className="text-muted-foreground">
                    {k === "manual"
                      ? tr("手动把题目加入这个分组", "Add questions to it by hand")
                      : k === "filter"
                        ? tr("按条件自动包含题目", "Includes questions matching conditions")
                        : tr("描述一类题（无需原题）", "Describes a type of question (no source questions needed)")}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>

        {kind === "filter" && (
          <div className="space-y-2 rounded-lg border border-border/60 bg-white/[0.02] p-3 text-sm">
            <p className="text-xs text-muted-foreground">{tr("当前列表的筛选条件：", "Current list filters:")}</p>
            <p className="font-medium">{filterSummary(currentFilter, tr)}</p>
            {category?.filter && (
              <>
                <p className="text-xs text-muted-foreground">{tr("已保存的条件：", "Saved conditions:")}</p>
                <p>{filterSummary(category.filter, tr)}</p>
                <CheckboxField checked={useCurrentFilter} onChange={setUseCurrentFilter}>
                  {tr("用当前列表筛选替换", "Replace with the current list filters")}
                </CheckboxField>
              </>
            )}
            {!category && (
              <p className="text-xs text-muted-foreground">
                {tr("先在题目列表中设置搜索和筛选，再创建筛选分类。", "Set the search and filters in the question list first, then create the filter category.")}
              </p>
            )}
          </div>
        )}

        {kind === "style" && <StyleFields style={style} onChange={setStyle} detail={detail} />}

        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {tr("取消", "Cancel")}
          </Button>
          <Button onClick={() => void save()} loading={busy}>
            {tr("保存", "Save")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function StyleFields({ style, onChange, detail }: { style: StyleTemplate; onChange: (s: StyleTemplate) => void; detail: BankDetail }) {
  const { tr } = useI18n();
  const set = <K extends keyof StyleTemplate>(k: K, v: StyleTemplate[K]) => onChange({ ...style, [k]: v });
  return (
    <div className="space-y-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <FieldLabel htmlFor="style-grade">{tr("年级", "Grade")}</FieldLabel>
          <Input id="style-grade" value={style.grade ?? ""} onChange={(e) => set("grade", e.target.value)} placeholder={tr("如：五年级 / Year 5", "e.g. Year 5")} className="h-8 text-sm" />
        </div>
        <div className="space-y-1.5">
          <FieldLabel>{tr("题型", "Type")}</FieldLabel>
          <NativeSelect value={style.type} onChange={(v) => set("type", v as QuestionType)} className="h-8" ariaLabel={tr("题型", "Type")}>
            {QUESTION_TYPE_LIST.map((t) => (
              <option key={t} value={t}>
                {typeLabel(t, tr)}
              </option>
            ))}
          </NativeSelect>
        </div>
        {style.type === "multiple_choice" && (
          <div className="space-y-1.5">
            <FieldLabel>{tr("选项数", "Options")}</FieldLabel>
            <NativeSelect value={String(style.option_count ?? 5)} onChange={(v) => set("option_count", Number(v))} className="h-8" ariaLabel={tr("选项数", "Options")}>
              {[2, 3, 4, 5, 6, 7, 8].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </NativeSelect>
          </div>
        )}
        <div className="space-y-1.5">
          <FieldLabel>{tr("难度", "Difficulty")}</FieldLabel>
          <NativeSelect value={String(style.difficulty ?? 3)} onChange={(v) => set("difficulty", Number(v))} className="h-8" ariaLabel={tr("难度", "Difficulty")}>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <FieldLabel>{tr("语言", "Language")}</FieldLabel>
          <NativeSelect value={style.language ?? ""} onChange={(v) => set("language", v ? (v as "zh" | "en") : undefined)} className="h-8" ariaLabel={tr("语言", "Language")}>
            <option value="">{tr("跟随界面 / 题库", "Follow UI / bank")}</option>
            <option value="zh">{tr("中文", "Chinese")}</option>
            <option value="en">{tr("英文", "English")}</option>
          </NativeSelect>
        </div>
        <div className="flex items-end pb-1.5">
          <CheckboxField checked={!!style.with_figure} onChange={(v) => set("with_figure", v)}>
            {tr("带图", "With figure")}
          </CheckboxField>
        </div>
      </div>
      <div className="space-y-1.5">
        <FieldLabel htmlFor="style-kp">{tr("知识点", "Knowledge points")}</FieldLabel>
        <KnowledgePointInput id="style-kp" value={style.knowledge_points} onChange={(v) => set("knowledge_points", v)} vocab={detail.vocab} />
      </div>
      <div className="space-y-1.5">
        <FieldLabel htmlFor="style-notes">{tr("风格说明", "Style notes")}</FieldLabel>
        <Textarea
          id="style-notes"
          rows={3}
          value={style.notes ?? ""}
          onChange={(e) => set("notes", e.target.value)}
          maxLength={3000}
          placeholder={tr("情境、措辞、单位、常见设问方式……", "Context, wording, units, what is typical…")}
          className="text-sm"
        />
      </div>
    </div>
  );
}
