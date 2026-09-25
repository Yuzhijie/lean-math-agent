import { beforeEach, describe, expect, it, vi } from "vitest";

const { chatJsonMock } = vi.hoisted(() => ({ chatJsonMock: vi.fn() }));
vi.mock("@/lib/llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/client")>();
  return { ...actual, chatJson: chatJsonMock };
});

import { compileExpr, ExprError } from "@/lib/figure/expr";
import { buildFigure } from "@/lib/figure/check";
import { FigureError, dist, solveFigure, solveTriangle } from "@/lib/figure/solve";
import { figureSpecSchema, type FigureSpec } from "@/lib/figure/spec";
import { renderFigureSvg } from "@/lib/figure/render";
import { generateFigure, mightNeedFigure } from "@/lib/figure/generate";

const spec = (s: Partial<FigureSpec> & Record<string, unknown>): FigureSpec => figureSpecSchema.parse({ needed: true, ...s });
const close = (a: number, b: number, tol = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(tol);

describe("compileExpr", () => {
  it("evaluates textbook notation with implicit multiplication", () => {
    close(compileExpr("x^2 - 2x - 3")(3), 0);
    close(compileExpr("2(x+1)(x-1)")(2), 6);
    close(compileExpr("-x^2")(3), -9);
    close(compileExpr("2^-x")(1), 0.5);
    close(compileExpr("sin(pi/2) + sqrt(x)")(4), 3);
    close(compileExpr("|x - 1| + 2sin x")(0), 1);
    close(compileExpr("1/(x-1)")(3), 0.5);
    close(compileExpr("3x²")(2), 12);
    close(compileExpr("ln(e)")(0), 1);
    close(compileExpr("x**3")(2), 8);
  });

  it("rejects anything that is not a math expression", () => {
    expect(() => compileExpr("process.exit()")).toThrow(ExprError);
    expect(() => compileExpr("x +")).toThrow(ExprError);
    expect(() => compileExpr("(x+1")).toThrow(ExprError);
    expect(() => compileExpr("y + 1")).toThrow(ExprError);
    expect(() => compileExpr("x; alert(1)")).toThrow(ExprError);
  });
});

describe("solveTriangle", () => {
  const D = Math.PI / 180;
  it("solves SSS, SAS, ASA and isosceles data", () => {
    const sss = solveTriangle({ a: 3, b: 4, c: 5 });
    close(sss.C / D, 90, 1e-6);
    const sas = solveTriangle({ b: 2, c: 2, A: 60 * D });
    close(sas.a, 2);
    const asa = solveTriangle({ a: 10, B: 30 * D, C: 60 * D });
    close(asa.b, 5);
    const iso = solveTriangle({ a: 6, b: 5 }, 0);
    close(iso.c, 5);
  });

  it("fills missing data with defaults and reports it", () => {
    const warnings: string[] = [];
    const t = solveTriangle({ A: 90 * D }, undefined, warnings);
    close((t.A + t.B + t.C) / D, 180, 1e-9);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("rejects impossible triangles", () => {
    expect(() => solveTriangle({ a: 1, b: 2, c: 5 })).toThrow(FigureError);
    expect(() => solveTriangle({ a: 1, b: 5, A: 80 * D })).toThrow(FigureError);
  });
});

describe("solveFigure + checks", () => {
  it("builds an isosceles triangle with its altitude, and the conditions hold", () => {
    const fig = buildFigure(
      spec({
        constructions: [
          { op: "triangle", ids: ["A", "B", "C"], sides: { AB: 5, AC: 5, BC: 6 }, isosceles_at: "A" },
          { op: "foot", id: "D", from: "A", line: ["B", "C"] },
        ],
        claims: [
          { type: "perpendicular", lines: [["A", "D"], ["B", "C"]] },
          { type: "equal_length", segments: [["B", "D"], ["D", "C"]] },
          { type: "length", segment: ["A", "D"], value: 4 },
        ],
      }),
    );
    expect(fig.verified).toBe(true);
    close(dist(fig.points.A, fig.points.D), 4);
    // Implicit claims from the construction data are checked too.
    expect(fig.claims.length).toBe(3 + 3);
  });

  it("flags a figure whose data contradict a claim (sketch, not verified)", () => {
    const fig = buildFigure(
      spec({
        constructions: [{ op: "triangle", ids: ["A", "B", "C"], sides: { AB: 3, BC: 4, AC: 5 } }],
        claims: [{ type: "angle", points: ["A", "C", "B"], value: 90 }],
      }),
    );
    expect(fig.verified).toBe(false);
    expect(fig.claims.find((c) => !c.ok)?.detail).toMatch(/∠ACB/);
  });

  it("supports circles, intersections, rotations, bisectors and shapes placed on existing points", () => {
    const fig = buildFigure(
      spec({
        constructions: [
          { op: "square", ids: ["A", "B", "C", "D"], side: 4 },
          { op: "intersection", id: "O", line1: ["A", "C"], line2: ["B", "D"] },
          { op: "circumcircle", id: "c", of: ["A", "B", "C"], center_id: "O2" },
          { op: "triangle", ids: ["E", "A", "B"], equilateral: true },
          { op: "rotate", id: "B1", of: "B", center: "A", angle: 90 },
          { op: "angle_bisector_point", id: "F", vertex: "A", from: "B", to: "D" },
          { op: "point_on_circle", id: "P", circle: "c", angle: 30 },
        ],
        claims: [
          { type: "equal_length", segments: [["O", "A"], ["O", "B"]] },
          { type: "on_circle", point: "D", circle: "c" },
          { type: "length", segment: ["E", "A"], value: 4 },
          { type: "collinear", points: ["A", "D", "B1"] },
          { type: "concyclic", points: ["A", "B", "C", "P"] },
          { type: "equal_length", segments: [["B", "F"], ["F", "D"]] },
        ],
      }),
    );
    expect(fig.claims.filter((c) => !c.ok)).toEqual([]);
    close(fig.points.O.x, fig.points.O2.x);
    expect(fig.warnings).toEqual([]);
  });

  it("reports construction errors with the offending construction", () => {
    expect(() => solveFigure(spec({ constructions: [{ op: "midpoint", id: "M", of: ["A", "B"] }] }))).toThrow(/midpoint M：点 A 尚未定义/);
    expect(() =>
      solveFigure(
        spec({
          constructions: [
            { op: "point", id: "A", x: 0, y: 0 },
            { op: "point", id: "B", x: 1, y: 0 },
            { op: "point", id: "C", x: 0, y: 1 },
            { op: "point", id: "D", x: 1, y: 1 },
            { op: "intersection", id: "X", line1: ["A", "B"], line2: ["C", "D"] },
          ],
        }),
      ),
    ).toThrow(/平行/);
    expect(() => solveFigure(spec({ constructions: [{ op: "triangle", ids: ["A", "B", "C"], sides: { XY: 3 } }] }))).toThrow(/无法识别/);
  });

  it("puts points on function graphs and checks them", () => {
    const fig = buildFigure(
      spec({
        axes: { x: [-3, 5], y: [-5, 6] },
        functions: [{ id: "f", expr: "x^2-2x-3" }],
        constructions: [
          { op: "function_point", id: "A", fn: "f", x: -1 },
          { op: "function_point", id: "P", fn: "f", x: 1 },
        ],
        claims: [
          { type: "function_passes", fn: "f", x: 3, y: 0 },
          { type: "function_passes", fn: "f", x: 0, y: 1 },
        ],
      }),
    );
    close(fig.points.P.y, -4);
    expect(fig.claims.map((c) => c.ok)).toEqual([true, false]);
  });
});

describe("regression: right triangle with the incentres of ABD and ACD", () => {
  const text = "在直角三角形 $ABC$ 中，$\\angle A=90^\\circ$，$AB=6$，$AC=8$。从点 $A$ 向斜边 $BC$ 作垂线，垂足为 $D$。设 $I_1$、$I_2$ 分别为三角形 $ABD$、$ACD$ 的内心，求 $I_1I_2^2$。";

  it("passes the pre-filter, also with LaTeX-only wording", () => {
    expect(mightNeedFigure(text)).toBe(true);
    expect(mightNeedFigure("设 $\\triangle PQR$ 满足 $PQ=QR$")).toBe(true);
    expect(mightNeedFigure("$\\angle ABC = 30^\\circ$，求 $\\sin$ 值")).toBe(true);
  });

  it("builds a checked figure with I1I2² = 8", () => {
    const fig = buildFigure(
      spec({
        constructions: [
          { op: "triangle", ids: ["A", "B", "C"], sides: { AB: 6, AC: 8 }, angles: { A: 90 } },
          { op: "foot", id: "D", from: "A", line: ["B", "C"] },
          { op: "incircle", id: "w1", of: ["A", "B", "D"], center_id: "I1" },
          { op: "incircle", id: "w2", of: ["A", "C", "D"], center_id: "I2" },
        ],
        claims: [
          { type: "perpendicular", lines: [["A", "D"], ["B", "C"]] },
          { type: "length", segment: ["I1", "I2"], value: Math.sqrt(8) },
        ],
      }),
    );
    expect(fig.verified).toBe(true);
    close(dist(fig.points.I1, fig.points.I2) ** 2, 8);
    close(fig.circles.w1.r, 1.2);
    close(fig.circles.w2.r, 1.6);
  });
});

describe("renderFigureSvg", () => {
  const fig = buildFigure(
    spec({
      title: "三角形 <ABC>",
      constructions: [
        { op: "triangle", ids: ["A", "B", "C"], sides: { AB: 5, AC: 5, BC: 6 } },
        { op: "foot", id: "D", from: "A", line: ["B", "C"] },
      ],
      draw: [
        { type: "segment", a: "A", b: "D", id: "AD", dashed: true, label: "h" },
        { type: "angle", vertex: "D", from: "A", to: "C", right: true },
        { type: "equal_marks", segments: [["A", "B"], ["A", "C"]] },
      ],
      step_highlights: [{ step: 1, ids: ["AD", "D"] }],
    }),
  );

  it("draws shapes, auxiliary lines, marks and escaped labels", () => {
    const svg = renderFigureSvg(fig);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("<polygon");
    expect(svg).toContain('stroke-dasharray="6 4"');
    expect(svg).toContain("&lt;ABC&gt;");
    for (const n of ["A", "B", "C", "D"]) expect(svg).toContain(`>${n}</text>`);
    expect(svg).not.toMatch(/NaN|Infinity/);
  });

  it("highlights the elements of a step", () => {
    const plain = renderFigureSvg(fig);
    const hi = renderFigureSvg(fig, { highlight: ["AD", "D"] });
    expect(plain).not.toContain("#f59e0b");
    expect(hi).toContain("#f59e0b");
  });

  it("plots functions on axes and breaks the curve at discontinuities", () => {
    const g = buildFigure(spec({ axes: { x: [-4, 4], y: [-5, 5] }, functions: [{ id: "f", expr: "1/x", label: "y=1/x" }] }));
    const svg = renderFigureSvg(g);
    expect((svg.match(/<polyline/g) ?? []).length).toBe(2);
    expect(svg).toContain(">y=1/x</text>");
    expect(svg).not.toMatch(/NaN|Infinity/);
  });
});

describe("generateFigure", () => {
  beforeEach(() => {
    chatJsonMock.mockReset();
  });

  const good = {
    needed: true,
    constructions: [
      { op: "triangle", ids: ["A", "B", "C"], sides: { AB: 5, AC: 5, BC: 6 }, isosceles_at: "A" },
      { op: "foot", id: "D", from: "A", line: ["B", "C"] },
    ],
    claims: [{ type: "perpendicular", lines: [["A", "D"], ["B", "C"]] }],
  };

  it("skips problems without geometric or graphical content", async () => {
    expect(mightNeedFigure("求方程 2x+3=7 的解")).toBe(false);
    expect(mightNeedFigure("在 △ABC 中，AB=AC")).toBe(true);
    expect(mightNeedFigure("二次函数 y=x^2 的图像")).toBe(true);
    const r = await generateFigure({ problemText: "计算 12 × 15" });
    expect(r).toEqual({ reason: "not_needed", attempts: 0 });
    expect(chatJsonMock).not.toHaveBeenCalled();
  });

  it("returns a verified figure from the first attempt", async () => {
    chatJsonMock.mockResolvedValueOnce(figureSpecSchema.parse(good));
    const r = await generateFigure({ problemText: "等腰三角形 ABC 中 AB=AC=5，BC=6，求 BC 边上的高" });
    expect(r.figure?.verified).toBe(true);
    expect(r.attempts).toBe(1);
  });

  it("feeds construction errors back once and keeps the repaired figure", async () => {
    chatJsonMock
      .mockResolvedValueOnce(figureSpecSchema.parse({ needed: true, constructions: [{ op: "foot", id: "D", from: "A", line: ["B", "C"] }] }))
      .mockResolvedValueOnce(figureSpecSchema.parse(good));
    const r = await generateFigure({ problemText: "三角形 ABC 中 AD ⊥ BC" });
    expect(r.figure?.verified).toBe(true);
    expect(r.attempts).toBe(2);
    const repairPrompt = (chatJsonMock.mock.calls[1][0] as { user: string }).user;
    expect(repairPrompt).toContain("点 A 尚未定义");
  });

  it("honours needed:false from the model", async () => {
    chatJsonMock.mockResolvedValueOnce(figureSpecSchema.parse({ needed: false }));
    const r = await generateFigure({ problemText: "角度换算：30° 等于多少弧度", force: true });
    expect(r.reason).toBe("not_needed");
  });
});
