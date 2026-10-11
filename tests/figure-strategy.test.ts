import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { buildFigure } from "@/lib/figure/check";
import { renderFigureSvg } from "@/lib/figure/render";
import { figureSpecSchema } from "@/lib/figure/spec";
import { parseProb, solveStrategy, strategySchema, strategySteps } from "@/lib/figure/strategy";
import { graphReadouts } from "@/lib/figure/strategy-render";
import { compileExprVars } from "@/lib/figure/expr";

const fig = (strategy: unknown, step_highlights: unknown[] = []) => buildFigure(figureSpecSchema.parse({ needed: true, strategy, step_highlights }));
const fails = (f: ReturnType<typeof fig>) => f.claims.filter((c) => !c.ok).map((c) => c.detail).join(" | ");
const OUT = process.env.STRATEGY_PREVIEW;
const preview = (name: string, svgs: string[]) => {
  if (OUT) fs.writeFileSync(`${OUT}/${name}.html`, `<html><body style="background:#0b1220;margin:0;padding:16px;display:flex;flex-direction:column;gap:18px">${svgs.map((s) => `<div>${s}</div>`).join("")}</body></html>`);
};

// "Mia has 24 sweets. She gives 3/8 of them to her brother and then eats 4. How many are left?" (11)
const MIA = {
  type: "bar_model",
  unit: "颗",
  bars: [{ id: "mia", label: "Mia 的糖", total: 24, units: 8, parts: [{ id: "give", label: "给弟弟", units: 3, from_step: 2 }, { id: "eat", label: "吃掉", value: 4, from_step: 3 }, { id: "left", label: "剩下", unknown: true, reveal_step: 4 }] }],
  ask: "left",
  answer: 11,
};

describe("bar model (线段图)", () => {
  it("finds the unit, checks the given numbers and the answer", () => {
    const f = fig(MIA, [{ step: 2, ids: ["give"] }, { step: 4, ids: ["left"] }]);
    expect(fails(f)).toBe("");
    expect(f.verified).toBe(true);
    expect(f.strategy).toMatchObject({ type: "bar_model", unit: 3, parts: { give: 9, eat: 4, left: 11 } });
    expect(f.claims.map((c) => c.detail).join(" ")).toMatch(/每份 = 3 颗|One unit = 3/);
    expect(fig({ ...MIA, answer: 12 }).claims.some((c) => !c.ok && /11/.test(c.detail))).toBe(true);
    expect(strategySteps(strategySchema.parse(MIA))).toEqual([2, 3, 4]);
    // Step 1: only the whole bar's total; the unknown stays "?" until step 4; the full figure shows 11.
    const s1 = renderFigureSvg(f, { step: 1 });
    expect(s1).not.toContain("给弟弟");
    const s3 = renderFigureSvg(f, { step: 3, highlight: ["eat"] });
    expect(s3).toContain("给弟弟");
    expect(s3).toMatch(/>\?</);
    expect(s3).toContain("#f59e0b");
    expect(renderFigureSvg(f)).toContain(">11 颗<");
    preview("bar-mia", [renderFigureSvg(f, { step: 1 }), renderFigureSvg(f, { step: 2, highlight: ["give"] }), s3, renderFigureSvg(f, { step: 4, highlight: ["left"] })]);
  });

  it("comparison and difference models", () => {
    // A has 3 times as many as B; together 48. How many has A? (36)
    const times = fig({ type: "bar_model", bars: [{ id: "A", label: "A", parts: [{ id: "a", units: 3 }] }, { id: "B", label: "B", parts: [{ id: "b", units: 1 }] }], relations: [{ id: "tot", type: "sum", bars: ["A", "B"], value: 48 }], ask: "A", answer: 36 });
    expect(fails(times)).toBe("");
    expect(times.strategy).toMatchObject({ unit: 12, bars: { A: 36, B: 12 } });
    // A has 15 more than B; together 75. (A = 45)
    const more = fig({ type: "bar_model", bars: [{ id: "A", label: "甲", parts: [{ id: "a1", units: 1 }, { id: "extra", value: 15, label: "多 15" }] }, { id: "B", label: "乙", parts: [{ id: "b1", units: 1 }] }], relations: [{ id: "tot", type: "sum", bars: ["A", "B"], value: 75 }, { id: "diff", type: "difference", bars: ["A", "B"], value: 15 }], ask: "A", answer: 45 });
    expect(fails(more)).toBe("");
    // Numbers that contradict each other are reported.
    const bad = fig({ type: "bar_model", bars: [{ id: "A", parts: [{ id: "a", units: 2, value: 10 }, { id: "c", units: 3, value: 18 }] }] });
    expect(fails(bad)).toMatch(/不一致|does not agree/);
    expect(() => fig({ type: "bar_model", bars: [{ id: "A", parts: [{ id: "a" }, { id: "b" }] }] })).toThrow(/at most one|最多只能有一段/);
    preview("bar-compare", [renderFigureSvg(times), renderFigureSvg(more, { highlight: ["diff"] })]);
  });
});

