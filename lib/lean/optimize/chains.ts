/**
 * "The largest family of subsets without three in a chain" (A ⊊ B ⊊ C) — a
 * session's statement: subsets of a 5-set, at most 20. The condition is on
 * three members at once, so the colouring of family.ts (conditions on pairs)
 * has nothing to colour, and the families are far too many to go through.
 *
 * The proof is the textbook one, with the counting left to the kernel: the
 * subsets of an n-set split into chains (the symmetric chain decomposition,
 * built here), two subsets of one chain are comparable (one `decide` over
 * the pairs), so a family without a 3-chain has at most two members in each
 * chain — and no more than the chain has. Σ min(2, length) is the sum of the
 * two largest binomial coefficients; the two middle layers attain it.
 *
 * How the condition is spelled (¬ ∃ A B C …, ∀ … → False, ⊂ or ⊆ with ≠) is
 * not read: the script states "no A ⊂ B ⊂ C among the members" and lets
 * `grind` take it from the statement's condition, and back for the witness.
 * A condition that says something else fails there, and the route with it.
 */
import { splitLets, stripParens, squash } from "../combinatorics/lets";
import { splitExists } from "./domain";
import { NAME, bareSet, conjuncts, flatten, plainForm } from "./family";

export interface ChainStatement {
  /** size of the ground set (members are `Finset (Fin n)`) */
  n: number;
  M: number;
  /** `rintro` pattern of the conditions before `t = F.card` */
  pattern: string;
  /** the lets to introduce and the statement to `show` when it was rewritten before it was read */
  opening: string[];
}

/** Largest ground set taken: the kernel compares every pair of subsets (4ⁿ). */
export const CHAIN_MAX_N = 6;

const binom = (n: number, k: number): number => {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
};

/** The two largest layers of the subsets of an n-set. */
export function middleLayers(n: number): [number, number] {
  const m = Math.floor(n / 2);
  return n % 2 ? [m, m + 1] : [m - 1, m];
}

/** Symmetric chain decomposition of the subsets of {0, …, n − 1}, subsets as bit masks, each chain rising. */
export function symmetricChains(n: number): number[][] {
  let chains: number[][] = [[0]];
  for (let i = 0; i < n; i++) {
    const b = 2 ** i;
    const next: number[][] = [];
    for (const c of chains) {
      next.push([...c, c[c.length - 1] + b]);
      if (c.length > 1) next.push(c.slice(0, -1).map((x) => x + b));
    }
    chains = next;
  }
  return chains;
}

/** The statement's shape, or undefined when it is not a "no three in a chain" family statement. */
export function chainShape(theoremType: string): ChainStatement | undefined {
  const t0 = squash(theoremType);
  const split = splitLets(t0);
  const lets = split?.lets ?? [];
  let body = split ? split.body : t0.startsWith(":") ? stripParens(t0.slice(1)) : undefined;
  if (!body) return undefined;
  body = stripParens(body);
  const opening: string[] = [];
  if (lets.length) {
    const plain = plainForm(lets, body);
    if (!plain) return undefined;
    opening.push(`intro ${lets.map((l) => l.name).join(" ")}`, `show ${plain}`);
    body = plain;
  }
  const m = new RegExp(`^IsGreatest\\s*\\{\\s*(${NAME})\\s*(?::\\s*ℕ)?\\s*\\|\\s*([\\s\\S]+)\\}\\s*(\\d+)$`).exec(bareSet(body));
  if (!m) return undefined;
  const [, tv, inner, Mtext] = m;
  const ex = splitExists(inner.trim());
  if (!ex || ex.binders.length !== 1) return undefined;
  const F = ex.binders[0].name;
  const mt = /^Finset \(Finset \(?Fin (\d+)\)?\)$/.exec(ex.binders[0].type?.replace(/\s+/g, " ").trim() ?? "");
  if (!mt) return undefined;
  const n = Number(mt[1]);
  if (n < 2 || n > CHAIN_MAX_N) return undefined;
  const top = conjuncts(ex.body);
  const last = top.pop()!;
  if (!new RegExp(`^(${tv} = ${F}\\.card|${F}\\.card = ${tv}|${tv} = Finset\\.card ${F})$`).test(last)) return undefined;
  const { flat, pattern } = flatten(top, 0);
  // every condition is "members are subsets of everything" (says nothing) or the one about three members
  const UNIV = String.raw`\(?Finset\.univ(?: : Finset \(?Fin \d+\)?)?\)?`;
  const idle = new RegExp(`^∀ (${NAME}) ∈ ${F}, \\1 ⊆ ${UNIV}$`);
  const rest = flat.filter((it) => !idle.test(it));
  if (rest.length !== 1) return undefined;
  const cond = rest[0];
  // three members named by one run of binders, and nothing but inclusion between them
  const names =
    new RegExp(`^¬ ?\\(?∃ ((?:${NAME} ){3}): [^,]+,`).exec(cond)?.[1].trim().split(" ") ??
    new RegExp(`^∀ ((?:${NAME} ){3}): [^,]+,`).exec(cond)?.[1].trim().split(" ") ??
    [...cond.matchAll(new RegExp(`[∀∃] (${NAME}) ∈ ${F},`, "g"))].map((x) => x[1]);
  if (names.length !== 3 || new Set(names).size !== 3) return undefined;
  if (!/[⊂⊆<]/.test(cond) || /\.card|∩|∪|\\|Disjoint|\d/.test(cond.replace(/Fin \d+/g, ""))) return undefined;
  return { n, M: Number(Mtext), pattern, opening };
}

