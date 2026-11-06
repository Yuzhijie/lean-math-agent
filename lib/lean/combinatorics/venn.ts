/**
 * Inclusion–exclusion (Venn regions) for card facts about finite sets: with sets A, B, C (≤ 4) in
 * context, every element lies in exactly one region (in A, not in B, in C, …). Each set expression
 * whose `card` appears — in a hypothesis or the goal — is written as the disjoint union of its
 * regions (`ext x; simp; tauto`), so its card is the sum of the regions' cards
 * (`Finset.card_union_of_disjoint`); the region cards are then the unknowns of a linear system
 * and omega solves it. `Fintype.card α` is the union of all regions, outside ones included.
 */
import { topIndex } from "./lets";
import { isInaccessible, type GoalState } from "../geometry/goal";
import { evalSet, parseSetExpr, setVars, usesUniverse, type SetExpr } from "./sets";

const MAX_SETS = 4;
const SIMPS = "Finset.mem_union, Finset.mem_inter, Finset.mem_sdiff, Finset.mem_filter, Finset.mem_compl, Finset.mem_univ, true_and, Finset.notMem_empty";

interface CardTerm {
  /** Exactly as printed: `(A ∩ B).card`, `A.card`, `Fintype.card α`. */
  text: string;
  expr: SetExpr;
}