describe("number line", () => {
  it("checks the jumps and the asked point", () => {
    const spec = { type: "number_line", min: -5, max: 10, points: [{ id: "s", value: -3, label: "−3℃" }, { id: "e", value: 5, label: "5℃", unknown: true, reveal_step: 2 }], jumps: [{ id: "j", from: -3, to: 5, delta: 8, label: "升高 8℃", from_step: 1 }], ask: "e", answer: 5 };
    const f = fig(spec);
    expect(fails(f)).toBe("");
    expect(fails(fig({ ...spec, jumps: [{ id: "j", from: -3, to: 5, delta: 7 }] }))).toMatch(/不是 7|not 7/);
    preview("number-line", [renderFigureSvg(f, { step: 1, highlight: ["j"] }), renderFigureSvg(f)]);
  });
});

describe("probability tree", () => {
  // 3 red and 2 blue balls, two drawn without replacement: P(both red) = 3/10.
  const TREE = {
    type: "prob_tree",
    levels: ["第一次", "第二次"],
    children: [
      { id: "R", label: "红", p: "3/5", children: [{ id: "RR", label: "红", p: "2/4" }, { id: "RB", label: "蓝", p: "2/4" }] },
      { id: "B", label: "蓝", p: "2/5", children: [{ id: "BR", label: "红", p: "3/4" }, { id: "BB", label: "蓝", p: "1/4" }] },
    ],
    ask: ["RR"],
    answer: "3/10",
  };
  it("forks add up to 1, leaves are products, the event is checked exactly", () => {
    const f = fig(TREE);
    expect(fails(f)).toBe("");
    expect(f.strategy).toMatchObject({ type: "prob_tree", event: "3/10", leaves: [{ p: "3/10" }, { p: "3/10" }, { p: "3/10" }, { p: "1/10" }] });
    expect(fails(fig({ ...TREE, answer: "9/25" }))).toMatch(/3\/10/);
    const badFork = structuredClone(TREE);
    badFork.children[1].children![1].p = "2/4";
    expect(fails(fig(badFork))).toMatch(/之和应为 1|add up to 1/);
    expect([parseProb("0.25"), parseProb("25%"), parseProb("\\frac{1}{4}")]).toEqual([{ n: 1, d: 4 }, { n: 1, d: 4 }, { n: 1, d: 4 }]);
    preview("prob-tree", [renderFigureSvg(f, { highlight: ["R", "RR"] })]);
  });
});

