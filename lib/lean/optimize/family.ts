/**
 * "Largest family of subsets": `IsGreatest {t | ∃ F : Finset (Finset X), (∀ A ∈ F, A ⊆ U) ∧
 * (∀ A ∈ F, ∀ B ∈ F, P A B) ∧ … ∧ t = F.card} M` with a small ground set U (≤ 7 elements).
 *
 * A family is a clique of the compatibility graph on U's subsets (A ~ B when every condition holds
 * for A, B, and for each with itself). Lean itself computes that graph from the statement's own
 * conditions (an `#eval`, not part of the proof); the program finds a largest clique (the witness)
 * and colours the subsets with M colours so that two subsets of the same colour are never
 * compatible. The proof then is: the kernel checks the colouring (`decide +kernel` over all pairs
 * of subsets), so the colour is injective on any family, and a family has at most M members
 * (Finset.card_le_card_of_injOn into range M). Eventown (pairwise even intersections over 6
 * elements: at most 8) is the motivating case; its usual proof is linear algebra over 𝔽₂.
 */
import { splitLets, stripParens, squash, topIndex } from "../combinatorics/lets";
import { splitExists } from "./domain";

export interface FamilyStatement {
  /** `intro` names of the statement's lets */
  lets: { name: string; type?: string; value: string }[];
  /** the family's variable and the element type of its members (`Finset ℕ`) */
  family: string;
  memberType: string;
  /** the ground set (Lean text) */
  domain: string;
  /** how the domain condition is written: `∀ A ∈ F, A ⊆ D` (item index) or `F ⊆ D.powerset` */
  domainItem: { index: number; kind: "subset" | "powerset" | "univ"; /** `.1` / `.2.1` … when `A ⊆ D` is one part of a conjunction */ proj?: string };
  /** `∀ A ∈ F, P A` (binder name, body) and `∀ A ∈ F, ∀ B ∈ F, Q A B` */
  unary: { index: number; v: string; body: string; /** the condition is written on the family: `F ⊆ Finset.univ.filter (fun A => P A)`, `F ⊆ Finset.powersetCard k Finset.univ` — P A for a member through that lemma */ via?: "filter" | "powersetCard" }[];
  pairwise: { index: number; a: string; b: string; body: string }[];
  /** "the family covers the ground set": `F.biUnion (fun A => A) = Finset.univ` (also `F.biUnion id`, `F.sup id`, either way round) — only read for members `Finset (Fin n)`; the bound is then a search (clique.ts), not a colouring */
  cover?: { index: number; union: string; reversed: boolean; /** written point by point: `∀ x : Fin n, ∃ A ∈ F, x ∈ A` */ pointwise?: boolean };
  /** the statement was rewritten before it was read (lets written out, typed binders as `∀ A ∈ F`): the names to `intro` and the goal to `show` — Lean accepts it by unfolding — before the proof */
  shown?: { intro: string[]; goal: string };
  /** the `rintro` pattern of the conditions when they are grouped (`⟨hc0, hc1, hc2⟩`); else `hc0, hc1, …` */
  pattern?: string;
  /** number of conjuncts before `t = F.card` */
  items: number;
  M: number;
}

/** Top-level conjuncts of a proposition. */
function conjuncts(s: string): string[] {
  const out: string[] = [];
  let t = stripParens(s);
  for (;;) {
    const i = topIndex(t, "∧");
    if (i < 0) {
      out.push(stripParens(t));
      return out;
    }
    out.push(stripParens(t.slice(0, i)));
    t = t.slice(i + 1).trim();
  }
}

const NAME = "[A-Za-z_][\\w'₀-₉]*";

