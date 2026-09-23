/**
 * Premise retrieval: given a goal (or a theorem statement), find Mathlib
 * lemmas that are likely to be useful and hand them to the prover as
 * verified names + statements.
 *
 * Sources, merged and deduplicated by name:
 *   1. the built index (`npm run premises:build` → PREMISE_INDEX_PATH,
 *      default `.data/premise-index.json`), produced by
 *      `scripts/lean/DumpDecls.lean` from the sandbox's Mathlib;
 *   2. the curated seed (`premise-seed.ts`), always present, so retrieval
 *      works before any index is built.
 *
 * Retrieval is BM25 over Mathlib-style tokens (see `lib/search/bm25.ts`):
 * the target of the goal weighs more than its hypotheses, and lemma names
 * count double because Mathlib names spell out the statement
 * (`mul_le_mul`, `sq_nonneg`, `Finset.sum_range_succ` …).
 */
import { promises as fs } from "node:fs";
import { Bm25Index, leanTokens, weightedQuery } from "../search/bm25";
import { PREMISE_SEED } from "./premise-seed";

export interface Premise {
  name: string;
  type: string;
  module?: string;
  kind?: "thm" | "def";
}

export interface PremiseIndexFile {
  version: 1;
  source?: string;
  built_at?: string;
  /** [name, type, module?, kind?] */
  entries: Array<[string, string, string?, string?]>;
}

export function premiseIndexPath(): string {
  return process.env.PREMISE_INDEX_PATH ?? ".data/premise-index.json";
}

/** Whether premise retrieval is used by the prover (PREMISES_ENABLED, default true). */
export function premisesEnabled(): boolean {
  return process.env.PREMISES_ENABLED !== "false";
}

interface Loaded {
  index: Bm25Index<Premise>;
  byName: Map<string, Premise>;
  lastComponent: Map<string, Premise[]>;
  fromFile: number;
}

let loaded: Promise<Loaded> | undefined;
let loadedPath: string | undefined;

function build(entries: Premise[]): Loaded {
  const index = new Bm25Index<Premise>();
  const byName = new Map<string, Premise>();
  const lastComponent = new Map<string, Premise[]>();
  for (const p of entries) {
    if (byName.has(p.name)) continue;
    byName.set(p.name, p);
    const nameTokens = leanTokens(p.name);
    index.add(p, [...nameTokens, ...nameTokens, ...leanTokens(p.type)]);
    const tail = p.name.split(".").pop() ?? p.name;
    const list = lastComponent.get(tail) ?? [];
    list.push(p);
    lastComponent.set(tail, list);
  }
  return { index, byName, lastComponent, fromFile: 0 };
}

async function readIndexFile(path: string): Promise<Premise[]> {
  try {
    const raw = await fs.readFile(path, "utf8");
    const data = JSON.parse(raw) as PremiseIndexFile;
    if (!data || !Array.isArray(data.entries)) return [];
    return data.entries
      .filter((e) => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "string")
      .map(([name, type, module, kind]) => ({
        name,
        type,
        module: module || undefined,
        kind: kind === "def" ? "def" : "thm",
      }));
  } catch {
    return [];
  }
}

/** Load (once) the premise index: file entries first, then the seed. */
export function loadPremises(): Promise<Loaded> {
  const path = premiseIndexPath();
  if (!loaded || loadedPath !== path) {
    loadedPath = path;
    loaded = (async () => {
      const fileEntries = await readIndexFile(path);
      const seed: Premise[] = PREMISE_SEED.map(([name, type]) => ({ name, type, kind: "thm" as const }));
      const result = build([...fileEntries, ...seed]);
      result.fromFile = fileEntries.length;
      return result;
    })();
  }
  return loaded;
}

/** Drop the cached index (tests, or after rebuilding the file). */
export function resetPremiseCache(): void {
  loaded = undefined;
  loadedPath = undefined;
}

export interface RetrieveOptions {
  /** Max premises (default 8). */
  k?: number;
  /** Extra text (problem statement, theorem type) with lower weight. */
  context?: string;
  /** Include definitions as well as theorems (default false). */
  includeDefs?: boolean;
}

/**
 * Split a Lean goal into hypothesis types and the target (`⊢ …`). Binder
 * names are dropped so `hab : a < b` contributes only `a < b`.
 */
export function goalParts(goal: string): { hypotheses: string[]; target: string } {
  const hypotheses: string[] = [];
  let target = "";
  const lines = goal.replace(/\r/g, "").split("\n");
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (t.startsWith("⊢")) {
      target = [t.slice(1), ...lines.slice(i + 1)].join("\n").trim();
      break;
    }
    if (/^case\b/.test(t) || t === "") continue;
    const m = t.match(/^[^:]+:\s*([\s\S]*)$/);
    if (m && !/^(\(|∀|∃|¬)/.test(t)) hypotheses.push(m[1].trim());
    else if (hypotheses.length) hypotheses[hypotheses.length - 1] += " " + t; // continuation line
  }
  if (!target && !hypotheses.length) target = goal.trim();
  return { hypotheses, target };
}

