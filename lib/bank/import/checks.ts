/**
 * Validation, duplicate checks and the report for draft batches.
 *
 * Issues found while parsing (a figure reference, a rewritten stem, a
 * dropped value) are kept with a draft until the user edits it; issues
 * from these checks are recomputed every time (see isCheckIssue).
 */
import { randomUUID } from "node:crypto";
import { lt } from "@/lib/llm/output-locale";
import { fingerprint, NEAR_DUPLICATE, StemIndex } from "../similarity";
import { itemFieldsSchema, type DraftItem, type ImportBatch, type Item, type ItemFields } from "../types";
import { clampStr, LETTERS, type DraftFields } from "./fields";

/** Stored as the stem of a record without question text (the data model needs a non-empty stem). */
export const EMPTY_STEM = "—";

const snippet = (s: string, n = 60) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

const MSG = {
  emptyStem: () => lt("没有题目内容（题干为空）", "No question text (the stem is empty)"),
  invalid: (path: string, msg: string) => lt(`字段无效：${path}（${msg}）`, `Invalid field: ${path} (${msg})`),
  fewOptions: () => lt("选择题的选项少于 2 个", "Multiple choice with fewer than 2 options"),
  emptyOption: (l: string) => lt(`选项 ${l} 为空（可能是图片选项）`, `Option ${l} is empty (maybe a picture option)`),
  answerNotOption: (a: string) => lt(`答案 ${a} 不在选项中`, `Answer ${a} is not one of the options`),
  dupBank: (s: string) => lt(`与题库中已有题目相同：${s}`, `Same as an existing bank question: ${s}`),
  nearBank: (pct: number, s: string) => lt(`与题库中已有题目相似（${pct}%）：${s}`, `Similar to an existing bank question (${pct}%): ${s}`),
  dupBatch: (label: string) => lt(`与本文件中的第 ${label} 题重复`, `Repeats question ${label} in this file`),
};

const CHECK_ISSUE = /^(?:没有题目内容|No question text|字段无效：|Invalid field: |选择题的选项少于|Multiple choice with fewer than|选项 [A-J] 为空|Option [A-J] is empty|答案 .+ 不在选项中|Answer .+ is not one of the options|与题库中已有题目|Same as an existing bank question|Similar to an existing bank question|与本文件中的第|Repeats question )/;

/** True for issues produced by these checks (recomputed on every check). */
export function isCheckIssue(issue: string): boolean {
  return CHECK_ISSUE.test(issue);
}

/** A draft about to be checked. */
export interface WorkingDraft {
  draft_id?: string;
  fields: DraftFields;
  raw: string;
  /** Issues from parsing that still apply. */
  issues: string[];
  include?: boolean;
  /** Status before this check (recheck), to know whether it newly became a duplicate. */
  prevStatus?: DraftItem["status"];
}

const FIELD_KEYS = ["stem", "type", "options", "answer", "solution", "grade", "difficulty", "knowledge_points", "tags", "images", "source", "language", "classified", "category_path"] as const;

/** The question fields of a draft (without draft_id, status, issues …). */
export function fieldsOf(d: Partial<ItemFields>): DraftFields {
  const out: Record<string, unknown> = {};
  for (const k of FIELD_KEYS) if (d[k] !== undefined) out[k] = d[k];
  return out as DraftFields;
}

function isEmptyStem(stem: string | undefined) {
  return !stem || !stem.trim() || stem.trim() === EMPTY_STEM;
}

/** Validation problems: errors make the draft unusable, warnings need review. */
export function validate(f: DraftFields): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (isEmptyStem(f.stem)) errors.push(MSG.emptyStem());
  else {
    const parsed = itemFieldsSchema.safeParse(f);
    if (!parsed.success) for (const e of parsed.error.issues.slice(0, 3)) errors.push(clampStr(MSG.invalid(e.path.join(".") || "-", e.message), 500));
  }
  if (f.type === "multiple_choice") {
    const opts = f.options ?? [];
    if (opts.length < 2) warnings.push(MSG.fewOptions());
    opts.forEach((o, i) => {
      if (!o.trim()) warnings.push(MSG.emptyOption(LETTERS[i]));
    });
    if (f.answer && opts.length >= 2) {
      const a = f.answer.trim();
      const letters = /^[A-J](?:\s*[,，、]?\s*[A-J])*$/.test(a) ? a.replace(/[\s,，、]/g, "").split("") : undefined;
      if (letters && letters.some((l) => LETTERS.indexOf(l) >= opts.length)) warnings.push(MSG.answerNotOption(clampStr(a, 40)));
    }
  }
  return { errors, warnings };
}

/** Validate, check duplicates (bank and within the batch) and build the drafts. */
export function checkDrafts(input: WorkingDraft[], existing: Item[]): DraftItem[] {
  const index = new StemIndex<Item>();
  for (const it of existing) index.add(it, it.stem);
  const seen = new Map<string, { draft_id: string; label: string }>();
  const usedIds = new Set<string>();
  return input.map((w, n) => {
    let draft_id = w.draft_id && /^[A-Za-z0-9_-]{1,64}$/.test(w.draft_id) && !usedIds.has(w.draft_id) ? w.draft_id : `d${n + 1}`;
    if (usedIds.has(draft_id)) draft_id = `d${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    usedIds.add(draft_id);

    const f = w.fields;
    const { errors, warnings } = validate(f);
    const issues = [...w.issues.filter((x) => !isCheckIssue(x)), ...errors, ...warnings];
    let status: DraftItem["status"] = errors.length ? "error" : issues.length ? "needs_review" : "ok";
    let duplicate_of: string | undefined;
    let include = w.include ?? true;

    if (status !== "error") {
      const fp = fingerprint(f.stem);
      const hit = index.size ? index.nearest(f.stem) : undefined;
      const inBatch = seen.get(fp);
      if (hit && hit.score >= 1) {
        status = "duplicate";
        duplicate_of = hit.item.id;
        issues.push(MSG.dupBank(snippet(hit.item.stem)));
      } else if (inBatch) {
        status = "duplicate";
        duplicate_of = inBatch.draft_id;
        issues.push(MSG.dupBatch(inBatch.label));
      } else if (hit && hit.score >= NEAR_DUPLICATE) {
        status = "near_duplicate";
        duplicate_of = hit.item.id;
        issues.push(MSG.nearBank(Math.round(hit.score * 100), snippet(hit.item.stem)));
      }
      if (status === "duplicate" && w.prevStatus !== "duplicate") include = false;
      if (!inBatch) seen.set(fp, { draft_id, label: f.source?.label ?? String(n + 1) });
    }

    return {
      ...f,
      stem: isEmptyStem(f.stem) ? EMPTY_STEM : f.stem,
      knowledge_points: f.knowledge_points ?? [],
      tags: f.tags ?? [],
      images: f.images ?? [],
      type: f.type ?? "other",
      draft_id,
      status,
      issues: issues.map((x) => clampStr(x, 500)),
      raw: clampStr(w.raw, 40_000),
      duplicate_of,
      include,
    };
  });
}

export function reportOf(drafts: DraftItem[]): NonNullable<ImportBatch["report"]> {
  const count = (s: DraftItem["status"]) => drafts.filter((d) => d.status === s).length;
  return {
    total: drafts.length,
    ok: count("ok"),
    needs_review: count("needs_review"),
    duplicate: count("duplicate") + count("near_duplicate"),
    error: count("error"),
  };
}
