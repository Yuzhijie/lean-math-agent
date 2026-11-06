/**
 * The polynomial functional equation P(x²) = P(x)² over ℝ with one value P(c) = v (c ≥ 2,
 * v = cⁿ): P = Xⁿ. The proof: expand 2 P = P² as polynomials (Polynomial.funext); the largest
 * index m below the degree d with a nonzero coefficient would give coefficient 2·a_m·a_d ≠ 0 at
 * d + m in P², but expand 2 P has a_{(d+m)/2} = 0 there (d > (d+m)/2 > m) — so P = a·X^d;
 * a = a² at x = 1, a ≠ 0, so a = 1; c^d = v gives d = n.
 *
 * "P(x²) = P(x)², P(2) = 1024 ⇒ P = x¹⁰" had defeated every route (the model's proof ran out of
 * heartbeats). One finisher, several lines (search.ts indents them under the `·`).
 */
import { isInaccessible, type GoalState } from "../geometry/goal";

const ID = "[^\\s(),:\\[\\]{}|∀∃→]+";
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\']/g, "\\$&");

export interface PolySquareEq {
  poly: string;
  eqHyp: string;
  valueHyp: string;
  c: number;
  v: bigint;
  n: number;
}

export function polySquareEq(st: GoalState): PolySquareEq | undefined {
  const goal = new RegExp(`^(${ID}) = (?:Polynomial\\.)?X \\^ (\\d+)$`).exec(st.target.trim());
  if (!goal) return undefined;
  const P = goal[1];
  const n = Number(goal[2]);
  if (!st.hyps.some((h) => h.names.includes(P) && /^(Polynomial ℝ|ℝ\[X\])$/.test(h.type.trim()))) return undefined;
  const eP = esc(P);
  let eqHyp: string | undefined;
  let value: { hyp: string; c: number; v: bigint } | undefined;
  for (const h of st.hyps) {
    if (h.names.length !== 1 || isInaccessible(h.names[0])) continue;
    const ty = h.type.replace(/\s+/g, " ").trim();
    const fe = new RegExp(`^∀ \\(?(${ID})(?: : ℝ)?\\)?, (?:Polynomial\\.)?eval \\(\\1 \\^ 2\\) ${eP} = \\(?(?:Polynomial\\.)?eval \\1 ${eP}\\)? \\^ 2$`).exec(ty);
    if (fe) eqHyp = h.names[0];
    const ve = new RegExp(`^(?:Polynomial\\.)?eval (\\d+) ${eP} = (\\d+)$`).exec(ty);
    if (ve) value = { hyp: h.names[0], c: Number(ve[1]), v: BigInt(ve[2]) };
  }
  if (!eqHyp || !value || value.c < 2 || n > 200) return undefined;
  if (BigInt(value.c) ** BigInt(n) !== value.v) return undefined;
  return { poly: P, eqHyp, valueHyp: value.hyp, c: value.c, v: value.v, n };
}

