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
 * Also the other reading, s seat ↦ person with Rot k f i = f (i + k) and every condition `∀ i : Fin n, …`
 * over seats (Adj i = i + 1): there a rotation shifts i, and the representative turns person 0 to
 * seat 0 (seatHead).
 *
 * 8 students, A, B, C pairwise apart and D, E apart, up to rotation = 1152: enumerating the
 * functions Fin 8 → Fin 8 (8⁸) or the permutations (Equiv.Perm, out of memory) is beyond the kernel;
 * the 5040 lists are not. Only the conditions are decided per list (bijectivity follows from the
 * list being a permutation): about 15 s, where deciding Bijective too took 108 s and ran out of memory
 * beside the REPL.
 */
import { splitLets, topIndex } from "./lets";

const ID = "[^\\s(),:\\[\\]{}|∀∃→]+";
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\']/g, "\\$&");

export interface CircularShape {
  n: number;
  /** "value": s person ↦ seat, Rot k f i = f i + k; "seat": s seat ↦ person, Rot k f i = f (i + k) */
  mode: "value" | "seat";
  /** helper lets (relations, seat maps such as Adj i = i + 1) */
  helpers: string[];
  /** seat mode: the number of conditions, each `∀ i : Fin n, …` */
  conds: number;
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
  const rv = squash(rd.value);
  const r = new RegExp(`^fun (${ID}) (${ID}) (${ID}) => \\2 \\3 \\+ \\1$`).exec(rv);
  const rs = new RegExp(`^fun (${ID}) (${ID}) (${ID}) => \\2 \\(\\3 \\+ \\1\\)$`).exec(rv);
  if (!r && !rs) return undefined;
  const mode = r ? "value" : "seat";
  const n = Number(n1 ?? n2 ?? o[4] ?? /Fin (\d+)/.exec(vd.type ?? "")?.[1]);
  if (!Number.isFinite(n) || n < 3 || n > 9) return undefined;
  const v = new RegExp(`^fun (${ID}) => Function\\.Bijective \\1(?: ∧ (.+))?$`).exec(squash(vd.value));
  if (!v) return undefined;
  const rest = v[2] ?? "";
  const helpers = sp.lets.filter((l) => ![valid, rot, orbit].includes(l.name));
  const names = sp.lets.map((l) => l.name);
  const base = { n, total: Number(total), mode, valid, rot, orbit, names, hasRest: !!v[2], binder: v[1], rest } as const;
  if (mode === "seat") {
    // the person at each seat: every condition is `∀ i : Fin n, …` (rotations shift i), helpers are
    // relations of two people or seat maps `fun i => i + c`
    for (const l of helpers) {
      const val = squash(l.value);
      if (!new RegExp(`^fun (${ID}) (${ID}) =>`).test(val) && !new RegExp(`^fun (${ID}) => \\1 \\+ \\d+$`).test(val)) return undefined;
    }
    const conds = rest ? splitTop(rest) : [];
    if (!conds.every((c) => new RegExp(`^∀ ${ID}(?: : Fin ${n})?,`).test(stripOuter(c)))) return undefined;
    return { ...base, helpers: helpers.map((l) => l.name), conds: conds.length, relations: [] };
  }
  // the other lets: relations of two seats, used by the conditions
  const relations: string[] = [];
  for (const l of helpers) {
    if (!new RegExp(`^fun (${ID}) (${ID}) =>`).test(squash(l.value))) return undefined;
    if (l.type && !/^Fin \d+ → Fin \d+ → Prop$/.test(squash(l.type))) return undefined;
    relations.push(l.name);
  }
  // the conditions may only compare seats through these relations or by (in)equality
  const stripped = relations.reduce((s, rel) => s.replace(new RegExp(`(^|[\\s(¬])${esc(rel)}(?=\\s)`, "g"), "$1"), rest);
  if (/[+\-*/<>≤≥%]/.test(stripped)) return undefined;
  return { ...base, helpers: relations, conds: 0, relations };
}

/** `(X)` → X when the parentheses enclose the whole text. */
function stripOuter(t: string): string {
  t = t.trim();
  while (t.startsWith("(") && t.endsWith(")")) {
    let depth = 0;
    let whole = true;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === "(") depth++;
      else if (t[i] === ")" && --depth === 0 && i < t.length - 1) {
        whole = false;
        break;
      }
    }
    if (!whole) break;
    t = t.slice(1, -1).trim();
  }
  return t;
}

function splitTop(t: string): string[] {
  const out: string[] = [];
  let rest = stripOuter(t);
  for (let i = topIndex(rest, " ∧ "); i >= 0; i = topIndex(rest, " ∧ ")) {
    out.push(rest.slice(0, i).trim());
    rest = rest.slice(i + 3).trim();
  }
  out.push(rest);
  return out;
}

