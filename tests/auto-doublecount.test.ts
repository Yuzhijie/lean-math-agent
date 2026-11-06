import { describe, expect, it } from "vitest";
import { doubleCountFinishers, setSystem } from "@/lib/lean/auto/doublecount";
import { finisherEntries } from "@/lib/lean/auto/rules";
import { parseGoal } from "@/lib/lean/geometry/goal";

const goal = [
  "U : Type u_1",
  "inst✝¹ : Fintype U",
  "inst✝ : DecidableEq U",
  "hU : Fintype.card U = 20",
  "A : Fin 6 → Finset U",
  "h_membership : ∀ (x : U), {i | x ∈ A i}.card = 3",
  "k : ℕ",
  "h_pairwise : ∀ (i j : Fin 6), i < j → (A i ∩ A j).card = k",
  "⊢ k = 4",
].join("\n");

describe("double counting in a set system", () => {
  it("reads sets, degree, pairwise intersections and |U| from the goal", () => {
    expect(setSystem(parseGoal(goal)!)).toMatchObject({ sets: "A", ground: "U", m: 6, r: 3, rel: "<", k: "k", memHyp: "h_membership", pairHyp: "h_pairwise", n: 20 });
  });

  it("writes C(6,2)·k = 20·C(3,2), then closes the goal; offered as the double-counting rule", () => {
    const fs = doubleCountFinishers(parseGoal(goal)!);
    expect(fs[0]).toMatch(/^\(have hdc : 15 \* k = 20 \* 3 := \(by .*decide \+kernel.*Finset\.sum_comm.*; omega\)$/);
    expect(finisherEntries(parseGoal(goal)!).find((e) => e.rule === "double-counting")?.tactic).toBe(fs[0]);
  });

  it("ordered pairs (i ≠ j), Fin N as the ground type, the filter spelling", () => {
    const g = parseGoal("A : Fin 5 → Finset (Fin 10)\nh : ∀ (x : Fin 10), (Finset.filter (fun i => x ∈ A i) Finset.univ).card = 2\nhp : ∀ (i j : Fin 5), i ≠ j → (A i ∩ A j).card = 1\n⊢ False")!;
    const s = setSystem(g)!;
    expect(s).toMatchObject({ m: 5, r: 2, rel: "≠", k: "1", n: 10, cardRw: "Finset.card_univ, Fintype.card_fin" });
    expect(doubleCountFinishers(g)[0]).toContain("have hdc : 20 * 1 = 10 * 2");
  });

  it("nothing without every ingredient", () => {
    expect(setSystem(parseGoal("A : Fin 6 → Finset U\nhU : Fintype.card U = 20\n⊢ True")!)).toBeUndefined();
  });
});
