/**
 * Oddtown: a family of subsets of an n-element set U in which every member has odd size and any two
 * different members meet in an even number of elements has at most n members (the singletons
 * reach it). The proof is linear algebra over 𝔽₂ — the members' indicator vectors in U → ZMod 2
 * have the identity as Gram matrix, so they are linearly independent and there are at most
 * dim = |U| of them — which no search finds, and the colouring route (family.ts) needs a concrete
 * ground set of at most 7 elements: "[n] = {1, …, n}, n arbitrary" had failed every route.
 *
 * The program writes the lemma once (`oddtown_bound`, over any type with decidable equality, as a
 * `have` in the proof), then works through the statement's goals in tactic mode, whatever shape
 * it has (IsGreatest, `M ∈ upperBounds`, `∀ F, … → F.card ≤ M`, a conjunction with "this family is
 * valid and has M members", conditions behind lets, `Odd`/`Even` or `% 2`):
 *  - a bound: the family's facts read from the hypotheses (aesop), the lemma, |U| = M, omega;
 *  - a witness: the singletons of U;
 *  - the singletons' facts: sizes 1, pairwise intersections empty, |{{i} | i ∈ U}| = |U|.
 */
import { parseGoal } from "../geometry/goal";
import type { TacticRunner } from "../tactic-runner";
import { introAll } from "../combinatorics/finite";
import { splitLets, topIndex } from "../combinatorics/lets";

/** The lemma, as one tactic (a `have` with its proof). Checked in Lean (Mathlib v4.33.1). */
export const ODDTOWN_LEMMA = `have oddtown_bound : ∀ {α : Type} [DecidableEq α] (U : Finset α) (F : Finset (Finset α)),
    (∀ A ∈ F, A ⊆ U) → (∀ A ∈ F, Odd A.card) → (∀ A ∈ F, ∀ B ∈ F, A ≠ B → Even (A ∩ B).card) → F.card ≤ U.card := by
  intro α _ U F hsub hodd heven
  classical
  let v : Finset α → (U → ZMod 2) := fun A x => if (x : α) ∈ A then 1 else 0
  have hdot : ∀ A B, A ⊆ U → B ⊆ U → (∑ x : U, v A x * v B x) = ((A ∩ B).card : ZMod 2) := by
    intro A B hA hB
    have : ∀ x : U, v A x * v B x = if (x : α) ∈ A ∩ B then 1 else 0 := by
      intro x; simp only [v, Finset.mem_inter]; split_ifs <;> simp_all
    simp only [this]
    rw [Finset.sum_coe_sort U (fun x => if x ∈ A ∩ B then (1 : ZMod 2) else 0), Finset.sum_boole,
      Finset.filter_mem_eq_inter, Finset.inter_eq_right.mpr (Finset.inter_subset_left.trans hA)]
  have hli : LinearIndependent (ZMod 2) (fun A : F => v A) := by
    rw [Fintype.linearIndependent_iff]
    intro g hg i
    have h1 := congrArg (fun w : U → ZMod 2 => ∑ x : U, w x * v i x) hg
    simp only [Finset.sum_apply, Pi.smul_apply, smul_eq_mul, Pi.zero_apply, zero_mul,
      Finset.sum_const_zero, Finset.sum_mul] at h1
    rw [Finset.sum_comm] at h1
    simp only [mul_assoc, ← Finset.mul_sum] at h1
    rw [Finset.sum_eq_single i] at h1
    · rw [hdot _ _ (hsub _ i.2) (hsub _ i.2), Finset.inter_self,
        ZMod.natCast_eq_one_iff_odd.mpr (hodd _ i.2), mul_one] at h1
      exact h1
    · intro j _ hji
      rw [hdot _ _ (hsub _ j.2) (hsub _ i.2),
        ZMod.natCast_eq_zero_iff_even.mpr (heven _ j.2 _ i.2 (fun h => hji (Subtype.ext h))), mul_zero]
    · intro h; exact absurd (Finset.mem_univ i) h
  have := hli.fintype_card_le_finrank
  simpa [Module.finrank_fintype_fun_eq_card] using this`;

const NAME = "[A-Za-z_][\\w'₀-₉]*";

export interface OddtownShape {
  /** the ground set as written (a let's name, an expression, or `Finset.univ` for `Finset (Fin k)` members) */
  domain: string;
  /** a let that is the ground set (kept folded: the facts are stated with it) */
  domainLet?: string;
  /** the statement's lets, in order */
  lets: string[];
}

