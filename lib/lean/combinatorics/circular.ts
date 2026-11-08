/**
 * Seatings round a table up to rotation: `Set.ncard {O | ∃ s, Valid s ∧ O = Orbit s} = M` where
 * the arrangements are functions s : Fin n → Fin n (person ↦ seat), Valid s = Bijective s ∧ the
 * conditions, Rot k f i = f i + k and Orbit s = {t | Valid t ∧ ∃ k, t = Rot k s}.
 *
 * The rotations act freely, so every orbit holds exactly one arrangement with person 0 in seat 0:
 * the orbits are the image of S₀ = {s | Valid s ∧ s 0 = 0} (InjOn), S₀ ≃ the lists 0 :: p with p a
 * permutation of [1, …, n − 1] satisfying the conditions (s ↦ (List.ofFn s).tail), and that list
 * — `List.permutations'`, structural, so the kernel evaluates it — is counted by
 * `decide +kernel`. The conditions survive a rotation because each relation they use is
 * translation invariant (`∀ a b k, R (a + k) (b + k) ↔ R a b`, by decide over Fin n³).
 *
 * 8 students, A, B, C pairwise apart and D, E apart, up to rotation = 1152: enumerating the
 * functions Fin 8 → Fin 8 (8⁸) or the permutations (Equiv.Perm, out of memory) is beyond the kernel;
 * the 5040 lists are not. Only the conditions are decided per list (bijectivity follows from the
 * list being a permutation): about 15 s, where deciding Bijective too took 108 s and ran out of memory
 * beside the REPL.
 */
import { splitLets } from "./lets";

const ID = "[^\\s(),:\\[\\]{}|∀∃→]+";
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\']/g, "\\$&");

export interface CircularShape {
  n: number;
  total: number;
  valid: string;
  rot: string;
  orbit: string;
  /** two-argument relations the conditions use (each gets a translation lemma) */
  relations: string[];
  /** every let name, unfolded for the final count */
  names: string[];
  /** whether Valid has conditions after `Function.Bijective f ∧` */
  hasRest: boolean;
  /** Valid's binder and those conditions ("" when none) */
  binder: string;
  rest: string;
}

export function circularShape(theoremType: string): CircularShape | undefined {
  const sp = splitLets(theoremType);
  if (!sp) return undefined;
  const body = squash(sp.body);
  const b = new RegExp(`^Set\\.ncard \\{ ?(${ID})(?: : Set \\(Fin (\\d+) → Fin \\2\\))? \\| ∃ (${ID})(?: : Fin (\\d+) → Fin \\4)?, (${ID}) \\3 ∧ \\1 = (${ID}) \\3 ?\\} = (\\d+)$`).exec(body);
  if (!b) return undefined;
  const [, , n1, , n2, valid, orbit, total] = b;
  const def = (name: string) => sp.lets.find((l) => l.name === name);
  const ob = def(orbit);
  const vd = def(valid);
  if (!ob || !vd) return undefined;
  const o = new RegExp(`^fun (${ID}) => \\{ ?(${ID})(?: : Fin \\d+ → Fin \\d+)? \\| ${esc(valid)} \\2 ∧ ∃ (${ID})(?: : Fin (\\d+))?, \\2 = (${ID}) \\3 \\1 ?\\}$`).exec(squash(ob.value));
  if (!o) return undefined;
  const rot = o[5];
  const rd = def(rot);
  if (!rd) return undefined;
  const r = new RegExp(`^fun (${ID}) (${ID}) (${ID}) => \\2 \\3 \\+ \\1$`).exec(squash(rd.value));
  if (!r) return undefined;
  const n = Number(n1 ?? n2 ?? o[4] ?? /Fin (\d+)/.exec(vd.type ?? "")?.[1]);
  if (!Number.isFinite(n) || n < 3 || n > 9) return undefined;
  const v = new RegExp(`^fun (${ID}) => Function\\.Bijective \\1(?: ∧ (.+))?$`).exec(squash(vd.value));
  if (!v) return undefined;
  const rest = v[2] ?? "";
  // the other lets: relations of two seats, used by the conditions
  const relations: string[] = [];
  for (const l of sp.lets) {
    if ([valid, rot, orbit].includes(l.name)) continue;
    if (!new RegExp(`^fun (${ID}) (${ID}) =>`).test(squash(l.value))) return undefined;
    if (l.type && !/^Fin \d+ → Fin \d+ → Prop$/.test(squash(l.type))) return undefined;
    relations.push(l.name);
  }
  // the conditions may only compare seats through these relations or by (in)equality
  const stripped = relations.reduce((s, rel) => s.replace(new RegExp(`(^|[\\s(¬])${esc(rel)}(?=\\s)`, "g"), "$1"), rest);
  if (/[+\-*/<>≤≥%]/.test(stripped)) return undefined;
  return { n, total: Number(total), valid, rot, orbit, relations, names: sp.lets.map((l) => l.name), hasRest: !!v[2], binder: v[1], rest };
}

