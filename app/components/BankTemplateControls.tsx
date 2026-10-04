"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BarChart3, FolderOpen, GraduationCap, Library } from "lucide-react";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useI18n } from "@/lib/i18n";

/** What the user picked: bank, Level, Difficulty, Topic ("" / 0 = any). */
export interface BankTemplateValue {
  bankId: string;
  grade: string;
  difficulty: number;
  /** "cat:<categoryId>" | "kp:<knowledge point>" | "" */
  topic: string;
}

export interface BankSummary {
  id: string;
  name: string;
  item_count: number;
  allow_model: boolean;
}

interface Options {
  grades: Array<{ value: string; count: number }>;
  knowledge_points: Array<{ value: string; count: number }>;
  topics: Array<{ id: string; path: string; parent_id: string | null; count: number }>;
  index: Array<{ g: string | null; d: number | null; c: string[]; k: string[] }>;
}

const ANY = "__any__";
const norm = (s: string) => s.normalize("NFKC").trim().toLowerCase();

/** Banks of this account that have questions (for the generator's mode switch). */
export function useBanks(): { banks: BankSummary[] | null } {
  const [banks, setBanks] = useState<BankSummary[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/banks")
      .then((r) => (r.ok ? r.json() : { banks: [] }))
      .then((d: { banks?: BankSummary[] }) => {
        if (!cancelled) setBanks((d.banks ?? []).filter((b) => b.item_count > 0));
      })
      .catch(() => !cancelled && setBanks([]));
    return () => {
      cancelled = true;
    };
  }, []);
  return { banks };
}

/**
 * Level / Difficulty / Topic pickers for "local bank as template": the
 * values come from the bank itself (its levels, its category tree and
 * knowledge points), and the number of matching template questions is
 * shown as the user picks.
 */
