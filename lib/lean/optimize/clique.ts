/**
 * "Largest family of subsets" where a colouring cannot give the bound — the family must also cover
 * the ground set: `IsGreatest {n | ∃ F : Finset (Finset (Fin 7)), (∀ A ∈ F, A.card = 4) ∧ (∀ A ∈ F,
 * ∀ B ∈ F, A ≠ B → 2 ≤ (A ∩ B).card) ∧ F.biUnion (fun A => A) = Finset.univ ∧ n = F.card} 13` (a
 * session's statement; without the cover the answer is 15 — all 4-sets that miss one point — so
 * no colouring with 13 colours exists, and the kernel cannot go through the 1.3 million families).
 *
 * The bound is a search the kernel runs: a node is (members still needed, candidates in order,
 * the points covered so far as a bit mask); it is dropped when too few candidates are left or when
 * even all of them would not cover the ground set (this is what cuts the 15-families off: they miss
 * a point), else split into "the first candidate is a member" (the candidates compatible with it
 * are kept) and "it is not". When no node is left, no family of M + 1 members exists (some 16 000 nodes
 * for the statement above). CLIQUE_LEMMA — two `have`s for any relation, any masks and any step
 * function with that equation, written into the proof: clique_bits (a bit of the union of the
 * masks) and clique_search (no node left after `fuel` steps ⇒ no compatible sub-list of the
 * candidates with the needed length covers). The statement's own conditions are only read: the
 * allowed subsets as a list (every allowed subset is in it; compatible subsets are adjacent in the
 * table; a subset's elements are its mask's bits — three `decide +kernel`), the family as the
 * indices of its members.
 *
 * Checked in Lean 4.33.1 + Mathlib: the statement above in 66 s standalone.
 */
import type { FamilyGraph, FamilyStatement } from "./family";

/** More nodes than this and the search is not given to the kernel. */
export const CLIQUE_MAX_NODES = Number(process.env.CLIQUE_MAX_NODES ?? 60_000);

