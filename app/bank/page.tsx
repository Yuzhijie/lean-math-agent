"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, FileClock, FileUp, Library, MousePointerClick, Plus, Settings, Sigma, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { LocaleSwitcher } from "../components/LocaleSwitcher";
import { useI18n } from "@/lib/i18n";
import { api, bankUrl, errMsg, type BankDetail, type BankSummary, type CategoryWithCount, type Item, type ItemFilter } from "../components/bank/api";
import { BankSettingsDialog, NewBankDialog } from "../components/bank/BankForms";
import { CategoryTree } from "../components/bank/CategoryTree";
import { GeneratePanel, type GenerateTemplate } from "../components/bank/GeneratePanel";
import { ImportWizard } from "../components/bank/ImportWizard";
import { ItemEditor } from "../components/bank/ItemEditor";
import { EMPTY_FILTERS, ItemList, PAGE_SIZE, type ListFilters } from "../components/bank/ItemList";
import { ErrorNote, FieldLabel, NativeSelect, languageLabel } from "../components/bank/ui";

type Loaded<T> = { key: string; data: T | null; error: string | null };

function toItemFilter(f: ListFilters, q: string): ItemFilter {
  const out: ItemFilter = {};
  if (q.trim()) out.query = q.trim();
  if (f.type) out.types = [f.type as NonNullable<ItemFilter["types"]>[number]];
  if (f.grade) out.grades = [f.grade];
  if (f.kp) out.knowledge_points = [f.kp];
  if (f.dmin) out.difficulty_min = Number(f.dmin);
  if (f.dmax) out.difficulty_max = Number(f.dmax);
  if (f.origin) out.origin = f.origin as ItemFilter["origin"];
  return out;
}

