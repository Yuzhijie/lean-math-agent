/**
 * Counting configurations up to rotation (and reflection): statements of the shape the
 * formalizer writes —
 *
 *   let Valid : Finset (Fin N) → Prop := …;
 *   let Rot : Fin N → Finset (Fin N) → Finset (Fin N) := fun k s => s.image (fun i => i + k);
 *   let Ref : Fin N → Finset (Fin N) → Finset (Fin N) := fun k s => s.image (fun i => k - i);   (optional)
 *   let Orbit : Finset (Fin N) → Set (Finset (Fin N)) := fun s => {t | Valid t ∧ ∃ k : Fin N, t = Rot k s ∨ t = Ref k s};
 *   Set.ncard {O : Set (Finset (Fin N)) | ∃ s : Finset (Fin N), Valid s ∧ O = Orbit s} = M
 *
 * The program asks Lean (`#eval`, outside the proof) for one representative per orbit — the valid
 * member with the smallest code —, then writes the proof: compositions of rotations/reflections
 * are rotations/reflections, so an orbit is the orbit of any of its members; the kernel checks
 * that the representatives are valid, that each has the smallest code among its images (two in
 * one orbit would each be at most the other: different orbits), and that every valid choice is an
 * image of one; then the orbits are the images of the representatives (Set.InjOn.ncard_image).
 *
 * What the kernel computes is numbers, not sets: a choice is its `code` (bit i for seat i), the
 * images of all representatives are one number `B` (bit c for the code c of an image), and each
 * finite fact is a Bool over a list (orbitScript). Checked in Lean up to the dihedral group, no
 * two adjacent, on 5 of 15 seats: 16 (5 s), 6 of 18: 50 (12 s, 1.4 GB), 6 of 20: 126 and 7 of 20:
 * 76 (30–45 s, 3–4 GB). The first version — each rotated list sorted and looked up among the
 * representatives, the cover a `∀ l ∈ list` decided as a proposition — stopped at 6 of 18: past
 * the kernel's recursion depth ("deep recursion detected") and, on a 7 GB machine, its memory.
 */
import { splitLets, squash, type LetDef } from "./lets";

export interface OrbitShape {
  /** Every let name, in order (for `intro`). */
  names: string[];
  lets: LetDef[];
  valid: string;
  rot: string;
  ref?: string;
  orbit: string;
  n: number;
  /** The size every valid choice has (`s.card = K` in Valid), when Valid says so. */
  k?: number;
  /**
   * Valid is exactly "K elements, no two adjacent" (`s.card = K ∧ ∀ i ∈ s, i + 1 ∉ s`): rotations
   * keep it, so only the choices containing 0 need checking (C(N−1, K−1) lists instead of C(N, K);
   * the kernel needs the memory of the smaller list — 5 of 15 seats did not fit in 3.5 GB otherwise).
   */
  adjacent?: boolean;
  total: number;
}

const ID = "[A-Za-z_][\\w'₀-₉]*";