export function polySquareScript(s: PolySquareEq): string {
  const { poly: P, eqHyp: H, valueHyp: V, c, v, n } = s;
  return `classical
have hpf_id : Polynomial.expand ℝ 2 ${P} = ${P} ^ 2 := by
  rw [Polynomial.expand_eq_comp_X_pow]
  apply Polynomial.funext
  intro x
  simp [Polynomial.eval_comp, ${H}]
have hpf_ne : ${P} ≠ 0 := by
  rintro rfl
  simp at ${V}
have hpf_c : ∀ i, (${P} ^ 2).coeff i = if 2 ∣ i then ${P}.coeff (i / 2) else 0 := by
  intro i
  rw [← hpf_id, Polynomial.coeff_expand (by norm_num)]
have hpf_hi : ∀ j, ${P}.natDegree < j → ${P}.coeff j = 0 := fun j hj => Polynomial.coeff_eq_zero_of_natDegree_lt hj
have hpf_lead : ${P}.coeff ${P}.natDegree ≠ 0 := Polynomial.leadingCoeff_ne_zero.mpr hpf_ne
have hpf_low : ∀ m, m < ${P}.natDegree → ${P}.coeff m = 0 := by
  by_contra hne
  push Not at hne
  let S := (Finset.range ${P}.natDegree).filter (fun j => ${P}.coeff j ≠ 0)
  have hS : S.Nonempty := by
    obtain ⟨m, hm, hmc⟩ := hne
    exact ⟨m, Finset.mem_filter.mpr ⟨Finset.mem_range.mpr hm, hmc⟩⟩
  obtain ⟨hmn, hmc⟩ := Finset.mem_filter.mp (Finset.max'_mem S hS)
  have hmn' := Finset.mem_range.mp hmn
  have hgap : ∀ j, S.max' hS < j → j < ${P}.natDegree → ${P}.coeff j = 0 := by
    intro j hj hjn
    by_contra hne'
    have hjS : j ∈ S := Finset.mem_filter.mpr ⟨Finset.mem_range.mpr hjn, hne'⟩
    have := Finset.le_max' S j hjS
    omega
  have hsq : (${P} ^ 2).coeff (${P}.natDegree + S.max' hS) = ${P}.coeff (S.max' hS) * ${P}.coeff ${P}.natDegree + ${P}.coeff ${P}.natDegree * ${P}.coeff (S.max' hS) := by
    rw [pow_two, Polynomial.coeff_mul]
    rw [Finset.sum_eq_add_of_mem (S.max' hS, ${P}.natDegree) (${P}.natDegree, S.max' hS) (by simp [add_comm]) (by simp) (by simp; omega)]
    rintro ⟨i, j⟩ hij ⟨h1, h2'⟩
    have hs : i + j = ${P}.natDegree + S.max' hS := Finset.HasAntidiagonal.mem_antidiagonal.mp hij
    by_cases hi : ${P}.natDegree < i
    · simp [hpf_hi i hi]
    by_cases hj : ${P}.natDegree < j
    · simp [hpf_hi j hj]
    have hi1 : S.max' hS < i := by
      by_contra hh
      apply h1
      ext <;> simp <;> omega
    have hi2 : i < ${P}.natDegree := by
      by_contra hh
      apply h2'
      ext <;> simp <;> omega
    simp [hgap i hi1 hi2]
  have hexp : (${P} ^ 2).coeff (${P}.natDegree + S.max' hS) = 0 := by
    rw [hpf_c]
    split_ifs with hd
    · obtain ⟨t, ht⟩ := hd
      rw [ht, Nat.mul_div_cancel_left t (by norm_num)]
      exact hgap t (by omega) (by omega)
    · rfl
  have h3 : ${P}.coeff (S.max' hS) * ${P}.coeff ${P}.natDegree = 0 := by
    have := hsq.symm.trans hexp
    linarith
  exact mul_ne_zero hmc hpf_lead h3
have hpf_form : ${P} = Polynomial.C (${P}.coeff ${P}.natDegree) * Polynomial.X ^ ${P}.natDegree := by
  ext i
  rw [Polynomial.coeff_C_mul_X_pow]
  split_ifs with hi
  · rw [hi]
  · rcases Nat.lt_or_gt_of_ne hi with h' | h'
    · exact hpf_low i h'
    · exact hpf_hi i h'
have hpf_a : ${P}.coeff ${P}.natDegree = 1 := by
  have h1 := ${H} 1
  rw [hpf_form] at h1
  simp at h1
  rw [Polynomial.coeff_natDegree]
  have hl : ${P}.leadingCoeff ≠ 0 := Polynomial.leadingCoeff_ne_zero.mpr hpf_ne
  have : ${P}.leadingCoeff * (${P}.leadingCoeff - 1) = 0 := by linear_combination -h1
  rcases mul_eq_zero.mp this with h0 | h0
  · exact absurd h0 hl
  · linarith
have hpf_n : ${P}.natDegree = ${n} := by
  have h4 := ${V}
  rw [hpf_form, hpf_a] at h4
  simp at h4
  have h5 : (${c} : ℕ) ^ ${P}.natDegree = ${v} := by exact_mod_cast h4
  rw [show (${v} : ℕ) = ${c} ^ ${n} by norm_num] at h5
  exact Nat.pow_right_injective (by norm_num : 2 ≤ ${c}) h5
rw [hpf_form, hpf_a, hpf_n]
simp`;
}

/** Names the script binds itself: a statement using one of them for P / its hypotheses is left alone. */
const SCRIPT_NAMES = new Set("x hne S hS m hm hmc hmn hmn' hgap j hj hjn hne' hjS hsq i h1 h2' hs hi hh hi1 hi2 hexp hd t ht h3 h' h0 hl h4 h5".split(" "));

export function polySquareFinishers(st: GoalState): string[] {
  const s = polySquareEq(st);
  if (!s || [s.poly, s.eqHyp, s.valueHyp].some((n) => SCRIPT_NAMES.has(n) || n.startsWith("hpf_"))) return [];
  return [polySquareScript(s)];
}
