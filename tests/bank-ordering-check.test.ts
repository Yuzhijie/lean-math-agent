import { describe, expect, it } from "vitest";
import { buildVisual, visualSpecSchema } from "@/lib/figure/visual";
import { arrangements, orderingCheck, readClues } from "@/lib/bank/ordering-check";

const STREET = { kind: "street", items: [{ thing: "house" }, { thing: "house" }, { thing: "house" }, { thing: "tree" }, { thing: "house" }] };
const q = (stem: string, options: string[], answer: string, spec: unknown = STREET) => {
  const v = buildVisual(visualSpecSchema.parse(spec));
  return { stem, type: "multiple_choice", options, answer, figure: { spec, description: v.description } };
};

describe("left-to-right ordering questions are solved by the program", () => {
  it("the paper's question: two mirror orders fit, the tree between the third and fourth house decides", () => {
    const stem = "Pete, Sita, Lin and Ben are friends.\nThey live in these four houses.\nPete and Sita each live 100 paces from Lin.\nLin and Sita each live 50 paces from Ben.\nWhat is the order of the four friend's houses from left to right?";
    const names = ["Pete", "Sita", "Lin", "Ben"];
    const { clues, unread } = readClues(stem, names);
    expect(clues).toHaveLength(4);
    expect(unread).toEqual([]);
    expect(arrangements(names, clues)).toHaveLength(2); // Sita Ben Lin Pete, and its mirror
    const opts = ["Ben, Lin, Pete, Sita", "Sita, Ben, Lin, Pete", "Ben, Sita, Lin, Pete", "Pete, Lin, Ben, Sita"];
    expect(orderingCheck(q(stem, opts, "B"))).toEqual({ mismatch: false, detail: expect.stringMatching(/only Sita, Ben, Lin, Pete|只有 Sita, Ben, Lin, Pete/) });
    expect(orderingCheck(q(stem, opts, "D"))!.mismatch).toBe(true);
    // Evenly spaced houses do not decide between the mirror images.
    expect(orderingCheck(q(stem, opts, "B", { kind: "street", items: [{ thing: "house" }, { thing: "house" }, { thing: "house" }, { thing: "house" }] }))!.detail).toMatch(/not unique|不唯一/);
  });

  it("catches the generated question whose clues contradict each other", () => {
    const stem = "Maya, Theo, Rosa and Ivo live in the four houses shown. Maya and Theo each live 90 paces from Rosa. Rosa and Theo each live 40 paces from Ivo. Maya's house is to the right of Rosa's house. What is the order of the four friends' houses from left to right?";
    const r = orderingCheck(q(stem, ["Theo, Ivo, Rosa, Maya", "Ivo, Theo, Rosa, Maya", "Theo, Rosa, Ivo, Maya", "Maya, Rosa, Ivo, Theo"], "A"));
    expect(r).toEqual({ mismatch: true, detail: expect.stringMatching(/contradicts itself|自相矛盾/) });
  });

  it("left/right clues, a wrong answer key, and questions it does not handle", () => {
    const stem = "Eva's house is 50 paces to the left of Nora's house. Nora's house is 50 paces to the left of Omar's house. Liam's house is 100 paces to the right of Omar's house. What is the order of the four houses from left to right?";
    const opts = ["Eva, Nora, Omar, Liam", "Nora, Eva, Omar, Liam", "Eva, Omar, Nora, Liam", "Liam, Omar, Nora, Eva"];
    expect(orderingCheck(q(stem, opts, "A"))!.mismatch).toBe(false);
    expect(orderingCheck(q(stem, opts, "C"))!.detail).toMatch(/option A|选项 A/);
    expect(orderingCheck(q(stem.replace("left to right", "right to left"), opts, "D"))!.mismatch).toBe(false);
    // Not an ordering question.
    expect(orderingCheck(q("How far is it?", ["10", "20", "30", "40"], "A"))).toBeNull();
    // A clue the program cannot read and several orders: left to the solver.
    expect(orderingCheck(q("Eva and Nora live 50 paces apart. Omar lives next door to Eva. Liam and Omar live 100 paces apart. What is the order from left to right?", opts, "A"))).toBeNull();
  });
});
