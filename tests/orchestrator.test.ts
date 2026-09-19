import { describe, it, expect } from "vitest";
import { getStrategistConfigs } from "@/lib/agents/strategist";
import { methodScoreSchema, evaluateResponseSchema } from "@/lib/schemas";

describe("strategist configs", () => {
  it("returns configs for competition_elementary domain", () => {
    const configs = getStrategistConfigs("competition_elementary");
    expect(configs).toHaveLength(3);
    expect(configs[0].id).toBe("strat-A");
    expect(configs[0].techniqueFamilies).toContain("direct_computation");
    expect(configs[1].id).toBe("strat-B");
    expect(configs[2].id).toBe("strat-C");
  });

  it("returns configs for number_theory domain", () => {
    const configs = getStrategistConfigs("number_theory");
    expect(configs).toHaveLength(3);
    expect(configs[0].techniqueFamilies).toContain("induction");
  });

  it("returns configs for set_theory domain", () => {
    const configs = getStrategistConfigs("set_theory");
    expect(configs).toHaveLength(3);
    expect(configs[0].techniqueFamilies).toContain("subset_argument");
    expect(configs[1].techniqueFamilies).toContain("cardinality_argument");
  });

  it("returns default configs for unknown domains", () => {
    const configs = getStrategistConfigs("topology");
    expect(configs).toHaveLength(2);
    expect(configs[0].techniqueFamilies.length).toBeGreaterThan(0);
  });

  it("all configs have unique ids", () => {
    const configs = getStrategistConfigs("competition_elementary");
    const ids = configs.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all configs use valid technique families", () => {
    const validTechniques = [
      "direct_computation", "induction", "contradiction", "contrapositive",
      "case_analysis", "extremal_principle", "invariant", "bijection",
      "generating_function", "algebraic_manipulation", "inequality_chain",
      "pigeonhole", "double_counting", "construction",
      "inclusion_exclusion", "subset_argument", "cardinality_argument",
    ];
    const configs = getStrategistConfigs("competition_elementary");
    for (const config of configs) {
      for (const tech of config.techniqueFamilies) {
        expect(validTechniques).toContain(tech);
      }
    }
  });
});

describe("evaluate schemas", () => {
  it("validates method score", () => {
    const score = {
      method_id: "m1",
      feasibility: 0.8,
      elegance: 0.7,
      lean_difficulty: 0.3,
      mathlib_coverage: 0.9,
      pedagogical_value: 0.6,
      composite: 0.75,
      rationale: "Good approach",
    };
    const result = methodScoreSchema.parse(score);
    expect(result.composite).toBe(0.75);
  });

  it("rejects scores outside 0-1 range", () => {
    expect(() =>
      methodScoreSchema.parse({
        method_id: "m1",
        feasibility: 1.5,
        elegance: 0.7,
        lean_difficulty: 0.3,
        mathlib_coverage: 0.9,
        pedagogical_value: 0.6,
        composite: 0.75,
        rationale: "Bad score",
      }),
    ).toThrow();
  });

  it("validates evaluate response", () => {
    const response = {
      scores: [
        {
          method_id: "m1",
          feasibility: 0.8,
          elegance: 0.7,
          lean_difficulty: 0.3,
          mathlib_coverage: 0.9,
          pedagogical_value: 0.6,
          composite: 0.75,
          rationale: "Good",
        },
      ],
      recommended_method_id: "m1",
      comparison: "方法一更好",
    };
    const result = evaluateResponseSchema.parse(response);
    expect(result.recommended_method_id).toBe("m1");
    expect(result.scores).toHaveLength(1);
  });
});
