import { describe, expect, it } from "vitest";
import { answerText, fromCandidates, generationPrintHref, optionColumns } from "@/lib/bank/worksheet";

describe("worksheets of generated questions", () => {
  it("answers with their option, multi-select answers, free answers", () => {
    expect(answerText({ answer: "C", options: ["6", "10", "12", "15"] })).toBe("C. 12");
    expect(answerText({ answer: "A, D", options: ["apple $1", "pear $2", "fig $3", "kiwi $4"] })).toBe("A. apple $1；D. kiwi $4");
    expect(answerText({ answer: "75" })).toBe("75");
    expect(answerText({ answer: "E", options: ["1", "2"] })).toBe("E"); // out of range: as written
  });
  it("lays out short options side by side", () => {
    expect(optionColumns(["6", "10", "12", "15"])).toBe(4);
    expect(optionColumns(["a long option that is quite long", "b"])).toBe(1);
    expect(optionColumns(["three weeks ago", "two days later", "next Tuesday"])).toBe(2);
  });
  it("candidates become worksheet questions; links", () => {
    const qs = fromCandidates([{ id: "c1", stem: "s", type: "multiple_choice", options: ["a", "b"], answer: "B", hints: [], knowledge_points: [], checks: {} as never, passed: true, figure: { svg: "<svg/>", description: "d", source: "program", verified: true, spec: {} } as never }]);
    expect(qs).toEqual([{ id: "c1", stem: "s", options: ["a", "b"], answer: "B", solution: undefined, figureSvg: "<svg/>", passed: true }]);
    expect(generationPrintHref("b1", "g1", ["c1", "c2"])).toBe("/print?bank=b1&gen=g1&ids=c1%2Cc2");
  });
});
