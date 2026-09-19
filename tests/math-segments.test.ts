import { describe, it, expect } from "vitest";
import { containsMath, splitMathSegments } from "@/lib/math-segments";

describe("splitMathSegments", () => {
  it("returns plain text unchanged as a single text segment", () => {
    expect(splitMathSegments("证明对任意自然数 n，n + 0 = n")).toEqual([
      { kind: "text", content: "证明对任意自然数 n，n + 0 = n" },
    ]);
  });

  it("splits inline $...$ math", () => {
    expect(splitMathSegments("设 $n$ 为自然数")).toEqual([
      { kind: "text", content: "设 " },
      { kind: "inline", content: "n" },
      { kind: "text", content: " 为自然数" },
    ]);
  });

  it("splits display $$...$$ math", () => {
    expect(splitMathSegments("求证 $$a+b=b+a$$ 完毕")).toEqual([
      { kind: "text", content: "求证 " },
      { kind: "display", content: "a+b=b+a" },
      { kind: "text", content: " 完毕" },
    ]);
  });

  it("treats multiline $$...$$ as a single display segment", () => {
    expect(splitMathSegments("$$\n x^2 \n$$")).toEqual([
      { kind: "display", content: "\n x^2 \n" },
    ]);
  });

  it("supports \\(...\\) inline and \\[...\\] display", () => {
    expect(splitMathSegments("\\(x+1\\) 与 \\[y^2\\]")).toEqual([
      { kind: "inline", content: "x+1" },
      { kind: "text", content: " 与 " },
      { kind: "display", content: "y^2" },
    ]);
  });

  it("keeps an unclosed $ as plain text", () => {
    expect(splitMathSegments("设 $n 为自然数")).toEqual([
      { kind: "text", content: "设 $n 为自然数" },
    ]);
  });

  it("does not pair currency-style $5 and $10", () => {
    expect(splitMathSegments("价格是 $5 和 $10 美元")).toEqual([
      { kind: "text", content: "价格是 $5 和 $10 美元" },
    ]);
  });

  it("splits adjacent inline math $a$$b$ into two segments", () => {
    expect(splitMathSegments("$a$$b$")).toEqual([
      { kind: "inline", content: "a" },
      { kind: "inline", content: "b" },
    ]);
  });

  it("keeps degenerate $$$$ as plain text", () => {
    expect(splitMathSegments("$$$$")).toEqual([
      { kind: "text", content: "$$$$" },
    ]);
  });

  it("does not treat $ x $ (whitespace padding) as math", () => {
    expect(splitMathSegments("给定 $ x $ 求值")).toEqual([
      { kind: "text", content: "给定 $ x $ 求值" },
    ]);
  });

  it("does not treat multiline $...$ as inline math", () => {
    expect(splitMathSegments("$a\nb$")).toEqual([
      { kind: "text", content: "$a\nb$" },
    ]);
  });

  it("unescapes \\$ into a literal $", () => {
    expect(splitMathSegments("价格 \\$5，公式 $x$")).toEqual([
      { kind: "text", content: "价格 $5，公式 " },
      { kind: "inline", content: "x" },
    ]);
  });
});

describe("containsMath", () => {
  it("is false for plain text and false positives", () => {
    expect(containsMath("证明对任意自然数 n，n + 0 = n")).toBe(false);
    expect(containsMath("价格是 $5 和 $10 美元")).toBe(false);
    expect(containsMath("设 $n 为自然数")).toBe(false);
  });

  it("is true when math delimiters are present", () => {
    expect(containsMath("设 $n$ 为自然数")).toBe(true);
    expect(containsMath("$$a+b$$")).toBe(true);
    expect(containsMath("\\(x\\)")).toBe(true);
  });
});