describe("enumeration table (列表法)", () => {
  // Chickens and rabbits: 10 heads, 28 legs.
  const TABLE = { type: "enum_table", vars: [{ id: "c", label: "鸡", from: 0, to: 10 }], columns: [{ id: "r", label: "兔", expr: "10 - c" }, { id: "l", label: "腿", expr: "2c + 4r", from_step: 2 }], conditions: ["l = 28"], answer_row: { c: 6, r: 4 }, answer_count: 1 };
  it("tries every case, marks the rows that fit, checks the answer", () => {
    const f = fig(TABLE);
    expect(fails(f)).toBe("");
    expect(f.strategy).toMatchObject({ type: "enum_table", tried: 11, matching: 1 });
    expect(fails(fig({ ...TABLE, answer_row: { c: 5, r: 5 } }))).toMatch(/不符合条件|does not meet/);
    // Two variables: pairs (m, n) of digits with m + n = 9 and m > n.
    const pairs = fig({ type: "enum_table", vars: [{ id: "m", label: "m", from: 0, to: 9 }, { id: "n", label: "n", from: 0, to: 9 }], conditions: ["m + n = 9", "m > n"], answer_count: 5 });
    expect(fails(pairs)).toBe("");
    expect(pairs.strategy).toMatchObject({ tried: 100, matching: 5, rows: expect.any(Array) });
    expect((pairs.strategy as { rows: unknown[] }).rows).toHaveLength(5); // > 16 rows: only the matching ones are shown
    expect(renderFigureSvg(f, { step: 1 })).not.toContain(">腿<");
    preview("enum-table", [renderFigureSvg(f, { step: 1 }), renderFigureSvg(f, { highlight: ["l"] }), renderFigureSvg(pairs)]);
  });
});

describe("graph with a slider", () => {
  // a + b = 4, a, b > 0: the largest value of ab is 4 (a = b = 2).
  const G = { type: "graph_explore", x: [0, 4], y: [0, 5], functions: [{ id: "f", expr: "x(4 - x)", label: "ab = a(4 − a)" }], param: { id: "a", label: "a", min: 0, max: 4, step: 0.1, start: 1 }, tracer: { fn: "f" }, readouts: [{ label: "b", expr: "4 - a" }, { label: "ab", expr: "a(4 - a)" }], optimum: { id: "top", fn: "f", kind: "max", x: 2, y: 4, from_step: 3 } };
  it("checks the claimed maximum by sampling; the point follows the slider", () => {
    const f = fig(G, [{ step: 3, ids: ["top"] }]);
    expect(fails(f)).toBe("");
    expect(fails(fig({ ...G, optimum: { fn: "f", kind: "max", x: 1.5, y: 3.75 } }))).toMatch(/最大值约为 4|maximum is about 4/);
    expect(graphReadouts(strategySchema.parse(G) as never, 1.5)).toEqual([{ label: "b", value: "2.5" }, { label: "ab", value: "3.75" }]);
    expect(renderFigureSvg(f, { param: 1.5 })).toContain("(1.5, 3.75)");
    expect(renderFigureSvg(f, { step: 1, param: 1 })).not.toContain("最大 4");
    // A parameter inside a function: a line y = kx + 1 that turns with the slider.
    expect(compileExprVars("k x + 1", ["k"])({ x: 2, k: 3 })).toBe(7);
    const line = fig({ type: "graph_explore", x: [-3, 3], y: [-3, 5], functions: [{ id: "p", expr: "x^2" }, { id: "l", expr: "kx + 2" }], param: { id: "k", min: -2, max: 2, start: 1 }, intersections: [{ fns: ["p", "l"], x: 2 }] });
    expect(fails(line)).toBe("");
    preview("graph", [renderFigureSvg(f, { param: 1 }), renderFigureSvg(f, { param: 2, highlight: ["top"] }), renderFigureSvg(line, { param: 1 })]);
  });
});

describe("strategy spec in the figure schema", () => {
  it("rejects a bad kind, keeps the rest of FigureSpec working", () => {
    expect(figureSpecSchema.safeParse({ needed: true, strategy: { type: "pie" } }).success).toBe(false);
    expect(() => solveStrategy(strategySchema.parse({ type: "enum_table", vars: [{ id: "e", label: "e", from: 0, to: 1 }], conditions: ["e = 1"] }))).toThrow();
  });
});
