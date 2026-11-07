import { describe, expect, it } from "vitest";
import { COMPETITION_DOMAINS, domainAllowed } from "@/lib/types";
import { buildGeneratorPrompt } from "@/lib/llm/agent-prompt";
import { competitionDomainSchema } from "@/lib/schemas";

describe("应用题 in the built-in generator", () => {
  it("is a domain for primary and middle school only", () => {
    expect(COMPETITION_DOMAINS).toContain("word_problem");
    expect(domainAllowed("word_problem", "elementary")).toBe(true);
    expect(domainAllowed("word_problem", "middle")).toBe(true);
    expect(domainAllowed("word_problem", "high")).toBe(false);
    expect(domainAllowed("word_problem", "university")).toBe(false);
    expect(domainAllowed("algebra", "university")).toBe(true);
    expect(competitionDomainSchema.parse("word_problem")).toBe("word_problem");
  });

  it("the writer is told what a word problem is at each level", () => {
    const p = buildGeneratorPrompt("elementary", "standard", "word_problem", 3);
    expect(p).toContain("**word_problem**: 应用题");
    expect(p).toMatch(/鸡兔同笼.*初中阶段：一元一次方程/s);
    expect(p).toContain("Domain: word_problem");
  });
});
