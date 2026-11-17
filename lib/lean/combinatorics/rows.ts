/**
 * Arrangements in a row with a condition on neighbours: "the permutations of 1, …, 8 in which no
 * two neighbours differ by 1" (5242) —
 *
 *     let Good : Equiv.Perm (Fin n) → Prop := fun p => ∀ i : Fin (n - 1), C (p ⟨i.val, _⟩) (p ⟨i.val + 1, _⟩);
 *     (Finset.univ.filter Good).card = M
 *
 * (also `Fintype.card {p // …}`, `Nat.card`, `Set.ncard {p | …}`; the neighbours as
 * `i.castSucc` / `i.succ`, as `∀ i : Fin n, i.val + 1 < n → … p i … p (i + 1)`, as
 * `∀ i j : Fin n, j.val = i.val + 1 → … p i … p j`, or over `i : ℕ`).
 *
 * The kernel cannot go through `Equiv.Perm (Fin 8)` (40 320 permutations, each a tower of swaps:
 * out of memory), and `native_decide` is not a proof here. What it can do is build the
 * arrangements place by place and drop a beginning as soon as two neighbours break the
 * condition: 19 184 partial rows instead of 40 320 × 8 values. That this builds every good
 * arrangement exactly once is a lemma about any `n` and any relation (ROW_LEMMA: the rows after
 * `k` places are exactly the lists of length `k` without repetition whose neighbours are related;
 * permutations ↔ such lists of length `n` through `List.ofFn`), written into the proof as two
 * `have`s; the statement's own condition is then only read — `C` with the two neighbours as `x`
 * and `y` — and the count is one `decide +kernel`.
 *
 * Lean also counts first (`#eval`, outside the proof; rowEvalCommand — a recurrence, so it counts
 * for every size): another number than the statement's is a counterexample; more rows than the
 * kernel should be given (ROWS_MAX_LISTS: 1 … 9 with the same condition is 167 513) and the
 * statement stays unproved, with Lean's count said.
 */
import { splitLets, squash, stripParens, topIndex, type LetDef } from "./lets";

/** How the statement says "for every pair of neighbouring places". */
export type RowForm =
  /** `∀ i : Fin (n - 1), … p ⟨i.val, _⟩ … p ⟨i.val + 1, _⟩ …` (or `i.castSucc` / `i.succ`) */
  | "short"
  /** `∀ i : Fin n, i.val + 1 < n → … p i … p ⟨i.val + 1, h⟩ …` */
  | "guard"
  /** the same with `p (i + 1)` */
  | "guard-add"
  /** `∀ i j : Fin n, j.val = i.val + 1 → … p i … p j …` */
  | "pair"
  /** `∀ i : ℕ, (h : i + 1 < n) → … p ⟨i, _⟩ … p ⟨i + 1, h⟩ …` */
  | "nat";

/** How the count is written. */
export type RowCount = "filter" | "subtype" | "natcard" | "ncard";

export interface RowShape {
  n: number;
  /** the stated number of arrangements */
  total: number;
  /** `fun x_ y_ : Fin n => decide (C x_ y_)`: the condition on a place's value and the next one's */
  relation: string;
  form: RowForm;
  count: RowCount;
  /** the statement's lets, to introduce */
  lets: string[];
}

const ID = "[A-Za-z_][\\w'₀-₉]*";
const NUM = "\\(?(\\d+)(?: : ℕ)?\\)?";

/** The names the written proof binds at its top level. */
const SCRIPT_NAMES = new Set(["row_enum", "row_count"]);

/** `name` as a whole identifier (not a part of one, not a member after a dot). */
const tokenRe = (name: string) => new RegExp(`(?<![\\w'₀-₉.])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w'₀-₉])`, "g");

/** The end (exclusive) of the bracket group that opens at `at`, or -1. */
function groupEnd(s: string, at: number): number {
  const open = s[at];
  const close = { "(": ")", "⟨": "⟩", "[": "]", "{": "}" }[open];
  if (!close) return -1;
  let depth = 0;
  for (let i = at; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close && --depth === 0) return i + 1;
  }
  return -1;
}

/** `fun p => BODY` / `fun (p : T) => BODY` / `fun p : T => BODY`. */
function lambda(text: string): { variable: string; body: string } | undefined {
  const m = new RegExp(`^(?:fun|λ) \\(?(${ID})(?: : [^=]*?)?\\)? (?:=>|↦) (.+)$`).exec(stripParens(text));
  return m ? { variable: m[1], body: m[2].trim() } : undefined;
}

