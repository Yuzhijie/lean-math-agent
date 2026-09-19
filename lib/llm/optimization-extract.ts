import { z } from "zod";
import { chatJson } from "./client";
import type { OptimizationStructure } from "../compute/optimization-solver";

// ── Schema ──────────────────────────────────────────────────────────

const categorySchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  count_variable: z.string().min(1),
  integer_type: z.enum(["even", "odd", "integer"]),
  min_sum_formula: z.string().min(1),
});

export const optimizationStructureSchema = z.object({
  objective: z.enum(["maximize", "minimize"]),
  objective_coefficients: z.record(z.number()),
  objective_description: z.string().min(1),
  target_sum: z.number(),
  target_description: z.string().min(1),
  categories: z.array(categorySchema).min(1),
  key_insight: z.string().min(1),
});

// ── Prompt ──────────────────────────────────────────────────────────

const OPTIMIZATION_EXTRACT_SYSTEM = `你是一位数学建模专家，擅长将组合优化问题提取为结构化的数学模型。

## 你的任务
将一个"最大化/最小化"问题转化为结构化的优化模型。

## 整数类型分类
- **even**: 正偶数 (2, 4, 6, ...)。k 个最小正偶数的和 = k(k+1)
- **odd**: 正奇数 (1, 3, 5, ...)。k 个最小正奇数的和 = k²
- **integer**: 正整数 (1, 2, 3, ...)。k 个最小正整数的和 = k(k+1)/2

## 关键约束
- 每个类别的 count_variable 必须与 objective_coefficients 中的键一致
- objective_coefficients 是每个变量的系数（如 "3m+4n" → {m: 3, n: 4}）
- target_sum 是题目中给出的总和约束

## 输出要求
返回 JSON：
{
  "objective": "maximize" | "minimize",
  "objective_coefficients": { "变量名": 系数 },
  "objective_description": "目标函数的中文描述",
  "target_sum": 总和数值,
  "target_description": "总和约束的中文描述",
  "categories": [
    {
      "id": "类别标识",
      "description": "类别中文描述",
      "count_variable": "计数变量名",
      "integer_type": "even" | "odd" | "integer",
      "min_sum_formula": "最小和公式（如 k(k+1)）"
    }
  ],
  "key_insight": "解题关键洞察（中文）"
}`;

// ── Main Function ───────────────────────────────────────────────────

/**
 * Use LLM to extract the optimization structure from a word problem.
 * Returns a deterministic-searchable structure.
 */
export async function extractOptimizationStructure(
  problemText: string,
): Promise<OptimizationStructure> {
  return chatJson({
    system: OPTIMIZATION_EXTRACT_SYSTEM,
    user: `提取以下优化问题的数学结构：\n\n${problemText}`,
    schema: optimizationStructureSchema,
    schemaName: "optimizationStructure",
    temperature: 0,
  });
}