export function circularScript(c: CircularShape): string {
  const { n, valid: V, rot: R, orbit: O } = c;
  const F = `Fin ${n} → Fin ${n}`;
  const tailList = Array.from({ length: n - 1 }, (_, i) => i + 1).join(", ");
  const keys = c.relations.map((rel, i) => `have ckey${i} : ∀ a b k : Fin ${n}, ${rel} (a + k) (b + k) ↔ ${rel} a b := by simp only [${rel}]; decide`);
  const keyNames = c.relations.map((_, i) => `ckey${i}`);
  const inv = c.hasRest
    ? [
        `have cinv : ∀ k s, ${V} s → ${V} (${R} k s) := by`,
        `  intro k s hs`,
        `  simp only [${V}, ${R}] at hs ⊢`,
        `  obtain ⟨hb, hrest⟩ := hs`,
        `  exact ⟨(Equiv.addRight k).bijective.comp hb, by simpa only [${[...keyNames, "add_left_inj", "ne_eq"].join(", ")}] using hrest⟩`,
      ]
    : [`have cinv : ∀ k s, ${V} s → ${V} (${R} k s) := by`, `  intro k s hs`, `  exact (Equiv.addRight k).bijective.comp hs`];
  return [
    `intro ${c.names.join(" ")}`,
    ...keys,
    ...inv,
    `have cRR : ∀ a b s, ${R} a (${R} b s) = ${R} (b + a) s := by`,
    `  intro a b s; funext i; exact add_assoc _ _ _`,
    `have cR0 : ∀ s, ${R} 0 s = s := by intro s; funext i; exact add_zero _`,
    `have cset : {O : Set (${F}) | ∃ s : ${F}, ${V} s ∧ O = ${O} s} = ${O} '' {s | ${V} s ∧ s 0 = 0} := by`,
    `  ext O; constructor`,
    `  · rintro ⟨s, hs, rfl⟩`,
    `    refine ⟨${R} (-(s 0)) s, ⟨cinv _ _ hs, add_neg_cancel _⟩, ?_⟩`,
    `    ext t; simp only [${O}, Set.mem_ofPred_eq]; constructor`,
    `    · rintro ⟨ht, k, rfl⟩; exact ⟨ht, -(s 0) + k, by rw [cRR]⟩`,
    `    · rintro ⟨ht, k, rfl⟩; exact ⟨ht, s 0 + k, by rw [cRR, neg_add_cancel_left]⟩`,
    `  · rintro ⟨s, ⟨hs, _⟩, rfl⟩; exact ⟨s, hs, rfl⟩`,
    `have cinj : Set.InjOn ${O} {s | ${V} s ∧ s 0 = 0} := by`,
    `  rintro s ⟨hs, hs0⟩ t ⟨ht, ht0⟩ hst`,
    `  have hmem : t ∈ ${O} s := by rw [hst]; exact ⟨ht, 0, (cR0 t).symm⟩`,
    `  obtain ⟨_, k, hk⟩ := hmem`,
    `  have hk0 : k = 0 := by`,
    `    have h0 := congrFun hk 0`,
    `    simp only [${R}] at h0`,
    `    rw [hs0, ht0] at h0`,
    `    simpa using h0.symm`,
    `  rw [hk, hk0, cR0]`,
    `rw [cset, cinj.ncard_image]`,
    `let cF : List (Fin ${n}) → Fin ${n} → Fin ${n} := fun p i => ((0 : Fin ${n}) :: p).getD i 0`,
    // only the conditions are decided per list; bijectivity of cF p follows from p being a permutation
    `let cR : (${F}) → Prop := fun ${c.hasRest ? c.binder : "_"} => ${c.hasRest ? c.rest : "True"}`,
    `let cL := (([${tailList}] : List (Fin ${n})).permutations').filter (fun p => decide (cR (cF p)))`,
    `have cofFn : ∀ s : ${F}, s 0 = 0 → List.ofFn s = 0 :: (List.ofFn s).tail := by`,
    `  intro s hs0; rw [List.ofFn_succ, hs0]; rfl`,
    `have cG : Set.InjOn (fun s : ${F} => (List.ofFn s).tail) {s | ${V} s ∧ s 0 = 0} := by`,
    `  rintro s ⟨_, hs0⟩ t ⟨_, ht0⟩ hst`,
    `  simp only at hst`,
    `  apply List.ofFn_injective`,
    `  rw [cofFn s hs0, cofFn t ht0, hst]`,
    `have hnd : cL.Nodup := by`,
    `  apply List.Nodup.filter`,
    `  exact (List.permutations_perm_permutations' _).nodup_iff.mp (List.nodup_permutations _ (by decide))`,
    `have hid : List.ofFn (id : ${F}) = 0 :: [${tailList}] := by decide`,
    `have himg : (fun s : ${F} => (List.ofFn s).tail) '' {s | ${V} s ∧ s 0 = 0} = {p | p ∈ cL} := by`,
    `  ext p; simp only [Set.mem_image, Set.mem_ofPred_eq]; constructor`,
    `  · rintro ⟨s, ⟨hs, hs0⟩, rfl⟩`,
    `    have hF : cF (List.ofFn s).tail = s := by`,
    `      funext i; simp only [cF]; rw [← cofFn s hs0, List.getD_eq_getElem _ _ (by simp), List.getElem_ofFn]`,
    `    refine List.mem_filter.mpr ⟨List.mem_permutations'.mpr ?_, by rw [hF]; exact decide_eq_true ${c.hasRest ? "hs.2" : "trivial"}⟩`,
    `    have hp : (List.ofFn s).Perm (List.ofFn id) := Equiv.Perm.ofFn_comp_perm (Equiv.ofBijective s ${c.hasRest ? "hs.1" : "hs"}) id`,
    `    rw [cofFn s hs0, hid] at hp`,
    `    exact hp.cons_inv`,
    `  · intro hp`,
    `    obtain ⟨hperm, hval⟩ := List.mem_filter.mp hp`,
    `    have hlen : p.length = ${n - 1} := (List.mem_permutations'.mp hperm).length_eq`,
    `    have hnd0 : ((0 : Fin ${n}) :: p).Nodup := ((List.mem_permutations'.mp hperm).cons 0).nodup_iff.mpr (by decide)`,
    `    have hinjF : Function.Injective (cF p) := by`,
    `      intro i j hij`,
    `      simp only [cF] at hij`,
    `      rw [List.getD_eq_getElem _ _ (by simp [hlen]), List.getD_eq_getElem _ _ (by simp [hlen])] at hij`,
    `      exact Fin.ext (hnd0.getElem_inj_iff.mp hij)`,
    `    have hbij : Function.Bijective (cF p) := Finite.injective_iff_bijective.mp hinjF`,
    `    refine ⟨cF p, ⟨${c.hasRest ? "⟨hbij, of_decide_eq_true hval⟩" : "hbij"}, rfl⟩, ?_⟩`,
    `    have hl : List.ofFn (cF p) = 0 :: p := by`,
    `      apply List.ext_getElem (by simp [hlen])`,
    `      intro i h1 h2`,
    `      simp only [List.getElem_ofFn, cF]`,
    `      rw [List.getD_eq_getElem _ _ h2]`,
    `    simp only [hl, List.tail_cons]`,
    `rw [← cG.ncard_image, himg, show {p | p ∈ cL} = (cL.toFinset : Set (List (Fin ${n}))) by ext; simp, Set.ncard_coe_finset, List.toFinset_card_of_nodup hnd]`,
    `simp only [${["cL", "cF", "cR", ...c.relations].join(", ")}]`,
    `decide +kernel`,
  ].join("\n");
}