export function circularScript(c: CircularShape): string {
  const { n, valid: V, rot: R, orbit: O } = c;
  const F = `Fin ${n} → Fin ${n}`;
  const tailList = Array.from({ length: n - 1 }, (_, i) => i + 1).join(", ");
  const head = c.mode === "value" ? valueHead(c) : seatHead(c);
  return [
    `intro ${c.names.join(" ")}`,
    ...head,
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
    `simp only [${["cL", "cF", "cR", ...c.helpers].join(", ")}]`,
    `decide +kernel`,
  ].join("\n");
}

/** s person ↦ seat, Rot k f i = f i + k: the relations are translation invariant, rotate by −(s 0). */
function valueHead(c: CircularShape): string[] {
  const { n, valid: V, rot: R, orbit: O } = c;
  const F = `Fin ${n} → Fin ${n}`;
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
  ];
}

/**
 * s seat ↦ person, Rot k f i = f (i + k): each condition `∀ i, …` at i + k is the condition at i
 * (seat sums normalised by add_assoc / add_comm / add_left_comm); the representative is the rotation
 * by the seat of person 0 (surjectivity), the rotation fixing it is 0 (injectivity).
 */
function seatHead(c: CircularShape): string[] {
  const { n, valid: V, rot: R, orbit: O } = c;
  const F = `Fin ${n} → Fin ${n}`;
  const hc = Array.from({ length: c.conds }, (_, i) => `hc${i}`);
  const norm = [...c.helpers, "add_assoc", "add_comm", "add_left_comm"].join(", ");
  const inv = c.conds
    ? [
        `have cinv : ∀ k s, ${V} s → ${V} (${R} k s) := by`,
        `  intro k s hs`,
        `  simp only [${V}, ${R}] at hs ⊢`,
        `  obtain ⟨${["hb", ...hc].join(", ")}⟩ := hs`,
        `  refine ⟨${["hb.comp (Equiv.addRight k).bijective", ...hc.map(() => "fun i => ?_")].join(", ")}⟩`,
        ...hc.map((h) => `  · simpa only [${norm}] using ${h} (i + k)`),
      ]
    : [`have cinv : ∀ k s, ${V} s → ${V} (${R} k s) := by`, `  intro k s hs`, `  exact hs.comp (Equiv.addRight k).bijective`];
  return [
    ...inv,
    `have cRR : ∀ a b s, ${R} a (${R} b s) = ${R} (a + b) s := by`,
    `  intro a b s; funext i; exact congrArg s (add_assoc _ _ _)`,
    `have cR0 : ∀ s, ${R} 0 s = s := by intro s; funext i; exact congrArg s (add_zero _)`,
    `have cset : {O : Set (${F}) | ∃ s : ${F}, ${V} s ∧ O = ${O} s} = ${O} '' {s | ${V} s ∧ s 0 = 0} := by`,
    `  ext O; constructor`,
    `  · rintro ⟨s, hs, rfl⟩`,
    `    obtain ⟨k, hk⟩ := ${c.hasRest ? "hs.1" : "hs"}.2 0`,
    `    refine ⟨${R} k s, ⟨cinv _ _ hs, by simp only [${R}, zero_add]; exact hk⟩, ?_⟩`,
    `    ext t; simp only [${O}, Set.mem_ofPred_eq]; constructor`,
    `    · rintro ⟨ht, j, rfl⟩; exact ⟨ht, j + k, cRR _ _ _⟩`,
    `    · rintro ⟨ht, j, rfl⟩; exact ⟨ht, j - k, by rw [cRR, sub_add_cancel]⟩`,
    `  · rintro ⟨s, ⟨hs, _⟩, rfl⟩; exact ⟨s, hs, rfl⟩`,
    `have cinj : Set.InjOn ${O} {s | ${V} s ∧ s 0 = 0} := by`,
    `  rintro s ⟨hs, hs0⟩ t ⟨ht, ht0⟩ hst`,
    `  have hmem : t ∈ ${O} s := by rw [hst]; exact ⟨ht, 0, (cR0 t).symm⟩`,
    `  obtain ⟨_, k, hk⟩ := hmem`,
    `  have hk0 : k = 0 := by`,
    `    have h0 := congrFun hk 0`,
    `    simp only [${R}, zero_add] at h0`,
    `    exact ${c.hasRest ? "hs.1" : "hs"}.1 (h0.symm.trans (ht0.trans hs0.symm))`,
    `  rw [hk, hk0, cR0]`,
  ];
}
