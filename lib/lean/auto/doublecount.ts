/**
 * Double counting in a set system: sets A : Fin m → Finset U over a finite type U with
 * |U| = N, every element in exactly r of the sets, and every two sets meeting in k elements.
 * Counting the pairs (x, {i, j}) with x ∈ A i ∩ A j both ways gives C(m, 2) · k = N · C(r, 2)
 * (ordered pairs i ≠ j: m(m − 1) · k = N · r(r − 1)), and the goal follows by omega.
 *
 * The proof: the pair counts for every r-subset of Fin m by `decide +kernel` (m ≤ 8), each
 * intersection's card as a sum of indicators, Finset.sum_comm, the hypotheses summed.
 * 20 elements each in 3 of 6 sets, pairwise intersections equal ⇒ k = 4 had defeated every route
 * ("finite: a goal the kernel could not decide", 195 tactic combinations, the model).
 */
import { isInaccessible, type GoalState } from "../geometry/goal";

const ID = "[A-Za-z_][\\w'₀-₉]*";

export interface SetSystem {
  sets: string;
  ground: string;
  m: number;
  r: number;
  /** "<" (unordered pairs) or "≠" (ordered pairs) */
  rel: "<" | "≠";
  k: string;
  memHyp: string;
  pairHyp: string;
  /** rewrite that turns `Finset.univ.card` (of the ground type) into N, and N */
  cardRw: string;
  n: number;
}

const choose2 = (r: number) => (r * (r - 1)) / 2;

export function setSystem(st: GoalState): SetSystem | undefined {
  const one = (h: { names: string[] }) => h.names.length === 1 && !isInaccessible(h.names[0]);
  for (const h of st.hyps) {
    const fam = new RegExp(`^Fin (\\d+) → Finset (${ID}|\\(Fin \\d+\\))$`).exec(h.type.trim());
    if (!fam || h.names.length !== 1) continue;
    const A = h.names[0];
    const m = Number(fam[1]);
    const U = fam[2].replace(/^\((.*)\)$/, "$1");
    if (m < 2 || m > 8) continue;
    const eA = A.replace(/[.*+?^${}()|[\]\\']/g, "\\$&");
    let mem: { hyp: string; r: number } | undefined;
    let pair: { hyp: string; rel: "<" | "≠"; k: string } | undefined;
    let card: { rw: string; n: number } | undefined;
    const fin = /^Fin (\d+)$/.exec(U);
    if (fin) card = { rw: "Finset.card_univ, Fintype.card_fin", n: Number(fin[1]) };
    for (const g of st.hyps) {
      if (!one(g)) continue;
      const ty = g.type.replace(/\s+/g, " ").trim();
      const mm =
        new RegExp(`^∀ \\(?(${ID})(?: : [^),]+)?\\)?, \\{(${ID}) \\| \\1 ∈ ${eA} \\2\\}\\.card = (\\d+)$`).exec(ty) ??
        new RegExp(`^∀ \\(?(${ID})(?: : [^),]+)?\\)?, \\(Finset\\.filter \\(fun (${ID}) => \\1 ∈ ${eA} \\2\\) Finset\\.univ\\)\\.card = (\\d+)$`).exec(ty);
      if (mm) mem = { hyp: g.names[0], r: Number(mm[3]) };
      const pm = new RegExp(`^∀ \\(?(${ID}) (${ID})(?: : Fin ${m})?\\)?, \\1 (<|≠) \\2 → \\(${eA} \\1 ∩ ${eA} \\2\\)\\.card = (${ID}|\\d+)$`).exec(ty);
      if (pm) pair = { hyp: g.names[0], rel: pm[3] as "<" | "≠", k: pm[4] };
      const cm = new RegExp(`^Fintype\\.card ${U.replace(/[.*+?^${}()|[\]\\']/g, "\\$&")} = (\\d+)$`).exec(ty);
      if (cm && !card) card = { rw: `Finset.card_univ, ${g.names[0]}`, n: Number(cm[1]) };
    }
    if (!mem || !pair || !card || mem.r > m) continue;
    return { sets: A, ground: U, m, r: mem.r, rel: pair.rel, k: pair.k, memHyp: mem.hyp, pairHyp: pair.hyp, cardRw: card.rw, n: card.n };
  }
  return undefined;
}

/** `have hdc : P * k = N * Q` (one tactic), or undefined. */
export function doubleCountHave(s: SetSystem): string {
  const { sets: A, ground: U, m, r, rel } = s;
  const P = `((Finset.univ : Finset (Fin ${m} × Fin ${m})).filter (fun p => p.1 ${rel} p.2))`;
  const pairs = rel === "<" ? choose2(m) : m * (m - 1);
  const per = rel === "<" ? choose2(r) : r * (r - 1);
  return (
    `have hdc : ${pairs} * ${s.k} = ${s.n} * ${per} := (by ` +
    `have hdcP : ∀ S : Finset (Fin ${m}), S.card = ${r} → (${P}.filter (fun p => p.1 ∈ S ∧ p.2 ∈ S)).card = ${per} := (by decide +kernel); ` +
    `have hdcN : ${P}.card = ${pairs} := (by decide +kernel); ` +
    `have hdcC : ∀ p : Fin ${m} × Fin ${m}, (${A} p.1 ∩ ${A} p.2).card = ∑ x : ${U}, if x ∈ ${A} p.1 ∧ x ∈ ${A} p.2 then 1 else 0 := (by intro p; rw [← Finset.card_filter]; congr 1; ext x; simp); ` +
    `have hdcX : ∀ x : ${U}, (${P}.filter (fun p => x ∈ ${A} p.1 ∧ x ∈ ${A} p.2)).card = ${per} := (by intro x; have h := hdcP (Finset.univ.filter (fun i : Fin ${m} => x ∈ ${A} i)) (${s.memHyp} x); simpa using h); ` +
    `have e : ∑ p ∈ ${P}, (${A} p.1 ∩ ${A} p.2).card = ∑ x : ${U}, (${P}.filter (fun p => x ∈ ${A} p.1 ∧ x ∈ ${A} p.2)).card := (by simp only [hdcC, Finset.card_filter]; exact Finset.sum_comm); ` +
    `rw [Finset.sum_congr rfl (fun p hp => ${s.pairHyp} p.1 p.2 (Finset.mem_filter.mp hp).2), Finset.sum_const, hdcN, smul_eq_mul, Finset.sum_congr rfl (fun x _ => hdcX x), Finset.sum_const, ${s.cardRw}, smul_eq_mul] at e; omega)`
  );
}

export function doubleCountFinishers(st: GoalState): string[] {
  const s = setSystem(st);
  if (!s) return [];
  const have = doubleCountHave(s);
  return ["omega", "linarith", "simp_all", "nlinarith [hdc]"].map((f) => `(${have}; ${f})`);
}