export function BankTemplateControls({
  banks,
  value,
  onChange,
  disabled,
  onMatchChange,
}: {
  banks: BankSummary[];
  value: BankTemplateValue;
  onChange: (v: BankTemplateValue) => void;
  disabled?: boolean;
  /** Matching questions: exact (all criteria) and for the topic alone. */
  onMatchChange?: (m: { exact: number; topic: number } | null) => void;
}) {
  const { tr } = useI18n();
  const [options, setOptions] = useState<{ bankId: string; data: Options } | null>(null);
  const [error, setError] = useState<{ bankId: string; message: string } | null>(null);
  const bankId = value.bankId;

  useEffect(() => {
    if (!bankId) return;
    let cancelled = false;
    fetch(`/api/banks/${encodeURIComponent(bankId)}/template-options`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error((d as { error?: string }).error ?? `HTTP ${r.status}`);
        return d as Options;
      })
      .then((d) => !cancelled && setOptions({ bankId, data: d }))
      .catch((e: unknown) => !cancelled && setError({ bankId, message: e instanceof Error ? e.message : String(e) }));
    return () => {
      cancelled = true;
    };
  }, [bankId]);

  const opts = options?.bankId === bankId ? options.data : null;
  const loadError = error?.bankId === bankId ? error.message : null;

  const match = useMemo(() => {
    if (!opts) return null;
    const topicOk = (row: Options["index"][number]) =>
      !value.topic ||
      (value.topic.startsWith("cat:") ? row.c.includes(value.topic.slice(4)) : row.k.some((k) => norm(k) === norm(value.topic.slice(3))));
    const topicRows = opts.index.filter(topicOk);
    const exact = topicRows.filter((r) => (!value.grade || norm(r.g ?? "") === norm(value.grade)) && (!value.difficulty || r.d === value.difficulty)).length;
    return { exact, topic: topicRows.length };
  }, [opts, value.topic, value.grade, value.difficulty]);

  useEffect(() => {
    onMatchChange?.(match);
  }, [match, onMatchChange]);

  const set = (patch: Partial<BankTemplateValue>) => onChange({ ...value, ...patch });
  const label = "flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-foreground";
  const diffLabel = (d: number) =>
    [tr("1 · 基础", "1 · Basic"), tr("2 · 较易", "2 · Easy"), tr("3 · 中等", "3 · Medium"), tr("4 · 较难", "4 · Hard"), tr("5 · 挑战", "5 · Challenge")][d - 1];

  return (
    <>
      {banks.length > 1 && (
        <div className="space-y-1.5">
          <label className={label}>
            <Library className="h-3 w-3" />
            {tr("题库", "Bank")}
          </label>
          <Select value={bankId} onValueChange={(v) => onChange({ bankId: v, grade: "", difficulty: 0, topic: "" })} disabled={disabled}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {banks.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name} ({b.item_count})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="space-y-1.5">
        <label className={label}>
          <GraduationCap className="h-3 w-3" />
          {tr("学段", "Level")}
        </label>
        <Select value={value.grade || ANY} onValueChange={(v) => set({ grade: v === ANY ? "" : v })} disabled={disabled || !opts}>
          <SelectTrigger className="w-full" aria-label={tr("学段", "Level")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>{tr("任意", "Any")}</SelectItem>
            {opts?.grades.map((g) => (
              <SelectItem key={g.value} value={g.value}>
                {g.value} ({g.count})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <label className={label}>
          <BarChart3 className="h-3 w-3" />
          {tr("难度", "Difficulty")}
        </label>
        <Select value={value.difficulty ? String(value.difficulty) : ANY} onValueChange={(v) => set({ difficulty: v === ANY ? 0 : Number(v) })} disabled={disabled || !opts}>
          <SelectTrigger className="w-full" aria-label={tr("难度", "Difficulty")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>{tr("任意", "Any")}</SelectItem>
            {[1, 2, 3, 4, 5].map((d) => (
              <SelectItem key={d} value={String(d)}>
                {diffLabel(d)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5 sm:col-span-2 lg:col-span-1">
        <label className={label}>
          <FolderOpen className="h-3 w-3" />
          {tr("主题", "Topic")}
        </label>
        <Select value={value.topic || ANY} onValueChange={(v) => set({ topic: v === ANY ? "" : v })} disabled={disabled || !opts}>
          <SelectTrigger className="w-full" aria-label={tr("主题", "Topic")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>{tr("整个题库", "Whole bank")}</SelectItem>
            {!!opts?.topics.length && (
              <SelectGroup>
                <SelectLabel>{tr("分类", "Categories")}</SelectLabel>
                {opts.topics.map((t) => (
                  <SelectItem key={t.id} value={`cat:${t.id}`}>
                    {t.path} ({t.count})
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
            {!!opts?.knowledge_points.length && (
              <SelectGroup>
                <SelectLabel>{tr("知识点", "Knowledge points")}</SelectLabel>
                {opts.knowledge_points.map((k) => (
                  <SelectItem key={k.value} value={`kp:${k.value}`}>
                    {k.value} ({k.count})
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
          </SelectContent>
        </Select>
      </div>

      {loadError && <p className="col-span-full text-xs text-destructive">{loadError}</p>}
    </>
  );
}

/** One line under the controls: how many bank questions will serve as the template. */
export function MatchHint({ match, value }: { match: { exact: number; topic: number } | null; value: BankTemplateValue }) {
  const { tr } = useI18n();
  if (!match) return null;
  if (!match.topic)
    return (
      <p className="text-xs text-warning">
        {tr("所选主题在题库中没有题目，请换一个主题，或切换到“内置”出题。", "The chosen topic has no questions in this bank; pick another topic or switch to Built-in.")}
      </p>
    );
  if (!match.exact)
    return (
      <p className="text-xs text-muted-foreground">
        {tr(
          `没有完全符合所选${value.grade ? "学段" : ""}${value.grade && value.difficulty ? "和" : ""}${value.difficulty ? "难度" : ""}的题；将在该主题的 ${match.topic} 道题中放宽条件选取模板，新题仍按所选学段和难度出。`,
          `No question matches the chosen ${[value.grade && "level", value.difficulty && "difficulty"].filter(Boolean).join(" and ")} exactly; the template will be widened within this topic (${match.topic} questions). New questions still target what you chose.`,
        )}
      </p>
    );
  return (
    <p className="text-xs text-muted-foreground">
      {tr(`将以题库中 ${match.exact} 道匹配的题为模板。`, `${match.exact} matching bank question${match.exact === 1 ? "" : "s"} will be the template.`)}{" "}
      <Link href="/bank" className="text-primary underline-offset-2 hover:underline">
        {tr("查看题库", "Open bank")}
      </Link>
    </p>
  );
}