export function orbitShape(theoremType: string): OrbitShape | undefined {
  const sp = splitLets(theoremType);
  if (!sp) return undefined;
  const body = squash(sp.body);
  const b = new RegExp(`^Set\\.ncard \\{ ?(${ID})(?: : Set \\(Finset \\(Fin (\\d+)\\)\\))? \\| ∃ (${ID})(?: : Finset \\(Fin \\d+\\))?, (${ID}) \\3 ∧ \\1 = (${ID}) \\3 ?\\} = (\\d+)$`).exec(body);
  if (!b) return undefined;
  const [, , nText, , valid, orbit, total] = b;
  const def = (name: string) => sp.lets.find((l) => l.name === name);
  const ob = def(orbit);
  const vd = def(valid);
  if (!ob || !vd) return undefined;
  const o = new RegExp(`^fun (${ID}) => \\{ ?(${ID})(?: : Finset \\(Fin \\d+\\))? \\| ${valid} \\2 ∧ ∃ (${ID})(?: : Fin (\\d+))?, \\2 = (${ID}) \\3 \\1(?: ∨ \\2 = (${ID}) \\3 \\1)? ?\\}$`).exec(squash(ob.value));
  if (!o) return undefined;
  const rot = o[5];
  const ref = o[6];
  const n = Number(nText ?? o[4] ?? /Fin (\d+)/.exec(vd.type ?? "")?.[1]);
  if (!Number.isFinite(n) || n < 2 || n > 20) return undefined;
  const isMap = (name: string, body: (i: string, k: string) => string) => {
    const d = def(name);
    if (!d) return false;
    const m = new RegExp(`^fun (${ID}) (${ID}) => (?:\\2\\.image|Finset\\.image) \\(fun (${ID}) => (.+)\\)(?: \\2)?$`).exec(squash(d.value));
    return !!m && squash(m[4]) === body(m[3], m[1]);
  };
  if (!isMap(rot, (i, k) => `${i} + ${k}`)) return undefined;
  if (ref && !isMap(ref, (i, k) => `${k} - ${i}`)) return undefined;
  const k = /\.card = (\d+)/.exec(squash(vd.value));
  const adjacent = new RegExp(`^fun (${ID}) => \\1\\.card = \\d+ ∧ ∀ (${ID}) ∈ \\1, \\2 \\+ (?:1|\\(1 : Fin \\d+\\)) ∉ \\1$`).test(squash(vd.value));
  return {
    names: sp.lets.map((l) => l.name),
    lets: sp.lets,
    valid,
    rot,
    ...(ref ? { ref } : {}),
    orbit,
    n,
    ...(k ? { k: Number(k[1]) } : {}),
    ...(adjacent && k ? { adjacent: true } : {}),
    total: Number(total),
  };
}

/**
 * The command that makes Lean list one representative per orbit (sorted lists of `Fin.val`s),
 * in a namespace of its own: every let as an `abbrev` (so its Prop is decidable), then `#eval`.
 * The valid choices are gone through by rising code (bit i for seat i), so each orbit's
 * representative is its valid member with the smallest code — what the proof's "different
 * representatives are in different orbits" rests on (orbitScript).
 */
export function orbitEvalCommand(shape: OrbitShape, ns = "OrbitReps"): string {
  const { n, k, valid, rot, ref } = shape;
  const defs = shape.lets.map((l) => `abbrev ${l.name}${l.type ? ` : ${l.type}` : ""} := ${l.value}`);
  const choices = k !== undefined ? `(List.finRange ${n}).sublistsLen ${k}` : `(List.finRange ${n}).sublists`;
  const images = ref ? `[code (${rot} k s), code (${ref} k s)]` : `[code (${rot} k s)]`;
  return [
    `namespace ${ns}`,
    ...defs,
    `def code (s : Finset (Fin ${n})) : Nat := (s.val.map (fun i => 2 ^ i.val)).sum`,
    `#eval`,
    `  let all := ((${choices}).filter (fun l => decide (${valid} l.toFinset))).mergeSort (fun a b => decide (code a.toFinset ≤ code b.toFinset))`,
    `  (all.foldl (fun (acc : List (List Nat) × List Nat) l =>`,
    `     let s := l.toFinset`,
    `     if acc.2.contains (code s) then acc`,
    `     else (acc.1 ++ [(l.map (·.val)).mergeSort], acc.2 ++ (List.finRange ${n}).flatMap (fun k => ${images})))`,
    `   ([], [])).1`,
    `end ${ns}`,
  ].join("\n");
}

/** `[[0, 2, 4], [0, 3, 5]]` from the #eval output. */
export function parseReps(text: string): number[][] | undefined {
  const t = text.replace(/\s+/g, "");
  if (!/^\[(\[(\d+(,\d+)*)?\](,\[(\d+(,\d+)*)?\])*)?\]$/.test(t)) return undefined;
  return JSON.parse(t) as number[][];
}