export const CLIQUE_LEMMA = `have clique_bits : ∀ (m : ℕ → ℕ) (l : List ℕ) (b x : ℕ), (l.foldr (fun i a => m i ||| a) b).testBit x = (b.testBit x || l.any (fun i => (m i).testBit x)) := by
  intro m l b x
  induction l with
  | nil => simp
  | cons i l ih =>
    simp only [List.foldr_cons, Nat.testBit_or, ih, List.any_cons]
    cases b.testBit x <;> cases (m i).testBit x <;> simp
have clique_search : ∀ (R : ℕ → ℕ → Bool) (m : ℕ → ℕ) (N : ℕ) (E : (ℕ × List ℕ × ℕ) → List (ℕ × List ℕ × ℕ)),
    (∀ (k : ℕ) (c : List ℕ) (mask : ℕ), E (k, c, mask) = match c with
       | [] => if k = 0 ∧ ((List.range N).all fun x => mask.testBit x) = true then [(k, c, mask)] else []
       | v :: rest => if rest.length + 1 < k then [] else
           if ((List.range N).all fun x => ((v :: rest).foldr (fun i a => m i ||| a) mask).testBit x) = false then [] else
           [(k - 1, rest.filter (R v), mask ||| m v), (k, rest, mask)]) →
    ∀ (fuel : ℕ) (L : List (ℕ × List ℕ × ℕ)), (fun L => L.flatMap E)^[fuel] L = [] →
      ∀ nd ∈ L, ∀ l : List ℕ, l.Sublist nd.2.1 → l.Pairwise (fun a b => R a b = true) → nd.1 ≤ l.length →
        ((List.range N).all fun x => (l.foldr (fun i a => m i ||| a) nd.2.2).testBit x) = false := by
  intro R m N E hE fuel
  induction fuel with
  | zero =>
    intro L hL nd hnd
    simp only [Function.iterate_zero, id_eq] at hL
    simp [hL] at hnd
  | succ fuel ih =>
    intro L hL nd hnd l hsub hpw hlen
    rw [Function.iterate_succ_apply] at hL
    have hch := ih (L.flatMap E) hL
    obtain ⟨k, c, mask⟩ := nd
    simp only at hsub hlen ⊢
    have hmem : ∀ ch ∈ E (k, c, mask), ch ∈ L.flatMap E := fun ch h => List.mem_flatMap.mpr ⟨_, hnd, h⟩
    rw [hE] at hmem
    cases c with
    | nil =>
      have hl : l = [] := List.sublist_nil.mp hsub
      subst hl
      simp only [List.length_nil, Nat.le_zero] at hlen
      subst hlen
      by_contra hne
      have hcov : ((List.range N).all fun x => mask.testBit x) = true := by simpa using hne
      have h1 := hch (0, [], mask) (hmem _ (by simp [hcov])) [] (List.Sublist.refl _) List.Pairwise.nil (Nat.le_refl _)
      simp only [List.foldr_nil] at h1
      rw [hcov] at h1
      exact absurd h1 (by decide)
    | cons v rest =>
      by_cases hshort : rest.length + 1 < k
      · have := hsub.length_le
        simp only [List.length_cons] at this
        omega
      · by_contra hne
        have hcov : ((List.range N).all fun x => (l.foldr (fun i a => m i ||| a) mask).testBit x) = true := by simpa using hne
        have hall : ((List.range N).all fun x => ((v :: rest).foldr (fun i a => m i ||| a) mask).testBit x) = true := by
          rw [List.all_eq_true] at hcov ⊢
          intro x hx
          have hx' := hcov x hx
          rw [clique_bits] at hx' ⊢
          rcases Bool.or_eq_true_iff.mp hx' with h | h
          · simp [h]
          · obtain ⟨i, hi, hb⟩ := List.any_eq_true.mp h
            exact Bool.or_eq_true_iff.mpr (Or.inr (List.any_eq_true.mpr ⟨i, hsub.subset hi, hb⟩))
        have hkids : ∀ ch ∈ [(k - 1, rest.filter (R v), mask ||| m v), (k, rest, mask)], ch ∈ L.flatMap E := by
          intro ch h
          refine hmem ch ?_
          simp only [hshort, if_false, hall]
          simpa using h
        cases hsub with
        | cons _ h2 =>
          have h1 := hch (k, rest, mask) (hkids _ (by simp)) l h2 hpw hlen
          simp only at h1
          rw [hcov] at h1
          exact absurd h1 (by decide)
        | cons_cons _ h2 =>
          rename_i l'
          have hp := List.pairwise_cons.mp hpw
          have hsub' : l'.Sublist (rest.filter (R v)) := by
            have := h2.filter (R v)
            rwa [List.filter_eq_self.mpr (fun w hw => hp.1 w hw)] at this
          have h1 := hch (k - 1, rest.filter (R v), mask ||| m v) (hkids _ (by simp)) l' hsub' hp.2 (by simp only [List.length_cons] at hlen; omega)
          simp only at h1
          have hcov' : ((List.range N).all fun x => (l'.foldr (fun i a => m i ||| a) (mask ||| m v)).testBit x) = true := by
            rw [List.all_eq_true] at hcov ⊢
            intro x hx
            have hx' := hcov x hx
            rw [clique_bits] at hx' ⊢
            simp only [List.any_cons, Nat.testBit_or] at hx' ⊢
            rw [Bool.or_assoc]
            exact hx'
          rw [hcov'] at h1
          exact absurd h1 (by decide)`;

const bit = (mask: number, x: number) => Math.floor(mask / 2 ** x) % 2 === 1;

export interface CliqueTable {
  /** the allowed subsets (indices into the graph), in the order of the search */
  verts: number[];
  /** per allowed subset: its elements as a bit mask, and the allowed subsets compatible with it as a bit mask over positions in `verts` */
  codes: number[];
  adj: bigint[];
  /** the ground set has the elements 0 … points − 1 */
  points: number;
}

export function cliqueTable(g: FamilyGraph, points: number): CliqueTable {
  const verts = g.sets.map((_, i) => i).filter((i) => g.ok[i]);
  const codes = verts.map((v) => g.sets[v].reduce((a, x) => a + 2 ** x, 0));
  const adj = verts.map((v, i) => verts.reduce((a, w, j) => (j !== i && g.compat[v][w] && g.compat[w][v] ? a | (1n << BigInt(j)) : a), 0n));
  return { verts, codes, adj, points };
}

const full = (t: CliqueTable) => 2 ** t.points - 1;
const covers = (t: CliqueTable, mask: number) => mask === full(t);

/**
 * The search as the kernel will run it: the number of nodes, and whether it ends with no node left
 * (no covering family of `need` members). Stops counting past `cap`.
 */
