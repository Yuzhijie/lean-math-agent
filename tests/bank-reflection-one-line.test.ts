import { describe, expect, it } from "vitest";
import { mirrorChoiceAnswer, shapeKey, transformCells } from "@/lib/figure/reflection";
import { buildVisual, VISUAL_GUIDE, visualSpecSchema } from "@/lib/figure/visual";
import { reflectionCheck } from "@/lib/bank/generate";

// "Jack flipped this shape across the dashed line to form a new shape. What did his new shape look like?"
// Four squares, each split by a diagonal with one half shaded; one vertical mirror line; four picture
// choices in a 2 by 2 grid. On the printed paper the answer is A.
const JACK = [[0, 0, "tl"], [1, 0, "tr"], [1, 1, "br"], [1, 2, "tr"]] as Array<[number, number, "tl" | "tr" | "br"]>;
const SPEC = { kind: "reflection", mode: "one_line", grid: 3, cells: JACK, cards: ["flip_h", "flip_h_squares", "rotate_180", "flip_v"] };

describe("one mirror line, picture choices", () => {
  it("flips the half-shading with the squares", () => {
    // Choice A on the paper: the tower on the right, top square top-right half, bottom row tl, bl, tl.
    expect(shapeKey(transformCells(JACK, 3, "flip_h"))).toBe(shapeKey([[0, 2, "tr"], [1, 0, "tl"], [1, 1, "bl"], [1, 2, "tl"]]));
    // Moving the squares without flipping the shading is a different picture.
    expect(shapeKey(transformCells(JACK, 3, "flip_h_squares"))).not.toBe(shapeKey(transformCells(JACK, 3, "flip_h")));
    // A quarter turn four times is the shape again; plain squares keep their old keys.
    let t = JACK as Array<[number, number, "tl" | "tr" | "br"]>;
    for (let i = 0; i < 4; i++) t = transformCells(t, 3, "rotate_90");
    expect(shapeKey(t)).toBe(shapeKey(JACK));
    expect(shapeKey([[0, 0], [0, 1]])).toBe("0,0 0,1");
  });

  it("knows the right choice, and catches symmetric shapes and look-alike choices", () => {
    const parse = (s: unknown) => visualSpecSchema.parse(s) as never;
    expect(mirrorChoiceAnswer(parse(SPEC))).toEqual({ flip: "flip_h", rightCards: [1], symmetric: false, duplicateCards: [] });
    expect(mirrorChoiceAnswer(parse({ ...SPEC, first_line: "horizontal" })).rightCards).toEqual([4]);
    // Plain squares in a column look the same flipped left–right.
    expect(mirrorChoiceAnswer(parse({ ...SPEC, cells: [[0, 0], [1, 0]] })).symmetric).toBe(true);
    expect(mirrorChoiceAnswer(parse({ ...SPEC, cards: ["flip_h", "original", "flip_h", "rotate_90"] })).duplicateCards).toEqual([3]);
  });

  it("draws one dashed line, half-shaded squares and four lettered choices, no target boxes", () => {
    const v = buildVisual(visualSpecSchema.parse(SPEC));
    expect(v.source).toBe("program");
    expect(v.svg.match(/stroke-dasharray="6 5"/g)?.length).toBe(1);
    expect(v.svg.match(/<polygon /g)?.length).toBe(20); // 4 half-shaded squares × (shape + 4 choices)
    expect(v.svg).not.toMatch(/rx="3" fill="#ffffff" stroke="#1f1f1f"/);
    for (const l of ["A", "B", "C", "D"]) expect(v.svg).toContain(`>${l}</text>`);
    expect(v.description).toContain("vertical dashed mirror line to its right");
    expect(v.description).toContain("row 1 col 1 (top-left half shaded)");
    expect(v.description).toContain("4 answer pictures in a 2 by 2 grid: A = the shape reflected left–right, B = the squares placed as in a left–right reflection but each square's shading not flipped");
    expect(VISUAL_GUIDE).toContain('mode "one_line"');
  });

  it("the program checks the chosen picture", () => {
    const q = (answer: string, extra: Record<string, unknown> = {}, spec: unknown = SPEC) => {
      const v = buildVisual(visualSpecSchema.parse(spec));
      return { type: "multiple_choice" as const, options: ["A", "B", "C", "D"], answer, figure: { spec, svg: v.svg, description: v.description, source: "program" as const, verified: true }, ...extra };
    };
    expect(reflectionCheck(q("A"))).toEqual({ mismatch: false, detail: expect.stringMatching(/flipped shape is A|翻折后的图形是 A/) });
    expect(reflectionCheck(q("C"))!.detail).toMatch(/is A, not C|是 A，不是 C/);
    expect(reflectionCheck(q("A", { options: ["A", "B", "C"] }))!.mismatch).toBe(true);
    expect(reflectionCheck(q("Picture A", { type: "other", options: undefined }))!.mismatch).toBe(false);
    expect(reflectionCheck(q("A", {}, { ...SPEC, cells: [[0, 0], [1, 0]] }))!.detail).toMatch(/same after the flip|翻折后不变/);
    // The two-line kind is unchanged: it still wants cards and places.
    expect(reflectionCheck(q("A", {}, { ...SPEC, mode: undefined }))!.detail).toMatch(/which card goes where|哪张卡/);
  });
});
