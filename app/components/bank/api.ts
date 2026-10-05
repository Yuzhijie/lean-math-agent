/**
 * Client-side helpers for the /api/banks routes: typed fetch that turns
 * `{error}` responses into thrown Errors, and the response shapes the bank
 * UI works with (types only — nothing from the server bundle is imported).
 */
import type {
  Bank,
  Candidate,
  Category,
  DraftItem,
  Generation,
  ImportBatch,
  Item,
  ItemFields,
  ItemFilter,
  QuestionType,
  StyleTemplate,
  TemplateProfile,
  TemplateRef,
} from "@/lib/bank/types";

export type { Bank, Candidate, Category, DraftItem, Generation, ImportBatch, Item, ItemFields, ItemFilter, QuestionType, StyleTemplate, TemplateProfile, TemplateRef };

export const QUESTION_TYPE_LIST: QuestionType[] = ["multiple_choice", "numeric", "short_answer", "proof", "other"];
export const DRAFT_STATUS_LIST: DraftItem["status"][] = ["ok", "needs_review", "duplicate", "near_duplicate", "error"];

export type BankSummary = Bank & { item_count: number };
export type FacetEntry = { value: string; count: number };
export type BatchSummary = Omit<ImportBatch, "drafts"> & { draft_count: number };
export type CategoryWithCount = Category & { member_count: number };

export interface BankDetail {
  bank: Bank;
  storage: string;
  item_count: number;
  categories: Category[];
  facets: { types: FacetEntry[]; grades: FacetEntry[]; knowledge_points: FacetEntry[]; tags: FacetEntry[]; origins: FacetEntry[] };
  vocab: { own: string[]; builtin: Array<{ strand: string; points: string[] }> };
  batches: BatchSummary[];
}

export interface ColumnPreview {
  format: "csv" | "xlsx";
  headers: string[];
  suggested: Record<string, string>;
  sample: string[][];
}

/** Fetch JSON; a non-2xx response throws an Error with the server's `{error}` message. */
export async function api<T>(url: string, init?: RequestInit & { json?: unknown }, fallbackError = "Request failed"): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(url, {
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "Content-Type": "application/json", ...(rest.headers ?? {}) } } : {}),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON body (e.g. a proxy error page).
  }
  if (!res.ok) {
    const msg = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : `${fallbackError} (${res.status})`;
    throw new Error(msg);
  }
  return data as T;
}

export const bankUrl = (bankId: string, path = "") => `/api/banks/${encodeURIComponent(bankId)}${path}`;

export const errMsg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export const letter = (i: number) => String.fromCharCode(65 + i);

/** A question as solver input: stem plus "A. …" option lines. */
/**
 * Main-page link that loads a question: ?problem=<text>, plus its figures
 * (bank assets) as ?bank=<id>&fig=<asset>… so they are shown with it.
 */
export function problemHref(q: { stem: string; options?: string[]; images?: Array<{ asset: string }> }, bankId?: string): string {
  const params = new URLSearchParams({ problem: problemText(q) });
  if (bankId && q.images?.length) {
    params.set("bank", bankId);
    for (const im of q.images.slice(0, 6)) params.append("fig", im.asset);
  }
  return `/?${params.toString()}`;
}

export function problemText(q: { stem: string; options?: string[] }): string {
  const opts = q.options?.length ? "\n" + q.options.map((o, i) => `${letter(i)}. ${o}`).join("\n") : "";
  return q.stem + opts;
}
