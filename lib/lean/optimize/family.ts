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
  domainItem: { index: number; kind: "subset" | "powerset" };
  /** `∀ A ∈ F, P A` (binder name, body) and `∀ A ∈ F, ∀ B ∈ F, Q A B` */
  unary: { index: number; v: string; body: string }[];
  pairwise: { index: number; a: string; b: string; body: string }[];
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
  const items = conjuncts(ex.body);
  const last = items.pop()!;
  if (!new RegExp(`^(${tv} = ${F}\\.card|${F}\\.card = ${tv}|${tv} = Finset\\.card ${F})$`).test(last)) return undefined;
  const st: FamilyStatement = { lets, family: F, memberType: mt[1], domain: "", domainItem: { index: -1, kind: "subset" }, unary: [], pairwise: [], items: items.length, M: Number(Mtext) };
  items.forEach((it, index) => {
    const pair = new RegExp(`^∀ (${NAME}) ∈ ${F}, ∀ (${NAME}) ∈ ${F}, ([\\s\\S]+)$`).exec(it);
    if (pair) {
      st.pairwise.push({ index, a: pair[1], b: pair[2], body: pair[3] });
      return;
    }
    const one = new RegExp(`^∀ (${NAME}) ∈ ${F}, ([\\s\\S]+)$`).exec(it);
    if (one) {
      const sub = new RegExp(`^${one[1]} ⊆ ([\\s\\S]+)$`).exec(one[2]);
      if (sub && st.domainItem.index < 0) {
        st.domain = stripParens(sub[1]);
        st.domainItem = { index, kind: "subset" };
      } else st.unary.push({ index, v: one[1], body: one[2] });
      return;
    }
    const pw = new RegExp(`^${F} ⊆ ([\\s\\S]+)\\.powerset$`).exec(it) ?? new RegExp(`^${F} ⊆ Finset\\.powerset ([\\s\\S]+)$`).exec(it);
    if (pw && st.domainItem.index < 0) {
      st.domain = stripParens(pw[1]);
      st.domainItem = { index, kind: "powerset" };
      return;
    }
    st.domainItem.index = -2; // a condition of another kind: not taken
  });
  if (st.domainItem.index < 0 || !st.pairwise.length || !Number.isInteger(st.M) || st.M < 1) return undefined;
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
    args.push(`(${hyp(u.index)} A hA)`, `(${hyp(u.index)} B hB)`);
  }
  for (const p of st.pairwise) {
    const f = `(fun (${p.a} ${p.b} : ${T}) => ${p.body})`;
    premises.push(`${f} A A`, `${f} B B`, `${f} A B`, `${f} B A`);
    const h = hyp(p.index);
    args.push(`(${h} A hA A hA)`, `(${h} B hB B hB)`, `(${h} A hA B hB)`, `(${h} B hB A hA)`);
  }
  const dom = st.domainItem.kind === "subset" ? `fun A hA => Finset.mem_powerset.mpr (${hyp(st.domainItem.index)} A hA)` : `fun A hA => ${hyp(st.domainItem.index)} hA`;
  return [
    ...(st.lets.length ? [`intro ${st.lets.map((l) => l.name).join(" ")}`] : []),
    `let code : ${T} → ℕ := fun A => A.sum (fun i => 2 ^ (i : ℕ))`,
    `let color : ${T} → ℕ := fun A => ((([${table}] : List (ℕ × ℕ)).lookup (code A)).getD 0)`,
    `have key : ∀ A ∈ (${D}).powerset, ∀ B ∈ (${D}).powerset, A ≠ B → ${premises.map((p) => `${p} → `).join("")}color A ≠ color B := by`,
    `  decide +kernel`,
    `have hcol : ∀ A ∈ (${D}).powerset, color A < ${st.M} := by`,
    `  decide +kernel`,
    `refine ⟨⟨${famLit}, ?_⟩, ?_⟩`,
    `· decide +kernel`,
    `· rintro t ⟨F, ${Array.from({ length: n }, (_, i) => hyp(i)).join(", ")}, rfl⟩`,
    `  have hD : ∀ A ∈ F, A ∈ (${D}).powerset := ${dom}`,
    `  calc F.card ≤ (Finset.range ${st.M}).card := by`,
    `        refine Finset.card_le_card_of_injOn color (fun A hA => Finset.mem_range.mpr (hcol A (hD A hA))) ?_`,
    `        intro A hA B hB hAB`,
    `        by_contra hne`,
    `        exact key A (hD A hA) B (hD B hB) hne ${args.join(" ")} hAB`,
    `    _ = ${st.M} := by simp`,
  ].join("\n");
}