/** The statement's shape, or undefined when it is not a "largest family" statement this prover takes. */
export function parseFamily(theoremType: string): FamilyStatement | undefined {
  const t0 = squash(theoremType);
  const split = splitLets(t0);
  const lets = split?.lets ?? [];
  let body = split ? split.body : t0.startsWith(":") ? stripParens(t0.slice(1)) : undefined;
  if (!body) return undefined;
  body = stripParens(body);
  const direct = readFamily(lets, body);
  if (direct) return direct;
  // the same statement written with helper lets (`let Good := fun F => …; … Good F …`) or with typed
  // binders (`∀ A : T, A ∈ F → …`, `∃ A : T, A ∈ F ∧ …`): written out, read again, and shown to Lean first
  const plain = plainForm(lets, body);
  if (!plain || plain === body) return undefined;
  const st = readFamily([], plain);
  if (!st) return undefined;
  st.shown = { intro: lets.map((l) => l.name), goal: plain };
  return st;
}

const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\']/g, "\\$&");
const word = (v: string) => new RegExp(`(?<![\\w'.₀-₉])${esc(v)}(?![\\w'₀-₉])`, "g");

/** The statement's body with its lets written out and membership binders in their short form; undefined when a let cannot be written out. */
function plainForm(lets: FamilyStatement["lets"], body: string): string | undefined {
  let t = body;
  // later lets may use earlier ones: from the last to the first
  for (let k = lets.length - 1; k >= 0; k--) {
    const l = lets[k];
    const fn = new RegExp(`^fun \\(?(${NAME})(?: : [^=]+?)?\\)? => ([\\s\\S]+)$`).exec(stripParens(l.value));
    const into = (text: string): string | undefined => {
      if (!fn) return text.replace(word(l.name), `(${l.value})`);
      // a predicate: every use must be an application to a name
      const applied = new RegExp(`(?<![\\w'.₀-₉])${esc(l.name)} (${NAME})(?![\\w'₀-₉])`, "g");
      const out = text.replace(applied, (_, arg: string) => `(${fn[2].replace(word(fn[1]), arg)})`);
      return word(l.name).test(out) ? undefined : out;
    };
    const next = into(t);
    if (next === undefined) return undefined;
    t = next;
  }
  // a let used inside an earlier-inlined let's value has been written out with it (values are inlined after their users)
  if (lets.some((l) => word(l.name).test(t))) return undefined;
  return t
    .replace(new RegExp(`∀ \\(?(${NAME}) : [^,()]*(?:\\([^()]*(?:\\([^()]*\\))?[^()]*\\))?[^,()]*\\)?, \\1 ∈ (${NAME}) → `, "g"), "∀ $1 ∈ $2, ")
    .replace(new RegExp(`∃ \\(?(${NAME}) : [^,()]*(?:\\([^()]*(?:\\([^()]*\\))?[^()]*\\))?[^,()]*\\)?, \\1 ∈ (${NAME}) ∧ `, "g"), "∃ $1 ∈ $2, ");
}

/** The conditions of a (possibly grouped) conjunction, flat, with the `rintro` pattern that takes them apart. */
function flatten(items: string[], start: number): { flat: string[]; pattern: string } {
  const flat: string[] = [];
  const names: string[] = [];
  for (const it of items) {
    // a group in brackets — not a quantified condition, whose body may hold an ∧ of its own
    if (!/^[∀∃¬]/.test(it) && topIndex(it, "∧") >= 0) {
      const inner = flatten(conjuncts(it), start + flat.length);
      flat.push(...inner.flat);
      names.push(`⟨${inner.pattern}⟩`);
    } else {
      names.push(`hc${start + flat.length}`);
      flat.push(it);
    }
  }
  return { flat, pattern: names.join(", ") };
}

