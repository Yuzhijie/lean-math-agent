import { describe, expect, it } from "vitest";
import { COMPETITION_DOMAINS, domainAllowed } from "@/lib/types";
import { competitionDomainSchema } from "@/lib/schemas";
import { buildGeneratorPrompt } from "@/lib/llm/agent-prompt";

describe("数列: a domain of the built-in generator for primary and middle school", () => {
  it("is offered for those two levels only", () => {
    expect(COMPETITION_DOMAINS).toContain("sequence");
    expect(domainAllowed("sequence", "elementary")).toBe(true);
    expect(domainAllowed("sequence", "middle")).toBe(true);
    expect(domainAllowed("sequence", "high")).toBe(false);
    expect(domainAllowed("sequence", "university")).toBe(false);
    expect(competitionDomainSchema.parse("sequence")).toBe("sequence");
  });

  it("the writer is told what a sequence question is at each level", () => {
    for (const grade of ["elementary", "middle"] as const) {
      const p = buildGeneratorPrompt(grade, "standard", "sequence", 3);
      expect(p).toContain("**sequence**: 数列题");
      expect(p).toMatch(/小学阶段：等差数列.*周期数列.*初中阶段：用含 n 的代数式/s);
      expect(p).toContain("Domain: sequence");
      expect(p).toContain("数列");
    }
  });
});
