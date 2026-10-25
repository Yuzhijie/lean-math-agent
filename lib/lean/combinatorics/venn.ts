/**
 * Inclusion–exclusion (Venn regions) for card facts about finite sets: with sets A, B, C (≤ 4) in
 * context, every element lies in exactly one region (in A, not in B, in C, …). Each set expression
 * whose `card` appears — in a hypothesis or the goal — is written as the disjoint union of its
 * regions (`ext x; simp; tauto`), so its card is the sum of the regions' cards
 * (`Finset.card_union_of_disjoint`); the region cards are then the unknowns of a linear system
 * and omega solves it. `Fintype.card α` is the union of all regions, outside ones included.
 */
import { isInaccessible, type GoalState } from "../geometry/goal";
import { evalSet, parseSetExpr, setVars, usesUniverse, type SetExpr } from "./sets";

const MAX_SETS = 4;
const SIMPS = "Finset.mem_union, Finset.mem_inter, Finset.mem_sdiff, Finset.mem_filter, Finset.mem_compl, Finset.mem_univ, true_and, Finset.notMem_empty";
const DISJOINT = `(by rw [Finset.disjoint_left]; intro x; (try simp only [${SIMPS}]) <;> tauto)`;

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

/** The script, or undefined when the goal is not about cards of these sets. */
export function vennScript(st: GoalState): string[] | undefined {
  const sets = st.hyps.filter((h) => /^Finset\s+\S+$|^Finset\s*\(.*\)$/.test(h.type.trim())).flatMap((h) => h.names).filter((n) => !isInaccessible(n));
  if (!sets.length || sets.length > MAX_SETS) return undefined;
  const setNames = new Set(sets);
  const texts = [st.target, ...st.hyps.map((h) => h.type)];
  const terms: CardTerm[] = [];
  for (const t of texts) {
    if (!/card/.test(t)) continue;
    const found = cardTerms(t, setNames);
    if (!found) return undefined;
    for (const c of found) if (!terms.some((x) => x.text === c.text)) terms.push(c);
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
      lines.push(`have c${i} : ${t.text} = 0 := by rw [Finset.card_eq_zero]; ext x; (try simp only [${SIMPS}]) <;> tauto`);
      return;
    }
    lines.push(`have e${i} : ${lhsSet} = ${union(regs)} := by ext x; (try simp only [${SIMPS}]) <;> tauto`);
    const disj = Array(regs.length - 1).fill(`Finset.card_union_of_disjoint ${DISJOINT}`);
    const pre = isUniv && t.text.startsWith("Fintype.card") ? "rw [← Finset.card_univ]; " : "";
    lines.push(`have c${i} : ${t.text} = ${sum(regs)} := by ${pre}rw [congrArg Finset.card e${i}]${disj.length ? `; rw [${disj.join(", ")}]` : ""}`);
  });
  lines.push("omega");
  return lines;
}