function readFamily(lets: FamilyStatement["lets"], body: string): FamilyStatement | undefined {
  const m = new RegExp(`^IsGreatest\\s*\\{\\s*(${NAME})\\s*(?::\\s*ℕ)?\\s*\\|\\s*([\\s\\S]+)\\}\\s*(\\d+)$`).exec(body);
  if (!m) return undefined;
  const [, tv, inner, Mtext] = m;
  const ex = splitExists(inner.trim());
  if (!ex || ex.binders.length !== 1) return undefined;
  const fam = ex.binders[0];
  const famType = fam.type?.replace(/\s+/g, " ").trim();
  const mt = famType && /^Finset \((Finset (?:ℕ|\(Fin \d+\)|Fin \d+))\)$/.exec(famType);
  if (!mt) return undefined;
  const F = fam.name;
  const top = conjuncts(ex.body);
  const last = top.pop()!;
  if (!new RegExp(`^(${tv} = ${F}\\.card|${F}\\.card = ${tv}|${tv} = Finset\\.card ${F})$`).test(last)) return undefined;
  const { flat: items, pattern } = flatten(top, 0);
  const st: FamilyStatement = { lets, family: F, memberType: mt[1], domain: "", domainItem: { index: -1, kind: "subset" }, unary: [], pairwise: [], items: items.length, M: Number(Mtext) };
  if (items.length !== top.length) st.pattern = pattern;
  items.forEach((it, index) => {
    const pair = new RegExp(`^∀ (${NAME}) ∈ ${F}, ∀ (${NAME}) ∈ ${F}, ([\\s\\S]+)$`).exec(it);
    if (pair) {
      st.pairwise.push({ index, a: pair[1], b: pair[2], body: pair[3] });
      return;
    }
    const one = new RegExp(`^∀ (${NAME}) ∈ ${F}, ([\\s\\S]+)$`).exec(it);
    if (one) {
      // `A ⊆ D`, alone or as one part of a conjunction (`A ⊆ D ∧ A.card = 4`)
      const parts = conjuncts(one[2]);
      const at = parts.findIndex((q) => new RegExp(`^${one[1]} ⊆ `).test(q));
      if (at >= 0 && st.domainItem.index < 0) {
        st.domain = stripParens(parts[at].slice(parts[at].indexOf("⊆") + 1).trim());
        const proj = parts.length === 1 ? "" : at < parts.length - 1 ? ".2".repeat(at) + ".1" : ".2".repeat(at);
        st.domainItem = { index, kind: "subset", proj };
        // the other parts are conditions on each member (the whole body: the domain part is harmless)
        if (parts.length > 1) st.unary.push({ index, v: one[1], body: one[2] });
      } else st.unary.push({ index, v: one[1], body: one[2] });
      return;
    }
    const pw = new RegExp(`^${F} ⊆ ([\\s\\S]+)\\.powerset$`).exec(it) ?? new RegExp(`^${F} ⊆ Finset\\.powerset ([\\s\\S]+)$`).exec(it);
    if (pw && st.domainItem.index < 0) {
      st.domain = stripParens(pw[1]);
      st.domainItem = { index, kind: "powerset" };
      return;
    }
    // the members' condition written on the family: F ⊆ the subsets with P (only over a whole type)
    const UNIVF = String.raw`\(?Finset\.univ(?: : Finset \(Finset \(?Fin \d+\)?\))?\)?`;
    const filt =
      new RegExp(`^${F} ⊆ \\(?${UNIVF}\\.filter \\(fun (${NAME})(?: : [^=]+?)? => ([\\s\\S]+)\\)\\)?$`).exec(it) ??
      new RegExp(`^${F} ⊆ \\(?Finset\\.filter \\(fun (${NAME})(?: : [^=]+?)? => ([\\s\\S]+)\\) ${UNIVF}\\)?$`).exec(it);
    if (filt && /^Finset \(?Fin \d+\)?$/.test(st.memberType)) {
      // the pattern's last bracket is optional: a closing bracket too many belongs to the filter, not to the condition
      let cond = filt[2].trim();
      const depth = (t: string) => [...t].reduce((d, ch) => d + (ch === "(" ? 1 : ch === ")" ? -1 : 0), 0);
      while (cond.endsWith(")") && depth(cond) < 0) cond = cond.slice(0, -1).trim();
      st.unary.push({ index, v: filt[1], body: cond, via: "filter" });
      return;
    }
    const pc = new RegExp(`^${F} ⊆ \\(?Finset\\.powersetCard (\\d+) \\(?Finset\\.univ(?: : Finset \\(?Fin \\d+\\)?)?\\)?\\)?$`).exec(it) ?? new RegExp(`^${F} ⊆ \\(?\\(?Finset\\.univ(?: : Finset \\(?Fin \\d+\\)?)?\\)?\\.powersetCard (\\d+)\\)?$`).exec(it);
    if (pc && /^Finset \(?Fin \d+\)?$/.test(st.memberType)) {
      st.unary.push({ index, v: "A", body: `A.card = ${pc[1]}`, via: "powersetCard" });
      return;
    }
    // the family covers everything, said point by point
    const pt = new RegExp(`^∀ \\(?(${NAME})(?: : Fin \\d+)?\\)?, ∃ (${NAME}) ∈ ${F}, \\1 ∈ \\2$`).exec(it);
    if (pt && !st.cover && /^Finset \(?Fin \d+\)?$/.test(st.memberType)) {
      st.cover = { index, union: "", reversed: false, pointwise: true };
      return;
    }
    // the family covers everything: its union is the whole type
    const UNIV = String.raw`\(?Finset\.univ(?: : Finset \(?Fin \d+\)?)?\)?`;
    const UNION = `${F}\\.biUnion \\(fun (?<v>${NAME}) => \\k<v>\\)|${F}\\.biUnion id|${F}\\.sup id`;
    const cov = new RegExp(`^(${UNION}) = ${UNIV}$`).exec(it);
    const voc = cov ? null : new RegExp(`^${UNIV} = (${UNION})$`).exec(it);
    if ((cov || voc) && !st.cover && /^Finset \(?Fin \d+\)?$/.test(st.memberType)) {
      st.cover = { index, union: (cov ?? voc)![1], reversed: !cov };
      return;
    }
    st.domainItem.index = -2; // a condition of another kind: not taken
  });
  // no ground-set condition: the members' type is the ground set (`Finset (Finset (Fin 6))`)
  const fin = /^Finset \(?Fin (\d+)\)?$/.exec(st.memberType);
  if (st.domainItem.index === -1 && fin) {
    st.domain = `(Finset.univ : Finset (Fin ${fin[1]}))`;
    st.domainItem = { index: -1, kind: "univ" };
  }
  // a cover is read against the whole type: not with a ground set of its own
  if (st.cover && st.domainItem.kind !== "univ") return undefined;
  if ((st.domainItem.index < 0 && st.domainItem.kind !== "univ") || !st.pairwise.length || !Number.isInteger(st.M) || st.M < 1) return undefined;
  return st;
}