/** Retrieve the top-k premises for a goal state (or a bare statement). */
export async function retrievePremises(goal: string, opts: RetrieveOptions = {}): Promise<Premise[]> {
  const k = opts.k ?? 8;
  if (!goal.trim() || k <= 0) return [];
  const { index } = await loadPremises();
  const { hypotheses, target } = goalParts(goal);
  const query = weightedQuery([
    { text: target, weight: 2 },
    ...hypotheses.map((h) => ({ text: h, weight: 1 })),
    ...(opts.context ? [{ text: opts.context, weight: 0.5 }] : []),
  ]);
  if (query.weights.size === 0) return [];
  const hits = index.search(query, k * 4, (p) => opts.includeDefs || p.kind !== "def");
  // Prefer lemmas whose conclusion has the same shape as the target
  // (an inequality for an inequality goal, a divisibility for `∣`, …).
  const rel = mainRelation(target);
  const numberType = dominantNumberType(goal);
  const ranked = hits
    .map((h) => {
      let score = h.score;
      if (rel && mainRelation(conclusionOf(h.item.type)) === rel) score *= 1.25;
      // A goal about ℤ rarely needs `Nat.*` lemmas and vice versa.
      if (numberType === "Nat" && /^Int\./.test(h.item.name)) score *= 0.6;
      if (numberType === "Int" && /^Nat\./.test(h.item.name)) score *= 0.6;
      return { item: h.item, score };
    })
    .sort((x, y) => y.score - x.score);
  return ranked.slice(0, k).map((h) => h.item);
}

/** "Nat" or "Int" when the goal's variables are (only) of that type, else undefined. */
function dominantNumberType(goal: string): "Nat" | "Int" | undefined {
  const nat = /ℕ|\bNat\b/.test(goal);
  const int = /ℤ|\bInt\b/.test(goal);
  if (nat && !int) return "Nat";
  if (int && !nat) return "Int";
  return undefined;
}

/** The conclusion of a statement: what follows the last top-level `→`. */
export function conclusionOf(type: string): string {
  let depth = 0;
  let last = 0;
  for (let i = 0; i < type.length; i++) {
    const c = type[i];
    if (c === "(" || c === "[" || c === "{" || c === "⟨") depth++;
    else if (c === ")" || c === "]" || c === "}" || c === "⟩") depth = Math.max(0, depth - 1);
    else if (c === "→" && depth === 0) last = i + 1;
  }
  return type.slice(last).trim();
}

/** Top-level relation of a proposition (`≤`, `<`, `=`, `∣`, `∈`, `↔`, …), or "". */
export function mainRelation(prop: string): string {
  const s = prop.replace(/^∀[^,]*,\s*/, "").trim();
  let depth = 0;
  let best = "";
  const order = ["↔", "∨", "∧", "≤", "<", "≥", ">", "≠", "=", "∣", "∈", "⊆"];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[" || c === "{" || c === "⟨") depth++;
    else if (c === ")" || c === "]" || c === "}" || c === "⟩") depth = Math.max(0, depth - 1);
    else if (depth === 0 && order.includes(c) && (best === "" || order.indexOf(c) < order.indexOf(best))) best = c;
  }
  if (best === "≥") best = "≤";
  if (best === ">") best = "<";
  return best;
}

/** Declarations whose last name component equals `identifier`'s (case-insensitive), for "did you mean". */
export async function similarNames(identifier: string, k = 5): Promise<Premise[]> {
  const { lastComponent, index } = await loadPremises();
  const tail = identifier.split(".").pop() ?? identifier;
  const exact = lastComponent.get(tail) ?? [];
  if (exact.length >= k) return exact.slice(0, k);
  const query = weightedQuery([{ text: identifier.replace(/\./g, " "), weight: 1 }]);
  const more = index
    .search(query, k * 3)
    .map((h) => h.item)
    .filter((p) => !exact.includes(p) && p.name !== identifier);
  return [...exact, ...more].slice(0, k);
}

/** Prompt block for a list of premises, or "" when empty. */
export function formatPremises(premises: Premise[], title = "Possibly relevant Mathlib lemmas"): string {
  if (premises.length === 0) return "";
  return (
    `${title} (real names, statements simplified; use them via exact/apply/rw/linarith [..]/nlinarith [..], or ignore them):\n` +
    premises.map((p) => `- ${p.name} : ${p.type}`).join("\n")
  );
}

/** Prompt block for identifiers Lean did not know, from the local index (no network). */
export async function localHintsForUnknownIdentifiers(identifiers: string[]): Promise<string> {
  const blocks: string[] = [];
  for (const id of identifiers.slice(0, 3)) {
    const hits = await similarNames(id, 5);
    if (hits.length === 0) continue;
    blocks.push(`\`${id}\` does not exist. Similar declarations:\n` + hits.map((h) => `- ${h.name} : ${h.type}`).join("\n"));
  }
  return blocks.join("\n\n");
}

/** Statistics for logs / the bench. */
export async function premiseStats(): Promise<{ total: number; fromFile: number; path: string }> {
  const l = await loadPremises();
  return { total: l.byName.size, fromFile: l.fromFile, path: premiseIndexPath() };
}
