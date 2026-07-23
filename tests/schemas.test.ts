import { describe, it, expect } from "vitest";
import { enumerateResponseSchema } from "@/lib/schemas";

describe("enumerateResponseSchema", () => {
  it("accepts a valid enumerate payload with ≥1 method", () => {
    const parsed = enumerateResponseSchema.parse({
      comparison_summary: "归纳最稳；rewrite 最短。",
      out_of_domain_warning: null,
      methods: [
        {
          id: "m1",
          category: "induction",
          title: "对 n 归纳",
          inspiration: "目标对全体自然数成立，结构上适合归纳。",
          pros: "覆盖所有 n，证明完整。",
          cons: "比 simp 啰嗦。",
          lean_sketch: "induction n <;> simp",
          confidence: 0.9,
        },
      ],
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
