import { afterEach, describe, expect, it } from "vitest";
import { baseSolveEffort, escalates, isEarlyGrade } from "@/lib/generation-effort";

afterEach(() => {
  delete process.env.GENERATE_SOLVE_EFFORT;
});

describe("solve effort for generated questions", () => {
  it("recognises primary and lower-secondary grades", () => {
    for (const g of ["Year 3", "Grade 6", "year 8", "P4", "三年级", "小学", "初二", "Kindergarten", "Foundation", "elementary", "middle", "5"]) expect(isEarlyGrade(g), g).toBe(true);
    for (const g of ["Year 11", "Grade 10", "高一", "high", "university", "", undefined]) expect(isEarlyGrade(g), String(g)).toBe(false);
  });

  it("medium for early grades below competition level, the configured effort otherwise", () => {
    expect(baseSolveEffort({ grade: "Year 3", difficulty: 2 })).toBe("medium");
    expect(baseSolveEffort({ grade: "Year 3", difficulty: 4 })).toBeUndefined();
    expect(baseSolveEffort({ gradeLevel: "middle", difficulty: "advanced" })).toBe("medium");
    expect(baseSolveEffort({ gradeLevel: "elementary", difficulty: "competition" })).toBeUndefined();
    expect(baseSolveEffort({ gradeLevel: "high", difficulty: "standard" })).toBeUndefined();
    expect(escalates("medium")).toBe(true);
    expect(escalates("high")).toBe(false);
    expect(escalates(undefined)).toBe(false);
  });

  it("GENERATE_SOLVE_EFFORT fixes one effort", () => {
    process.env.GENERATE_SOLVE_EFFORT = "low";
    expect(baseSolveEffort({ grade: "Year 11" })).toBe("low");
    process.env.GENERATE_SOLVE_EFFORT = "default";
    expect(baseSolveEffort({ grade: "Year 3" })).toBeUndefined();
  });
});
