/**
 * How the problem generator shows a bank-templated question's checks, and how it reads the
 * streamed generation (NDJSON progress lines). Bundled into the browser: no server imports.
 */
import type { BankProblemMeta } from "@/lib/types";

export type CheckKey = "format" | "answer" | "novelty" | "fit" | "figure";
export const CHECK_KEYS: CheckKey[] = ["answer", "figure", "fit", "novelty", "format"];

/** ok = every check ran and passed; review = passed, but a check could not run (a person should look); failed = a check failed. */
export type CardStatus = "ok" | "review" | "failed";

/** A check that could not run and needs a person (every skipped check but "this question has no figure"). */
const NO_FIGURE = /此题不需要图形|has no figure/;
const needsReview = (c: { ok: boolean; detail: string; skipped?: boolean } | undefined) => !!c?.skipped && !NO_FIGURE.test(c.detail);

export function cardStatus(meta: Pick<BankProblemMeta, "passed" | "checks">): CardStatus {
  if (!meta.passed) return "failed";
  return CHECK_KEYS.some((k) => needsReview(meta.checks[k])) ? "review" : "ok";
}

export interface CheckIssue {
  key: CheckKey;
  kind: "failed" | "review";
  detail: string;
}

/** The checks worth showing on the card without opening the details: failures first, then those to review. */
export function checkIssues(meta: Pick<BankProblemMeta, "checks">): CheckIssue[] {
  const failed = CHECK_KEYS.flatMap((k): CheckIssue[] => {
    const c = meta.checks[k];
    return c && !c.ok && !c.skipped ? [{ key: k, kind: "failed", detail: c.detail }] : [];
  });
  const review = CHECK_KEYS.flatMap((k): CheckIssue[] => (needsReview(meta.checks[k]) ? [{ key: k, kind: "review", detail: meta.checks[k]!.detail }] : []));
  return [...failed, ...review];
}

/** Progress line of a streamed bank generation (see GenerationProgress in lib/bank/generate.ts). */
export interface ProgressLine {
  stage: string;
  round?: number;
  rounds: number;
  requested: number;
  passed?: number;
  detail: string;
}

/** Read an NDJSON response body line by line. */
export async function readNdjson(body: ReadableStream<Uint8Array>, onLine: (line: Record<string, unknown>) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const flush = (text: string) => {
    const t = text.trim();
    if (!t) return;
    try {
      onLine(JSON.parse(t) as Record<string, unknown>);
    } catch {
      /* not a JSON line */
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      flush(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  flush(buf + decoder.decode());
}
