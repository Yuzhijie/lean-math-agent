import { describe, expect, it } from "vitest";
import { buildVisual, visualSpecSchema } from "@/lib/figure/visual";
import { answerLeak } from "@/lib/bank/generate";

// "Eva's house is 50 paces to the left of Nora's … What is the order of the four friends' houses from left to right?"
// The generated figure was a number line with each friend's name at their house: the answer, drawn.
const OPTIONS = ["Eva, Nora, Omar, Liam", "Nora, Eva, Omar, Liam", "Eva, Omar, Nora, Liam", "Liam, Omar, Nora, Eva"];
const q = (spec: unknown, extra: Record<string, unknown> = {}) => {
  const v = buildVisual(visualSpecSchema.parse(spec));
  return { type: "multiple_choice" as const, options: OPTIONS, answer: "A", figure: { spec, svg: v.svg, description: v.description, source: v.source, verified: true }, ...extra };
};
const LINE = (labels: string[]) => ({ kind: "number_line", min: 0, max: 200, step: 50, points: [0, 50, 100, 200].map((value, i) => ({ value, ...(labels[i] ? { label: labels[i] } : {}) })) });

describe("a figure that gives the answer away", () => {
  it("catches the names placed in the asked order", () => {
    expect(answerLeak(q(LINE(["Eva", "Nora", "Omar", "Liam"])))).toMatch(/gives the answer away|已经把答案呈现/);
    // Points listed out of order in the spec are read left to right by value.
    const shuffled = { ...LINE([]), points: [{ value: 200, label: "Liam" }, { value: 0, label: "Eva" }, { value: 100, label: "Omar" }, { value: 50, label: "Nora" }] };
    expect(answerLeak(q(shuffled))).not.toBeNull();
    // Free-text answers too.
    expect(answerLeak(q(LINE(["Eva", "Nora", "Omar", "Liam"]), { type: "other", options: undefined, answer: "Eva, Nora, Omar, Liam" }))).not.toBeNull();
  });

  it("lets through figures that only show what the question gives", () => {
    // Houses without names, only the paces.
    expect(answerLeak(q(LINE([])))).toBeNull();
    // Only the one house the stem names.
    expect(answerLeak(q(LINE(["", "Nora"])))).toBeNull();
    // Every option drawn as a card: all four orders are on the figure, so none is singled out.
    const cards = { kind: "cards", columns: 1, cards: OPTIONS.map((o) => ({ label: o, checkbox: true })) };
    expect(answerLeak(q(cards))).toBeNull();
    // Answers that are not an ordered list are not judged here.
    expect(answerLeak(q(LINE(["Eva", "Nora", "Omar", "Liam"]), { options: ["50", "100", "150", "200"], answer: "B" }))).toBeNull();
  });
});
