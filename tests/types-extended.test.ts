import { describe, it, expect } from "vitest";
import {
  TAXONOMY,
  MATH_DOMAINS,
  PROOF_TECHNIQUES,
  AGENT_ROLES,
  ERROR_KINDS,
} from "@/lib/types";

describe("MATH_DOMAINS", () => {
  it("has exactly 21 domains", () => {
    expect(MATH_DOMAINS).toHaveLength(21);
  });

  it("includes core math domains", () => {
    expect(MATH_DOMAINS).toContain("nat_arithmetic");
    expect(MATH_DOMAINS).toContain("int_arithmetic");
    expect(MATH_DOMAINS).toContain("real_analysis");
    expect(MATH_DOMAINS).toContain("number_theory");
    expect(MATH_DOMAINS).toContain("algebra");
    expect(MATH_DOMAINS).toContain("combinatorics");
    expect(MATH_DOMAINS).toContain("set_theory");
  });

  it("includes competition domains", () => {
    expect(MATH_DOMAINS).toContain("competition_elementary");
    expect(MATH_DOMAINS).toContain("competition_inequality");
    expect(MATH_DOMAINS).toContain("competition_number_theory");
    expect(MATH_DOMAINS).toContain("competition_combinatorics");
    expect(MATH_DOMAINS).toContain("competition_set_theory");
  });

  it("ends with 'other'", () => {
    expect(MATH_DOMAINS[MATH_DOMAINS.length - 1]).toBe("other");
  });
});

describe("PROOF_TECHNIQUES", () => {
  it("has exactly 17 techniques", () => {
    expect(PROOF_TECHNIQUES).toHaveLength(17);
  });

  it("includes core techniques", () => {
    expect(PROOF_TECHNIQUES).toContain("induction");
    expect(PROOF_TECHNIQUES).toContain("contradiction");
    expect(PROOF_TECHNIQUES).toContain("case_analysis");
    expect(PROOF_TECHNIQUES).toContain("direct_computation");
    expect(PROOF_TECHNIQUES).toContain("algebraic_manipulation");
  });

  it("includes competition techniques", () => {
    expect(PROOF_TECHNIQUES).toContain("extremal_principle");
    expect(PROOF_TECHNIQUES).toContain("invariant");
    expect(PROOF_TECHNIQUES).toContain("pigeonhole");
    expect(PROOF_TECHNIQUES).toContain("double_counting");
    expect(PROOF_TECHNIQUES).toContain("bijection");
  });

  it("includes set theory techniques", () => {
    expect(PROOF_TECHNIQUES).toContain("inclusion_exclusion");
    expect(PROOF_TECHNIQUES).toContain("subset_argument");
    expect(PROOF_TECHNIQUES).toContain("cardinality_argument");
  });
});

describe("AGENT_ROLES", () => {
  it("has exactly 6 roles", () => {
    expect(AGENT_ROLES).toHaveLength(6);
  });

  it("includes all pipeline roles", () => {
    expect(AGENT_ROLES).toContain("orchestrator");
    expect(AGENT_ROLES).toContain("formalizer");
    expect(AGENT_ROLES).toContain("strategist");
    expect(AGENT_ROLES).toContain("critic");
    expect(AGENT_ROLES).toContain("prover");
    expect(AGENT_ROLES).toContain("explainer");
  });
});

describe("ERROR_KINDS", () => {
  it("has exactly 8 error kinds", () => {
    expect(ERROR_KINDS).toHaveLength(8);
  });

  it("includes all repair-loop error kinds", () => {
    expect(ERROR_KINDS).toContain("unknown_identifier");
    expect(ERROR_KINDS).toContain("type_mismatch");
    expect(ERROR_KINDS).toContain("unsolved_goal");
    expect(ERROR_KINDS).toContain("tactic_failed");
    expect(ERROR_KINDS).toContain("missing_lemma");
    expect(ERROR_KINDS).toContain("scope_error");
    expect(ERROR_KINDS).toContain("syntax_error");
    expect(ERROR_KINDS).toContain("timeout");
  });
});

describe("TAXONOMY (unchanged)", () => {
  it("still has exactly 8 categories", () => {
    expect(TAXONOMY).toHaveLength(8);
  });
});
