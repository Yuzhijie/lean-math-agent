import { describe, it, expect } from "vitest";
import {
  enumerateResponseSchema,
  planResponseSchema,
  generateProblemResponseSchema,
} from "@/lib/schemas";

const method = (id: string) => ({
  id,
  category: "induction" as const,
  title: "t",
  inspiration: "i",
  pros: "p",
  cons: "c",
  lean_sketch: "s",
  confidence: 1,
});

describe("enumerateResponseSchema", () => {
  it("accepts in-domain payload with ≥3 methods", () => {
    const parsed = enumerateResponseSchema.parse({
      comparison_summary: "归纳最稳；rewrite 最短；simp 最快。",
      out_of_domain_warning: null,
      methods: [method("m1"), method("m2"), method("m3")],
    });
    expect(parsed.methods).toHaveLength(3);
  });

  it("rejects in-domain payload with fewer than 3 methods", () => {
    expect(() =>
      enumerateResponseSchema.parse({
        comparison_summary: "x",
        out_of_domain_warning: null,
        methods: [method("m1")],
      }),
    ).toThrow(/at least 3 methods/);
  });

  it("allows fewer than 3 methods when out_of_domain_warning is set", () => {
    const parsed = enumerateResponseSchema.parse({
      comparison_summary: "域外",
      out_of_domain_warning: "非 Nat/Int 等式",
      methods: [method("m1")],
    });
    expect(parsed.methods).toHaveLength(1);
  });

  it("rejects unknown category", () => {
    expect(() =>
      enumerateResponseSchema.parse({
        comparison_summary: "x",
        methods: [
          {
            id: "m1",
            category: "magic",
            title: "t",
            inspiration: "i",
            pros: "p",
            cons: "c",
            lean_sketch: "s",
            confidence: 1,
          },
        ],
      }),
    ).toThrow();
  });
});

describe("generateProblemResponseSchema leniency", () => {
  const problem = (overrides: Record<string, unknown> = {}) => ({
    statement: "求方程 x^2 - 5x + 6 = 0 的所有实数解。",
    answer: "x = 2 或 x = 3",
    hints: ["因式分解", "试根", "韦达定理"],
    grade_level: "high",
    difficulty: "standard",
    domain: "algebra",
    suggested_techniques: ["algebraic_manipulation"],
    source_inspiration: "课本习题",
    estimated_solve_time: "5分钟",
    ...overrides,
  });

  it("trims hints to at most 5 instead of rejecting", () => {
    const parsed = generateProblemResponseSchema.parse({
      problems: [problem({ hints: ["h1", "h2", "h3", "h4", "h5", "h6", "h7"] })],
    });
    expect(parsed.problems[0].hints).toEqual(["h1", "h2", "h3", "h4", "h5"]);
  });

  it("accepts null diagram_svg and coerces to undefined", () => {
    const parsed = generateProblemResponseSchema.parse({
      problems: [problem({ diagram_svg: null })],
    });
    expect(parsed.problems[0].diagram_svg).toBeUndefined();
  });

  it("passes through a real diagram_svg string", () => {
    const parsed = generateProblemResponseSchema.parse({
      problems: [problem({ diagram_svg: "<svg></svg>" })],
    });
    expect(parsed.problems[0].diagram_svg).toBe("<svg></svg>");
  });

  it("still rejects an empty hints array", () => {
    expect(() =>
      generateProblemResponseSchema.parse({
        problems: [problem({ hints: [] })],
      }),
    ).toThrow();
  });
});

describe("planResponseSchema theorem_name", () => {
  it("accepts Lean identifiers", () => {
    const parsed = planResponseSchema.parse({
      theorem_name: "nat_add_zero'",
      theorem_type: "(n : Nat) : n + 0 = n",
      steps: [{ index: 0, plain_goal: "g", lean_goal: "⊢ True" }],
    });
    expect(parsed.theorem_name).toBe("nat_add_zero'");
  });

  it("rejects whitespace / newlines in theorem_name", () => {
    expect(() =>
      planResponseSchema.parse({
        theorem_name: "bad name",
        theorem_type: "(n : Nat) : n + 0 = n",
        steps: [{ index: 0, plain_goal: "g", lean_goal: "⊢ True" }],
      }),
    ).toThrow();
    expect(() =>
      planResponseSchema.parse({
        theorem_name: "bad\nname",
        theorem_type: "(n : Nat) : n + 0 = n",
        steps: [{ index: 0, plain_goal: "g", lean_goal: "⊢ True" }],
      }),
    ).toThrow();
  });
});