/** `#eval` printing every subset of the domain (sorted elements), whether it may be in a family, and its compatibility row. */
export function familyEvalCommand(st: FamilyStatement): string {
  const T = st.memberType;
  const lets = st.lets.map((l) => `  let ${l.name}${l.type ? ` : ${l.type}` : ""} := ${l.value}`);
  const unary = st.unary.map((u, i) => `  let u${i} : ${T} → Bool := fun ${u.v} => decide (${u.body})`);
  const pair = st.pairwise.map((p, i) => `  let p${i} : ${T} → ${T} → Bool := fun ${p.a} ${p.b} => decide (${p.body})`);
  const ok = ["true", ...st.unary.map((_, i) => `u${i} X`), ...st.pairwise.map((_, i) => `p${i} X X`)].join(" && ");
  const compat = ["true", ...st.pairwise.flatMap((_, i) => [`p${i} X Y`, `p${i} Y X`])].join(" && ");
  return [
    "#eval Id.run do",
    ...lets,
    ...unary,
    ...pair,
    // Finset.toList is noncomputable: the subsets as sublists of the sorted ground set
    `  let subs : List (${T}) := ((${st.domain}).sort (· ≤ ·)).sublists.map List.toFinset`,
    "  let mut out : String := \"\"",
    "  for X in subs do",
    "    let row := String.join (subs.map (fun Y => if " + compat + " then \"1\" else \"0\"))",
    "    out := out ++ s!\"{(X.sort (· ≤ ·)).map (fun i => (i : ℕ))}|{if " + ok + " then 1 else 0}|{row}\\n\"",
    "  return out",
  ].join("\n");
}

