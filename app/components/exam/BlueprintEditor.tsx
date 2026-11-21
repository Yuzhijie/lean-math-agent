"use client";

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { domainLabel, difficultyLabel, gradeLabel, kindLabel } from "@/lib/exam/labels";
import { newPart, presetBlueprint } from "@/lib/exam/preset";
import { EXAM_KINDS, plannedTotal, type ExamKind } from "@/lib/exam/types";
import { COMPETITION_DOMAINS, domainAllowed, GRADE_LEVELS, type CompetitionDomain, type GradeLevel } from "@/lib/types";
import { FieldLabel, NativeSelect, splitList } from "../bank/ui";
import { MathText } from "../MathText";
import type { Blueprint, ExamPart } from "./api";

/** The teacher's banks that may be sent to the model (a bank part's questions are its template). */
export interface BankChoice {
  id: string;
  name: string;
  item_count: number;
  allow_model: boolean;
}

interface Topics {
  topics: { id: string; path: string; count: number }[];
  knowledge_points: { value: string; count: number }[];
}

export function useBankChoices(): BankChoice[] {
  const [banks, setBanks] = useState<BankChoice[]>([]);
  useEffect(() => {
    let off = false;
    fetch("/api/banks")
      .then((r) => (r.ok ? (r.json() as Promise<{ banks?: BankChoice[] }>) : { banks: [] }))
      .then((d) => !off && setBanks((d.banks ?? []).filter((b) => b.item_count > 0 && b.allow_model)))
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, []);
  return banks;
}

/** Categories and knowledge points of a bank, loaded once per bank. */
function useTopics(bankId: string | undefined): Topics | null {
  const [cache, setCache] = useState<Record<string, Topics>>({});
  useEffect(() => {
    if (!bankId || cache[bankId]) return;
    let off = false;
    fetch(`/api/banks/${encodeURIComponent(bankId)}/template-options`)
      .then((r) => (r.ok ? (r.json() as Promise<Topics>) : null))
      .then((d) => !off && d && setCache((c) => ({ ...c, [bankId]: { topics: d.topics ?? [], knowledge_points: d.knowledge_points ?? [] } })))
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, [bankId, cache]);
  return bankId ? (cache[bankId] ?? null) : null;
}

const clampInt = (v: string, lo: number, hi: number, fallback: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
};

/**
 * A paper as parts: each part one kind of question (choice, fill-in, worked, proof) — where its
 * questions come from (the built-in generator in a domain, or the teacher's bank by category or
 * knowledge point), what they are about, difficulty, how many and points each. A paper mixes kinds;
 * it prints in sections by kind. A planned part shows why it is there and the questions it varies.
 */
export function BlueprintEditor({ value, onChange, banks, disabled, presets = true }: { value: Blueprint; onChange: (b: Blueprint) => void; banks: BankChoice[]; disabled?: boolean; presets?: boolean }) {
  const { tr } = useI18n();
  const set = (patch: Partial<Blueprint>) => onChange({ ...value, ...patch });
  const setPart = (i: number, p: ExamPart) => set({ parts: value.parts.map((x, j) => (j === i ? p : x)) });
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= value.parts.length) return;
    const parts = [...value.parts];
    [parts[i], parts[j]] = [parts[j], parts[i]];
    set({ parts });
  };
  const questions = value.parts.reduce((a, p) => a + p.count, 0);
  const changeGrade = (g: GradeLevel) =>
    // a domain the new level does not offer falls back to the level's default
    set({ grade_level: g, parts: value.parts.map((p) => (p.source.kind === "builtin" && !domainAllowed(p.source.domain, g) ? { ...p, source: { kind: "builtin", domain: g === "elementary" ? "computation" : "algebra" } } : p)) });

  return (
    <fieldset disabled={disabled} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_auto]">
        <div className="space-y-1">
          <FieldLabel>{tr("试卷名称", "Title")}</FieldLabel>
          <Input value={value.title} maxLength={100} onChange={(e) => set({ title: e.target.value })} placeholder={tr("如：第三单元测验", "e.g. Unit 3 test")} />
        </div>
        <div className="space-y-1">
          <FieldLabel>{tr("学段", "Level")}</FieldLabel>
          <NativeSelect value={value.grade_level} onChange={(v) => changeGrade(v as GradeLevel)} ariaLabel={tr("学段", "Level")}>
            {GRADE_LEVELS.map((g) => (
              <option key={g} value={g}>
                {gradeLabel(g, tr)}
              </option>
            ))}
          </NativeSelect>
        </div>
        {presets && (
          <div className="flex items-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9"
              title={tr("换成这个学段常见的 100 分试卷结构（会替换下面的各部分）", "Replace the parts below with a usual 100-point paper for the level")}
              onClick={() => onChange({ ...presetBlueprint(value.grade_level, value.title), title: value.title })}
            >
              {tr("套用常见结构", "Usual layout")}
            </Button>
          </div>
        )}
      </div>

      <div className="space-y-2">
        {value.parts.map((p, i) => (
          <PartRow key={p.id} index={i} part={p} grade={value.grade_level} banks={banks} onChange={(x) => setPart(i, x)} onMove={(d) => move(i, d)} onRemove={value.parts.length > 1 ? () => set({ parts: value.parts.filter((_, j) => j !== i) }) : undefined} last={i === value.parts.length - 1} />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">{tr("添加一部分：", "Add a part:")}</span>
        {EXAM_KINDS.map((k) => (
          <Button key={k} type="button" variant="outline" size="sm" className="h-7 gap-1 text-xs" disabled={value.parts.length >= 12} onClick={() => set({ parts: [...value.parts, newPart(k, value.grade_level)] })}>
            <Plus className="h-3 w-3" />
            {kindLabel(k, tr)}
          </Button>
        ))}
        <span className="ml-auto text-sm tabular-nums" data-testid="blueprint-total">
          {tr(`共 ${questions} 题 · ${plannedTotal(value.parts)} 分`, `${questions} questions · ${plannedTotal(value.parts)} points`)}
        </span>
      </div>
    </fieldset>
  );
}

function PartRow({
  index,
  part,
  grade,
  banks,
  onChange,
  onMove,
  onRemove,
  last,
}: {
  index: number;
  part: ExamPart;
  grade: GradeLevel;
  banks: BankChoice[];
  onChange: (p: ExamPart) => void;
  onMove: (d: -1 | 1) => void;
  onRemove?: () => void;
  last: boolean;
}) {
  const { tr } = useI18n();
  // the skills as typed while the field has focus; otherwise the part's own
  const [kpDraft, setKpDraft] = useState<string | null>(null);
  const kps = kpDraft ?? part.knowledge_points.join("，");
  const [showLike, setShowLike] = useState(false);
  const bankId = part.source.kind === "bank" ? part.source.bank_id : undefined;
  const topics = useTopics(bankId);
  const set = (patch: Partial<ExamPart>) => onChange({ ...part, ...patch });
  const sourceValue = part.source.kind === "bank" ? `bank:${part.source.bank_id}` : `builtin:${part.source.domain}`;
  const topicValue = part.source.kind === "bank" ? (part.source.category_id ? `cat:${part.source.category_id}` : part.source.knowledge_point ? `kp:${part.source.knowledge_point}` : "") : "";
  const bankMissing = part.source.kind === "bank" && !banks.some((b) => b.id === bankId);

  const setSource = (v: string) => {
    if (v.startsWith("bank:")) {
      const b = banks.find((x) => `bank:${x.id}` === v);
      if (b) set({ source: { kind: "bank", bank_id: b.id, bank_name: b.name, ...(part.knowledge_points[0] ? { knowledge_point: part.knowledge_points[0] } : {}) } });
    } else set({ source: { kind: "builtin", domain: v.slice(8) as CompetitionDomain } });
  };
  const setTopic = (v: string) => {
    if (part.source.kind !== "bank") return;
    const { category_id: _c, knowledge_point: _k, ...rest } = part.source;
    void _c;
    void _k;
    // a knowledge point picked as the template is what the questions are counted under when marked
    set({
      source: { ...rest, ...(v.startsWith("cat:") ? { category_id: v.slice(4) } : v.startsWith("kp:") ? { knowledge_point: v.slice(3) } : {}) },
      ...(v.startsWith("kp:") ? { knowledge_points: [v.slice(3).slice(0, 60)] } : {}),
    });
  };

  return (
    <div className="rounded-md border border-border/60 p-3" data-testid="exam-part">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-[7rem_minmax(0,1.4fr)_minmax(0,1fr)_7rem_4.5rem_4.5rem_auto]">
        <div className="space-y-1">
          <FieldLabel>{tr(`第 ${index + 1} 部分`, `Part ${index + 1}`)}</FieldLabel>
          <NativeSelect value={part.kind} onChange={(v) => set({ kind: v as ExamKind })} ariaLabel={tr("题型", "Kind")}>
            {EXAM_KINDS.map((k) => (
              <option key={k} value={k}>
                {kindLabel(k, tr)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <FieldLabel>{tr("出题来源", "Source")}</FieldLabel>
          <NativeSelect value={bankMissing ? "" : sourceValue} onChange={setSource} ariaLabel={tr("出题来源", "Source")}>
            {bankMissing && <option value="">{tr("（题库不可用）", "(bank not available)")}</option>}
            <optgroup label={tr("内置出题", "Built-in generator")}>
              {COMPETITION_DOMAINS.filter((d) => domainAllowed(d, grade)).map((d) => (
                <option key={d} value={`builtin:${d}`}>
                  {domainLabel(d, tr)}
                </option>
              ))}
            </optgroup>
            {banks.length > 0 && (
              <optgroup label={tr("我的题库（以题库题为模板）", "My banks (bank questions as the template)")}>
                {banks.map((b) => (
                  <option key={b.id} value={`bank:${b.id}`}>
                    {b.name}（{b.item_count}）
                  </option>
                ))}
              </optgroup>
            )}
          </NativeSelect>
        </div>
        <div className="col-span-2 space-y-1 sm:col-span-1">
          {part.source.kind === "bank" ? (
            <>
              <FieldLabel>{tr("模板：分类或知识点", "Template: category or skill")}</FieldLabel>
              <NativeSelect value={topicValue} onChange={setTopic} ariaLabel={tr("模板", "Template")}>
                <option value="">{tr("全部题目", "All questions")}</option>
                {topicValue.startsWith("kp:") && !topics?.knowledge_points.some((k) => `kp:${k.value}` === topicValue) && <option value={topicValue}>{topicValue.slice(3)}</option>}
                {topics?.topics.length ? (
                  <optgroup label={tr("分类", "Categories")}>
                    {topics.topics.map((t) => (
                      <option key={t.id} value={`cat:${t.id}`}>
                        {t.path}（{t.count}）
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {topics?.knowledge_points.length ? (
                  <optgroup label={tr("知识点", "Skills")}>
                    {topics.knowledge_points.map((k) => (
                      <option key={k.value} value={`kp:${k.value}`}>
                        {k.value}（{k.count}）
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </NativeSelect>
            </>
          ) : (
            <>
              <FieldLabel>{tr("知识点（可选，最多 3 个）", "Skills (optional, up to 3)")}</FieldLabel>
              <Input
                value={kps}
                onFocus={() => setKpDraft(kps)}
                onChange={(e) => setKpDraft(e.target.value)}
                onBlur={() => {
                  set({ knowledge_points: splitList(kps).slice(0, 3).map((k) => k.slice(0, 60)) });
                  setKpDraft(null);
                }}
                placeholder={tr("如：分数加减，通分", "e.g. fractions, common denominators")}
                className="h-9"
              />
            </>
          )}
        </div>
        <div className="space-y-1">
          <FieldLabel>{tr("难度", "Difficulty")}</FieldLabel>
          <NativeSelect value={String(part.difficulty)} onChange={(v) => set({ difficulty: Number(v) })} ariaLabel={tr("难度", "Difficulty")}>
            {[1, 2, 3, 4, 5].map((d) => (
              <option key={d} value={d}>
                {difficultyLabel(d, tr)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <FieldLabel>{tr("题数", "Count")}</FieldLabel>
          <Input type="number" min={1} max={10} value={part.count} onChange={(e) => set({ count: clampInt(e.target.value, 1, 10, part.count) })} className="h-9 tabular-nums" aria-label={tr("题数", "Count")} />
        </div>
        <div className="space-y-1">
          <FieldLabel>{tr("每题分", "Points")}</FieldLabel>
          <Input type="number" min={1} max={50} value={part.points} onChange={(e) => set({ points: clampInt(e.target.value, 1, 50, part.points) })} className="h-9 tabular-nums" aria-label={tr("每题分值", "Points each")} />
        </div>
        <div className="col-span-2 flex items-end justify-end gap-0.5 sm:col-span-1">
          <Button type="button" variant="ghost" size="sm" className="h-9 w-8 p-0" aria-label={tr("上移", "Move up")} disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
          <Button type="button" variant="ghost" size="sm" className="h-9 w-8 p-0" aria-label={tr("下移", "Move down")} disabled={last} onClick={() => onMove(1)}>
            <ArrowDown className="h-3.5 w-3.5" />
          </Button>
          <Button type="button" variant="ghost" size="sm" className="h-9 w-8 p-0 text-destructive" aria-label={tr("删除这部分", "Remove part")} disabled={!onRemove} onClick={onRemove}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {(part.reason || part.target || part.like.length > 0 || (part.source.kind === "bank" && part.knowledge_points.length > 0)) && (
        <div className="mt-2 space-y-1 border-t border-border/40 pt-2 text-xs text-muted-foreground">
          {part.reason && (
            <p data-testid="part-reason">
              <span className="font-medium text-foreground">{tr("为什么：", "Why: ")}</span>
              {part.reason}
            </p>
          )}
          {part.source.kind === "bank" && part.knowledge_points.length > 0 && <p>{tr(`计入知识点：${part.knowledge_points.join("、")}`, `Counted under: ${part.knowledge_points.join(", ")}`)}</p>}
          {part.like.length > 0 && (
            <div>
              <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => setShowLike((x) => !x)}>
                {showLike ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                {tr(`按做错的 ${part.like.length} 道题出变式（同一知识点和题型，换数据和情境）`, `Variants of ${part.like.length} question(s) got wrong (same skill and kind, new numbers and setting)`)}
              </button>
              {showLike && (
                <ol className="ml-4 mt-1 list-decimal space-y-1">
                  {part.like.map((t, i) => (
                    <li key={i} className={cn("text-foreground/80")}>
                      <MathText text={t} />
                      <button type="button" className="ml-2 text-destructive hover:underline" onClick={() => set({ like: part.like.filter((_, j) => j !== i) })}>
                        {tr("不用这道", "Drop")}
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