export function cliqueSearch(t: CliqueTable, need: number, cap = CLIQUE_MAX_NODES): { nodes: number; empty: boolean } {
  let nodes = 0;
  let empty = true;
  const go = (k: number, c: number[], mask: number) => {
    if (nodes > cap || !empty) return;
    nodes++;
    if (!c.length) {
      if (k === 0 && covers(t, mask)) empty = false;
      return;
    }
    if (c.length < k) return;
    if (!covers(t, c.reduce((a, i) => a | t.codes[i], mask))) return;
    const [v, ...rest] = c;
    go(Math.max(k - 1, 0), rest.filter((j) => (t.adj[v] >> BigInt(j)) & 1n), mask | t.codes[v]);
    go(k, rest, mask);
  };
  go(need, t.verts.map((_, i) => i), 0);
  return { nodes, empty: empty && nodes <= cap };
}

/** A largest compatible family that covers the ground set (positions in `verts`), stopping at `cap` members. */
export function maxCoverFamily(t: CliqueTable, cap: number, deadline = Date.now() + 20_000): number[] {
  let best: number[] = [];
  const go = (chosen: number[], cand: number[], mask: number) => {
    if (Date.now() > deadline || best.length >= cap) return;
    if (chosen.length > best.length && covers(t, mask)) best = [...chosen];
    if (chosen.length + cand.length <= best.length) return;
    if (!covers(t, cand.reduce((a, i) => a | t.codes[i], mask))) return;
    for (let k = 0; k < cand.length; k++) {
      if (chosen.length + cand.length - k <= best.length) return;
      const v = cand[k];
      go([...chosen, v], cand.slice(k + 1).filter((j) => (t.adj[v] >> BigInt(j)) & 1n), mask | t.codes[v]);
    }
  };
  go([], t.verts.map((_, i) => i), 0);
  return best;
}

const setText = (s: number[]) => (s.length ? `{${s.join(", ")}}` : "∅");