/** The `….card` and `Fintype.card α` terms of a text. */
export function cardTerms(text: string, sets: Set<string>): CardTerm[] | undefined {
  const out: CardTerm[] = [];
  for (const m of text.matchAll(/Fintype\.card ([^\s()=]+)/g)) out.push({ text: m[0], expr: { k: "univ" } });
  for (const m of text.matchAll(/\.card(?![\w'])/g)) {
    const end = m.index!;
    if (/(^|[^\w.])(Fintype|Nat|Set|Finset)$/.test(text.slice(0, end))) continue;
    let start: number;
    if (text[end - 1] === ")") {
      let depth = 0;
      start = -1;
      for (let i = end - 1; i >= 0; i--) {
        if (text[i] === ")") depth++;
        else if (text[i] === "(") depth--;
        if (depth === 0) {
          start = i;
          break;
        }
      }
      if (start < 0) return undefined;
    } else {
      const id = /[A-Za-z_][\w'₀-₉.]*$/.exec(text.slice(0, end));
      if (!id) return undefined;
      start = id.index;
    }
    const exprText = text.slice(start, end);
    if (exprText.startsWith("Finset.univ")) {
      out.push({ text: `${exprText}.card`, expr: { k: "univ" } });
      continue;
    }
    const expr = parseSetExpr(exprText);
    if (!expr || [...setVars(expr)].some((v) => !sets.has(v))) return undefined;
    out.push({ text: `${exprText}.card`, expr });
  }
  return out;
}

/** The expression with the let-defined sets replaced by their definitions. */
function substDefs(e: SetExpr, defs: Map<string, SetExpr>): SetExpr {
  switch (e.k) {
    case "var":
      return defs.has(e.name) ? substDefs(defs.get(e.name)!, defs) : e;
    case "compl":
      return { k: "compl", a: substDefs(e.a, defs) };
    case "bin":
      return { k: "bin", op: e.op, a: substDefs(e.a, defs), b: substDefs(e.b, defs) };
    default:
      return e;
  }
}

/** The script, or undefined when the goal is not about cards of these sets. */
export function vennScript(st: GoalState): string[] | undefined {
  const finsets = st.hyps.filter((h) => /^Finset\s+\S+$|^Finset\s*\(.*\)$/.test(h.type.trim()));
  // sets defined by a let (X := (A \ (B ∪ C)) ∪ …): their definitions, not new sets — a fourth
  // "set" X made 16 regions whose proofs ran out of heartbeats, and omega knew nothing of X
  const defs = new Map<string, SetExpr>();
  for (const h of finsets) {
    if (h.value === undefined || h.names.length !== 1) continue;
    const e = parseSetExpr(h.value.trim());
    if (e) defs.set(h.names[0], e);
  }
  const sets = finsets.flatMap((h) => h.names).filter((n) => !isInaccessible(n) && !defs.has(n));
  for (const [n, e] of [...defs]) if ([...setVars(substDefs(e, defs))].some((v) => !sets.includes(v))) defs.delete(n);
  if (!sets.length || sets.length > MAX_SETS) return undefined;
  const setNames = new Set([...sets, ...defs.keys()]);
  const simps = [...defs.keys(), SIMPS].join(", ");
  const disjoint = `(by rw [Finset.disjoint_left]; intro x; (try simp only [${simps}]) <;> tauto)`;
  // set equations (A ∪ B ∪ C = Finset.univ): their cards are equal too
  const pre: string[] = [];
  const extra: string[] = [];
  for (const h of st.hyps) {
    const n = h.names[0];
    const ty = h.type.replace(/\s+/g, " ").trim();
    if (h.names.length !== 1 || isInaccessible(n) || /card|[∀∃→]/.test(ty)) continue;
    const at = topIndex(ty, " = ");
    if (at < 0) continue;
    const [l, r] = [ty.slice(0, at).trim(), ty.slice(at + 3).trim()];
    const side = (x: string) => {
      const e = parseSetExpr(x);
      return e && [...setVars(e)].every((v) => setNames.has(v)) && (setVars(e).size > 0 || e.k === "univ") ? e : undefined;
    };
    if (!side(l) || !side(r)) continue;
    // the universe as Fintype.card α (`Finset.univ.card` alone leaves the type to infer: "typeclass instance problem is stuck")
    const elem = /^Finset\s+(.+)$/.exec(st.hyps.find((x) => x.names.includes(sets[0]))!.type.trim())?.[1];
    const isU = (x: string) => /^Finset\.univ$/.test(x);
    if ((isU(l) || isU(r)) && !elem) continue;
    const cardOf = (x: string) => (isU(x) ? `Fintype.card ${elem}` : `(${x}).card`);
    const fact = `${cardOf(l)} = ${cardOf(r)}`;
    const proof = isU(r) ? `by rw [${n}]; exact Finset.card_univ` : isU(l) ? `by rw [← Finset.card_univ, ${n}]` : `congrArg Finset.card ${n}`;
    pre.push(`have hseq${pre.length} : ${fact} := ${proof}`);
    extra.push(fact);
  }
  const texts = [st.target, ...st.hyps.map((h) => h.type), ...extra];
  const terms: CardTerm[] = [];
  for (const t of texts) {
    if (!/card/.test(t)) continue;
    const found = cardTerms(t, setNames);
    if (!found) return undefined;
    for (const c of found) if (!terms.some((x) => x.text === c.text)) terms.push({ ...c, expr: substDefs(c.expr, defs) });
  }
  const targetTerms = cardTerms(st.target, setNames) ?? [];
  if (!targetTerms.length || !/^[^∀∃]*(=|≤|<|≥|>)/.test(st.target)) return undefined;
  // only the sets that occur
  const used = sets.filter((v) => terms.some((t) => setVars(t.expr).has(v)));
  if (!used.length) return undefined;
  const universe = terms.some((t) => usesUniverse(t.expr));
  const patterns = [...Array(1 << used.length).keys()].filter((p) => p !== 0 || universe);
  const inP = (p: number) => (name: string) => {
    const i = used.indexOf(name);
    return i >= 0 && ((p >> i) & 1) === 1;
  };
  const region = (p: number): string => {
    const lits = used.map((v, i) => `x ${(p >> i) & 1 ? "∈" : "∉"} ${v}`);
    if (p === 0) return `(Finset.univ.filter (fun x => ${lits.join(" ∧ ")}))`;
    const base = used.findIndex((_, i) => (p >> i) & 1);
    const rest = lits.filter((_, i) => i !== base);
    return rest.length ? `(${used[base]}.filter (fun x => ${rest.join(" ∧ ")}))` : used[base];
  };
  const union = (rs: string[]): string => (rs.length === 1 ? rs[0] : `${rs[0]} ∪ (${union(rs.slice(1))})`);
  const sum = (rs: string[]): string => (rs.length === 1 ? `${rs[0]}.card` : `${rs[0]}.card + (${sum(rs.slice(1))})`);
  const lines: string[] = [];
  terms.forEach((t, i) => {
    const regs = patterns.filter((p) => evalSet(t.expr, inP(p))).map(region);
    const isUniv = t.expr.k === "univ";
    const lhsSet = isUniv ? "(Finset.univ : Finset _)" : t.text.replace(/\.card$/, "");
    if (!regs.length) {
      lines.push(`have c${i} : ${t.text} = 0 := by rw [Finset.card_eq_zero]; ext x; (try simp only [${simps}]) <;> tauto`);
      return;
    }
    lines.push(`have e${i} : ${lhsSet} = ${union(regs)} := by ext x; (try simp only [${simps}]) <;> tauto`);
    const disj = Array(regs.length - 1).fill(`Finset.card_union_of_disjoint ${disjoint}`);
    const pre = isUniv && t.text.startsWith("Fintype.card") ? "rw [← Finset.card_univ]; " : "";
    lines.push(`have c${i} : ${t.text} = ${sum(regs)} := by ${pre}rw [congrArg Finset.card e${i}]${disj.length ? `; rw [${disj.join(", ")}]` : ""}`);
  });
  lines.push("omega");
  return [...pre, ...lines];
}
