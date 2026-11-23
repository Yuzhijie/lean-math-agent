import { describe, expect, it } from "vitest";
import { answerForFormalizer, normalizeAnswer, problemOptions, sameAnswer } from "@/lib/pipeline/answer-format";
import { answerCandidates, problemWithAnswer } from "@/lib/pipeline/lean-attempt";

const text = (a: string, p?: string) => normalizeAnswer(a, p).text;
const CHOICE = "下列哪个数最大？\nA. 12\nB. $\\frac{25}{2}$\nC. 13\nD. 11.5";

describe("the solved answer in one format", () => {
  it("takes the boxed part and drops the delimiters and the words around the answer", () => {
    expect(text("$$\\boxed{907200}$$")).toBe("907200");
    expect(text("共有 \\(\\boxed{19}\\) 种")).toBe("19");
    expect(text("答：x = 2 或 x = 3。")).toBe("x = 2 ∨ x = 3");
    expect(text("The answer is 13.")).toBe("13");
    expect(text("所以答案是 $7$")).toBe("7");
  });

  it("writes LaTeX as plain mathematics", () => {
    expect(text("$$\\boxed{\\dfrac{3}{4}}$$")).toBe("3/4");
    expect(text("$-\\frac{1}{2}$")).toBe("-1/2");
    expect(text("$\\frac{\\sqrt{3}}{2}$")).toBe("√3/2");
    expect(text("$\\frac{x+1}{x-1}$")).toBe("(x+1)/(x-1)");
    expect(text("$2\\frac{1}{3}$")).toBe("2 + 1/3");
    expect(text("$\\sqrt[3]{5}$")).toBe("5^(1/3)");
    expect(text("$x^{2}+y^{n+1}$")).toBe("x^2+y^(n+1)");
    expect(text("\\(\\{2, 3\\}\\)")).toBe("{2, 3}");
    expect(text("$\\left(\\frac{1}{2}, +\\infty\\right)$")).toBe("(1/2, +∞)");
    expect(text("$n = 4k + 1\\ (k \\in \\mathbb{Z})$")).toBe("n = 4k + 1 (k ∈ ℤ)");
    expect(text("$x_1=1+\\sqrt{2},\\ x_2=1-\\sqrt{2}$")).toBe("x_1 = 1+√2, x_2 = 1-√2");
  });

  it("joins equations by ∨ / ∧ and lists by a comma", () => {
    expect(text("$x \\le -1$ 或 $x \\ge 3$")).toBe("x ≤ -1 ∨ x ≥ 3");
    expect(text("x = 1 or x = -1")).toBe("x = 1 ∨ x = -1");
    expect(text("$a = 1$ 且 $b = -4$")).toBe("a = 1 ∧ b = -4");
    expect(text("x=3，y=-2")).toBe("x = 3, y = -2");
    expect(text("2、3、5")).toBe("2, 3, 5");
    // "或" between bare values is a list of possibilities, not a proposition: left as written
    expect(text("2 或 3")).toBe("2 或 3");
  });

  it("takes a unit off the value and names it apart", () => {
    expect(normalizeAnswer("12 平方厘米")).toMatchObject({ text: "12", unit: "平方厘米" });
    expect(normalizeAnswer("$12\\pi\\ \\text{cm}^2$")).toMatchObject({ text: "12π", unit: "cm²" });
    expect(normalizeAnswer("$60^\\circ$")).toMatchObject({ text: "60", unit: "°" });
    expect(normalizeAnswer("45 km/h")).toMatchObject({ text: "45", unit: "km/h" });
    expect(normalizeAnswer("18 个")).toMatchObject({ text: "18", unit: "个" });
    // a unit written after the box is kept
    expect(normalizeAnswer("$\\boxed{12}$ 平方厘米。")).toMatchObject({ text: "12", unit: "平方厘米" });
    expect(normalizeAnswer("共有 \\(\\boxed{19}\\) 种")).toMatchObject({ text: "19", unit: "种" });
    // a letter that is part of the answer is not a unit; a percentage is not rewritten
    expect(normalizeAnswer("3m")).toMatchObject({ text: "3m" });
    expect(normalizeAnswer("x = 2t").unit).toBeUndefined();
    expect(normalizeAnswer("25%")).toMatchObject({ text: "25%" });
    expect(normalizeAnswer("bad").unit).toBeUndefined();
  });

  it("replaces a choice letter by the option it names", () => {
    expect([...problemOptions(CHOICE)]).toEqual([["A", "12"], ["B", "$\\frac{25}{2}$"], ["C", "13"], ["D", "11.5"]]);
    expect(normalizeAnswer("C", CHOICE)).toMatchObject({ text: "13", choice: { letters: ["C"], options: ["13"] } });
    expect(normalizeAnswer("选 B", CHOICE)).toMatchObject({ text: "25/2", choice: { letters: ["B"] } });
    expect(normalizeAnswer("A、D", "多选\n(A) 1 (B) 2 (C) 3 (D) 4").text).toBe("1, 4");
    // no options in the problem, or a letter the problem does not list: the letter stays
    expect(text("C", "求 x 的值。")).toBe("C");
    expect(text("E", CHOICE)).toBe("E");
    expect(problemOptions("设 A. 那么 x = 1").size).toBe(0);
  });

  it("computes nothing and leaves what it cannot read", () => {
    expect(text("0.75")).toBe("0.75");
    expect(text("1 : 2")).toBe("1 : 2");
    expect(text("当 $x=3$ 时，$y$ 取最小值 $5$")).toBe("当 x = 3 时, y 取最小值 5");
    expect(text("")).toBe("");
    expect(normalizeAnswer("13").changes).toEqual([]);
  });

  it("two spellings of one answer are the same answer", () => {
    expect(sameAnswer("$\\frac{1}{2}$", "1/2")).toBe(true);
    expect(sameAnswer("\\boxed{12}", "12 ")).toBe(true);
    expect(sameAnswer("1/2", "0.5")).toBe(false);
    expect(answerCandidates({ computation_result: { answer: "1/2", cross_validated: true }, nl_solution: { final_answer: "$\\dfrac{1}{2}$" } })).toEqual(["1/2"]);
    expect(answerCandidates({ computation_result: { answer: "3" }, nl_solution: { final_answer: "4" } })).toEqual(["4", "3"]);
  });

  it("the formalizer gets the normalized answer, what was taken off it, and the answer as written", () => {
    expect(answerForFormalizer("13")).toBe("The answer found by solving is: 13");
    expect(answerForFormalizer("$12\\ \\text{cm}^2$")).toBe(["The answer found by solving is: 12", "(its unit is cm²; the statement is about the number)", "(as the solution wrote it: $12\\ \\text{cm}^2$)"].join("\n"));
    expect(answerForFormalizer("C", CHOICE)).toContain("The answer found by solving is: 13\n(the solution chose option C of the problem; the statement is about the value, not the letter)");
    const sent = problemWithAnswer(CHOICE, "C");
    expect(sent.startsWith(CHOICE)).toBe(true);
    expect(sent).toContain("The answer found by solving is: 13");
    expect(problemWithAnswer("求 x", undefined)).toBe("求 x");
  });
});
