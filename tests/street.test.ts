import { describe, expect, it } from "vitest";
import { buildVisual, VISUAL_GUIDE, VISUAL_KINDS, visualSpecSchema } from "@/lib/figure/visual";
import { answerLeak } from "@/lib/bank/generate";

// "Pete, Sita, Lin and Ben are friends. They live in these four houses. … What is the order of the four
// friends' houses from left to right?" — four coloured houses in a row, a tree between the third and
// fourth, nothing labelled.
const ROW = { kind: "street", items: [{ thing: "house" }, { thing: "house" }, { thing: "house" }, { thing: "tree" }, { thing: "house" }] };

describe("a row of houses", () => {
  it("draws the houses and the tree program-side and describes them left to right", () => {
    const v = buildVisual(visualSpecSchema.parse(ROW));
    expect(v.source).toBe("program");
    expect(v.svg).toContain("<svg");
    expect(v.description).toBe(
      "a row of 5 things along a street, from left to right: 1) a blue house, 2) a yellow house, 3) a pink house, 4) a tree, 5) a purple house; nothing is labelled; grass and a road along the bottom",
    );
    expect(VISUAL_KINDS).toContain("street");
    expect(VISUAL_GUIDE).toContain('{"kind":"street"');
  });

  it("labels and colours when given; flower pots labelled A–D", () => {
    const v = buildVisual(visualSpecSchema.parse({ kind: "street", ground: false, items: ["red", "green", "black", "blue"].map((colour, i) => ({ thing: "pot", colour, label: "ABCD"[i] })) }));
    expect(v.description).toContain('1) a red flower pot labelled "A", 2) a green flower pot labelled "B"');
    for (const l of "ABCD") expect(v.svg).toContain(`>${l}</text>`);
    expect(() => visualSpecSchema.parse({ kind: "street", items: [{ thing: "castle" }] })).toThrow();
  });

  it("names on the houses in the asked order give the answer away", () => {
    const named = { ...ROW, items: ["Eva", "Nora", "Omar", null, "Liam"].map((n) => (n ? { thing: "house", label: n } : { thing: "tree" })) };
    const q = (spec: unknown) => {
      const v = buildVisual(visualSpecSchema.parse(spec));
      return { type: "multiple_choice" as const, options: ["Eva, Nora, Omar, Liam", "Nora, Eva, Omar, Liam", "Eva, Omar, Nora, Liam", "Liam, Omar, Nora, Eva"], answer: "A", figure: { spec, svg: v.svg, description: v.description, source: v.source, verified: true } };
    };
    expect(answerLeak(q(named))).not.toBeNull();
    expect(answerLeak(q(ROW))).toBeNull();
  });
});
