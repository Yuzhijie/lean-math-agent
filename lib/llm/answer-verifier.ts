import type { GeneratedProblem } from "../types";

// ── Arithmetic expression extraction ────────────────────────────────────

/** Normalise various multiplication/division symbols to '*' / '/'. */
function normaliseOps(expr: string): string {
  return expr
    // LaTeX commands must be replaced as whole tokens (before the char class).
    .replace(/\\times/g, "*")
    .replace(/\\cdot/g, "*")
    .replace(/\\div/g, "/")
    // Unicode / plain-text operator symbols.
    .replace(/[×✕✖·⋅]/g, "*")
    .replace(/[÷]/g, "/")
    // Strip thousands-separators and whitespace.
    .replace(/[,，\s]/g, "");
}

/**
 * Try to extract a simple arithmetic expression from a problem statement.
 *
 * Supported patterns (inside $…$ LaTeX or plain text):
 *   a × b,  a * b,  a \times b,  a \cdot b
 *   a + b
 *   a - b  (subtraction)
 *   a ÷ b,  a / b,  a \div b
 *   chained:  a × b × c  (up to 6 operands)
 *
 * Returns the normalised expression string or null if nothing matched.
 */
export function extractArithmetic(statement: string): string | null {
  // Collect all math spans ($…$) and also scan the raw text.
  const spans: string[] = [];

  // Extract $…$ delimited math (non-greedy).
  const mathRe = /\$([^$]+)\$/g;
  let m: RegExpExecArray | null;
  while ((m = mathRe.exec(statement)) !== null) {
    spans.push(m[1]);
  }

  // Also try the raw statement (for problems without LaTeX delimiters).
  spans.push(statement);

  // Pattern: number (op number)+  —  up to 6 operands.
  const NUM = `\\d[\\d,，\\s]*`;
  const OP = `[+\\-−*×✕✖·⋅÷/]`;
  // Allow LaTeX operators too.
  const OP_LATEX = `(?:${OP}|\\\\times|\\\\cdot|\\\\div)`;
  const arithRe = new RegExp(
    `(${NUM}(?:\\s*${OP_LATEX}\\s*${NUM}){1,5})`,
    "g",
  );

  for (const span of spans) {
    const match = arithRe.exec(span);
    if (match) {
      return normaliseOps(match[1]);
    }
  }
  return null;
}

// ── Safe arithmetic evaluation ──────────────────────────────────────────

/**
 * Evaluate a normalised arithmetic expression (only +, -, *, / with integers).
 * Returns the numeric result or null if the expression is invalid / unsafe.
 *
 * Only allows: digits, +, -, *, /, (, )
 * Rejects anything else (no code execution risk).
 */
export function safeEval(expr: string): number | null {
  // Whitelist check — only digits and basic operators.
  if (!/^[\d+\-*/().]+$/.test(expr)) return null;

  try {
    // Use Function constructor instead of eval for isolation.
    const result = new Function(`"use strict"; return (${expr});`)() as number;
    if (typeof result !== "number" || !Number.isFinite(result)) return null;
    return result;
  } catch {
    return null;
  }
}

// ── Answer extraction ───────────────────────────────────────────────────

/**
 * Extract the numeric value from an answer string.
 * Handles: "4140", "答案是 4140", "$4140$", "4,140", etc.
 * Returns the number or null.
 */
export function extractAnswerNumber(answer: string): number | null {
  // Strip LaTeX delimiters and common answer prefixes.
  const cleaned = answer
    .replace(/\$/g, "")
    .replace(/^(?:答案|结果|解|答)[:：=\s]*/i, "")
    .replace(/[,，\s]/g, "");

  // Try to find a standalone number (possibly negative).
  const numRe = /^-?\d+$/;
  if (numRe.test(cleaned)) {
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  // Fallback: find the last number in the string (the "final answer").
  const lastNum = cleaned.match(/-?\d+/g);
  if (lastNum && lastNum.length > 0) {
    const n = Number(lastNum[lastNum.length - 1]);
    return Number.isFinite(n) ? n : null;
  }

  return null;
}

// ── Main verification function ──────────────────────────────────────────

export interface VerificationResult {
  verified: boolean;
  corrected: boolean;
  originalAnswer: string;
  correctAnswer?: string;
  expression?: string;
  computed?: number;
}

/**
 * Verify a generated problem's answer against programmatic arithmetic.
 * If the answer is wrong, returns a corrected copy of the problem.
 */
export function verifyAndFixAnswer(
  problem: Omit<GeneratedProblem, "id">,
): Omit<GeneratedProblem, "id"> {
  const result = verifyAnswer(problem);
  if (result.corrected) {
    return {
      ...problem,
      answer: problem.answer.replace(
        extractAnswerNumber(problem.answer)?.toString() ?? "",
        result.correctAnswer!,
      ),
    };
  }
  return problem;
}

/**
 * Verify a generated problem's answer and return detailed results.
 */
export function verifyAnswer(problem: Omit<GeneratedProblem, "id">): VerificationResult {
  const expr = extractArithmetic(problem.statement);
  if (!expr) {
    return { verified: false, corrected: false, originalAnswer: problem.answer };
  }

  const computed = safeEval(expr);
  if (computed === null) {
    return {
      verified: false,
      corrected: false,
      originalAnswer: problem.answer,
      expression: expr,
    };
  }

  const stated = extractAnswerNumber(problem.answer);
  if (stated === null) {
    return {
      verified: false,
      corrected: false,
      originalAnswer: problem.answer,
      expression: expr,
      computed,
    };
  }

  // For division, only verify when result is an exact integer.
  if (expr.includes("/") && !Number.isInteger(computed)) {
    return {
      verified: false,
      corrected: false,
      originalAnswer: problem.answer,
      expression: expr,
      computed,
    };
  }

  const correctAnswer = Number.isInteger(computed)
    ? computed.toString()
    : computed.toFixed(6).replace(/\.?0+$/, "");

  if (stated === computed) {
    return {
      verified: true,
      corrected: false,
      originalAnswer: problem.answer,
      expression: expr,
      computed,
      correctAnswer,
    };
  }

  // Answer is wrong — mark for correction.
  return {
    verified: true,
    corrected: true,
    originalAnswer: problem.answer,
    correctAnswer,
    expression: expr,
    computed,
  };
}
