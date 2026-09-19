import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupEquations } from "@/lib/llm/equation-setup";
import { equationSetupSchema } from "@/lib/llm/equation-setup";

// ── Test helpers ────────────────────────────────────────────────────

function chatResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

beforeEach(() => {
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_BASE_URL = "https://example.test/v1";
  process.env.LLM_MODEL = "test-model";
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MODEL;
});

// ── Schema tests ────────────────────────────────────────────────────

describe("equationSetupSchema", () => {
  it("accepts valid equation setup for beach problem", () => {
    const result = equationSetupSchema.parse({
      variables: [
        { name: "x", description: "A到B的距离", domain: "positive_real" },
      ],
      equations: [
        {
          lhs: "x/3 + sqrt((3-x)**2 + 3)/2",
          rhs: "Rational(5,3)",
          description: "总时间等于5/3小时",
        },
      ],
      constraints: ["x > 0"],
      target_expression: "x1 + x2",
      target_description: "两个有效距离之和",
      solution_methods: [
        { name: "explicit_solve", description: "显式求解二次方程" },
        { name: "vieta", description: "韦达定理求根之和" },
      ],
    });
    expect(result.variables).toHaveLength(1);
    expect(result.equations).toHaveLength(1);
    expect(result.solution_methods).toHaveLength(2);
  });

  it("rejects setup with no variables", () => {
    expect(() =>
      equationSetupSchema.parse({
        variables: [],
        equations: [{ lhs: "x", rhs: "0", description: "test" }],
        constraints: [],
        target_expression: "x",
        target_description: "test",
        solution_methods: [
          { name: "m1", description: "d1" },
          { name: "m2", description: "d2" },
        ],
      }),
    ).toThrow();
  });

  it("rejects setup with fewer than 2 methods", () => {
    expect(() =>
      equationSetupSchema.parse({
        variables: [{ name: "x", description: "变量", domain: "real" }],
        equations: [{ lhs: "x", rhs: "0", description: "test" }],
        constraints: [],
        target_expression: "x",
        target_description: "test",
        solution_methods: [{ name: "m1", description: "d1" }],
      }),
    ).toThrow();
  });

  it("rejects empty equation lhs", () => {
    expect(() =>
      equationSetupSchema.parse({
        variables: [{ name: "x", description: "变量", domain: "real" }],
        equations: [{ lhs: "", rhs: "0", description: "test" }],
        constraints: [],
        target_expression: "x",
        target_description: "test",
        solution_methods: [
          { name: "m1", description: "d1" },
          { name: "m2", description: "d2" },
        ],
      }),
    ).toThrow();
  });
});

// ── Integration tests ───────────────────────────────────────────────

describe("setupEquations", () => {
  it("sets up equations for beach walking problem", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      chatResponse(
        JSON.stringify({
          variables: [
            { name: "x", description: "A到B的距离(英里)", domain: "positive_real" },
          ],
          equations: [
            {
              lhs: "x/3 + sqrt((3-x)**2 + 3)/2",
              rhs: "Rational(5,3)",
              description: "步行时间 + 游泳时间 = 总时间",
            },
          ],
          constraints: ["x > 0"],
          target_expression: "x1 + x2",
          target_description: "两个满足条件的距离值之和",
          solution_methods: [
            { name: "explicit_solve", description: "化简为二次方程并求解" },
            { name: "vieta", description: "利用韦达定理直接求根之和" },
          ],
        }),
      ),
    );

    const result = await setupEquations(
      "A person walks along a beach at 3 mi/h...",
    );

    expect(result.variables[0].name).toBe("x");
    expect(result.equations[0].lhs).toContain("sqrt");
    expect(result.solution_methods).toHaveLength(2);

    // Verify the fetch was called with equation setup prompt
    const callBody = JSON.parse(
      fetchMock.mock.calls[0][1]!.body as string,
    );
    const messages = callBody.messages;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("SymPy");
  });
});