/** Every let name in `text` replaced by its value (earlier lets inside later ones first): the condition no longer depends on the statement's context. */
function inlineLets(text: string, lets: LetDef[]): string {
  let out = text;
  for (let k = lets.length - 1; k >= 0; k--) {
    const l = lets[k];
    out = out.replace(tokenRe(l.name), () => (l.type ? `((${l.value}) : ${l.type})` : `(${l.value})`));
  }
  return out;
}

/** The argument written after the permutation at `at` (one identifier with members, or one bracket group), and where it ends. */
function argumentAt(s: string, at: number): { text: string; end: number } | undefined {
  if (s[at] === "(" || s[at] === "⟨") {
    const end = groupEnd(s, at);
    return end < 0 ? undefined : { text: s.slice(at, end), end };
  }
  const m = new RegExp(`^${ID}(?:\\.${ID})*`).exec(s.slice(at));
  return m ? { text: m[0], end: at + m[0].length } : undefined;
}

/** Which of the two neighbours an argument names: the place itself, the next one, or neither. */
function neighbour(arg: string, form: RowForm, i: string, j: string | undefined): "this" | "next" | undefined {
  const a = squash(arg);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const iv = `(?:${esc(i)}\\.val|↑${esc(i)}|\\(${esc(i)} : ℕ\\)|\\(↑${esc(i)} : ℕ\\)|${esc(i)}\\.1)`;
  const proof = "(?:, [^⟨⟩]*)";
  if (form === "short") {
    if (new RegExp(`^(?:${esc(i)}\\.castSucc|\\(Fin\\.castSucc ${esc(i)}\\)|⟨${iv}${proof}⟩)$`).test(a)) return "this";
    if (new RegExp(`^(?:${esc(i)}\\.succ|\\(Fin\\.succ ${esc(i)}\\)|⟨${iv} \\+ 1${proof}⟩)$`).test(a)) return "next";
    return undefined;
  }
  if (form === "guard" || form === "guard-add") {
    if (a === i) return "this";
    if (new RegExp(`^⟨${iv} \\+ 1${proof}⟩$`).test(a)) return form === "guard" ? "next" : undefined;
    if (new RegExp(`^\\(${esc(i)} \\+ 1\\)$`).test(a)) return form === "guard-add" ? "next" : undefined;
    return undefined;
  }
  if (form === "pair") return a === i ? "this" : a === j ? "next" : undefined;
  // nat: i : ℕ
  if (new RegExp(`^⟨${esc(i)}${proof}⟩$`).test(a)) return "this";
  if (new RegExp(`^⟨${esc(i)} \\+ 1${proof}⟩$`).test(a)) return "next";
  return undefined;
}

/**
 * The condition with the permutation's values at a place and at the next one written `x` and `y`;
 * undefined when the permutation is used any other way (another place, the place itself in the
 * condition, `p.symm` …).
 */
function relationOf(inner: string, p: string, form: RowForm, i: string, j: string | undefined, n: number): string | undefined {
  const used = new Set(inner.match(new RegExp(ID, "g")) ?? []);
  const fresh = (base: string) => {
    let name = `${base}_`;
    while (used.has(name)) name += "_";
    used.add(name);
    return name;
  };
  const x = fresh("x");
  const y = fresh("y");
  let out = "";
  let at = 0;
  let seenThis = false;
  let seenNext = false;
  const re = tokenRe(p);
  for (let m = re.exec(inner); m; m = re.exec(inner)) {
    let k = m.index + p.length;
    if (inner[k] !== " ") return undefined;
    while (inner[k] === " ") k++;
    const arg = argumentAt(inner, k);
    if (!arg) return undefined;
    const which = neighbour(arg.text, form, i, j);
    if (!which) return undefined;
    if (which === "this") seenThis = true;
    else seenNext = true;
    out += inner.slice(at, m.index) + (which === "this" ? x : y);
    at = arg.end;
    re.lastIndex = at;
  }
  out += inner.slice(at);
  if (!seenThis || !seenNext) return undefined;
  // nothing left of the place or of the permutation: the condition is about the two values only
  for (const name of [p, i, ...(j ? [j] : [])]) if (tokenRe(name).test(out)) return undefined;
  return `fun ${x} ${y} : Fin ${n} => decide (${out})`;
}