export interface FamilyGraph {
  /** members of each subset (as numbers) */
  sets: number[][];
  ok: boolean[];
  compat: boolean[][];
}

/** The `#eval` output (a string literal) back into the graph; undefined when it does not read. */
export function readFamilyGraph(output: string): FamilyGraph | undefined {
  const m = /"([\s\S]*)"/.exec(output.trim());
  const text = (m ? m[1] : output).replace(/\\n/g, "\n");
  const sets: number[][] = [];
  const ok: boolean[] = [];
  const rows: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parts = /^\[([\d, ]*)\]\|([01])\|([01]+)$/.exec(line.trim());
    if (!parts) return undefined;
    sets.push(parts[1].trim() ? parts[1].split(",").map((x) => Number(x.trim())) : []);
    ok.push(parts[2] === "1");
    rows.push(parts[3]);
  }
  if (!sets.length || rows.some((r) => r.length !== sets.length)) return undefined;
  return { sets, ok, compat: rows.map((r) => [...r].map((c) => c === "1")) };
}

/** A largest set of pairwise compatible allowed subsets (branch and bound), stopping at `cap` members. */
export function maxFamily(g: FamilyGraph, cap = 64, deadline = Date.now() + 20_000): number[] {
  const verts = g.sets.map((_, i) => i).filter((i) => g.ok[i]);
  let best: number[] = [];
  const grow = (chosen: number[], cand: number[]) => {
    if (Date.now() > deadline) return;
    if (chosen.length > best.length) best = [...chosen];
    if (best.length >= cap) return;
    for (let k = 0; k < cand.length; k++) {
      if (chosen.length + cand.length - k <= best.length) return;
      const v = cand[k];
      grow([...chosen, v], cand.slice(k + 1).filter((w) => g.compat[v][w]));
    }
  };
  grow([], verts);
  return best;
}

/** Colours 0…k-1 for the allowed subsets with no two compatible subsets alike (DSATUR backtracking), or undefined. */
export function colourFamily(g: FamilyGraph, k: number, deadline = Date.now() + 20_000): number[] | undefined {
  const verts = g.sets.map((_, i) => i).filter((i) => g.ok[i]);
  const col = new Map<number, number>();
  const conflicts = (v: number) => verts.filter((w) => w !== v && g.compat[v][w]);
  const nb = new Map(verts.map((v) => [v, conflicts(v)]));
  const go = (): boolean => {
    if (Date.now() > deadline) return false;
    if (col.size === verts.length) return true;
    // the uncoloured subset with the most distinct neighbour colours
    let pick = -1;
    let sat = -1;
    for (const v of verts) {
      if (col.has(v)) continue;
      const s = new Set(nb.get(v)!.filter((w) => col.has(w)).map((w) => col.get(w))).size;
      if (s > sat) {
        sat = s;
        pick = v;
      }
    }
    const used = new Set(nb.get(pick)!.filter((w) => col.has(w)).map((w) => col.get(w)));
    const maxUsed = Math.max(-1, ...col.values());
    for (let c = 0; c < k && c <= maxUsed + 1; c++) {
      if (used.has(c)) continue;
      col.set(pick, c);
      if (go()) return true;
      col.delete(pick);
    }
    return false;
  };
  if (!go()) return undefined;
  return g.sets.map((_, i) => col.get(i) ?? 0);
}

/** The first lines of a proof: the lets introduced, and the statement as it was read when it was rewritten. */
export function opening(st: FamilyStatement): string[] {
  const names = st.shown ? st.shown.intro : st.lets.map((l) => l.name);
  return [...(names.length ? [`intro ${names.join(" ")}`] : []), ...(st.shown ? [`show ${st.shown.goal}`] : [])];
}