/** Names the proof binds itself: a statement that uses one of them for a let is left to the other routes. */
const SCRIPT_NAMES = new Set(["hcardV", "code", "hbit", "hmem", "hcodeEq", "hcodeOf", "RL", "hcnd", "hnd", "hinjRL", "IM", "B", "hB", "hminB", "hmin", "hcovB", "hcov", "hcover", "hset", "hinj", "rr", "fr", "rf", "ff", "r0", "oRot", "oRef", "mapRot", "mapRef", "vRot", "hRv0", "hRv", "hL"]);

/**
 * The proof, given the representatives (each the member of its orbit with the smallest code, as
 * orbitEvalCommand lists them).
 *
 * What the kernel computes is kept small and flat — its memory goes with the number of reduction
 * steps (about 2 KB each), so the steps must grow with the choices gone through, not with choices
 * × group × representatives:
 * - a choice is a number (`code`: bit i set for seat i — the kernel's own big-number arithmetic);
 * - "different representatives, different orbits" is one comparison per image: each representative
 *   has the smallest code of its orbit (looking every image up among the representatives was
 *   635 000 steps for 126 of them, 5 GB);
 * - the images of the representatives under the whole group are one number `B` (bit c set for the
 *   code c of an image), and "this choice is in the orbit of a representative" is one bit test;
 * - "no two adjacent" on a list in rising order is read off neighbours (K comparisons, not K²);
 * - every finite fact is a Bool computed by `List.all` (`decide +kernel` on `… = true`): a
 *   `∀ l ∈ list` decided as a proposition recurses once per element, and 6188 lists (6 of 18
 *   seats) were past the kernel's depth — "deep recursion detected".
 * What is left grows with C(N − 1, K − 1), the lists gone through to find the valid ones.
 */