/** The whole tactic script, or the reason there is none. */
export function chainScript(st: ChainStatement): { tactics?: string; reason: string } {
  const [a, b] = middleLayers(st.n);
  const best = binom(st.n, a) + binom(st.n, b);
  if (st.M !== best) return { reason: `the largest family without three in a chain has ${best} members (the two middle layers), not ${st.M}` };
  const chains = symmetricChains(st.n);
  const k = chains.length;
  const T = `Finset (Fin ${st.n})`;
  const table = chains.flatMap((c, i) => c.map((x) => `(${x}, ${i})`)).join(", ");
  const W = `((Finset.univ : Finset (${T})).filter (fun A => A.card = ${a} ∨ A.card = ${b}))`;
  const fibre = `((Finset.univ : Finset (${T})).filter (fun A => chain A = c)).card`;
  const tactics = [
    ...st.opening,
    `let code : ${T} → ℕ := fun A => A.sum (fun i => 2 ^ (i : ℕ))`,
    `let chain : ${T} → ℕ := fun A => ((([${table}] : List (ℕ × ℕ)).lookup (code A)).getD 0)`,
    // two subsets of one chain are comparable; the chains are numbered below k; two from each (one from a chain of one) is M
    `have hcomp : ∀ A B : ${T}, chain A = chain B → A ⊆ B ∨ B ⊆ A := by`,
    `  decide +kernel`,
    `have hlt : ∀ A : ${T}, chain A < ${k} := by`,
    `  decide +kernel`,
    `have hsum : ∑ c ∈ Finset.range ${k}, min 2 ${fibre} = ${st.M} := by`,
    `  decide +kernel`,
    // the witness: two layers; a chain of three would need three sizes
    `have hW : ∀ A ∈ ${W}, ∀ B ∈ ${W}, ∀ C ∈ ${W}, A ⊂ B → B ⊂ C → False := by`,
    `  intro A hA B hB C hC hAB hBC`,
    `  have h1 := Finset.card_lt_card hAB`,
    `  have h2 := Finset.card_lt_card hBC`,
    `  simp only [Finset.mem_filter, Finset.mem_univ, true_and] at hA hB hC`,
    `  omega`,
    `have hWcard : ${W}.card = ${st.M} := by`,
    `  decide +kernel`,
    `refine ⟨⟨${W}, ?_⟩, ?_⟩`,
    `· grind [Finset.subset_univ]`,
    `· rintro t ⟨F, ${st.pattern}, rfl⟩`,
    `  clear hW hWcard`,
    `  have hno : ∀ A ∈ F, ∀ B ∈ F, ∀ C ∈ F, A ⊂ B → B ⊂ C → False := by`,
    `    intro A hA B hB C hC hAB hBC`,
    `    grind`,
    `  have h3 : ∀ X ∈ F, ∀ Y ∈ F, ∀ Z ∈ F, X ⊆ Y → Y ⊆ Z → X ≠ Y → Y ≠ Z → False :=`,
    `    fun X hX Y hY Z hZ h1 h2 n1 n2 => hno X hX Y hY Z hZ ⟨h1, fun h => n1 (Finset.Subset.antisymm h1 h)⟩ ⟨h2, fun h => n2 (Finset.Subset.antisymm h2 h)⟩`,
    `  have hfib : ∀ c ∈ Finset.range ${k}, (F.filter (fun A => chain A = c)).card ≤ min 2 ${fibre} := by`,
    `    intro c _`,
    `    refine le_min ?_ (Finset.card_le_card (Finset.filter_subset_filter _ (Finset.subset_univ F)))`,
    `    by_contra hgt`,
    `    obtain ⟨A, hA, B, hB, C, hC, hAB, hAC, hBC⟩ := Finset.two_lt_card.mp (not_le.mp hgt)`,
    `    obtain ⟨hA, eA⟩ := Finset.mem_filter.mp hA`,
    `    obtain ⟨hB, eB⟩ := Finset.mem_filter.mp hB`,
    `    obtain ⟨hC, eC⟩ := Finset.mem_filter.mp hC`,
    // three different subsets of one chain: every order of them is a chain of three, or closes a cycle
    `    rcases hcomp A B (eA.trans eB.symm) with h1 | h1 <;> rcases hcomp A C (eA.trans eC.symm) with h2 | h2 <;> rcases hcomp B C (eB.trans eC.symm) with h4 | h4`,
    `    · exact h3 A hA B hB C hC h1 h4 hAB hBC`,
    `    · exact h3 A hA C hC B hB h2 h4 hAC hBC.symm`,
    `    · exact hAB (Finset.Subset.antisymm h1 (h4.trans h2))`,
    `    · exact h3 C hC A hA B hB h2 h1 hAC.symm hAB`,
    `    · exact h3 B hB A hA C hC h1 h2 hAB.symm hAC`,
    `    · exact hAC (Finset.Subset.antisymm h2 (h4.trans h1))`,
    `    · exact h3 B hB C hC A hA h4 h2 hBC hAC.symm`,
    `    · exact h3 C hC B hB A hA h4 h1 hBC.symm hAB.symm`,
    `  calc F.card = ∑ c ∈ Finset.range ${k}, (F.filter (fun A => chain A = c)).card :=`,
    `        Finset.card_eq_sum_card_fiberwise (fun A _ => Finset.mem_range.mpr (hlt A))`,
    `    _ ≤ ∑ c ∈ Finset.range ${k}, min 2 ${fibre} := Finset.sum_le_sum hfib`,
    `    _ = ${st.M} := hsum`,
  ].join("\n");
  return { tactics, reason: "" };
}