/**
 * Whether the statement says "members of odd size, pairwise even intersections, the largest such
 * family" over subsets of some set. Sizes may be written `Odd A.card` / `A.card % 2 = 1`, the
 * intersections `Even (A ∩ B).card` / `(A ∩ B).card % 2 = 0`.
 */
export function oddtownShape(theoremType: string): OddtownShape | undefined {
  const t = theoremType.replace(/\s+/g, " ");
  if (!/\b(IsGreatest|upperBounds)\b|\.card ≤/.test(t)) return undefined;
  if (!/Finset \(Finset /.test(t)) return undefined;
  const odd = new RegExp(`Odd (?:\\(?${NAME}\\.card\\)?|\\(?Finset\\.card ${NAME}\\)?)|${NAME}\\.card % 2 = 1`).test(t);
  const even = new RegExp(`Even \\(?\\(?${NAME} ∩ ${NAME}\\)\\.card\\)?|\\(${NAME} ∩ ${NAME}\\)\\.card % 2 = 0|Even \\(Finset\\.card \\(${NAME} ∩ ${NAME}\\)\\)`).test(t);
  if (!odd || !even) return undefined;
  const lets = splitLets(t)?.lets.map((l) => l.name) ?? [...t.matchAll(new RegExp(`(?:^|[:;] )let (${NAME})`, "g"))].map((m) => m[1]);
  const sub = new RegExp(`∀ (${NAME}) ∈ ${NAME}, \\(?\\1 ⊆ ([^∧∀,()]+?|\\([^()]*\\))\\s*(?:∧|\\)|,|$)`).exec(t);
  if (sub) {
    const domain = sub[2].trim();
    return { domain, domainLet: lets.includes(domain) ? domain : undefined, lets };
  }
  const fin = /Finset \(Finset \(Fin (\d+)\)\)/.exec(t);
  if (fin) return { domain: `(Finset.univ : Finset (Fin ${fin[1]}))`, lets };
  return undefined;
}

const MAX_STEPS = 40;

/** Closes the goal with the first tactic that does (and leaves no new goal behind). */
async function closeWith(run: TacticRunner, tactics: string[]): Promise<boolean> {
  const before = run.goals().length;
  for (const t of tactics) {
    const mark = run.save();
    if ((await run.apply(t)) && run.goals().length < before) return true;
    run.restore(mark);
  }
  return false;
}

/**
 * Prove the statement (already opened in `run`) with the Oddtown lemma; true when no goal is left.
 * On failure the runner is left wherever it stopped (the caller restores its own mark).
 */
export async function oddtownProof(run: TacticRunner, shape: OddtownShape): Promise<{ ok: boolean; reason: string }> {
  if (!(await run.apply(ODDTOWN_LEMMA))) return { ok: false, reason: `the Oddtown lemma did not check: ${run.lastError().split("\n")[0]}` };
  const lets = await introAll(run);
  const unfold = lets.filter((l) => l !== shape.domainLet);
  const dom = shape.domain.startsWith("(") ? shape.domain : `(${shape.domain})`;
  const simpLets = unfold.length ? `try simp only [${unfold.join(", ")}] at *` : "skip";
  const oddEven = "Nat.odd_iff, Nat.even_iff";
  const cardDom = [...(lets.length ? [`simp [${lets.join(", ")}]`] : []), "simp", "rfl", "decide", "norm_num"].map((t) => `(${t})`).join(" | ");
  // aesop leaves its goals behind with only a warning when it fails: `terminal` makes it an error, so `first` goes on
  const aesop = "aesop (config := { terminal := true })";
  const aesopP = `aesop (add norm simp [${oddEven}]) (config := { terminal := true })`;
  const facts = (F: string) => [
    `have hsub : ∀ A ∈ ${F}, A ⊆ ${dom} := by first | (intro A _; exact Finset.subset_univ A) | ${aesop} | (simp_all [${oddEven}]; done)`,
    `have hodd : ∀ A ∈ ${F}, Odd A.card := by first | ${aesop} | (intro A hA; exact Nat.odd_iff.mpr (by ${aesop})) | ${aesopP}`,
    `have heven : ∀ A ∈ ${F}, ∀ B ∈ ${F}, A ≠ B → Even (A ∩ B).card := by first | ${aesop} | (intro A hA B hB hAB; exact Nat.even_iff.mpr (by ${aesop})) | ${aesopP}`,
    `have hbound := oddtown_bound ${dom} ${F} hsub hodd heven`,
  ];
  /** after the family F and its facts are in the context: the bound itself */
  const bound = async (F: string): Promise<boolean> => {
    await run.apply("try casesm* _ ∧ _");
    await run.apply(simpLets);
    await run.apply("try casesm* _ ∧ _");
    for (const f of facts(F)) if (!(await run.apply(f))) return false;
    const L = lets.length ? ` [${lets.join(", ")}]` : "";
    return closeWith(run, ["omega", `(simp${L} at hbound; omega)`, `(simp${L} at hbound ⊢; omega)`, `(simp at hbound; omega)`, "exact hbound", `simpa${L} using hbound`]);
  };
  const singletons = `Finset.image (fun i => ({i} : Finset _)) ${dom}`;
  const leaf = [
    // a member of the singletons: size 1 (odd), inside the ground set
    `(intro A hA; obtain ⟨i, hi, rfl⟩ := Finset.mem_image.mp hA; simp [hi])`,
    `(intro A hA; obtain ⟨i, hi, rfl⟩ := Finset.mem_image.mp hA; simp_all [${oddEven}])`,
    // two different singletons meet in nothing
    `(intro A hA B hB hAB; obtain ⟨i, hi, rfl⟩ := Finset.mem_image.mp hA; obtain ⟨j, hj, rfl⟩ := Finset.mem_image.mp hB; have hij : i ≠ j := fun h => hAB (h ▸ rfl); rw [Finset.singleton_inter_of_notMem (by simpa using hij)]; simp)`,
    // as many singletons as elements
    `(rw [Finset.card_image_of_injective _ Finset.singleton_injective]; first | ${cardDom})`,
    `(simp only [${lets.length ? `${lets.join(", ")}, ` : ""}Finset.card_image_of_injective _ Finset.singleton_injective]; first | ${cardDom})`,
    "simp",
    "decide",
    "rfl",
  ];
  for (let step = 0; step < MAX_STEPS && run.goals().length; step++) {
    const g = parseGoal(run.goals()[0]);
    if (!g) return { ok: false, reason: "a goal could not be read" };
    const target = g.target.replace(/\s+/g, " ").trim();
    if (/^IsGreatest\b/.test(target) || (topIndex(target, "∧") >= 0 && !/^(∀|∃)/.test(target))) {
      if (!(await run.apply("refine ⟨?_, ?_⟩"))) return { ok: false, reason: `could not split: ${target.slice(0, 120)}` };
      continue;
    }
    if (/∈ upperBounds/.test(target)) {
      if (!(await run.apply("intro t ht")) || !(await run.apply("simp only [Set.mem_setOf_eq] at ht")) || !(await run.apply("obtain ⟨Fam, hFam⟩ := ht"))) return { ok: false, reason: "could not open the bound" };
      if (!(await bound("Fam"))) return { ok: false, reason: `the bound did not close: ${run.lastError().split("\n")[0]}` };
      continue;
    }
    const all = new RegExp(`^∀ \\(?(${NAME})(?: : Finset \\(Finset [^)]*\\)\\)?)?,`).exec(target);
    if (all && /\.card ≤/.test(target)) {
      if (!(await run.apply(`intro ${all[1]}`))) return { ok: false, reason: "could not open the bound" };
      while (topIndex((parseGoal(run.goals()[0])?.target ?? "").replace(/\s+/g, " "), "→") >= 0) if (!(await run.apply(`intro ${run.fresh("h")}`))) break;
      if (!(await bound(all[1]))) return { ok: false, reason: `the bound did not close: ${run.lastError().split("\n")[0]}` };
      continue;
    }
    if (/^∃|∈ \{/.test(target)) {
      await run.apply("try simp only [Set.mem_setOf_eq]");
      if (!(await run.apply(`refine ⟨${singletons}, ?_⟩`))) return { ok: false, reason: `the singletons are no witness: ${run.lastError().split("\n")[0]}` };
      continue;
    }
    // a fact of the witness, possibly behind lets
    if (unfold.length) await run.apply(`try simp only [${unfold.join(", ")}]`);
    const after = parseGoal(run.goals()[0])?.target.replace(/\s+/g, " ").trim() ?? "";
    if (topIndex(after, "∧") >= 0 && !/^(∀|∃)/.test(after)) continue;
    if (!(await closeWith(run, leaf))) return { ok: false, reason: `a goal did not close: ${after.slice(0, 160)}` };
  }
  return run.goals().length ? { ok: false, reason: "goals left" } : { ok: true, reason: "" };
}