/** `∀ i : Fin K, INNER` and the other ways of saying "every pair of neighbouring places". */
function neighbours(body: string, p: string, n: number): { form: RowForm; relation: string } | undefined {
  const b = stripParens(body);
  const fin = (k: number) => `Fin ${k}`;
  const lt = `(?:(?:I\\.val|↑I|\\(I : ℕ\\)|I\\.1) \\+ 1 < ${n}|(?:I\\.val|↑I|\\(I : ℕ\\)|I\\.1) < ${n - 1}|(?:I\\.val|↑I|\\(I : ℕ\\)|I\\.1) < ${n} - 1)`;
  const forI = (pattern: string, i: string) => pattern.replace(/I/g, i.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  let m: RegExpExecArray | null;
  // ∀ i : Fin (n - 1), INNER
  if ((m = new RegExp(`^∀ \\(?(${ID}) : ${fin(n - 1)}\\)?, (.+)$`).exec(b)) || (m = new RegExp(`^∀ \\(?(${ID}) : Fin \\(${n} - 1\\)\\)?, (.+)$`).exec(b))) {
    const relation = relationOf(m[2], p, "short", m[1], undefined, n);
    return relation ? { form: "short", relation } : undefined;
  }
  // ∀ i : Fin n, guard → INNER   /   ∀ (i : Fin n) (h : guard), INNER   /   ∀ i : Fin n, ∀ h : guard, INNER
  if ((m = new RegExp(`^∀ \\(?(${ID}) : ${fin(n)}\\)?,? ?(?:∀ )?\\(?(?:${ID} : )?(.+?)\\)?(?: →|,) (.+)$`).exec(b))) {
    const i = m[1];
    if (new RegExp(`^${forI(lt, i)}$`).test(m[2].trim())) {
      for (const form of ["guard", "guard-add"] as const) {
        const relation = relationOf(m[3], p, form, i, undefined, n);
        if (relation) return { form, relation };
      }
      return undefined;
    }
  }
  // ∀ i j : Fin n, j.val = i.val + 1 → INNER
  if ((m = new RegExp(`^∀ \\(?(${ID}) (${ID}) : ${fin(n)}\\)?, (.+?) → (.+)$`).exec(b)) || (m = new RegExp(`^∀ \\(?(${ID}) : ${fin(n)}\\)?,? ?∀ \\(?(${ID}) : ${fin(n)}\\)?, (.+?) → (.+)$`).exec(b))) {
    const [, i, j, hyp, inner] = m;
    const v = (name: string) => `(?:${name}\\.val|↑${name}|\\(${name} : ℕ\\)|${name}\\.1)`;
    if (new RegExp(`^(?:${v(j)} = ${v(i)} \\+ 1|${v(i)} \\+ 1 = ${v(j)})$`).test(hyp.trim())) {
      const relation = relationOf(inner, p, "pair", i, j, n);
      return relation ? { form: "pair", relation } : undefined;
    }
  }
  // ∀ i : ℕ, (h : i + 1 < n) → INNER   /   ∀ (i : ℕ) (h : i + 1 < n), INNER
  if ((m = new RegExp(`^∀ \\(?(${ID})(?: : ℕ)?\\)?,? ?(?:∀ )?\\(?${ID} : (${ID}) \\+ 1 < ${n}\\)?(?: →|,) (.+)$`).exec(b)) && m[1] === m[2]) {
    const relation = relationOf(m[3], p, "nat", m[1], undefined, n);
    return relation ? { form: "nat", relation } : undefined;
  }
  return undefined;
}

/** A predicate on permutations — a let's name or a lambda — as its variable and its body. */
function predicate(text: string, lets: LetDef[]): { variable: string; body: string } | undefined {
  const t = stripParens(text);
  const named = lets.find((l) => l.name === t);
  return lambda(named ? named.value : t);
}

/** The statement as a count of arrangements in a row, or undefined. */
export function rowShape(theoremType: string): RowShape | undefined {
  const t = squash(theoremType);
  if (!t.startsWith(":")) return undefined;
  const split = splitLets(t);
  const lets = split?.lets ?? [];
  const body = stripParens(split?.body ?? t.slice(1));
  if (lets.some((l) => SCRIPT_NAMES.has(l.name))) return undefined;
  const perm = /Equiv\.Perm \(Fin (\d+)\)/.exec(t);
  if (!perm) return undefined;
  const n = Number(perm[1]);
  if (n < 2 || n > 12 || [...t.matchAll(/Equiv\.Perm \(Fin (\d+)\)/g)].some((m) => Number(m[1]) !== n)) return undefined;
  const eq = new RegExp(`^(.+) = ${NUM}$`).exec(body);
  if (!eq) return undefined;
  const lhs = stripParens(eq[1]);
  const total = Number(eq[2]);

  let count: RowCount;
  let pred: { variable: string; body: string } | undefined;
  let m: RegExpExecArray | null;
  const univ = `(?:Finset\\.univ|\\(Finset\\.univ : Finset \\(Equiv\\.Perm \\(Fin ${n}\\)\\)\\))`;
  if ((m = new RegExp(`^\\(${univ}\\.filter (.+)\\)\\.card$`).exec(lhs)) || (m = new RegExp(`^\\(Finset\\.filter (.+) ${univ}\\)\\.card$`).exec(lhs)) || (m = new RegExp(`^Finset\\.card \\(Finset\\.filter (.+) ${univ}\\)$`).exec(lhs)) || (m = new RegExp(`^Finset\\.card \\(${univ}\\.filter (.+)\\)$`).exec(lhs))) {
    count = "filter";
    pred = predicate(m[1], lets);
  } else if ((m = new RegExp(`^(Fintype\\.card|Nat\\.card) \\{ ?(${ID}) : Equiv\\.Perm \\(Fin ${n}\\) // (.+?) ?\\}$`).exec(lhs))) {
    count = m[1] === "Fintype.card" ? "subtype" : "natcard";
    pred = applied(m[3], m[2], lets);
  } else if ((m = new RegExp(`^Set\\.ncard \\{ ?(${ID}) : Equiv\\.Perm \\(Fin ${n}\\) \\| (.+?) ?\\}$`).exec(lhs)) || (m = new RegExp(`^\\(?\\{ ?(${ID}) : Equiv\\.Perm \\(Fin ${n}\\) \\| (.+?) ?\\}(?: : Set \\(Equiv\\.Perm \\(Fin ${n}\\)\\)\\))?\\.ncard$`).exec(lhs))) {
    count = "ncard";
    pred = applied(m[2], m[1], lets);
  } else return undefined;
  if (!pred) return undefined;
  const nb = neighbours(inlineLets(pred.body, lets), pred.variable, n);
  if (!nb) return undefined;
  return { n, total, relation: nb.relation, form: nb.form, count, lets: lets.map((l) => l.name) };
}

/** `Good p` (a let applied to the bound variable) or the condition itself, as a predicate in `p`. */
function applied(text: string, variable: string, lets: LetDef[]): { variable: string; body: string } | undefined {
  const t = stripParens(text);
  const m = new RegExp(`^(${ID}) (${ID})$`).exec(t);
  if (m && m[2] === variable) {
    const named = lets.find((l) => l.name === m[1]);
    return named ? lambda(named.value) : undefined;
  }
  return { variable, body: t };
}

/** The rows after one more place: every row extended at the front by every value not in it that the relation allows before its first. */
const extend = (n: number, relation: string) =>
  `(fun L : List (List (Fin ${n})) => L.flatMap (fun l => ((List.finRange ${n}).filter (fun x => decide (x ∉ l) && l.head?.all (fun y => (${relation}) x y))).map (fun x => x :: l)))`;

/**
 * Lean's own count (`#eval`, outside the proof): the number of rows after 1, 2, …, n places. No
 * row is built for it — the rows that use the same values and begin with the same one are kept as
 * one number (at most 2ⁿ · n of them), so it counts whatever the size; the last number is the
 * number of arrangements, the sum what the kernel would have to build.
 */
export function rowEvalCommand(shape: RowShape): string {
  const { n, relation } = shape;
  const table = `Std.HashMap (Nat × Fin ${n}) Nat`;
  return [
    `#eval`,
    `  let R : Fin ${n} → Fin ${n} → Bool := (${relation})`,
    `  let step := fun (S : ${table}) =>`,
    `    S.fold (fun (T : ${table}) (key : Nat × Fin ${n}) (c : Nat) =>`,
    `      (List.finRange ${n}).foldl (fun (T : ${table}) (x : Fin ${n}) =>`,
    `        if !key.1.testBit x.val && R x key.2 then T.insert (key.1 ||| 2 ^ x.val, x) (T.getD (key.1 ||| 2 ^ x.val, x) 0 + c) else T) T) {}`,
    `  let start : ${table} := (List.finRange ${n}).foldl (fun T x => T.insert (2 ^ x.val, x) 1) {}`,
    `  ((List.range (${n} - 1)).foldl (fun (acc : ${table} × List Nat) _ =>`,
    `      let S := step acc.1; (S, acc.2 ++ [S.fold (fun a _ c => a + c) 0])) (start, [${n}])).2`,
  ].join("\n");
}

/** `[8, 42, 180]` from the #eval output. */
export function parseLevels(text: string): number[] | undefined {
  const t = text.replace(/\s+/g, "");
  return /^\[(\d+(,\d+)*)?\]$/.test(t) ? (JSON.parse(t) as number[]) : undefined;
}

/**
 * The lemma, for any `n` and any relation — two `have`s:
 *  row_enum   the rows after `k` places are exactly the lists of length `k` without repetition
 *             whose neighbours are related, each once (induction on `k`);
 *  row_count  the permutations whose neighbouring values are related are as many as the rows
 *             after `n` places (`p ↦ List.ofFn p` is a bijection onto them).
 */
export const ROW_LEMMA = `have row_enum : ∀ (n : ℕ) (R : Fin n → Fin n → Bool) (E : List (List (Fin n)) → List (List (Fin n))),
    (∀ L, E L = L.flatMap (fun l => ((List.finRange n).filter (fun x => decide (x ∉ l) && l.head?.all (fun y => R x y))).map (fun x => x :: l))) →
    ∀ k : ℕ, (∀ l : List (Fin n), l ∈ E^[k] [[]] ↔ (l.length = k ∧ l.Nodup ∧ l.IsChain (fun a b => R a b = true))) ∧ (E^[k] [[]]).Nodup := by
  intro n R E hE k
  induction k with
  | zero =>
    refine ⟨fun l => ?_, by simp⟩
    simp only [Function.iterate_zero, id_eq, List.mem_singleton]
    constructor
    · rintro rfl
      simp
    · rintro ⟨h, -, -⟩
      exact List.length_eq_zero_iff.mp h
  | succ k ih =>
    obtain ⟨hm, hn⟩ := ih
    rw [Function.iterate_succ_apply', hE]
    refine ⟨fun l => ?_, ?_⟩
    · simp only [List.mem_flatMap, List.mem_map, List.mem_filter, List.mem_finRange, true_and, Bool.and_eq_true, decide_eq_true_eq, hm]
      constructor
      · rintro ⟨t, ⟨hlen, hnd, hch⟩, x, ⟨hx, hok⟩, rfl⟩
        refine ⟨by simp [hlen], List.nodup_cons.mpr ⟨hx, hnd⟩, List.isChain_cons.mpr ⟨?_, hch⟩⟩
        cases t with
        | nil => simp
        | cons y t => simpa using hok
      · rintro ⟨hlen, hnd, hch⟩
        cases l with
        | nil => simp at hlen
        | cons x t =>
          rw [List.nodup_cons] at hnd
          rw [List.isChain_cons] at hch
          refine ⟨t, ⟨by simpa using hlen, hnd.2, hch.2⟩, x, ⟨hnd.1, ?_⟩, rfl⟩
          cases t with
          | nil => simp
          | cons y t => simpa using hch.1
    · rw [List.nodup_flatMap]
      refine ⟨fun t _ => ?_, ?_⟩
      · exact ((List.nodup_finRange n).filter _).map (fun a b h => (List.cons.inj h).1)
      · refine hn.imp (fun {a b} hab => ?_)
        intro z hz1 hz2
        simp only [List.mem_map] at hz1 hz2
        obtain ⟨x, -, rfl⟩ := hz1
        obtain ⟨y, -, h⟩ := hz2
        exact hab (List.cons.inj h).2.symm
have row_count : ∀ (n : ℕ) (R : Fin n → Fin n → Bool) (P : Equiv.Perm (Fin n) → Prop) [DecidablePred P],
    (∀ p, P p ↔ ∀ i : Fin n, ∀ h : i.val + 1 < n, R (p i) (p ⟨i.val + 1, h⟩) = true) →
    (Finset.univ.filter P).card = ((fun L : List (List (Fin n)) => L.flatMap (fun l => ((List.finRange n).filter (fun x => decide (x ∉ l) && l.head?.all (fun y => R x y))).map (fun x => x :: l)))^[n] [[]]).length := by
  intro n R P _ hP
  obtain ⟨hmem, hnd⟩ := row_enum n R _ (fun _ => rfl) n
  rw [← List.toFinset_card_of_nodup hnd]
  refine Finset.card_bij (fun p _ => List.ofFn (⇑p)) ?_ ?_ ?_
  · intro p hp
    simp only [Finset.mem_filter, Finset.mem_univ, true_and] at hp
    rw [List.mem_toFinset, hmem]
    exact ⟨List.length_ofFn, List.nodup_ofFn.mpr p.injective, List.isChain_ofFn.mpr (fun i hi => (hP p).mp hp ⟨i, by omega⟩ hi)⟩
  · intro p _ q _ h
    exact Equiv.ext (congrFun (List.ofFn_injective h))
  · intro l hl
    rw [List.mem_toFinset, hmem] at hl
    obtain ⟨hlen, hnd', hch⟩ := hl
    have hinj : Function.Injective (fun i : Fin n => l[i.val]'(by rw [hlen]; exact i.isLt)) := by
      intro i j hij
      exact Fin.ext ((hnd'.getElem_inj_iff).mp hij)
    refine ⟨Equiv.ofBijective _ (Finite.injective_iff_bijective.mp hinj), ?_, ?_⟩
    · simp only [Finset.mem_filter, Finset.mem_univ, true_and]
      rw [hP]
      intro i h
      exact (List.isChain_iff_getElem.mp hch) i.val (by rw [hlen]; exact h)
    · refine List.ext_getElem (by rw [List.length_ofFn, hlen]) (fun i h1 h2 => ?_)
      rw [List.getElem_ofFn]
      rfl`;

/** The statement's condition is the lemma's: both directions, by what the statement's way of naming the neighbours unfolds to. */
function bridge(form: RowForm, n: number): string[] {
  const to: Record<RowForm, string[]> = {
    short: ["exact decide_eq_true (H_ ⟨i_.val, by omega⟩)"],
    guard: ["exact decide_eq_true (H_ i_ (by omega))"],
    "guard-add": ["rw [← hadd_ i_ h_]", "exact decide_eq_true (H_ i_ (by omega))"],
    pair: ["exact decide_eq_true (H_ i_ ⟨i_.val + 1, h_⟩ rfl)"],
    nat: ["exact decide_eq_true (H_ i_.val h_)"],
  };
  const from: Record<RowForm, string[]> = {
    short: ["intro H_ i_", "exact of_decide_eq_true (H_ ⟨i_.val, by omega⟩ (by simp only []; omega))"],
    guard: ["intro H_ i_ h_", "exact of_decide_eq_true (H_ i_ (by omega))"],
    "guard-add": ["intro H_ i_ h_", "have e_ := H_ i_ (by omega)", "rw [← hadd_ i_ (by omega)] at e_", "exact of_decide_eq_true e_"],
    pair: ["intro H_ i_ j_ hij_", `have hb_ : i_.val + 1 < ${n} := by omega`, "obtain rfl : j_ = ⟨i_.val + 1, hb_⟩ := Fin.ext (by omega)", "exact of_decide_eq_true (H_ i_ hb_)"],
    nat: ["intro H_ i_ h_", "exact of_decide_eq_true (H_ ⟨i_, by omega⟩ h_)"],
  };
  return [
    ...(form === "guard-add" ? [`have hadd_ : ∀ (i : Fin ${n}) (h : i.val + 1 < ${n}), i + 1 = ⟨i.val + 1, h⟩ := by decide`] : []),
    "intro p_",
    "constructor",
    "· intro H_ i_ h_",
    ...to[form].map((l) => `  ${l}`),
    ...from[form].map((l, k) => (k === 0 ? `· ${l}` : `  ${l}`)),
  ];
}

/** The whole proof: the lets, the lemma, the count turned into a filter's card, the statement's condition read as the relation, the kernel's count. */
export function rowScript(shape: RowShape): string {
  const { n, relation, form, count, lets } = shape;
  const pre: Record<RowCount, string[]> = {
    filter: [],
    subtype: ["rw [Fintype.card_subtype]"],
    // (`classical`: a condition over `i : ℕ` has no decision procedure of its own, and none is needed — the lemma takes any)
    natcard: ["classical", "rw [Nat.card_eq_fintype_card, Fintype.card_subtype]"],
    ncard: ["classical", "rw [Set.ncard_eq_toFinset_card', Set.toFinset_ofPred]"],
  };
  return [
    ...(lets.length ? [`intro ${lets.join(" ")}`] : []),
    ROW_LEMMA,
    ...pre[count],
    `refine (row_count ${n} (${relation}) _ ?_).trans ?_`,
    ...bridge(form, n).map((l, k) => (k === 0 ? `· ${l}` : `  ${l}`)),
    "· decide +kernel",
  ].join("\n");
}
