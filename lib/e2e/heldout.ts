/**
 * The held-out problem set of the end-to-end evaluation (`npm run e2e`; bench/heldout.json): the
 * problems as a user would type them, with the known answer. The provers were being improved one
 * pasted failure at a time, which says nothing about the next problem nobody has seen; this set is
 * fixed, and its `test` split is only ever reported in aggregate — a failure there is never opened
 * or fixed against (the `dev` split is for that). `seen_family` marks problems of a kind the
 * program already has a dedicated route for, so the report can show how far the provers reach
 * beyond the families they were written for.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";

const problemSchema = z.object({
  id: z.string().min(1),
  topic: z.string().min(1),
  /** find = a value is asked for (answer known); prove = a claim to prove. */
  kind: z.enum(["find", "prove"]),
  level: z.number().int().min(1).max(5).default(2),
  seen_family: z.boolean().default(false),
  split: z.enum(["dev", "test"]),
  text: z.string().min(1),
  /** The answer as one would write it ("24√3/7", "4, 10"). */
  answer: z.string().optional(),
  /** Its numeric value (single-valued answers). */
  value: z.number().optional(),
  /** All values, when the answer is a set of numbers. */
  values: z.array(z.number()).min(1).optional(),
  /** How the answer was checked (scripts/heldout_check.py): computed | theorem | cases. */
  check: z.string().optional(),
});

const setSchema = z.object({
  name: z.string().min(1),
  version: z.number().int().default(1),
  description: z.string().optional(),
  problems: z.array(problemSchema).min(1),
});

export type HeldoutProblem = z.infer<typeof problemSchema>;

export interface HeldoutSet {
  name: string;
  version: number;
  problems: HeldoutProblem[];
  /** Changes whenever a problem's text, answer, kind or split changes: runs on different sets are not compared. */
  hash: string;
}

/** Parse and validate a set (throws with the problem's id on an inconsistent entry). */
export function parseHeldout(text: string): HeldoutSet {
  const doc = setSchema.parse(JSON.parse(text));
  const seen = new Set<string>();
  for (const p of doc.problems) {
    if (seen.has(p.id)) throw new Error(`held-out set: duplicate id ${p.id}`);
    seen.add(p.id);
    const hasValue = p.value !== undefined || p.values !== undefined;
    if (p.kind === "find" && (!p.answer?.trim() || !hasValue)) throw new Error(`held-out set: ${p.id} asks for a value but has no answer / value`);
    if (p.kind === "find" && p.value !== undefined && p.values !== undefined) throw new Error(`held-out set: ${p.id} has both value and values`);
    if (p.kind === "prove" && (p.answer !== undefined || hasValue)) throw new Error(`held-out set: ${p.id} is a claim to prove and must not carry an answer`);
  }
  const key = doc.problems.map((p) => [p.id, p.split, p.kind, p.text, p.answer ?? "", p.value ?? "", (p.values ?? []).join(",")]);
  const hash = createHash("sha256").update(JSON.stringify(key)).digest("hex").slice(0, 12);
  return { name: doc.name, version: doc.version, problems: doc.problems, hash };
}

export function loadHeldout(file: string): HeldoutSet {
  return parseHeldout(readFileSync(file, "utf8"));
}

export interface Selection {
  split?: "dev" | "test" | "all";
  topics?: string[];
  ids?: string[];
  /** A deterministic sample of about this many problems, spread evenly over split × topic. */
  sample?: number;
  limit?: number;
}

/** The problems a run covers, in the set's order. */
export function selectProblems(set: HeldoutSet, sel: Selection = {}): HeldoutProblem[] {
  let list = set.problems;
  if (sel.ids?.length) {
    const want = new Set(sel.ids);
    list = list.filter((p) => want.has(p.id));
  }
  if (sel.split && sel.split !== "all") list = list.filter((p) => p.split === sel.split);
  if (sel.topics?.length) list = list.filter((p) => sel.topics!.includes(p.topic));
  if (sel.sample !== undefined && sel.sample < list.length) list = stratifiedSample(list, sel.sample);
  if (sel.limit !== undefined) list = list.slice(0, Math.max(0, sel.limit));
  return list;
}

/** Every k-th problem of each split × topic group, the groups' shares proportional to their sizes. */
function stratifiedSample(list: HeldoutProblem[], n: number): HeldoutProblem[] {
  const groups = new Map<string, HeldoutProblem[]>();
  for (const p of list) {
    const k = `${p.split}/${p.topic}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  const want = Math.max(0, Math.floor(n));
  // largest-remainder shares
  const shares = [...groups.entries()].map(([k, g]) => ({ k, g, exact: (want * g.length) / list.length, take: 0 }));
  for (const s of shares) s.take = Math.floor(s.exact);
  let left = want - shares.reduce((a, s) => a + s.take, 0);
  for (const s of [...shares].sort((a, b) => b.exact - b.take - (a.exact - a.take) || a.k.localeCompare(b.k))) {
    if (left <= 0) break;
    if (s.take < s.g.length) {
      s.take++;
      left--;
    }
  }
  const picked = new Set<string>();
  for (const s of shares) for (let i = 0; i < s.take; i++) picked.add(s.g[Math.floor((i * s.g.length) / s.take)].id);
  return list.filter((p) => picked.has(p.id));
}
