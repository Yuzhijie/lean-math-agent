/**
 * The pieces of an optimization proof that are plain text: the binders of an `∃` goal, the
 * finite candidates Lean enumerates for each (a `#eval` search, outside the proof), the witness
 * as Lean text, and the "box" statement the kernel decides for the bound.
 */
import { topIndex } from "../combinatorics/lets";

export interface ExBinder {
  name: string;
  /** a binder predicate written in the binder: `s ⊆ X`, `x ∈ X`, `x < B`, `x ≤ B` */
  pred?: { op: "⊆" | "∈" | "<" | "≤"; rhs: string };
  /** type when the statement writes it (`∃ a b : ℕ, …`) */
  type?: string;
}

/** `∃ a b c, P` / `∃ s ⊆ X, P` / `∃ (a : ℕ) (b : ℤ), P`, nested `∃`s merged; undefined when not an ∃. */
export function splitExists(target: string): { binders: ExBinder[]; body: string } | undefined {
  let t = target.trim();
  const binders: ExBinder[] = [];
  while (t.startsWith("∃")) {
    const comma = topIndex(t, ",");
    if (comma < 0) return undefined;
    const head = t.slice(1, comma).trim();
    t = t.slice(comma + 1).trim();
    const pred = /^([A-Za-z_][\w'₀-₉]*)\s*(⊆|∈|<|≤)\s*(.+)$/.exec(head);
    if (pred) {
      binders.push({ name: pred[1], pred: { op: pred[2] as "⊆" | "∈" | "<" | "≤", rhs: pred[3].trim() } });
      continue;
    }
    const groups = [...head.matchAll(/\(([^():]+):([^()]+(?:\([^()]*\)[^()]*)*)\)/g)];
    if (groups.length && head.replace(/\(([^():]+):([^()]+(?:\([^()]*\)[^()]*)*)\)/g, "").trim() === "") {
      for (const g of groups) for (const n of g[1].trim().split(/\s+/)) binders.push({ name: n, type: g[2].trim() });
      continue;
    }
    const typed = /^([^:]+):(.+)$/.exec(head);
    const names = (typed ? typed[1] : head).trim().split(/\s+/);
    if (!names.every((n) => /^[A-Za-z_][\w'₀-₉]*$/.test(n))) return undefined;
    for (const n of names) binders.push({ name: n, ...(typed ? { type: typed[2].trim() } : {}) });
  }
  if (!binders.length) return undefined;
  return { binders, body: t };
}

export interface Candidates {
  /** Lean expression of a List to loop over */
  list: string;
  /** how many */
  size: number;
  /** the loop variable when it is not the binder itself (functions: their digit list) */
  loopVar?: string;
  /** `let name : T := …` built from the loop variable */
  bind?: string;
  /** witness text from the printed value */
  witness: (printed: string) => string;
}

const plain = (s: string) => s;
const intWitness = (s: string) => (s.startsWith("-") ? `(${s})` : s);

/** The candidates for one binder of type `type` (as Lean prints it), `bound` for unbounded numbers. */
export function candidates(b: ExBinder, type: string, bound: number): Candidates | undefined {
  const T = type.trim();
  if (T === "ℕ") {
    if (b.pred?.op === "∈") return { list: `((${b.pred.rhs}).sort (· ≤ ·))`, size: bound, witness: plain };
    if (b.pred?.op === "<" && /^\d+$/.test(b.pred.rhs)) return { list: `List.range ${b.pred.rhs}`, size: Number(b.pred.rhs), witness: plain };
    if (b.pred?.op === "≤" && /^\d+$/.test(b.pred.rhs)) return { list: `List.range ${Number(b.pred.rhs) + 1}`, size: Number(b.pred.rhs) + 1, witness: plain };
    return { list: `List.range ${bound + 1}`, size: bound + 1, witness: plain };
  }
  if (T === "ℤ") return { list: `((List.range ${2 * bound + 1}).map (fun i => (i : ℤ) - ${bound}))`, size: 2 * bound + 1, witness: intWitness };
  if (T === "Bool") return { list: "[false, true]", size: 2, witness: plain };
  let m = /^Fin (\d+)$/.exec(T);
  if (m) return { list: `List.finRange ${m[1]}`, size: Number(m[1]), witness: plain };
  m = /^Finset \(Fin (\d+)\)$/.exec(T);
  if (m) {
    const n = Number(m[1]);
    if (n > 16) return undefined;
    return { list: `((List.range ${2 ** n}).map (fun m => (Finset.univ.filter (fun i : Fin ${n} => m.testBit i.val))))`, size: 2 ** n, witness: plain };
  }
  if (/^Finset ℕ$/.test(T) && b.pred?.op === "⊆") {
    const L = `((${b.pred.rhs}).sort (· ≤ ·))`;
    return {
      list: `((List.range (2 ^ ${L}.length)).map (fun m => (((List.range ${L}.length).filter (fun i => m.testBit i)).map (fun i => ${L}[i]!)).toFinset))`,
      size: 1 << 16,
      witness: plain,
    };
  }
  m = /^Fin (\d+) → Fin (\d+)$/.exec(T);
  if (m) {
    const [n, k] = [Number(m[1]), Number(m[2])];
    if (k ** n > 200_000) return undefined;
    const lv = `${b.name}_digits`;
    return {
      list: `((List.range ${k ** n}).map (fun c => (List.range ${n}).map (fun i => c / ${k} ^ i % ${k})))`,
      size: k ** n,
      loopVar: lv,
      bind: `let ${b.name} : Fin ${n} → Fin ${k} := fun i => ⟨${lv}[i.val]! % ${k}, Nat.mod_lt _ (by decide)⟩`,
      witness: (s) => `!${s}`,
    };
  }
  return undefined;
}

/**
 * `#eval` program: loop over every binder's candidates, return the first tuple that makes the body
 * true, printed as `w₁¦w₂¦…` (or none). `lets` are the statement's local definitions.
 */
export function searchProgram(binders: { name: string; c: Candidates }[], body: string, lets: { name: string; value: string; type?: string }[]): string {
  const lines = ["#eval Id.run do"];
  for (const l of lets) lines.push(`  let ${l.name}${l.type ? ` : ${l.type}` : ""} := ${l.value}`);
  let indent = "  ";
  for (const b of binders) {
    lines.push(`${indent}for ${b.c.loopVar ?? b.name} in ${b.c.list} do`);
    indent += "  ";
    if (b.c.bind) lines.push(`${indent}${b.c.bind}`);
  }
  const shown = binders.map((b) => `{repr ${b.c.loopVar ?? b.name}}`).join("¦");
  lines.push(`${indent}if decide (${body}) then`);
  lines.push(`${indent}  return some s!"${shown}"`);
  lines.push(`  return (none : Option String)`);
  return lines.join("\n");
}

/** `some "3¦3¦4"` (Lean's printed result) → the printed values; undefined for none / anything else. */
export function readSearchOutput(data: string): string[] | undefined {
  const m = /some\s+"((?:[^"\\]|\\.)*)"/.exec(data);
  if (!m) return undefined;
  const s = m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  return s.split("¦").map((x) => x.trim());
}

// ── the box ──────────────────────────────────────────────────────────────────

export type BoxVar =
  | { name: string; kind: "range"; type: "ℕ" | "ℤ"; lo: bigint; hi: bigint; loProof: string; hiProof: string }
  | { name: string; kind: "type"; type: string; size: number }
  | { name: string; kind: "subset"; set: string; proof: string; size: number };

export function boxSize(vars: BoxVar[]): number {
  let n = 1;
  for (const v of vars) n *= v.kind === "range" ? Number(v.hi - v.lo + 1n) : v.size;
  return n;
}

/** Elements of a finite type the kernel enumerates (undefined: not one we handle). */
export function finiteTypeSize(type: string): number | undefined {
  const T = type.trim();
  if (T === "Bool") return 2;
  let m = /^Fin (\d+)$/.exec(T);
  if (m) return Number(m[1]);
  m = /^Finset \(Fin (\d+)\)$/.exec(T);
  if (m) return Number(m[1]) <= 16 ? 2 ** Number(m[1]) : undefined;
  m = /^Fin (\d+) → (Fin (\d+)|Bool)$/.exec(T);
  if (m) {
    const k = m[3] ? Number(m[3]) : 2;
    return k ** Number(m[1]);
  }
  return undefined;
}

const num = (n: bigint, type: string) => (n < 0n ? `(${n} : ${type})` : `(${n} : ${type})`);

/** `have key : ∀ a ∈ Finset.Icc 0 10, …, H₁ → H₂ → G` and the term that applies it. */
export function boxKey(vars: BoxVar[], hyps: { name: string; type: string }[], goal: string): { statement: string; apply: string } {
  const binders = vars.map((v) =>
    v.kind === "range" ? `∀ ${v.name} ∈ Finset.Icc ${num(v.lo, v.type)} ${num(v.hi, v.type)},` : v.kind === "type" ? `∀ ${v.name} : ${v.type},` : `∀ ${v.name} ∈ (${v.set}).powerset,`,
  );
  const statement = [...binders, [...hyps.map((h) => `(${h.type}) →`), `(${goal})`].join(" ")].join(" ");
  const args = vars.map((v) =>
    v.kind === "range" ? `${v.name} (Finset.mem_Icc.mpr ⟨${v.loProof}, ${v.hiProof}⟩)` : v.kind === "type" ? v.name : `${v.name} (Finset.mem_powerset.mpr ${v.proof})`,
  );
  return { statement, apply: [...args, ...hyps.map((h) => h.name)].join(" ") };
}

/** Local names a text mentions (identifiers among `names`). */
export function mentions(text: string, names: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z_][\w'₀-₉!?]*(?:\.[A-Za-z_][\w'₀-₉!?]*)*/g)) {
    const head = m[0].split(".")[0];
    if (names.has(m[0])) out.add(m[0]);
    else if (names.has(head)) out.add(head);
  }
  return out;
}

/** Integers written in a text (for bound candidates). */
export function numbersIn(text: string): bigint[] {
  return [...text.matchAll(/(?<![\w.'])\d+(?![\w.])/g)].map((m) => BigInt(m[0]));
}

/** Upper-bound candidates, small first: the numbers written, their sum, a few round numbers. */
export function boundCandidates(nums: bigint[], cap = 100_000n): bigint[] {
  const set = new Set<bigint>();
  const pos = nums.filter((n) => n >= 0n && n <= cap);
  for (const n of pos) {
    set.add(n);
    if (n > 0n) set.add(n - 1n);
  }
  const sum = pos.reduce((a, b) => a + b, 0n);
  if (sum <= cap) set.add(sum);
  for (const r of [10n, 100n, 1000n]) set.add(r);
  return [...set].filter((n) => n >= 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, 12);
}
