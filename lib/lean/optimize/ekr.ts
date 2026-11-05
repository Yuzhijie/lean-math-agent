/**
 * Erdős–Ko–Rado: the largest family of k-element subsets of an n-element set in which any two
 * members meet has C(n − 1, k − 1) members when 2k ≤ n. A statement of that shape
 * (`IsGreatest {t | ∃ F : Finset (Finset ℕ), (∀ A ∈ F, A ⊆ D ∧ A.card = k) ∧ (∀ A ∈ F, ∀ B ∈ F,
 * A ≠ B → (A ∩ B).Nonempty) ∧ t = F.card} M`, conditions written in any of the usual ways) is
 * proved through Mathlib's `Finset.erdos_ko_rado`, which is stated for `Fin n`: the family is moved
 * there by the rank of each element in D (injective on D, checked by the kernel). The witness is
 * the star: every k-set through D's least element.
 *
 * The ground sets are far too big for the colouring route (10 points: 1024 subsets), and the
 * usual proof (Katona's cycle) is out of reach of the generic search; a model once called a
 * lemma `erdos_ko_rado_10` that does not exist.
 */
import type { FamilyStatement } from "./family";

export interface EkrShape {
  /** k: the members' size, from a unary condition `A.card = k` */
  k: number;
  /** the conjunct (index) and projection that gives `A ⊆ D` / `A.card = k` from `hc A hA` */
  sizeItem: number;
  /** pairwise condition index */
  pairItem: number;
}

const CARD = (v: string) => new RegExp(`(?:^|∧ )(?:${v}\\.card|Finset\\.card ${v}|#${v}) = (\\d+)(?: ∧|$)`);
const INTERSECTING = (a: string, b: string) => {
  const ab = `\\(${a} ∩ ${b}\\)`;
  const forms = [
    `${ab}\\.Nonempty`,
    `Finset\\.Nonempty ${ab}`,
    `${a} ∩ ${b} ≠ ∅`,
    `¬ ?Disjoint ${a} ${b}`,
    `0 < ${ab}\\.card`,
    `${ab}\\.card ≠ 0`,
    `1 ≤ ${ab}\\.card`,
    `${ab}\\.card ≥ 1`,
    `${ab}\\.card > 0`,
  ];
  return new RegExp(`^(?:${a} ≠ ${b} → )?(?:${forms.join("|")})$`);
};

/** Whether a parsed family statement says "k-sets of D, any two meet" (and nothing else). */
export function ekrShape(st: FamilyStatement): EkrShape | undefined {
  if (st.memberType !== "Finset ℕ" || st.pairwise.length !== 1) return undefined;
  const p = st.pairwise[0];
  if (!INTERSECTING(p.a, p.b).test(p.body.trim())) return undefined;
  let k: number | undefined;
  let sizeItem = -1;
  for (const u of st.unary) {
    // the only unary facts allowed: A ⊆ D (the domain) and A.card = k
    const parts = u.body.split(/ ∧ /).map((s) => s.trim().replace(/^\((.*)\)$/, "$1"));
    for (const part of parts) {
      const c = CARD(u.v).exec(part);
      if (c) {
        k = Number(c[1]);
        sizeItem = u.index;
      } else if (!new RegExp(`^${u.v} ⊆ `).test(part)) return undefined;
    }
  }
  if (k === undefined || k < 1) return undefined;
  return { k, sizeItem, pairItem: p.index };
}

/** `#eval` listing the ground set (sorted). */
export function groundEvalCommand(st: FamilyStatement): string {
  const lets = st.lets.map((l) => `  let ${l.name}${l.type ? ` : ${l.type}` : ""} := ${l.value}`);
  return ["#eval Id.run do", ...lets, `  return ((${st.domain}).sort (· ≤ ·))`].join("\n");
}

export function readGround(output: string): number[] | undefined {
  const m = /\[([\d,\s]*)\]/.exec(output);
  if (!m) return undefined;
  return m[1].trim() ? m[1].split(",").map((x) => Number(x.trim())) : [];
}

export function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

/** Tactics that give `hc A hA`'s part: the whole fact or any projection of a conjunction of up to 3. */
const PROJ = ["", ".1", ".2", ".2.1", ".2.2", ".1.1", ".1.2"];
const fromItem = (h: string, args: string) => `first ${PROJ.map((p) => `| exact (${h} ${args})${p}`).join(" ")}`;

