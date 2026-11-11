import { describe, expect, it } from "vitest";
import path from "node:path";
import { answerItems, evalNumber, matchAnswer } from "@/lib/e2e/answer-match";
import { loadHeldout } from "@/lib/e2e/heldout";

describe("evalNumber", () => {
  it("reads numbers the way answers are written", () => {
    const cases: [string, number][] = [
      ["84", 84],
      ["-160", -160],
      ["−1", -1],
      ["5/12", 5 / 12],
      ["$\\dfrac{5}{12}$", 5 / 12],
      ["\\frac12", 0.5],
      ["√13", Math.sqrt(13)],
      ["2√6", 2 * Math.sqrt(6)],
      ["24√3/7", (24 * Math.sqrt(3)) / 7],
      ["$\\dfrac{24\\sqrt{3}}{7}$", (24 * Math.sqrt(3)) / 7],
      ["\\frac{1+\\sqrt5}{2}", (1 + Math.sqrt(5)) / 2],
      ["(1+√5)/2", (1 + Math.sqrt(5)) / 2],
      ["\\boxed{3\\sqrt{3}}", 3 * Math.sqrt(3)],
      ["150^\\circ", 150],
      ["150°", 150],
      ["1:2", 0.5],
      ["1 : 2", 0.5],
      ["8\\frac{1}{4}", 8.25],
      ["-1\\frac{1}{2}", -1.5],
      ["2^{10}-3", 1021],
      ["\\sqrt[3]{27}", 3],
      ["2\\pi", 2 * Math.PI],
      ["1{,}806", 1806],
      ["3 \\times 4", 12],
    ];
    for (const [text, want] of cases) expect(evalNumber(text), text).toBeCloseTo(want, 9);
  });

  it("refuses what is not a closed number", () => {
    for (const text of ["x + 1", "4 10", "", "n", "\\angle A", "1/0", "3 或 4"]) expect(evalNumber(text), text).toBeUndefined();
  });
});

describe("answerItems", () => {
  it("splits lists, tuples and sets, not fractions or brackets", () => {
    expect(answerItems("4, 10")).toEqual(["4", "10"]);
    expect(answerItems("$n=4$ 或 $n=10$")).toEqual(["n=4", "n=10"]);
    expect(answerItems("\\{4, 10\\}")).toEqual(["4", "10"]);
    expect(answerItems("(4, 10)")).toEqual(["4", "10"]);
    expect(answerItems("(1+√5)/2")).toEqual(["(1+√5)/2"]);
    expect(answerItems("\\frac{16}{3}")).toEqual(["\\frac{16}{3}"]);
  });
});

describe("matchAnswer", () => {
  const one = (value: number) => ({ answer: String(value), value });

  it("one value, however it is dressed", () => {
    expect(matchAnswer(one(12), "12")).toBe(true);
    expect(matchAnswer(one(12), "最小值为 $12$。")).toBe(true);
    expect(matchAnswer(one(12), "12，此时 $a=6$，$b=\\frac32$")).toBe(true);
    expect(matchAnswer(one(12), "12（当 a=6 时取到）")).toBe(true);
    expect(matchAnswer(one(103), "$P(10)=103$")).toBe(true);
    expect(matchAnswer(one(19), "共有 19 种")).toBe(true);
    expect(matchAnswer(one(4), "x = 4")).toBe(true);
    expect(matchAnswer(one(10), "$\\angle BCD = 10^\\circ$")).toBe(true);
    expect(matchAnswer({ answer: "1/2", value: 0.5 }, "$AP:PD=1:2$")).toBe(true);
    expect(matchAnswer({ answer: "1/2", value: 0.5 }, "AP：PD＝1：2")).toBe(true);
    expect(matchAnswer({ answer: "3√3", value: 3 * Math.sqrt(3) }, "5.196")).toBe(true);
    expect(matchAnswer(one(12), "13")).toBe(false);
    expect(matchAnswer(one(262145), "262146")).toBe(false);
    expect(matchAnswer({ answer: "5/12", value: 5 / 12 }, "\\frac{7}{12}")).toBe(false);
  });

  it("a single value against a list of solutions is wrong; against a remark it is not", () => {
    expect(matchAnswer(one(3), "3, 5")).toBe(false);
    expect(matchAnswer(one(4), "$n=4$ 或 $n=10$")).toBe(false);
    expect(matchAnswer(one(5), "当 $x=3$ 时取最小值 5")).toBeUndefined();
  });

  it("a set of values in any order", () => {
    const ref = { answer: "4, 10", values: [4, 10] };
    expect(matchAnswer(ref, "10, 4")).toBe(true);
    expect(matchAnswer(ref, "$n=4$ 或 $n=10$")).toBe(true);
    expect(matchAnswer(ref, "n \\in \\{4, 10\\}")).toBe(true);
    expect(matchAnswer(ref, "4")).toBe(false);
    expect(matchAnswer(ref, "4, 10, 12")).toBe(false);
  });

  it("falls back on the product's decimal, and gives up otherwise", () => {
    expect(matchAnswer({ answer: "3√3", value: 3 * Math.sqrt(3) }, "三倍根号三", "5.19615")).toBe(true);
    expect(matchAnswer(one(8), undefined, 8)).toBe(true);
    expect(matchAnswer(one(8), "无法确定")).toBeUndefined();
    expect(matchAnswer({}, "42")).toBeUndefined();
  });
});

describe("the held-out set", () => {
  const set = loadHeldout(path.join(process.cwd(), "bench", "heldout.json"));

  it("is well formed: 120 problems, dev and test in every topic", () => {
    expect(set.problems).toHaveLength(120);
    expect(set.hash).toMatch(/^[0-9a-f]{12}$/);
    for (const topic of ["number_theory", "combinatorics", "geometry", "algebra"]) {
      const of = set.problems.filter((p) => p.topic === topic);
      expect(of.filter((p) => p.split === "dev")).toHaveLength(10);
      expect(of.filter((p) => p.split === "test")).toHaveLength(20);
    }
  });

  it("every written answer evaluates to its own value", () => {
    for (const p of set.problems.filter((q) => q.kind === "find")) expect(matchAnswer(p, p.answer), p.id).toBe(true);
  });

  it("an answer one off is not accepted", () => {
    for (const p of set.problems.filter((q) => q.kind === "find" && q.value !== undefined)) expect(matchAnswer(p, String(p.value! + 1)), p.id).toBe(false);
  });
});
