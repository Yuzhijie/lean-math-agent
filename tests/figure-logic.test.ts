import { describe, expect, it } from "vitest";
import { buildFigure } from "@/lib/figure/check";
import { mightNeedFigure } from "@/lib/figure/generate";
import { solveGrid, solveOrdering, solveTree, solveVenn } from "@/lib/figure/logic";
import { renderFigureSvg } from "@/lib/figure/render";
import { figureSpecSchema } from "@/lib/figure/spec";
import { FigureError } from "@/lib/figure/solve";

const people = { name: "人", items: ["甲", "乙", "丙"] };
const jobs = { name: "职业", items: ["医生", "教师", "律师"] };

describe("logic grid", () => {
  it("solves a matching puzzle uniquely and checks the answer", () => {
    const r = solveGrid({
      type: "grid",
      categories: [people, jobs],
      constraints: [
        { type: "is_not", a: "甲", b: "医生" },
        { type: "is", a: "乙", b: "律师" },
      ],
      answer: { 甲: ["教师"], 乙: ["律师"], 丙: ["医生"] },
    });
    expect(r.solved.solutions).toBe(1);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    // 甲 row: 医生 ✗, 教师 ✓, 律师 ✗
    expect(r.solved.cells[0][0]).toEqual([-1, 1, -1]);
  });

  it("reports several solutions and a wrong answer", () => {
    const r = solveGrid({
      type: "grid",
      categories: [people, jobs],
      constraints: [{ type: "is_not", a: "甲", b: "医生" }],
      answer: { 甲: ["医生"], 乙: ["教师"], 丙: ["律师"] },
    });
    expect(r.solved.solutions).toBe(4);
    expect(r.checks.filter((c) => !c.ok).map((c) => c.detail).join()).toMatch(/4 种解|答案/);
  });

  it("handles three categories with cross-category constraints", () => {
    const r = solveGrid({
      type: "grid",
      categories: [people, jobs, { name: "城市", items: ["北京", "上海", "广州"] }],
      constraints: [
        { type: "is", a: "甲", b: "教师" },
        { type: "is", a: "医生", b: "北京" },
        { type: "is_not", a: "乙", b: "医生" },
        { type: "is_not", a: "甲", b: "上海" },
      ],
    });
    expect(r.solved.solutions).toBe(1);
    // 丙 is the doctor, so lives in 北京; 甲 not 上海 → 广州; 乙 → 上海
    expect(r.solved.cells[2][1]).toEqual([1, -1, -1]);
    expect(r.solved.cells[0][1]).toEqual([-1, -1, 1]);
  });

  it("flags unencoded conditions and rejects unknown names", () => {
    const r = solveGrid({ type: "grid", categories: [people, jobs], constraints: [{ type: "is", a: "乙", b: "律师" }], unencoded: ["甲比教师年龄大"] });
    expect(r.checks.some((c) => !c.ok && c.detail.includes("甲比教师年龄大"))).toBe(true);
    expect(() => solveGrid({ type: "grid", categories: [people, jobs], constraints: [{ type: "is", a: "丁", b: "律师" }] })).toThrow(/丁/);
  });
});

