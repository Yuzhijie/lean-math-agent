import { describe, expect, it } from "vitest";
import { buildFigure } from "@/lib/figure/check";
import { FigureError } from "@/lib/figure/solve";
import { figureSpecSchema, type FigureSpec } from "@/lib/figure/spec";
import { withOutputLocale } from "@/lib/llm/output-locale";

const spec = (s: Record<string, unknown>): FigureSpec => figureSpecSchema.parse({ needed: true, ...s });

const triangle = spec({
  constructions: [
    { op: "triangle", ids: ["A", "B", "C"], sides: { AB: 5, AC: 5, BC: 6 }, isosceles_at: "A" },
    { op: "foot", id: "D", from: "A", line: ["B", "C"] },
  ],
  claims: [{ type: "perpendicular", lines: [["A", "D"], ["B", "C"]] }],
});

describe("figure check details follow the output language", () => {
  it("geometry claims: Chinese by default, English under en-US", () => {
    const zh = buildFigure(triangle);
    expect(zh.verified).toBe(true);
    expect(zh.claims.some((c) => c.detail.includes("夹角"))).toBe(true);

    const en = withOutputLocale("en-US", () => buildFigure(triangle));
    expect(en.verified).toBe(true);
    const perp = en.claims.find((c) => c.claim?.type === "perpendicular")!;
    expect(perp.detail).toMatch(/^Angle between AD and BC: 90° \(should be 90°\)$/);
    expect(en.claims.every((c) => !/[一-龥]/.test(c.detail))).toBe(true);
  });

  it("logic checks and errors are English under en-US", () => {
    const tree = spec({ logic: { type: "tree", levels: [{ label: "top", options: ["red", "blue"] }, { label: "pants", options: ["black", "white"] }], answer: 6 } });
    const en = withOutputLocale("en-US", () => buildFigure(tree));
    expect(en.claims.map((c) => c.detail)).toEqual(["4 in total", "The tree diagram counts 4, but the answer says 6"]);

    const bad = spec({ constructions: [{ op: "foot", id: "D", from: "A", line: ["B", "C"] }] });
    expect(() => withOutputLocale("en-US", () => buildFigure(bad))).toThrow(/point A is not defined yet/);
    expect(() => buildFigure(bad)).toThrow(FigureError);
    expect(() => buildFigure(bad)).toThrow(/尚未定义/);
  });
});