export default function BankPage() {
  const { tr } = useI18n();

  // ── Banks ──────────────────────────────────────────────────────────
  const [banksReload, setBanksReload] = useState(0);
  const [banks, setBanks] = useState<Loaded<BankSummary[]>>({ key: "", data: null, error: null });
  const [chosenBankId, setChosenBankId] = useState<string | null>(null);
  const bankId = chosenBankId && banks.data?.some((b) => b.id === chosenBankId) ? chosenBankId : (banks.data?.[0]?.id ?? null);

  useEffect(() => {
    let cancelled = false;
    const key = String(banksReload);
    api<{ banks: BankSummary[] }>("/api/banks")
      .then((r) => !cancelled && setBanks({ key, data: r.banks.sort((a, b) => b.updated_at - a.updated_at), error: null }))
      .catch((e) => !cancelled && setBanks((b) => ({ key, data: b.data, error: errMsg(e, "Error") })));
    return () => {
      cancelled = true;
    };
  }, [banksReload]);

  // ── Bank detail + categories ───────────────────────────────────────
  const [detailReload, setDetailReload] = useState(0);
  const [detail, setDetail] = useState<Loaded<{ detail: BankDetail; categories: CategoryWithCount[] }>>({ key: "", data: null, error: null });
  const detailKey = `${bankId}:${detailReload}`;
  useEffect(() => {
    if (!bankId) return;
    let cancelled = false;
    Promise.all([api<BankDetail>(bankUrl(bankId)), api<{ categories: CategoryWithCount[] }>(bankUrl(bankId, "/categories"))])
      .then(([d, c]) => !cancelled && setDetail({ key: detailKey, data: { detail: d, categories: c.categories }, error: null }))
      .catch((e) => !cancelled && setDetail({ key: detailKey, data: null, error: errMsg(e, "Error") }));
    return () => {
      cancelled = true;
    };
  }, [bankId, detailKey]);
  const current = detail.data && detail.data.detail.bank.id === bankId ? detail.data : null;
  const categories = useMemo(() => current?.categories ?? [], [current]);

  // ── List state ─────────────────────────────────────────────────────
  const [filters, setFilters] = useState<ListFilters>(EMPTY_FILTERS);
  const [debouncedQ, setDebouncedQ] = useState("");
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [listReload, setListReload] = useState(0);
  const [selection, setSelection] = useState<Map<string, Item>>(new Map());
  const [openItem, setOpenItem] = useState<Item | null>(null);
  const [list, setList] = useState<Loaded<{ total: number; items: Item[] }>>({ key: "", data: null, error: null });
  const editorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(filters.q), 300);
    return () => clearTimeout(t);
  }, [filters.q]);

  const activeCategory = categories.find((c) => c.id === activeCategoryId) ?? null;
  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (debouncedQ.trim()) p.set("q", debouncedQ.trim());
    if (filters.type) p.set("types", filters.type);
    if (filters.grade) p.set("grades", filters.grade);
    if (filters.kp) p.set("knowledge_points", filters.kp);
    if (filters.dmin) p.set("difficulty_min", filters.dmin);
    if (filters.dmax) p.set("difficulty_max", filters.dmax);
    if (filters.origin) p.set("origin", filters.origin);
    if (activeCategoryId) p.set("category", activeCategoryId);
    p.set("page", String(page));
    p.set("page_size", String(PAGE_SIZE));
    return p.toString();
  }, [debouncedQ, filters, activeCategoryId, page]);
  const listKey = `${bankId}?${query}#${listReload}`;

  useEffect(() => {
    if (!bankId) return;
    let cancelled = false;
    api<{ total: number; items: Item[] }>(bankUrl(bankId, `/items?${query}`))
      .then((r) => !cancelled && setList({ key: listKey, data: r, error: null }))
      .catch((e) => !cancelled && setList((l) => ({ key: listKey, data: l.data, error: errMsg(e, "Error") })));
    return () => {
      cancelled = true;
    };
  }, [bankId, query, listKey]);

  // ── Dialogs / panels ───────────────────────────────────────────────
  const [newBankOpen, setNewBankOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [importState, setImportState] = useState<{ open: boolean; resume: string | null; n: number }>({ open: false, resume: null, n: 0 });
  const [generate, setGenerate] = useState<{ template: GenerateTemplate; open: boolean; n: number } | null>(null);

  const refreshAll = useCallback(() => {
    setDetailReload((n) => n + 1);
    setListReload((n) => n + 1);
    setBanksReload((n) => n + 1);
  }, []);

  const selectBank = (id: string) => {
    setChosenBankId(id);
    setActiveCategoryId(null);
    setFilters(EMPTY_FILTERS);
    setDebouncedQ("");
    setPage(1);
    setSelection(new Map());
    setOpenItem(null);
  };

  const openItemDetail = (it: Item) => {
    setOpenItem(it);
    if (typeof window !== "undefined" && window.innerWidth < 1024) {
      requestAnimationFrame(() => editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  };

  const bank = current?.detail.bank ?? null;
  const pendingBatches = current?.detail.batches.filter((b) => b.status === "draft") ?? [];
  const listLoading = list.key !== listKey;
  const noBanks = banks.data !== null && banks.data.length === 0;

  return (
    <div className="relative z-10 min-h-screen">
      {/* ── Header (same style as the solver) ─────────────────────── */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto max-w-screen-2xl px-4 sm:px-6">
          <div className="flex h-14 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
                <Sigma className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h1 className="truncate font-serif text-base font-bold leading-none tracking-tight text-foreground">{tr("题库", "Question banks")}</h1>
                <p className="truncate text-[11px] text-muted-foreground">Lean Math Agent</p>
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

      <main className="mx-auto max-w-screen-2xl px-4 py-5 sm:px-6">
        <ErrorNote message={banks.error} />
        {banks.data === null && !banks.error ? (
          <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
            <Skeleton className="h-64" />
            <Skeleton className="h-96" />
          </div>
        ) : noBanks ? (
          <div className="mx-auto mt-10 flex max-w-md flex-col items-center gap-3 rounded-lg border border-border/60 bg-white/[0.02] px-6 py-10 text-center">
            <Library className="h-8 w-8 text-primary" />
            <h2 className="text-base font-semibold">{tr("还没有题库", "No question banks yet")}</h2>
            <p className="text-sm text-muted-foreground">
              {tr("题库保存你自己的题目：导入试卷或表格，按分类管理，并按模板生成同类新题。", "A bank holds your own questions: import papers or spreadsheets, organise them in categories, and generate new questions of the same type.")}
            </p>
            <Button className="gap-1.5" onClick={() => setNewBankOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              {tr("新建题库", "New bank")}
            </Button>
          </div>
        ) : (
          <div className="grid items-start gap-4 lg:grid-cols-[240px_minmax(0,1fr)_minmax(0,360px)] xl:grid-cols-[260px_minmax(0,1fr)_minmax(0,400px)] 2xl:grid-cols-[280px_minmax(0,1fr)_minmax(0,460px)]">
            {/* ── Left: banks + categories ──────────────────────────── */}
            <aside className="space-y-4 rounded-lg border border-border/60 bg-white/[0.02] p-3 lg:sticky lg:top-[4.5rem] lg:max-h-[calc(100vh-5.5rem)] lg:overflow-y-auto">
              <div className="space-y-1.5">
                <FieldLabel>{tr("题库", "Bank")}</FieldLabel>
                <div className="flex gap-1.5">
                  <NativeSelect value={bankId ?? ""} onChange={selectBank} className="h-8 text-sm" ariaLabel={tr("选择题库", "Choose a bank")}>
                    {(banks.data ?? []).map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name} ({b.item_count})
                      </option>
                    ))}
                  </NativeSelect>
                  <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1 px-2" onClick={() => setNewBankOpen(true)} title={tr("新建题库", "New bank")}>
                    <Plus className="h-3.5 w-3.5" />
                    <span className="text-xs">{tr("新建", "New")}</span>
                  </Button>
                </div>
              </div>

              {pendingBatches.length > 0 && bank && (
                <div className="space-y-1.5">
                  <FieldLabel>{tr("待复核的导入", "Imports awaiting review")}</FieldLabel>
                  {pendingBatches.map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      className="flex w-full items-center gap-1.5 rounded-md border border-warning/30 bg-warning/5 px-2 py-1.5 text-left text-xs hover:border-warning/60"
                      onClick={() => setImportState((s) => ({ open: true, resume: b.id, n: s.n + 1 }))}
                    >
                      <FileClock className="h-3.5 w-3.5 shrink-0 text-warning" />
                      <span className="min-w-0 flex-1 truncate">{b.file_name}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">{b.draft_count}</span>
                    </button>
                  ))}
                </div>
              )}

              {current && bankId ? (
                <CategoryTree
                  bankId={bankId}
                  detail={current.detail}
                  categories={categories}
                  activeId={activeCategoryId}
                  onSelect={(id) => {
                    setActiveCategoryId(id);
                    setPage(1);
                  }}
                  currentFilter={toItemFilter(filters, debouncedQ)}
                  onChanged={() => setDetailReload((n) => n + 1)}
                  onGenerate={(cat) => setGenerate((g) => ({ template: { kind: "category", category: cat }, open: true, n: (g?.n ?? 0) + 1 }))}
                />
              ) : (
                <Skeleton className="h-32" />
              )}
            </aside>

            {/* ── Middle: items ─────────────────────────────────────── */}
            <section className="min-w-0 space-y-3">
              {bank && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="truncate text-lg font-semibold">
                      {activeCategory ? activeCategory.name : bank.name}
                    </h2>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      {activeCategory && <span>{bank.name} ·</span>}
                      <span>{tr(`${current?.detail.item_count ?? 0} 道题`, `${current?.detail.item_count ?? 0} questions`)}</span>
                      <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-medium">
                        {languageLabel(bank.language, tr)}
                      </Badge>
                      {!bank.allow_model && (
                        <Badge variant="warning" className="gap-1 px-1.5 py-0 text-[10px]">
                          <AlertTriangle className="h-3 w-3" />
                          {tr("不发送给模型", "Not sent to the model")}
                        </Badge>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {activeCategory && (
                      <Button
                        size="sm"
                        className="gap-1.5"
                        onClick={() => setGenerate((g) => ({ template: { kind: "category", category: activeCategory }, open: true, n: (g?.n ?? 0) + 1 }))}
                      >
                        <Sparkles className="h-3.5 w-3.5" />
                        {tr("按此类出题", "Generate from this type")}
                      </Button>
                    )}
                    <Button size="sm" variant={activeCategory ? "outline" : "default"} className="gap-1.5" onClick={() => setImportState((s) => ({ open: true, resume: null, n: s.n + 1 }))}>
                      <FileUp className="h-3.5 w-3.5" />
                      {tr("导入", "Import")}
                    </Button>
                    <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setSettingsOpen(true)}>
                      <Settings className="h-3.5 w-3.5" />
                      {tr("设置", "Settings")}
                    </Button>
                  </div>
                </div>
              )}
              <ErrorNote message={detail.key === detailKey ? detail.error : null} />
              {current && bankId && (
                <ItemList
                  bankId={bankId}
                  detail={current.detail}
                  categories={categories}
                  activeCategory={activeCategory}
                  filters={filters}
                  onFiltersChange={(f) => {
                    setFilters(f);
                    setPage(1);
                  }}
                  result={list.data}
                  loading={listLoading}
                  error={list.error}
                  page={page}
                  onPageChange={setPage}
                  selection={selection}
                  onSelectionChange={setSelection}
                  openItemId={openItem?.id ?? null}
                  onOpenItem={openItemDetail}
                  onChanged={() => {
                    setListReload((n) => n + 1);
                    setDetailReload((n) => n + 1);
                    setBanksReload((n) => n + 1);
                    if (openItem && selection.has(openItem.id)) setOpenItem(null);
                  }}
                  onGenerateFromItems={(items) => setGenerate((g) => ({ template: { kind: "items", items }, open: true, n: (g?.n ?? 0) + 1 }))}
                  onGenerateFromCategory={(cat) => setGenerate((g) => ({ template: { kind: "category", category: cat }, open: true, n: (g?.n ?? 0) + 1 }))}
                />
              )}
            </section>

            {/* ── Right: item detail ────────────────────────────────── */}
            <section ref={editorRef} className="min-w-0 scroll-mt-20 rounded-lg border border-border/60 bg-white/[0.02] p-4 lg:sticky lg:top-[4.5rem] lg:max-h-[calc(100vh-5.5rem)] lg:overflow-y-auto">
              {openItem && current && bankId ? (
                <ItemEditor
                  key={`${openItem.id}:${openItem.updated_at}`}
                  bankId={bankId}
                  item={openItem}
                  detail={current.detail}
                  categories={categories}
                  onSaved={(it) => {
                    setOpenItem(it);
                    setListReload((n) => n + 1);
                    setDetailReload((n) => n + 1);
                  }}
                  onDeleted={() => {
                    setOpenItem(null);
                    refreshAll();
                  }}
                  onClose={() => setOpenItem(null)}
                />
              ) : (
                <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                  <MousePointerClick className="h-6 w-6 opacity-60" />
                  {tr("点击列表中的题目查看和编辑。", "Click a question in the list to view and edit it.")}
                </div>
              )}
            </section>
          </div>
        )}
      </main>

      {/* ── Dialogs ──────────────────────────────────────────────── */}
      <NewBankDialog
        open={newBankOpen}
        onOpenChange={setNewBankOpen}
        onCreated={(b) => {
          setNewBankOpen(false);
          selectBank(b.id);
          setBanksReload((n) => n + 1);
        }}
      />
      {bank && (
        <BankSettingsDialog
          key={`${bank.id}:${bank.updated_at}:${settingsOpen}`}
          bank={bank}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          onSaved={() => {
            setSettingsOpen(false);
            refreshAll();
          }}
          onDeleted={() => {
            setSettingsOpen(false);
            setChosenBankId(null);
            setOpenItem(null);
            setSelection(new Map());
            refreshAll();
          }}
        />
      )}
      {bank && importState.n > 0 && (
        <ImportWizard
          key={importState.n}
          bank={bank}
          categories={categories}
          open={importState.open}
          resumeBatchId={importState.resume}
          onOpenChange={(o) => setImportState((s) => ({ ...s, open: o }))}
          onFinished={refreshAll}
        />
      )}
      {bank && generate && (
        <GeneratePanel
          key={generate.n}
          bank={bank}
          template={generate.template}
          categories={categories}
          open={generate.open}
          onOpenChange={(o) => setGenerate((g) => (g ? { ...g, open: o } : g))}
          onAdopted={() => {
            setListReload((n) => n + 1);
            setDetailReload((n) => n + 1);
            setBanksReload((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}