/** The whole script, or a reason when the numbers do not fit the theorem (with a counterexample when M is too small). */
export function ekrScript(st: FamilyStatement, shape: EkrShape, ground: number[]): { tactics?: string; reason: string; counterexample?: string } {
  const n = ground.length;
  const { k } = shape;
  if (2 * k > n) return { reason: `k = ${k} > n / 2 = ${n}/2: any two ${k}-sets meet, not the Erdős–Ko–Rado case` };
  const best = choose(n - 1, k - 1);
  const a = ground[0];
  if (best > st.M) {
    return {
      reason: `the ${best} sets of size ${k} containing ${a} pairwise meet`,
      counterexample: `${best} > ${st.M}: every ${k}-subset containing ${a}`,
    };
  }
  if (best < st.M) return { reason: `the largest such family has C(${n - 1}, ${k - 1}) = ${best} members, not ${st.M}` };
  const D = `(${st.domain})`;
  const hyp = (i: number) => `hc${i}`;
  const p = st.pairwise[0];
  const pairBody = [
    `first`,
    `          | exact h hAB`,
    `          | exact h`,
    `          | exact Finset.nonempty_iff_ne_empty.mpr (h hAB)`,
    `          | exact Finset.nonempty_iff_ne_empty.mpr h`,
    `          | exact Finset.not_disjoint_iff_nonempty_inter.mp (h hAB)`,
    `          | exact Finset.not_disjoint_iff_nonempty_inter.mp h`,
    `          | exact Finset.card_pos.mp (Nat.pos_of_ne_zero (h hAB))`,
    `          | exact Finset.card_pos.mp (Nat.pos_of_ne_zero h)`,
    `          | exact Finset.card_pos.mp (h hAB)`,
    `          | exact Finset.card_pos.mp h`,
  ].join("\n");
  const witnessPair = [
    `first`,
    `        | exact fun _ => ⟨${a}, hx⟩`,
    `        | exact ⟨${a}, hx⟩`,
    `        | exact fun _ => Finset.nonempty_iff_ne_empty.mp ⟨${a}, hx⟩`,
    `        | exact Finset.nonempty_iff_ne_empty.mp ⟨${a}, hx⟩`,
    `        | exact fun _ => Finset.not_disjoint_iff_nonempty_inter.mpr ⟨${a}, hx⟩`,
    `        | exact Finset.not_disjoint_iff_nonempty_inter.mpr ⟨${a}, hx⟩`,
    `        | exact fun _ => Finset.card_pos.mpr ⟨${a}, hx⟩`,
    `        | exact Finset.card_pos.mpr ⟨${a}, hx⟩`,
    `        | exact fun _ => (Finset.card_pos.mpr ⟨${a}, hx⟩).ne'`,
    `        | exact (Finset.card_pos.mpr ⟨${a}, hx⟩).ne'`,
  ].join("\n");
  const unaryWitness = (index: number) => {
    void index;
    return [`  · intro A hA`, `    obtain ⟨h1, h2, _⟩ := hW A hA`, `    first | exact ⟨h1, h2⟩ | exact ⟨h2, h1⟩ | exact h1 | exact h2`];
  };
  const witnessGoals: string[] = [];
  for (let i = 0; i < st.items; i++) {
    if (i === p.index) {
      witnessGoals.push(
        `  · intro A hA B hB`,
        `    have hx : (${a} : ℕ) ∈ A ∩ B := Finset.mem_inter.mpr ⟨(hW A hA).2.2, (hW B hB).2.2⟩`,
        `    ${witnessPair.replace(/\n {8}/g, "\n      ")}`,
      );
    } else witnessGoals.push(...unaryWitness(i));
  }
  witnessGoals.push(`  · first | (rw [hWcard]; rfl) | (rw [hWcard]; decide) | (rw [hWcard]; norm_num [Nat.choose]) | (rw [eq_comm, hWcard]; rfl) | (rw [eq_comm, hWcard]; norm_num [Nat.choose])`);
  return {
    reason: "",
    tactics: [
      ...(st.lets.length ? [`intro ${st.lets.map((l) => l.name).join(" ")}`] : []),
      // the ground set's rank: an injection into Fin n
      `let e : ℕ → Fin ${n} := fun x => ⟨(${D}.filter (· < x)).card % ${n}, Nat.mod_lt _ (by norm_num)⟩`,
      `have hinj : ∀ x ∈ ${D}, ∀ y ∈ ${D}, e x = e y → x = y := by decide +kernel`,
      `have ha : (${a} : ℕ) ∈ ${D} := by decide +kernel`,
      `have hDcard : ${D}.card = ${n} := by decide +kernel`,
      // the star: every k-set through a
      `let W : Finset (Finset ℕ) := (${D}.erase ${a}).powersetCard ${k - 1} |>.image (insert ${a})`,
      `have hW : ∀ A ∈ W, A ⊆ ${D} ∧ A.card = ${k} ∧ (${a} : ℕ) ∈ A := by`,
      `  intro A hA`,
      `  obtain ⟨S, hS, rfl⟩ := Finset.mem_image.mp hA`,
      `  rw [Finset.mem_powersetCard] at hS`,
      `  have haS : (${a} : ℕ) ∉ S := fun h => by simpa using hS.1 h`,
      `  refine ⟨Finset.insert_subset ha (hS.1.trans (Finset.erase_subset _ _)), ?_, Finset.mem_insert_self _ _⟩`,
      `  rw [Finset.card_insert_of_notMem haS, hS.2]`,
      `have hWcard : W.card = Nat.choose ${n - 1} ${k - 1} := by`,
      `  rw [Finset.card_image_of_injOn, Finset.card_powersetCard, Finset.card_erase_of_mem ha, hDcard]`,
      `  intro S hS T hT h`,
      `  have haS : (${a} : ℕ) ∉ S := fun h => by simpa using (Finset.mem_powersetCard.mp hS).1 h`,
      `  have haT : (${a} : ℕ) ∉ T := fun h => by simpa using (Finset.mem_powersetCard.mp hT).1 h`,
      `  rw [← Finset.erase_insert haS, ← Finset.erase_insert haT]`,
      `  exact congrArg (fun s => Finset.erase s ${a}) h`,
      `refine ⟨⟨W, ?_⟩, ?_⟩`,
      `· refine ⟨${Array.from({ length: st.items + 1 }, () => "?_").join(", ")}⟩`,
      ...witnessGoals,
      `· rintro t ⟨F, ${Array.from({ length: st.items }, (_, i) => hyp(i)).join(", ")}, rfl⟩`,
      `  have hdom : ∀ A ∈ F, A ⊆ ${D} := fun A hA => by`,
      `    ${fromItem(hyp(st.domainItem.index), "A hA")}`,
      `  have hsize : ∀ A ∈ F, A.card = ${k} := fun A hA => by`,
      `    ${fromItem(hyp(shape.sizeItem), "A hA")}`,
      `  have hint : ∀ A ∈ F, ∀ B ∈ F, (A ∩ B).Nonempty := by`,
      `    intro A hA B hB`,
      `    by_cases hAB : A = B`,
      `    · subst hAB`,
      `      rw [Finset.inter_self, ← Finset.card_pos, hsize A hA]`,
      `      norm_num`,
      `    · have h := ${hyp(p.index)} A hA B hB`,
      `      ${pairBody.replace(/\n {10}/g, "\n        ")}`,
      `  have hinjF : Set.InjOn (fun A => A.image e) (F : Set (Finset ℕ)) := by`,
      `    have key : ∀ A ∈ F, ∀ B ∈ F, A.image e = B.image e → A ⊆ B := by`,
      `      intro A hA B hB h x hx`,
      `      have : e x ∈ B.image e := h ▸ Finset.mem_image_of_mem e hx`,
      `      obtain ⟨y, hy, hyx⟩ := Finset.mem_image.mp this`,
      `      rwa [hinj y (hdom B hB hy) x (hdom A hA hx) hyx] at hy`,
      `    intro A hA B hB h`,
      `    exact Finset.Subset.antisymm (key A hA B hB h) (key B hB A hA h.symm)`,
      `  have hcard : F.card = (F.image (fun A => A.image e)).card := (Finset.card_image_of_injOn hinjF).symm`,
      `  have hsized : ((F.image (fun A => A.image e) : Finset (Finset (Fin ${n}))) : Set (Finset (Fin ${n}))).Sized ${k} := by`,
      `    intro s hs`,
      `    obtain ⟨A, hA, rfl⟩ := Finset.mem_image.mp hs`,
      `    rw [Finset.card_image_of_injOn (fun x hx y hy h => hinj x (hdom A hA hx) y (hdom A hA hy) h), hsize A hA]`,
      `  have hinter : ((F.image (fun A => A.image e) : Finset (Finset (Fin ${n}))) : Set (Finset (Fin ${n}))).Intersecting := by`,
      `    intro s hs r hr hdis`,
      `    obtain ⟨A, hA, rfl⟩ := Finset.mem_image.mp hs`,
      `    obtain ⟨B, hB, rfl⟩ := Finset.mem_image.mp hr`,
      `    obtain ⟨x, hx⟩ := hint A hA B hB`,
      `    rw [Finset.mem_inter] at hx`,
      `    exact Finset.disjoint_left.mp hdis (Finset.mem_image_of_mem e hx.1) (Finset.mem_image_of_mem e hx.2)`,
      `  rw [hcard]`,
      `  exact (Finset.erdos_ko_rado hinter hsized (by norm_num)).trans (by norm_num [Nat.choose])`,
    ].join("\n"),
  };
}
