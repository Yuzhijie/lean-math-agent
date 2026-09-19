import { describe, it, expect } from "vitest";
import { stepInsightSchema, intuitionReviewSchema } from "@/lib/schemas";

describe("intuition schemas", () => {
  it("validates a step insight", () => {
    const insight = {
      step_index: 0,
      motivation: "这一步引入了变量n",
      trigger_observation: "问题中的自然数n提示我们使用归纳法",
      discovery_path: "看到关于自然数的命题，首先考虑是否可以用归纳法",
      dead_ends: ["直接展开定义会得到无穷递归"],
      transferable_lesson: "对于涉及自然数的命题，归纳法是最自然的证明策略",
    };

    const result = stepInsightSchema.parse(insight);
    expect(result.step_index).toBe(0);
    expect(result.dead_ends).toHaveLength(1);
  });

  it("rejects step insight with empty motivation", () => {
    expect(() =>
      stepInsightSchema.parse({
        step_index: 0,
        motivation: "",
        trigger_observation: "trigger",
        discovery_path: "path",
        dead_ends: [],
        transferable_lesson: "lesson",
      }),
    ).toThrow();
  });

  it("validates full intuition review", () => {
    const review = {
      per_step: [
        {
          step_index: 0,
          motivation: "引入变量",
          trigger_observation: "自然数参数",
          discovery_path: "看到参数就引入",
          dead_ends: [],
          transferable_lesson: "总是先引入所有参数",
        },
        {
          step_index: 1,
          motivation: "使用rfl闭合",
          trigger_observation: "等式两边完全相同",
          discovery_path: "检查等式是否可以直接由定义得到",
          dead_ends: ["用simp会多余"],
          transferable_lesson: "优先尝试最简单的策略",
        },
      ],
      overall_lessons: ["归纳法是自然数命题的基本工具", "简单策略应优先尝试"],
      transferable_patterns: [
        "对自然数参数使用归纳法",
        "先尝试rfl再考虑复杂策略",
      ],
    };

    const result = intuitionReviewSchema.parse(review);
    expect(result.per_step).toHaveLength(2);
    expect(result.overall_lessons).toHaveLength(2);
    expect(result.transferable_patterns).toHaveLength(2);
  });

  it("rejects empty overall_lessons", () => {
    expect(() =>
      intuitionReviewSchema.parse({
        per_step: [
          {
            step_index: 0,
            motivation: "m",
            trigger_observation: "t",
            discovery_path: "d",
            dead_ends: [],
            transferable_lesson: "l",
          },
        ],
        overall_lessons: [],
        transferable_patterns: ["pattern"],
      }),
    ).toThrow();
  });
});
