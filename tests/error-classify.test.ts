import { describe, it, expect } from "vitest";
import { classifyLeanErrors, formatErrorsForRepair, parseLeanLog } from "@/lib/lean/parse-log";

describe("classifyLeanErrors", () => {
  it("classifies unknown_identifier errors", () => {
    const log = `
Scratch/Session_test.lean:3:4: error: unknown identifier 'foo'
`;
    const errors = classifyLeanErrors(log);
    expect(errors).toHaveLength(1);
    expect(errors[0].kind).toBe("unknown_identifier");
    expect(errors[0].line).toBe(3);
    expect(errors[0].column).toBe(4);
    expect(errors[0].suggestion).toBeTruthy();
  });

  it("classifies type_mismatch errors", () => {
    const log = `
Scratch/Session_test.lean:5:2: error: type mismatch, expected Nat but got Int
`;
    const errors = classifyLeanErrors(log);
    expect(errors).toHaveLength(1);
    expect(errors[0].kind).toBe("type_mismatch");
  });

  it("classifies tactic_failed errors", () => {
    const log = `
error: tactic 'simp' failed to simplify
`;
    const errors = classifyLeanErrors(log);
    expect(errors).toHaveLength(1);
    expect(errors[0].kind).toBe("tactic_failed");
  });

  it("classifies unsolved_goal errors", () => {
    const log = `
error: unsolved goals
⊢ n + 0 = n
`;
    const errors = classifyLeanErrors(log);
    expect(errors).toHaveLength(1);
    expect(errors[0].kind).toBe("unsolved_goal");
  });

  it("classifies multiple errors", () => {
    const log = `
Scratch/Session_test.lean:3:4: error: unknown identifier 'add_comm'
Scratch/Session_test.lean:5:2: error: type mismatch
Scratch/Session_test.lean:7:1: error: tactic 'ring' failed
`;
    const errors = classifyLeanErrors(log);
    expect(errors).toHaveLength(3);
    expect(errors[0].kind).toBe("unknown_identifier");
    expect(errors[1].kind).toBe("type_mismatch");
    expect(errors[2].kind).toBe("tactic_failed");
  });

  it("returns empty array for clean log", () => {
    const errors = classifyLeanErrors("ok\nno issues\n");
    expect(errors).toHaveLength(0);
  });

  it("classifies syntax errors", () => {
    const log = `error: unexpected token 'end'; expected '}'`;
    const errors = classifyLeanErrors(log);
    expect(errors).toHaveLength(1);
    expect(errors[0].kind).toBe("syntax_error");
  });

  it("classifies timeout errors", () => {
    const log = `error: deterministic timeout`;
    const errors = classifyLeanErrors(log);
    expect(errors).toHaveLength(1);
    expect(errors[0].kind).toBe("timeout");
  });

  it("classifies missing_lemma errors", () => {
    const log = `error: failed to synthesize instance`;
    const errors = classifyLeanErrors(log);
    expect(errors).toHaveLength(1);
    expect(errors[0].kind).toBe("missing_lemma");
  });

  it("classifies scope_error", () => {
    const log = `error: variable 'x' is not in scope`;
    const errors = classifyLeanErrors(log);
    expect(errors).toHaveLength(1);
    expect(errors[0].kind).toBe("scope_error");
  });
});

describe("formatErrorsForRepair", () => {
  it("formats errors with suggestions", () => {
    const errors = classifyLeanErrors(`
Scratch/Session_test.lean:3:4: error: unknown identifier 'foo'
`);
    const formatted = formatErrorsForRepair(errors);
    expect(formatted).toContain("[unknown_identifier]");
    expect(formatted).toContain("line 3");
    expect(formatted).toContain("修复建议");
  });

  it("formats multiple errors with numbering", () => {
    const errors = classifyLeanErrors(`
error: unknown identifier 'foo'
error: type mismatch
`);
    const formatted = formatErrorsForRepair(errors);
    expect(formatted).toContain("1.");
    expect(formatted).toContain("2.");
  });
});

describe("parseLeanLog (backward compat)", () => {
  it("still filters useful lines", () => {
    const result = parseLeanLog("noise\nerror: something\nmore noise\nwarning: other");
    expect(result).toContain("error: something");
    expect(result).toContain("warning: other");
    expect(result).not.toContain("noise");
  });
});
