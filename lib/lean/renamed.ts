/**
 * Lemma names models write from older Mathlib, and what to use instead.
 * Pure module (no I/O): used by premises.ts (hints) and modernize.ts (rewrites).
 */

/**
 * Mathlib / Lean names that were renamed or removed, as models trained on older Mathlib still
 * write them (checked against the sandbox's Mathlib v4.33.1). Old name → name to use now.
 */
export const RENAMED_LEMMAS: Record<string, string> = {
  "Real.sqrt_eq_iff_sq_eq": "Real.sqrt_eq_iff_eq_sq",
  "Real.pi_gt_314": "Real.pi_gt_d2",
  "Real.pi_lt_315": "Real.pi_lt_d2",
  "Real.sqrt_two_mul_self": "Real.mul_self_sqrt",
  mul_self_abs: "abs_mul_abs_self",
  "sq_eq_zero'": "sq_eq_zero_iff",
  abs_le_abs_of_sq_le_sq: "sq_le_sq",
  le_or_lt: "le_or_gt",
  lt_or_le: "lt_or_ge",
  "dvd_sub'": "dvd_sub",
  "Nat.dvd_sub'": "Nat.dvd_sub",
  "Nat.succ_mul_choose_eq": "Nat.add_one_mul_choose_eq",
  "Nat.prime_def_lt''": "Nat.prime_def",
  "Nat.sq_sub_sq'": "Nat.sq_sub_sq",
  "Nat.even_mul_self_pred": "Nat.even_mul_pred_self",
  "Nat.exists_mul_emod_eq_one_of_coprime": "Nat.exists_mul_mod_eq_one_of_coprime",
  "Even.pow": "Even.pow_of_ne_zero",
  "Finset.card_insert_of_not_mem": "Finset.card_insert_of_notMem",
  "Finset.filter_card_add_filter_neg_card_eq_card": "Finset.card_filter_add_card_filter_not",
  "Finset.eq_empty_iff_forall_not_mem": "Finset.eq_empty_iff_forall_notMem",
  "Finset.not_mem_empty": "Finset.notMem_empty",
  "Finset.inner_mul_le_norm_mul_norm": "Finset.sum_mul_sq_le_sq_mul_sq",
  "Set.mem_setOf_eq": "Set.mem_ofPred_eq",
  "Set.mem_setOf": "Set.mem_ofPred",
  "Set.mem_def": "Set.mem_ofPred",
  "Irrational.add_rat": "Irrational.add_ratCast",
  "ZMod.natCast_self_eq_zero": "ZMod.natCast_self",
  "ZMod.natCast_zmod_eq_zero_iff_dvd": "ZMod.natCast_eq_zero_iff",
};

/**
 * Old names whose replacement takes the same arguments and proves the same fact (up to the
 * orientation of an equation or ↔), so a proof can be rewritten without asking the model.
 */
const REWRITABLE = new Set(
  Object.keys(RENAMED_LEMMAS).filter(
    (n) => !["Real.sqrt_two_mul_self", "abs_le_abs_of_sq_le_sq", "Set.mem_def", "Finset.inner_mul_le_norm_mul_norm"].includes(n),
  ),
);

const ID_CHAR = "[A-Za-z0-9_'.!?\u2080-\u2089]";

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces old lemma names in proof text with their current names: the full name anywhere,
 * and for `Real.` lemmas also the bare name (used under `open Real`).
 */
export function renameOldLemmas(text: string): string {
  let out = text;
  for (const old of REWRITABLE) {
    const now = RENAMED_LEMMAS[old];
    out = out.replace(new RegExp(`(?<!${ID_CHAR})${escape(old)}(?!${ID_CHAR})`, "g"), now);
    if (old.startsWith("Real.")) {
      const tail = old.slice(5);
      out = out.replace(new RegExp(`(?<!${ID_CHAR})${escape(tail)}(?!${ID_CHAR})`, "g"), now.slice(5));
    }
  }
  return out;
}
