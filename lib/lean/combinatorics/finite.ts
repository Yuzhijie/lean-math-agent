/**
 * Finite statements the kernel can decide once they are in a shape it computes with: the lets
 * unfolded, lambdas beta-reduced, `Set.ncard {x | P x}` / `Nat.card {x // P x}` turned into the
 * card of a `Finset.filter` over a finite type. Each goal is tried with these rewrites and a
 * finisher (`decide +kernel` first — plain `decide` hits the elaborator's recursion limit on
 * anything sizable); a conjunction is split and each part closed on its own.
 */
import { parseGoal } from "../geometry/goal";
import type { TacticRunner } from "../tactic-runner";
import { topIndex } from "./lets";

const MAX_INTROS = 40;
const MAX_GOALS = 12;

/** intro every let, binder and hypothesis; the names of the lets, in order. */
export async function introAll(run: TacticRunner): Promise<string[]> {
  const lets: string[] = [];
  for (let i = 0; i < MAX_INTROS && run.goals().length; i++) {
    const g = parseGoal(run.goals()[0]);
    if (!g) break;
    const t = g.target.trim();
    const l = /^let ([A-Za-z_][\w'₀-₉]*)/.exec(t);
    if (l) {
      if (!(await run.apply(`intro ${l[1]}`))) break;
      lets.push(l[1]);
      continue;
    }
    const all = /^∀ \(?([A-Za-z_][\w'₀-₉]*)/.exec(t);
    if (all) {
      if (!(await run.apply(`intro ${all[1]}`)) && !(await run.apply("intro"))) break;
      continue;
    }
    if (topIndex(t, "→") >= 0 && !/^(∃|¬)/.test(t)) {
      if (!(await run.apply(`intro ${run.fresh("h")}`))) break;
      continue;
    }
    break;
  }
  return lets;
}

function candidates(lets: string[]): string[] {
  const L = lets.join(", ");
  const card = "Set.ncard_eq_toFinset_card', Set.toFinset_setOf";
  const pre = [
    "",
    "beta_reduce; ",
    "dsimp only; ",
    ...(lets.length ? [`simp only [${L}]; `] : []),
    `simp only [${lets.length ? `${L}, ` : ""}${card}]; `,
    "rw [Nat.card_eq_fintype_card, Fintype.card_subtype]; ",
    `simp only [${lets.length ? `${L}, ` : ""}Fintype.card_subtype]; `,
    "simp only [Nat.card_eq_fintype_card, Fintype.card_subtype]; ",
  ];
  const fin = ["decide +kernel", "rfl", "norm_num", "simp", "decide", "omega"];
  const out: string[] = [];
  for (const p of pre) for (const f of fin) out.push(`${p}${f}`);
  return out;
}

/** Close every goal; false (state as Lean left it) when one resists. */
export async function closeFinite(run: TacticRunner, lets: string[]): Promise<boolean> {
  const cands = candidates(lets);
  for (let round = 0; round < MAX_GOALS && run.goals().length; round++) {
    let closed = false;
    const before = run.goals().length;
    for (const c of cands) {
      if ((await run.apply(`· ${c}`)) && run.goals().length < before) {
        closed = true;
        break;
      }
    }
    if (closed) continue;
    const g = parseGoal(run.goals()[0]);
    if (g && topIndex(g.target, " ∧ ") >= 0 && (await run.apply("refine ⟨?_, ?_⟩"))) continue;
    return false;
  }
  return run.goals().length === 0;
}
