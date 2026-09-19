import { describe, it, expect } from "vitest";
import {
  extractArithmetic,
  safeEval,
  extractAnswerNumber,
  verifyAnswer,
  verifyAndFixAnswer,
} from "@/lib/llm/answer-verifier";
import type { GeneratedProblem } from "@/lib/types";

// ── Helper ──────────────────────────────────────────────────────────────

function makeProblem(
  statement: string,
  answer: string,
): GeneratedProblem {
  return {
    id: "test",
    statement,
    answer,
    hints: ["hint"],
    grade_level: "elementary",
    difficulty: "standard",
    domain: "algebra",
    suggested_techniques: ["direct_computation"],
    source_inspiration: "test",
    estimated_solve_time: "1分钟",
  };
}

// ── extractArithmetic ───────────────────────────────────────────────────

describe("extractArithmetic", () => {
  it("extracts simple multiplication", () => {
    expect(extractArithmetic("计算 $345 \\times 12$")).toBe("345*12");
  });

  it("extracts multiplication with × symbol", () => {
    expect(extractArithmetic("计算 908 × 56 的值")).toBe("908*56");
  });

  it("extracts addition", () => {
    expect(extractArithmetic("求 $234 + 567$ 的值")).toBe("234+567");
  });

  it("extracts subtraction", () => {
    expect(extractArithmetic("计算 $1000 - 356$")).toBe("1000-356");
  });

  it("extracts division with ÷", () => {
    expect(extractArithmetic("计算 $720 ÷ 8$")).toBe("720/8");
  });

  it("extracts chained multiplication", () => {
    expect(extractArithmetic("计算 $2 × 3 × 5$")).toBe("2*3*5");
  });

  it("returns null for non-arithmetic problems", () => {
    expect(
      extractArithmetic("证明对任意自然数 n，n + 0 = n"),
    ).toBeNull();
  });

  it("returns null for proof-based problems", () => {
    expect(
      extractArithmetic("证明三角形内角和为 180 度"),
    ).toBeNull();
  });

  it("handles numbers with comma separators", () => {
    expect(extractArithmetic("计算 $1,234 × 56$")).toBe("1234*56");
  });
});

// ── safeEval ────────────────────────────────────────────────────────────

describe("safeEval", () => {
  it("evaluates multiplication correctly", () => {
    expect(safeEval("908*56")).toBe(50848);
  });

  it("evaluates addition", () => {
    expect(safeEval("234+567")).toBe(801);
  });

  it("evaluates subtraction", () => {
    expect(safeEval("1000-356")).toBe(644);
  });

  it("evaluates exact division", () => {
    expect(safeEval("720/8")).toBe(90);
  });

  it("evaluates chained operations", () => {
    expect(safeEval("2*3*5")).toBe(30);
  });

  it("returns null for unsafe expressions", () => {
    expect(safeEval("alert(1)")).toBeNull();
    expect(safeEval("process.exit()")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(safeEval("")).toBeNull();
  });
});

// ── extractAnswerNumber ─────────────────────────────────────────────────

describe("extractAnswerNumber", () => {
  it("extracts a plain number", () => {
    expect(extractAnswerNumber("4140")).toBe(4140);
  });

  it("extracts number with answer prefix", () => {
    expect(extractAnswerNumber("答案：4140")).toBe(4140);
  });

  it("extracts number in LaTeX", () => {
    expect(extractAnswerNumber("$4140$")).toBe(4140);
  });

  it("extracts number with thousands separator", () => {
    expect(extractAnswerNumber("4,140")).toBe(4140);
  });

  it("extracts negative number", () => {
    expect(extractAnswerNumber("-42")).toBe(-42);
  });

  it("extracts the last number from a sentence", () => {
    expect(extractAnswerNumber("经过计算，结果为 4140")).toBe(4140);
  });

  it("returns null for non-numeric answer", () => {
    expect(extractAnswerNumber("利用勾股定理可证")).toBeNull();
  });
});

// ── verifyAnswer ────────────────────────────────────────────────────────

describe("verifyAnswer", () => {
  it("marks correct answer as verified, not corrected", () => {
    const result = verifyAnswer(makeProblem("计算 $345 \\times 12$", "4140"));
    expect(result.verified).toBe(true);
    expect(result.corrected).toBe(false);
    expect(result.computed).toBe(4140);
  });

  it("detects and corrects wrong answer (908 × 56 = 58088)", () => {
    const result = verifyAnswer(
      makeProblem("计算 $908 \\times 56$ 的值", "58088"),
    );
    expect(result.verified).toBe(true);
    expect(result.corrected).toBe(true);
    expect(result.correctAnswer).toBe("50848");
    expect(result.computed).toBe(50848);
  });

  it("does not verify non-arithmetic problems", () => {
    const result = verifyAnswer(
      makeProblem("证明对任意自然数 n，n + 0 = n", "自然数加法恒等元为 0"),
    );
    expect(result.verified).toBe(false);
    expect(result.corrected).toBe(false);
  });

  it("handles plain text multiplication (no LaTeX)", () => {
    const result = verifyAnswer(
      makeProblem("请计算 908 × 56 等于多少？", "58088"),
    );
    expect(result.verified).toBe(true);
    expect(result.corrected).toBe(true);
    expect(result.correctAnswer).toBe("50848");
  });
});

// ── verifyAndFixAnswer ──────────────────────────────────────────────────

describe("verifyAndFixAnswer", () => {
  it("fixes wrong answer in the problem", () => {
    const problem = makeProblem("计算 $908 \\times 56$", "58088");
    const fixed = verifyAndFixAnswer(problem);
    expect(fixed.answer).toBe("50848");
    expect(fixed.statement).toBe(problem.statement);
  });

  it("leaves correct answer unchanged", () => {
    const problem = makeProblem("计算 $345 \\times 12$", "4140");
    const fixed = verifyAndFixAnswer(problem);
    expect(fixed.answer).toBe("4140");
  });

  it("leaves non-arithmetic problem unchanged", () => {
    const problem = makeProblem(
      "证明对任意自然数 n，n + 0 = n",
      "自然数加法恒等元为 0",
    );
    const fixed = verifyAndFixAnswer(problem);
    expect(fixed.answer).toBe(problem.answer);
  });

  it("fixes wrong answer with answer prefix", () => {
    const problem = makeProblem("计算 $908 \\times 56$", "答案：58088");
    const fixed = verifyAndFixAnswer(problem);
    expect(fixed.answer).toBe("答案：50848");
  });
});