/** The `rintro` pattern for the conditions before `t = F.card`. */
export const hypPattern = (st: FamilyStatement): string => st.pattern ?? Array.from({ length: st.items }, (_, i) => `hc${i}`).join(", ");

/** `P A` for a member A (`hA : A ∈ F`) from the family's hypothesis `h`. */
export function unaryArg(u: FamilyStatement["unary"][number], h: string, A = "A", hA = "hA"): string {
  if (u.via === "filter") return `(Finset.mem_filter.mp (${h} ${hA})).2`;
  if (u.via === "powersetCard") return `(Finset.mem_powersetCard.mp (${h} ${hA})).2`;
  return `(${h} ${A} ${hA})`;
}

const setText = (s: number[]) => (s.length ? `{${s.join(", ")}}` : "∅");

/** The whole tactic script (after the statement), or a reason. */
export function familyScript(st: FamilyStatement, g: FamilyGraph, witness: number[], colours: number[]): string {
  const T = st.memberType;
  const D = st.domain;
  const code = (s: number[]) => s.reduce((a, i) => a + 2 ** i, 0);
  const table = g.sets.map((s, i) => `(${code(s)}, ${colours[i]})`).join(", ");
  const famLit = `{${witness.map((i) => setText(g.sets[i])).join(", ")}}`;
  const n = st.items;
  const hyp = (i: number) => `hc${i}`;
  const premises: string[] = [];
  const args: string[] = [];
  for (const u of st.unary) {
    premises.push(`(fun (${u.v} : ${T}) => ${u.body}) A`, `(fun (${u.v} : ${T}) => ${u.body}) B`);
    args.push(unaryArg(u, hyp(u.index)), unaryArg(u, hyp(u.index), "B", "hB"));
  }
  for (const p of st.pairwise) {
    const f = `(fun (${p.a} ${p.b} : ${T}) => ${p.body})`;
    premises.push(`${f} A A`, `${f} B B`, `${f} A B`, `${f} B A`);
    const h = hyp(p.index);
    args.push(`(${h} A hA A hA)`, `(${h} B hB B hB)`, `(${h} A hA B hB)`, `(${h} B hB A hA)`);
  }
  const dom = st.domainItem.kind === "univ" ? `fun A _ => Finset.mem_powerset.mpr (Finset.subset_univ A)` : st.domainItem.kind === "subset" ? `fun A hA => Finset.mem_powerset.mpr (${hyp(st.domainItem.index)} A hA)${st.domainItem.proj ?? ""}` : `fun A hA => ${hyp(st.domainItem.index)} hA`;
  return [
    ...opening(st),
    `let code : ${T} → ℕ := fun A => A.sum (fun i => 2 ^ (i : ℕ))`,
    `let color : ${T} → ℕ := fun A => ((([${table}] : List (ℕ × ℕ)).lookup (code A)).getD 0)`,
    `have key : ∀ A ∈ (${D}).powerset, ∀ B ∈ (${D}).powerset, A ≠ B → ${premises.map((p) => `${p} → `).join("")}color A ≠ color B := by`,
    `  decide +kernel`,
    `have hcol : ∀ A ∈ (${D}).powerset, color A < ${st.M} := by`,
    `  decide +kernel`,
    `refine ⟨⟨${famLit}, ?_⟩, ?_⟩`,
    `· decide +kernel`,
    `· rintro t ⟨F, ${hypPattern(st)}, rfl⟩`,
    `  have hD : ∀ A ∈ F, A ∈ (${D}).powerset := ${dom}`,
    `  calc F.card ≤ (Finset.range ${st.M}).card := by`,
    `        refine Finset.card_le_card_of_injOn color (fun A hA => Finset.mem_range.mpr (hcol A (hD A hA))) ?_`,
    `        intro A hA B hB hAB`,
    `        by_contra hne`,
    `        exact key A (hD A hA) B (hD B hB) hne ${args.join(" ")} hAB`,
    `    _ = ${st.M} := by simp`,
  ].join("\n");
}