export function orbitScript(shape: OrbitShape, reps: number[][]): string | undefined {
  if (shape.names.some((x) => SCRIPT_NAMES.has(x))) return undefined;
  const { n, k, valid: V, rot: Rt, ref: Rf, orbit: Ob } = shape;
  const F = `Fin ${n}`;
  const sorted = reps.map((r) => [...r].sort((a, b) => a - b));
  const RL = `[${sorted.map((r) => `[${r.join(", ")}]`).join(", ")}]`;
  const rotOf = (l: string) => `${l}.map (· + k)`;
  const refOf = (l: string) => `${l}.map (k - ·)`;
  // only the maps the lemma is about: an unused simp argument is a linter warning in the verified source
  const comp = (lhs: string, rhs: string, names: string, defs = [Rt, Rf]) =>
    `have ${names} : ∀ j k s, ${lhs} = ${rhs} := by\n  intro j k s; simp only [${defs.filter(Boolean).join(", ")}, Finset.image_image]; congr 1; funext i; simp only [Function.comp_apply]; abel`;
  const L: string[] = [`intro ${shape.names.join(" ")}`];
  const adj = shape.adjacent && k !== undefined;
  // `tauto` looks at every hypothesis: here, while the context is only the statement's lets — once the
  // computed facts (`… = true`) are there, its `contradiction` evaluates them outside the kernel (40 s on 3 of 12)
  if (k !== undefined && !adj) L.push(`have hcardV : ∀ s, ${V} s → s.card = ${k} := by\n  intro s hs; simp only [${V}] at hs; tauto`);
  L.push(comp(`${Rt} k (${Rt} j s)`, `${Rt} (j + k) s`, "rr", [Rt]));
  if (Rf) {
    L.push(comp(`${Rf} k (${Rt} j s)`, `${Rf} (k - j) s`, "fr"));
    L.push(comp(`${Rt} k (${Rf} j s)`, `${Rf} (j + k) s`, "rf"));
    L.push(comp(`${Rf} k (${Rf} j s)`, `${Rt} (k - j) s`, "ff"));
  }
  L.push(`have r0 : ∀ s, ${Rt} 0 s = s := by\n  intro s; simp only [${Rt}, add_zero, Finset.image_id']`);
  const head = (name: string, g: string) => [`have ${name} : ∀ j s, ${Ob} (${g} j s) = ${Ob} s := by`, `  intro j s; ext t; simp only [${Ob}, Set.mem_ofPred_eq]`, `  constructor`];
  if (Rf) {
    L.push(
      [
        ...head("oRot", Rt),
        `  · rintro ⟨hv, k, h | h⟩`,
        `    · exact ⟨hv, j + k, Or.inl (h.trans (rr j k s))⟩`,
        `    · exact ⟨hv, k - j, Or.inr (h.trans (fr j k s))⟩`,
        `  · rintro ⟨hv, k, h | h⟩`,
        `    · exact ⟨hv, k - j, Or.inl (h.trans (by rw [rr]; congr 1; abel))⟩`,
        `    · exact ⟨hv, k + j, Or.inr (h.trans (by rw [fr]; congr 1; abel))⟩`,
      ].join("\n"),
    );
    L.push(
      [
        ...head("oRef", Rf),
        `  · rintro ⟨hv, k, h | h⟩`,
        `    · exact ⟨hv, j + k, Or.inr (h.trans (rf j k s))⟩`,
        `    · exact ⟨hv, k - j, Or.inl (h.trans (ff j k s))⟩`,
        `  · rintro ⟨hv, k, h | h⟩`,
        `    · exact ⟨hv, j + k, Or.inr (h.trans (by rw [ff]; congr 1; abel))⟩`,
        `    · exact ⟨hv, k - j, Or.inl (h.trans (by rw [rf]; congr 1; abel))⟩`,
      ].join("\n"),
    );
  } else {
    L.push(
      [
        ...head("oRot", Rt),
        `  · rintro ⟨hv, k, h⟩`,
        `    exact ⟨hv, j + k, h.trans (rr j k s)⟩`,
        `  · rintro ⟨hv, k, h⟩`,
        `    exact ⟨hv, k - j, h.trans (by rw [rr]; congr 1; abel)⟩`,
      ].join("\n"),
    );
  }
  L.push(`have mapRot : ∀ (l : List (${F})) k, ${Rt} k l.toFinset = (l.map (· + k)).toFinset := by\n  intro l k; ext x; simp only [${Rt}, Finset.mem_image, List.mem_toFinset, List.mem_map]`);
  if (Rf) L.push(`have mapRef : ∀ (l : List (${F})) k, ${Rf} k l.toFinset = (l.map (k - ·)).toFinset := by\n  intro l k; ext x; simp only [${Rf}, Finset.mem_image, List.mem_toFinset, List.mem_map]`);

  // a choice as a number: bit i for seat i; two lists have the same code exactly when they are the same set
  L.push(`let code : List (${F}) → ℕ := fun l => (l.map Fin.val).foldl (fun b c => b ||| 2 ^ c) 0`);
  L.push(
    [
      `have hbit : ∀ (l : List ℕ) (b j : ℕ), (l.foldl (fun b c => b ||| 2 ^ c) b).testBit j = (b.testBit j || decide (j ∈ l)) := by`,
      `  intro l`,
      `  induction l with`,
      `  | nil => intro b j; simp`,
      `  | cons a l ih =>`,
      `    intro b j`,
      `    rw [List.foldl_cons, ih, Nat.testBit_or, Nat.testBit_two_pow]`,
      `    by_cases h : a = j <;> simp [h, eq_comm]`,
    ].join("\n"),
  );
  L.push(`have hmem : ∀ (l : List (${F})) (i : ${F}), (code l).testBit i.val = decide (i ∈ l) := by\n  intro l i\n  simp only [code]\n  rw [hbit]\n  simp [Fin.val_inj]`);
  L.push(`have hcodeEq : ∀ l1 l2 : List (${F}), code l1 = code l2 → l1.toFinset = l2.toFinset := by\n  intro l1 l2 h\n  ext i\n  have h1 := hmem l1 i\n  rw [h, hmem l2 i] at h1\n  simpa using h1.symm`);
  L.push(
    [
      `have hcodeOf : ∀ l1 l2 : List (${F}), l1.toFinset = l2.toFinset → code l1 = code l2 := by`,
      `  intro l1 l2 h`,
      `  apply Nat.eq_of_testBit_eq`,
      `  intro j`,
      `  simp only [code]`,
      `  rw [hbit, hbit]`,
      `  congr 1`,
      `  have hm : ∀ i : ${F}, i ∈ l1 ↔ i ∈ l2 := fun i => by simpa using Finset.ext_iff.1 h i`,
      `  simp only [List.mem_map, hm]`,
    ].join("\n"),
  );

  // the representatives: different codes, so a representative is known by its code
  L.push(`let RL : List (List (${F})) := ${RL}`);
  L.push(`have hcnd : (RL.map code).Nodup := by decide +kernel`);
  L.push(`have hnd : RL.Nodup := List.Nodup.of_map code hcnd`);
  L.push(`have hinjRL : ∀ r1 ∈ RL, ∀ r2 ∈ RL, code r1 = code r2 → r1 = r2 := fun r1 h1 r2 h2 h => List.inj_on_of_nodup_map hcnd h1 h2 h`);
  if (adj) {
    L.push(`have vRot : ∀ j s, ${V} s → ${V} (${Rt} j s) := by\n  intro j s ⟨hc, ha⟩\n  refine ⟨by simp only [${Rt}]; rw [Finset.card_image_of_injective _ (add_left_injective j)]; exact hc, ?_⟩\n  simp only [${Rt}, Finset.mem_image]\n  rintro _ ⟨i, hi, rfl⟩ ⟨y, hy, he⟩\n  have : y = i + 1 := add_right_cancel (b := j) (by rw [he]; abel)\n  exact ha i hi (this ▸ hy)`);
    L.push(`have hRv0 : ∀ r ∈ RL, r.length = ${k} ∧ r.Nodup ∧ ∀ i : ${F}, i ∈ r → i + 1 ∉ r := by decide +kernel`);
    L.push(`have hRv : ∀ r ∈ RL, ${V} r.toFinset := by\n  intro r hr; obtain ⟨h5, hn, ha⟩ := hRv0 r hr\n  exact ⟨by rw [List.toFinset_card_of_nodup hn, h5], fun i hi => by simpa using ha i (by simpa using hi)⟩`);
  } else L.push(`have hRv : ∀ r ∈ RL, ${V} r.toFinset := by\n  simp only [${V}]; decide +kernel`);

  // each representative has the smallest code of its orbit (Lean listed them that way): two in one orbit
  // would each be at most the other. One comparison per image — looking every image up among the
  // representatives was half a million steps on 126 of them, past the kernel's memory
  if (adj) {
    L.push(`have hminB : RL.all (fun r => (List.finRange ${n}).all (fun k => Nat.ble (code r) (code (${rotOf("r")}))${Rf ? ` && Nat.ble (code r) (code (${refOf("r")}))` : ""})) = true := by\n  decide +kernel`);
    L.push(
      [
        `have hmin : ∀ r ∈ RL, ∀ k : ${F}, code r ≤ code (${rotOf("r")})${Rf ? ` ∧ code r ≤ code (${refOf("r")})` : ""} := by`,
        `  intro r hr k`,
        `  have hk := List.all_eq_true.1 (List.all_eq_true.1 hminB r hr) k (List.mem_finRange k)`,
        ...(Rf ? [`  have hk2 := Bool.and_eq_true_iff.1 hk`, `  exact ⟨Nat.le_of_ble_eq_true hk2.1, Nat.le_of_ble_eq_true hk2.2⟩`] : [`  exact Nat.le_of_ble_eq_true hk`]),
      ].join("\n"),
    );
    // the computed fact itself goes: a later tactic that scans the context must not evaluate it
    L.push(`clear hminB`);
  } else {
    // a general Valid is not kept by the maps: only the valid images are members of the orbit
    const least = (m: string) => `(${V} (${m}).toFinset → code r ≤ code (${m}))`;
    L.push(`have hmin : ∀ r ∈ RL, ∀ k : ${F}, ${least(rotOf("r"))}${Rf ? ` ∧ ${least(refOf("r"))}` : ""} := by\n  simp only [${V}]; decide +kernel`);
  }

  // every image of every representative, as one number: bit c for the code c of an image
  L.push(`let IM : List ℕ := RL.flatMap (fun r => (List.finRange ${n}).flatMap (fun k => [code (${rotOf("r")})${Rf ? `, code (${refOf("r")})` : ""}]))`);
  L.push(`let B : ℕ := IM.foldl (fun b c => b ||| 2 ^ c) 0`);
  const inOrbit = (l: string) => `${l}.toFinset = (r.map (· + k)).toFinset${Rf ? ` ∨ ${l}.toFinset = (r.map (k - ·)).toFinset` : ""}`;
  L.push(
    [
      `have hB : ∀ c, B.testBit c = true → ∃ r ∈ RL, ∃ k : ${F}, c = code (${rotOf("r")})${Rf ? ` ∨ c = code (${refOf("r")})` : ""} := by`,
      `  intro c hc`,
      `  have h := hbit IM 0 c`,
      `  simp only [Nat.zero_testBit, Bool.false_or] at h`,
      `  have hc' : c ∈ IM := of_decide_eq_true (h.symm.trans hc)`,
      `  simpa only [IM, List.mem_flatMap, List.mem_finRange, true_and, List.mem_cons, List.mem_singleton, List.not_mem_nil, or_false] using hc'`,
    ].join("\n"),
  );
  const found = Rf
    ? [`obtain ⟨r, hr, k, e | e⟩ := hB _ h`, `· exact ⟨r, hr, k, Or.inl (hcodeEq _ _ e)⟩`, `· exact ⟨r, hr, k, Or.inr (hcodeEq _ _ e)⟩`]
    : [`obtain ⟨r, hr, k, e⟩ := hB _ h`, `exact ⟨r, hr, k, hcodeEq _ _ e⟩`];
  const choices = k !== undefined ? `List.sublistsLen ${k} (List.finRange ${n})` : `(List.finRange ${n}).sublists`;
  if (adj) {
    const lists = `List.sublistsLen ${k! - 1} (List.finRange ${n}).tail`;
    // "no two adjacent" on a list in rising order: neighbours in the list, and seat N − 1 next to seat 0 —
    // K comparisons where every pair would be K² (the lists are the kernel's main cost: C(N − 1, K − 1) of them)
    const apartB = `(((0 :: l).zip l).all (fun p => p.1 + 1 != p.2) && !l.contains (${n - 1} : ${F}))`;
    L.push(`have hcovB : (${lists}).all (fun l => !${apartB} || B.testBit (code (0 :: l))) = true := by\n  decide +kernel`);
    L.push(
      [
        `have hcov : ∀ l ∈ ${lists}, (∀ i : ${F}, i ∈ 0 :: l → i + 1 ∉ 0 :: l) → ∃ r ∈ RL, ∃ k : ${F}, ${inOrbit("(0 :: l)")} := by`,
        `  intro l hl hadj`,
        `  rcases Bool.or_eq_true_iff.1 (List.all_eq_true.1 hcovB l hl) with h | h`,
        `  · have ha : ${apartB} = true := by`,
        `      rw [Bool.and_eq_true]`,
        `      constructor`,
        `      · refine List.all_eq_true.2 (fun p hp => ?_)`,
        `        have hm := List.of_mem_zip (a := p.1) (b := p.2) hp`,
        `        have hn := hadj p.1 hm.1`,
        `        rw [bne_iff_ne]`,
        `        exact fun e => hn (e ▸ List.mem_cons_of_mem _ hm.2)`,
        `      · by_contra hc`,
        `        have hm : (${n - 1} : ${F}) ∈ l := by simpa using hc`,
        `        exact hadj (${n - 1} : ${F}) (List.mem_cons_of_mem _ hm) (by simp)`,
        `    rw [ha] at h; exact absurd h (by decide)`,
        ...found.map((x, i) => (i === 0 ? `  · ${x}` : `    ${x}`)),
      ].join("\n"),
    );
    L.push(`clear hcovB`);
    L.push(`have hL : ∀ x : ${F}, x ∈ (List.finRange ${n}).tail ↔ x ≠ 0 := by decide`);
  } else {
    L.push(`have hcovB : ∀ l ∈ ${choices}, ${V} l.toFinset → B.testBit (code l) = true := by\n  simp only [${V}]; decide +kernel`);
    L.push([`have hcov : ∀ l ∈ ${choices}, ${V} l.toFinset → ∃ r ∈ RL, ∃ k : ${F}, ${inOrbit("l")} := by`, `  intro l hl hv`, `  have h := hcovB l hl hv`, ...found.map((x) => `  ${x}`)].join("\n"));
  }
  const member =
    k !== undefined
      ? [
          `  have hcard : s.card = ${k} := hcardV s hs`,
          `  have hlen : l.length = ${k} := by rw [← List.toFinset_card_of_nodup hlnd, hlf, hcard]`,
          `  have hl : l ∈ ${choices} := List.mem_sublistsLen.2 ⟨List.filter_sublist, hlen⟩`,
        ]
      : [`  have hl : l ∈ ${choices} := List.mem_sublists.2 List.filter_sublist`];
  // Orbit s = Orbit r.toFinset from "the list of s is an image of r"
  const same = (lhs: string, rewrite: string) =>
    Rf
      ? [
          `  obtain ⟨r, hr, k, e | e⟩ := ${lhs}`,
          `  · exact ⟨r, hr, ${rewrite.replace("MAP", "mapRot").replace("ORB", "oRot")}⟩`,
          `  · exact ⟨r, hr, ${rewrite.replace("MAP", "mapRef").replace("ORB", "oRef")}⟩`,
        ]
      : [`  obtain ⟨r, hr, k, e⟩ := ${lhs}`, `  exact ⟨r, hr, ${rewrite.replace("MAP", "mapRot").replace("ORB", "oRot")}⟩`];
  if (adj)
    L.push(
      [
        `have hcover : ∀ s, ${V} s → ∃ r ∈ RL, ${Ob} s = ${Ob} r.toFinset := by`,
        `  intro s hs`,
        `  obtain ⟨i, hi⟩ : s.Nonempty := Finset.card_pos.1 (by rw [hs.1]; norm_num)`,
        `  set s' := ${Rt} (-i) s with hs'`,
        `  have hv : ${V} s' := vRot (-i) s hs`,
        `  have h0 : (0 : ${F}) ∈ s' := Finset.mem_image.2 ⟨i, hi, by abel⟩`,
        `  let l := (List.finRange ${n}).tail.filter (fun x => decide (x ∈ s'))`,
        `  have hlf : l.toFinset = s'.erase 0 := by`,
        `    ext x; simp only [l, List.mem_toFinset, List.mem_filter, hL, decide_eq_true_eq, Finset.mem_erase]`,
        `  have hlnd : l.Nodup := ((List.nodup_finRange ${n}).sublist (List.tail_sublist _)).filter _`,
        `  have hlen : l.length = ${(k ?? 1) - 1} := by`,
        `    rw [← List.toFinset_card_of_nodup hlnd, hlf, Finset.card_erase_of_mem h0, hv.1]`,
        `  have hl : l ∈ List.sublistsLen ${(k ?? 1) - 1} (List.finRange ${n}).tail := List.mem_sublistsLen.2 ⟨List.filter_sublist, hlen⟩`,
        `  have hs0 : s' = (0 :: l).toFinset := by rw [List.toFinset_cons, hlf, Finset.insert_erase h0]`,
        `  have hadj : ∀ x : ${F}, x ∈ 0 :: l → x + 1 ∉ 0 :: l := fun x hx => by`,
        `    have := hv.2 x (by rw [hs0]; simpa using hx)`,
        `    rw [hs0] at this; simpa using this`,
        ...same(`hcov l hl hadj`, `(oRot (-i) s).symm.trans (show ${Ob} s' = ${Ob} r.toFinset by rw [hs0, e, ← MAP]; exact ORB k _)`),
      ].join("\n"),
    );
  else
    L.push(
      [
        `have hcover : ∀ s, ${V} s → ∃ r ∈ RL, ${Ob} s = ${Ob} r.toFinset := by`,
        `  intro s hs`,
        `  let l := (List.finRange ${n}).filter (fun x => decide (x ∈ s))`,
        `  have hlf : l.toFinset = s := by ext x; simp [l]`,
        `  have hlnd : l.Nodup := (List.nodup_finRange ${n}).filter _`,
        ...member,
        ...same(`hcov l hl (by rw [hlf]; exact hs)`, `by rw [← hlf, e, ← MAP]; exact ORB k _`),
      ].join("\n"),
    );
  L.push(
    [
      `have hset : {O : Set (Finset (${F})) | ∃ s : Finset (${F}), ${V} s ∧ O = ${Ob} s} = (fun r : List (${F}) => ${Ob} r.toFinset) '' {r | r ∈ RL} := by`,
      `  ext O; simp only [Set.mem_ofPred_eq, Set.mem_image]`,
      `  constructor`,
      `  · rintro ⟨s, hs, rfl⟩`,
      `    obtain ⟨r, hr, he⟩ := hcover s hs`,
      `    exact ⟨r, hr, he.symm⟩`,
      `  · rintro ⟨r, hr, rfl⟩`,
      `    exact ⟨r.toFinset, hRv r hr, rfl⟩`,
    ].join("\n"),
  );
  // a member of a representative's orbit has a code at least the representative's
  const atLeast = (map: string, img: string, side: string) =>
    adj ? `rw [hcodeOf rb (${img}) (by rw [← ${map}]; exact hk)]; exact (hmin ra ha k)${side}` : `rw [hcodeOf rb (${img}) (by rw [← ${map}]; exact hk)]; exact (hmin ra ha k)${side} (by rw [← ${map}, ← hk]; exact hv)`;
  L.push(
    [
      `have hinj : Set.InjOn (fun r : List (${F}) => ${Ob} r.toFinset) {r | r ∈ RL} := by`,
      `  intro r1 h1 r2 h2 he`,
      `  have he' : ${Ob} r1.toFinset = ${Ob} r2.toFinset := he`,
      `  have hle : ∀ ra ∈ RL, ∀ rb : List (${F}), rb.toFinset ∈ ${Ob} ra.toFinset → code ra ≤ code rb := by`,
      `    intro ra ha rb hb`,
      ...(Rf
        ? [`    obtain ⟨${adj ? "_" : "hv"}, k, hk | hk⟩ := hb`, `    · ${atLeast("mapRot", "ra.map (· + k)", ".1")}`, `    · ${atLeast("mapRef", "ra.map (k - ·)", ".2")}`]
        : [`    obtain ⟨${adj ? "_" : "hv"}, k, hk⟩ := hb`, `    ${atLeast("mapRot", "ra.map (· + k)", "")}`]),
      `  have m1 : r1.toFinset ∈ ${Ob} r1.toFinset := ⟨hRv r1 h1, 0, ${Rf ? "Or.inl " : ""}(r0 _).symm⟩`,
      `  have m2 : r2.toFinset ∈ ${Ob} r2.toFinset := ⟨hRv r2 h2, 0, ${Rf ? "Or.inl " : ""}(r0 _).symm⟩`,
      `  rw [he'] at m1`,
      `  rw [← he'] at m2`,
      `  exact hinjRL r1 h1 r2 h2 (Nat.le_antisymm (hle r1 h1 r2 m2) (hle r2 h2 r1 m1))`,
    ].join("\n"),
  );
  L.push(`rw [hset, hinj.ncard_image, show {r | r ∈ RL} = (RL.toFinset : Set (List (${F}))) by ext; simp, Set.ncard_coe_finset, List.toFinset_card_of_nodup hnd]`);
  L.push("rfl");
  return L.join("\n");
}