describe("venn", () => {
  it("solves two sets with a universe", () => {
    const r = solveVenn({
      type: "venn",
      sets: [
        { id: "A", label: "语文", total: 25 },
        { id: "B", label: "数学", total: 30 },
      ],
      intersections: [{ sets: ["A", "B"], count: 12 }],
      universe: 50,
      ask: "neither",
      answer: 7,
    });
    expect(r.solved.regions).toMatchObject({ A: 13, B: 18, AB: 12, none: 7 });
    expect(r.solved.asked).toBe(7);
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  it("finds the intersection from the union", () => {
    const r = solveVenn({ type: "venn", sets: [{ id: "A", label: "跳绳", total: 20 }, { id: "B", label: "踢毽", total: 16 }], intersections: [], union: 30, ask: "A∩B", answer: 6 });
    expect(r.solved.regions.AB).toBe(6);
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  it("solves three sets", () => {
    const r = solveVenn({
      type: "venn",
      sets: [
        { id: "A", label: "语文", total: 20 },
        { id: "B", label: "数学", total: 22 },
        { id: "C", label: "英语", total: 18 },
      ],
      intersections: [
        { sets: ["A", "B"], count: 8 },
        { sets: ["A", "C"], count: 6 },
        { sets: ["B", "C"], count: 7 },
        { sets: ["A", "B", "C"], count: 3 },
      ],
      universe: 45,
      ask: "neither",
    });
    // |A∪B∪C| = 20+22+18-8-6-7+3 = 42
    expect(r.solved.regions.none).toBe(3);
    expect(r.solved.regions.ABC).toBe(3);
    expect(r.solved.regions.AB).toBe(5);
    expect(r.solved.regions.A).toBe(9);
  });

  it("reports missing data and impossible counts", () => {
    const under = solveVenn({ type: "venn", sets: [{ id: "A", label: "甲", total: 10 }, { id: "B", label: "乙", total: 8 }], intersections: [] });
    expect(under.checks.some((c) => !c.ok && c.detail.includes("不足"))).toBe(true);
    const neg = solveVenn({ type: "venn", sets: [{ id: "A", label: "甲", total: 5 }, { id: "B", label: "乙", total: 8 }], intersections: [{ sets: ["A", "B"], count: 7 }] });
    expect(neg.checks.some((c) => !c.ok)).toBe(true);
  });
});

describe("ordering", () => {
  it("solves a line-up uniquely", () => {
    const r = solveOrdering({
      type: "ordering",
      layout: "row",
      items: ["A", "B", "C", "D"],
      constraints: [
        { type: "position", a: "A", pos: 1 },
        { type: "immediately_left_of", a: "B", b: "C" },
        { type: "left_of", a: "D", b: "B" },
      ],
      answer: ["A", "D", "B", "C"],
    });
    expect(r.solved.solutions).toBe(1);
    expect(r.solved.sample).toEqual(["A", "D", "B", "C"]);
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  it("counts arrangements for 有多少种排法", () => {
    const r = solveOrdering({ type: "ordering", layout: "row", items: ["甲", "乙", "丙", "丁"], constraints: [{ type: "adjacent", a: "甲", b: "乙" }], count: 12 });
    expect(r.solved.solutions).toBe(12);
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  it("treats rotations and mirror images of an undirected circle as one seating", () => {
    const r = solveOrdering({
      type: "ordering",
      layout: "circle",
      items: ["甲", "乙", "丙", "丁"],
      constraints: [
        { type: "opposite", a: "甲", b: "丙" },
        { type: "adjacent", a: "甲", b: "乙" },
      ],
    });
    expect(r.solved.solutions).toBe(2);
    expect(r.solved.distinct).toBe(1);
    expect(r.checks[0].ok).toBe(true);
  });

  it("rejects 左边 on a circle", () => {
    expect(() => solveOrdering({ type: "ordering", layout: "circle", items: ["a", "b", "c"], constraints: [{ type: "left_of", a: "a", b: "b" }] })).toThrow();
  });
});

describe("tree", () => {
  it("counts outfits and checks the answer", () => {
    const r = solveTree({ type: "tree", levels: [{ label: "上衣", options: ["红", "蓝"] }, { label: "裤子", options: ["黑", "白", "灰"] }], answer: 6 });
    expect(r.solved.count).toBe(6);
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  it("handles distinct picks and exclusions", () => {
    const digits = { label: "", options: ["1", "2", "3"] };
    const r = solveTree({ type: "tree", levels: [{ ...digits, label: "百位" }, { ...digits, label: "十位" }, { ...digits, label: "个位" }], distinct: true, exclude: [["1", "2"]], answer: 6 });
    // every permutation of 1,2,3 contains both 1 and 2
    expect(r.solved.count).toBe(0);
    expect(r.checks.some((c) => !c.ok)).toBe(true);
  });
});

describe("logic figures end to end", () => {
  const spec = (logic: unknown, extra: Record<string, unknown> = {}) => figureSpecSchema.parse({ needed: true, logic, ...extra });

  it("builds, verifies and renders each kind", () => {
    const specs = [
      spec(
        { type: "grid", categories: [people, jobs], constraints: [{ type: "is_not", a: "甲", b: "医生" }, { type: "is", a: "乙", b: "律师" }] },
        { step_highlights: [{ step: 1, ids: ["乙", "律师"] }] },
      ),
      spec({ type: "venn", sets: [{ id: "A", label: "语文", total: 25 }, { id: "B", label: "数学", total: 30 }], intersections: [{ sets: ["A", "B"], count: 12 }], universe: 50, ask: "neither" }),
      spec({ type: "ordering", layout: "row", items: ["A", "B", "C"], constraints: [{ type: "position", a: "A", pos: 1 }, { type: "left_of", a: "C", b: "B" }] }),
      spec({ type: "ordering", layout: "circle", items: ["甲", "乙", "丙", "丁"], constraints: [{ type: "opposite", a: "甲", b: "丙" }, { type: "adjacent", a: "甲", b: "乙" }] }),
      spec({ type: "tree", levels: [{ label: "上衣", options: ["红", "蓝"] }, { label: "裤子", options: ["黑", "白", "灰"] }] }),
    ];
    for (const s of specs) {
      const fig = buildFigure(s);
      expect(fig.verified, JSON.stringify(fig.claims)).toBe(true);
      const svg = renderFigureSvg(fig, { highlight: ["乙", "律师"] });
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).not.toMatch(/NaN|undefined/);
    }
    // Highlighted grid headers are drawn.
    expect(renderFigureSvg(buildFigure(specs[0]))).toContain("律师");
  });

  it("a wrong claimed answer makes the diagram a sketch", () => {
    const fig = buildFigure(spec({ type: "tree", levels: [{ label: "上衣", options: ["红", "蓝"] }, { label: "裤子", options: ["黑", "白"] }], answer: 6 }));
    expect(fig.verified).toBe(false);
  });

  it("a malformed description becomes a FigureError (repair round)", () => {
    expect(() => buildFigure(spec({ type: "grid", categories: [people, { name: "职业", items: ["医生", "教师"] }], constraints: [] }))).toThrow(FigureError);
  });

  it("escapes item names", () => {
    const fig = buildFigure(spec({ type: "ordering", layout: "row", items: ["<b>", "a&b"], constraints: [{ type: "position", a: "<b>", pos: 1 }] }));
    const svg = renderFigureSvg(fig);
    expect(svg).not.toContain("<b>");
    expect(svg).toContain("&lt;b&gt;");
  });
});

describe("pre-filter", () => {
  it("lets logic puzzles through", () => {
    for (const t of [
      "甲、乙、丙三人分别是医生、教师和律师。甲不是医生……",
      "全班 50 人，喜欢语文的有 25 人，喜欢数学的有 30 人，两样都喜欢的有 12 人，两样都不喜欢的有几人？",
      "A、B、C、D 四人排成一排照相，A 站在最左边……",
      "4 人围坐圆桌，甲和丙相对而坐……",
      "2 件上衣和 3 条裤子，一共有多少种不同的搭配？",
    ])
      expect(mightNeedFigure(t), t).toBe(true);
    expect(mightNeedFigure("计算 123 × 45")).toBe(false);
  });
});
