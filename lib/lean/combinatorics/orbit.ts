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
 * The program asks Lean (`#eval`, outside the proof) for one representative per orbit, then
 * writes the proof: compositions of rotations/reflections are rotations/reflections, so an orbit
 * is the orbit of any of its members; the kernel checks on lists (it cannot decide over Finsets
 * of Finsets) that the representatives are valid, pairwise in different orbits, and that every
 * valid choice is carried onto one of them; then the orbits are the images of the representatives
 * (Set.InjOn.ncard_image). Checked in Lean on 5 of 15 seats, no two adjacent, up to the dihedral
 * group: 16.
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
    `  let all := (${choices}).filter (fun l => decide (${valid} l.toFinset))`,
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

/** The proof, given the representatives. */
export function orbitScript(shape: OrbitShape, reps: number[][]): string {
  const { n, k, valid: V, rot: Rt, ref: Rf, orbit: Ob } = shape;
  const F = `Fin ${n}`;
  const RL = `[${reps.map((r) => `[${[...r].sort((a, b) => a - b).join(", ")}]`).join(", ")}]`;
  const comp = (lhs: string, rhs: string, names: string) =>
    `have ${names} : ∀ j k s, ${lhs} = ${rhs} := by\n  intro j k s; simp only [${[Rt, Rf].filter(Boolean).join(", ")}, Finset.image_image]; congr 1; funext i; simp only [Function.comp_apply]; abel`;
  const L: string[] = [`intro ${shape.names.join(" ")}`];
  L.push(comp(`${Rt} k (${Rt} j s)`, `${Rt} (j + k) s`, "rr"));
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
  L.push(`let srt : List (${F}) → List (${F}) := fun l => l.insertionSort (· ≤ ·)`);
  L.push(`have hsrt : ∀ l r, srt l = r → l.toFinset = r.toFinset := by\n  intro l r h; rw [← h]; exact (List.toFinset_eq_of_perm _ _ (List.perm_insertionSort _ _)).symm`);
  L.push(`let RL : List (List (${F})) := ${RL}`);
  const adj = shape.adjacent && k !== undefined;
  if (adj) {
    L.push(`have vRot : ∀ j s, ${V} s → ${V} (${Rt} j s) := by\n  intro j s ⟨hc, ha⟩\n  refine ⟨by simp only [${Rt}]; rw [Finset.card_image_of_injective _ (add_left_injective j)]; exact hc, ?_⟩\n  simp only [${Rt}, Finset.mem_image]\n  rintro _ ⟨i, hi, rfl⟩ ⟨y, hy, he⟩\n  have : y = i + 1 := add_right_cancel (b := j) (by rw [he]; abel)\n  exact ha i hi (this ▸ hy)`);
    L.push(`have hRv0 : ∀ r ∈ RL, r.length = ${k} ∧ r.Nodup ∧ ∀ i : ${F}, i ∈ r → i + 1 ∉ r := by decide +kernel`);
    L.push(`have hRv : ∀ r ∈ RL, ${V} r.toFinset := by\n  intro r hr; obtain ⟨h5, hn, ha⟩ := hRv0 r hr\n  exact ⟨by rw [List.toFinset_card_of_nodup hn, h5], fun i hi => by simpa using ha i (by simpa using hi)⟩`);
  } else L.push(`have hRv : ∀ r ∈ RL, ${V} r.toFinset := by\n  simp only [${V}]; decide +kernel`);
  L.push(`have hnd : RL.Nodup := by decide +kernel`);
  const sepRef = Rf ? ` ∧ ((r1.map (k - ·)).toFinset = r2.toFinset → r1 = r2)` : "";
  L.push(`have hsep : ∀ r1 ∈ RL, ∀ r2 ∈ RL, ∀ k : ${F}, ((r1.map (· + k)).toFinset = r2.toFinset → r1 = r2)${sepRef} := by\n  decide +kernel`);
  const choices = k !== undefined ? `List.sublistsLen ${k} (List.finRange ${n})` : `(List.finRange ${n}).sublists`;
  // each image sorted once, then looked up in RL (`∃ r ∈ RL, ∃ k, srt … = r` sorts |RL| times more)
  const covRef = Rf ? ` ∨ srt (l.map (k - ·)) ∈ RL` : "";
  const covRef0 = Rf ? ` ∨ srt ((0 :: l).map (k - ·)) ∈ RL` : "";
  if (adj) {
    L.push(`have hcov : ∀ l ∈ List.sublistsLen ${k! - 1} (List.finRange ${n}).tail, (∀ i : ${F}, i ∈ 0 :: l → i + 1 ∉ 0 :: l) → ∃ k : ${F}, srt ((0 :: l).map (· + k)) ∈ RL${covRef0} := by\n  decide +kernel`);
    L.push(`have hL : ∀ x : ${F}, x ∈ (List.finRange ${n}).tail ↔ x ≠ 0 := by decide`);
  } else L.push(`have hcov : ∀ l ∈ ${choices}, ${V} l.toFinset → ∃ k : ${F}, srt (l.map (· + k)) ∈ RL${covRef} := by\n  simp only [${V}]; decide +kernel`);
  const member =
    k !== undefined
      ? [
          `  have hcard : s.card = ${k} := by simp only [${V}] at hs; tauto`,
          `  have hlen : l.length = ${k} := by rw [← List.toFinset_card_of_nodup hlnd, hlf, hcard]`,
          `  have hl : l ∈ ${choices} := List.mem_sublistsLen.2 ⟨List.filter_sublist, hlen⟩`,
        ]
      : [`  have hl : l ∈ ${choices} := List.mem_sublists.2 List.filter_sublist`];
  const coverCases = Rf
    ? [
        `  obtain ⟨k, hk | hk⟩ := hcov l hl (by rw [hlf]; exact hs)`,
        `  · have e : ${Rt} k s = (srt (l.map (· + k))).toFinset := by rw [← hlf, mapRot, hsrt _ _ rfl]`,
        `    exact ⟨_, hk, by rw [← oRot k s, e]⟩`,
        `  · have e : ${Rf} k s = (srt (l.map (k - ·))).toFinset := by rw [← hlf, mapRef, hsrt _ _ rfl]`,
        `    exact ⟨_, hk, by rw [← oRef k s, e]⟩`,
      ]
    : [
        `  obtain ⟨k, hk⟩ := hcov l hl (by rw [hlf]; exact hs)`,
        `  have e : ${Rt} k s = (srt (l.map (· + k))).toFinset := by rw [← hlf, mapRot, hsrt _ _ rfl]`,
        `  exact ⟨_, hk, by rw [← oRot k s, e]⟩`,
      ];
  const adjCover = [
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
    ...(Rf
      ? [
          `  obtain ⟨k, hk | hk⟩ := hcov l hl hadj`,
          `  · exact ⟨_, hk, by rw [← oRot (-i) s, ← oRot k s', hs0, mapRot, hsrt _ _ rfl]⟩`,
          `  · exact ⟨_, hk, by rw [← oRot (-i) s, ← oRef k s', hs0, mapRef, hsrt _ _ rfl]⟩`,
        ]
      : [`  obtain ⟨k, hk⟩ := hcov l hl hadj`, `  exact ⟨_, hk, by rw [← oRot (-i) s, ← oRot k s', hs0, mapRot, hsrt _ _ rfl]⟩`]),
  ].join("\n");
  if (adj) L.push(adjCover);
  else L.push(
    [
      `have hcover : ∀ s, ${V} s → ∃ r ∈ RL, ${Ob} s = ${Ob} r.toFinset := by`,
      `  intro s hs`,
      `  let l := (List.finRange ${n}).filter (fun x => decide (x ∈ s))`,
      `  have hlf : l.toFinset = s := by ext x; simp [l]`,
      `  have hlnd : l.Nodup := (List.nodup_finRange ${n}).filter _`,
      ...member,
      ...coverCases,
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
  const injCases = Rf
    ? [
        `  obtain ⟨_, k, hk | hk⟩ := this`,
        `  · exact (hsep r1 h1 r2 h2 k).1 (by rw [← mapRot]; exact hk.symm)`,
        `  · exact (hsep r1 h1 r2 h2 k).2 (by rw [← mapRef]; exact hk.symm)`,
      ]
    : [`  obtain ⟨_, k, hk⟩ := this`, `  exact hsep r1 h1 r2 h2 k (by rw [← mapRot]; exact hk.symm)`];
  L.push(
    [
      `have hinj : Set.InjOn (fun r : List (${F}) => ${Ob} r.toFinset) {r | r ∈ RL} := by`,
      `  intro r1 h1 r2 h2 he`,
      `  have : r2.toFinset ∈ ${Ob} r2.toFinset := ⟨hRv r2 h2, 0, ${Rf ? "Or.inl " : ""}(r0 _).symm⟩`,
      `  rw [← show ${Ob} r1.toFinset = ${Ob} r2.toFinset from he] at this`,
      ...injCases,
    ].join("\n"),
  );
  L.push(`rw [hset, hinj.ncard_image, show {r | r ∈ RL} = (RL.toFinset : Set (List (${F}))) by ext; simp, Set.ncard_coe_finset, List.toFinset_card_of_nodup hnd]`);
  L.push("rfl");
  return L.join("\n");
}