/** The whole tactic script (after the statement) for a family statement with a cover condition over `Finset (Fin n)`. */
export function cliqueScript(st: FamilyStatement, g: FamilyGraph, t: CliqueTable, witness: number[]): string {
  const T = st.memberType;
  const n = t.verts.length;
  const N = t.points;
  const hyp = (i: number) => `hc${i}`;
  const SL = `(List.range ${n}).filter (fun i => decide (SL.getD i ∅ ∈ ${st.family}))`;
  // every condition on one subset: the unary ones, and each pairwise one with itself
  const single = [...st.unary.map((u) => ({ prop: `(fun (${u.v} : ${T}) => ${u.body}) A`, arg: `(${hyp(u.index)} A hA)` })), ...st.pairwise.map((p) => ({ prop: `(fun (${p.a} ${p.b} : ${T}) => ${p.body}) A A`, arg: `(${hyp(p.index)} A hA A hA)` }))];
  const pairs = st.pairwise.flatMap((p) => {
    const f = `(fun (${p.a} ${p.b} : ${T}) => ${p.body})`;
    const h = hyp(p.index);
    const mi = "(of_decide_eq_true hi'.2)";
    const mj = "(of_decide_eq_true hj'.2)";
    return [
      { prop: `${f} (SL.getD i ∅) (SL.getD j ∅)`, arg: `(${h} _ ${mi} _ ${mj})` },
      { prop: `${f} (SL.getD j ∅) (SL.getD i ∅)`, arg: `(${h} _ ${mj} _ ${mi})` },
    ];
  });
  const cover = st.cover!;
  const step = [
    `(fun (nd : ℕ × List ℕ × ℕ) => match nd.2.1 with`,
    `       | [] => if nd.1 = 0 ∧ ((List.range ${N}).all fun x => nd.2.2.testBit x) = true then [(nd.1, nd.2.1, nd.2.2)] else []`,
    `       | v :: rest => if rest.length + 1 < nd.1 then [] else`,
    `           if ((List.range ${N}).all fun x => ((v :: rest).foldr (fun i a => CL.getD i 0 ||| a) nd.2.2).testBit x) = false then [] else`,
    `           [(nd.1 - 1, rest.filter (fun j => (AL.getD v 0).testBit j), nd.2.2 ||| CL.getD v 0), (nd.1, rest, nd.2.2)])`,
  ].join("\n");
  const root = `(${st.M + 1}, List.range ${n}, 0)`;
  return [
    ...(st.lets.length ? [`intro ${st.lets.map((l) => l.name).join(" ")}`] : []),
    CLIQUE_LEMMA,
    `let SL : List (${T}) := [${t.verts.map((v) => setText(g.sets[v])).join(", ")}]`,
    `let CL : List ℕ := [${t.codes.join(", ")}]`,
    `let AL : List ℕ := [${t.adj.join(", ")}]`,
    `have hidx : ∀ A : ${T}, ${single.map((s) => `${s.prop} → `).join("")}∃ i ∈ List.range ${n}, SL.getD i ∅ = A := by`,
    `  decide +kernel`,
    `have hadj : ∀ i ∈ List.range ${n}, ∀ j ∈ List.range ${n}, i < j → ${pairs.map((p) => `${p.prop} → `).join("")}(AL.getD i 0).testBit j = true := by`,
    `  decide +kernel`,
    `have hbit : ∀ i ∈ List.range ${n}, ∀ x : Fin ${N}, x ∈ SL.getD i ∅ → (CL.getD i 0).testBit (x : ℕ) = true := by`,
    `  decide +kernel`,
    `have hrun : (fun L => L.flatMap ${step})^[${n + 1}] [${root}] = [] := by`,
    `  decide +kernel`,
    `refine ⟨⟨{${witness.map((i) => setText(g.sets[t.verts[i]])).join(", ")}}, ?_⟩, ?_⟩`,
    `· decide +kernel`,
    `· rintro t ⟨${st.family}, ${Array.from({ length: st.items }, (_, i) => hyp(i)).join(", ")}, rfl⟩`,
    `  have hcover : ∀ x : Fin ${N}, ∃ A ∈ ${st.family}, x ∈ A := by`,
    `    intro x`,
    `    have hx : x ∈ ${cover.union} := by`,
    `      rw [${cover.reversed ? "← " : ""}${hyp(cover.index)}]`,
    `      exact Finset.mem_univ x`,
    `    simpa [Finset.mem_biUnion, Finset.mem_sup] using hx`,
    `  by_contra hgt`,
    `  have hF : ${st.M + 1} ≤ ${st.family}.card := by omega`,
    `  have hl_sub : (${SL}).Sublist (List.range ${n}) := List.filter_sublist`,
    `  have hl_pw : (${SL}).Pairwise (fun a b => (AL.getD a 0).testBit b = true) := by`,
    `    refine (List.Pairwise.filter _ List.pairwise_lt_range).imp_of_mem ?_`,
    `    intro i j hi hj hlt`,
    `    have hi' := List.mem_filter.mp hi`,
    `    have hj' := List.mem_filter.mp hj`,
    `    exact hadj i hi'.1 j hj'.1 hlt ${pairs.map((p) => p.arg).join(" ")}`,
    `  have hl_len : ${st.family}.card ≤ (${SL}).length := by`,
    `    have hsubset : ${st.family} ⊆ ((${SL}).map (fun i => SL.getD i ∅)).toFinset := by`,
    `      intro A hA`,
    `      obtain ⟨i, hi, rfl⟩ := hidx A ${single.map((s) => s.arg).join(" ")}`,
    `      exact List.mem_toFinset.mpr (List.mem_map.mpr ⟨i, List.mem_filter.mpr ⟨hi, decide_eq_true hA⟩, rfl⟩)`,
    `    exact (Finset.card_le_card hsubset).trans ((List.toFinset_card_le _).trans (by simp))`,
    `  have hl_cov : ((List.range ${N}).all fun x => ((${SL}).foldr (fun i a => CL.getD i 0 ||| a) 0).testBit x) = true := by`,
    `    rw [List.all_eq_true]`,
    `    intro x hx`,
    `    rw [clique_bits]`,
    `    obtain ⟨A, hA, hxA⟩ := hcover ⟨x, List.mem_range.mp hx⟩`,
    `    obtain ⟨i, hi, rfl⟩ := hidx A ${single.map((s) => s.arg).join(" ")}`,
    `    exact Bool.or_eq_true_iff.mpr (Or.inr (List.any_eq_true.mpr ⟨i, List.mem_filter.mpr ⟨hi, decide_eq_true hA⟩, hbit i hi _ hxA⟩))`,
    `  have hno := clique_search (fun v j => (AL.getD v 0).testBit j) (fun i => CL.getD i 0) ${N} _ (fun k c mask => rfl) ${n + 1} _ hrun ${root} (List.mem_singleton.mpr rfl) _ hl_sub hl_pw (hF.trans hl_len)`,
    `  exact absurd (hl_cov.symm.trans hno) (by decide)`,
  ].join("\n");
}
