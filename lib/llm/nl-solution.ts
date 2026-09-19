import { z } from "zod";
import { chatJson } from "./client";
import type { NaturalLanguageSolution } from "../types";

// ── Schema ──────────────────────────────────────────────────────────

const nlStepSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  substeps: z.array(z.string()).optional(),
  key_formula: z.string().optional(),
});

export const nlSolutionSchema = z.object({
  summary: z.string().min(1),
  steps: z.array(nlStepSchema).min(1),
  final_answer: z.string().min(1),
  verification: z.string().min(1),
});

// ── Prompts ─────────────────────────────────────────────────────────

const NL_SOLUTION_SYSTEM = `你是一位数学教育专家，负责用自然语言详细解答数学问题。

## 要求：
1. **完整推导**：每一步都要展示具体的计算过程，不能跳步
2. **数学公式**：使用 LaTeX 格式，行内用 $...$，独立公式用 $$...$$
3. **中文输出**：所有解释用中文书写
4. **验证环节**：将答案代回原题验证正确性
5. **最终答案**：明确给出最终数值答案

## 解答结构：
- **理解题意**：分析问题中的已知条件和目标
- **建立模型**：设变量，建立方程或关系式
- **求解过程**：逐步推导，展示关键代数运算
- **验证答案**：将结果代入原方程/原问题验证
- **最终答案**：清晰地给出最终答案

返回 JSON 格式：
{
  "summary": "一句话概括解题思路和答案",
  "steps": [
    { "title": "步骤标题", "content": "详细步骤内容（含 LaTeX 公式）" },
    ...
  ],
  "final_answer": "最终答案（LaTeX 格式）",
  "verification": "验证方法说明"
}`;

const NL_SOLUTION_COMPUTATIONAL_SYSTEM = `你是一位数学教育专家，专门解答计算类数学问题。你需要：

1. 仔细分析问题，明确已知量和未知量
2. 设立变量，建立方程
3. 逐步求解方程，展示每一步代数运算
4. 特别注意：
   - 对于含有根号的方程，平方后可能产生增根，**必须逐一验根**
   - 对于二次方程，使用韦达定理验证根的和与积
   - 对于应用题，检查答案是否符合实际意义
5. 将每个解代回**原始方程**（不是化简后的方程）验证
6. 清晰地给出最终答案

## 格式要求：
- 使用 LaTeX 数学公式：行内 $...$，独立 $$...$$
- 所有内容用中文书写
- 展示完整的计算过程，不能跳步

返回 JSON 格式：
{
  "summary": "一句话概括：问题类型 + 关键方法 + 答案",
  "steps": [
    { "title": "理解题意", "content": "...", "key_formula": "关键公式（可选）" },
    { "title": "设立变量", "content": "...", "substeps": ["子步骤1", "子步骤2"] },
    { "title": "建立方程", "content": "...", "key_formula": "$$ax^2 + bx + c = 0$$" },
    { "title": "求解方程", "content": "...", "substeps": ["计算判别式", "代入求根公式"] },
    { "title": "验证答案", "content": "..." }
  ],
  "final_answer": "最终答案（LaTeX 格式，如 $\\\\frac{14}{5}$）",
  "verification": "如何将答案代回原题验证"
}

注意：
- "substeps" 和 "key_formula" 为可选字段，仅在步骤包含多个子步骤或关键公式时使用
- "key_formula" 应为独立的 LaTeX 公式（使用 $$...$$），会被高亮显示`;

const NL_SOLUTION_FIND_ALL_SYSTEM = `你是一位数论和竞赛数学专家，专门解答"求所有满足条件的值"类型问题。你需要：

## 核心原则
1. **系统性搜索**：不遗漏任何候选值
2. **完备性证明**：证明找到的值是全部解，不存在其他解
3. **逐一验证**：对每个候选值严格验证是否满足所有条件

## 解题步骤

### 第一步：分析必要条件
- 从题目条件推导出参数必须满足的必要条件
- 利用整除性、同余、奇偶性等数论工具缩小搜索范围
- 对递推数列问题：先计算前几项，观察规律

### 第二步：确定搜索范围
- 利用增长速率论证参数有界
- 利用模运算排除大量候选值
- 给出明确的搜索上界和下界

### 第三步：逐一验证候选值
- 对每个候选值，计算数列的前 10-15 项
- 检查每项是否满足条件（如是否为完全平方数）
- 若发现规律（如与已知数列的关系），尝试证明一般项也满足

### 第四步：完备性论证
- 解释为什么超出搜索范围的值不可能满足条件
- 总结关键数学洞察

## 特别注意
- 递推数列问题：特征方程、闭式表达、与经典数列（Fibonacci, Pell等）的关系
- 完全平方条件：检查是否为整数平方根，注意大数
- 不要只给出一个解就停止，要穷举所有可能

## 格式要求
- 使用 LaTeX 数学公式：行内 $...$，独立 $$...$$
- 所有内容用中文书写
- 展示完整的推导过程

返回 JSON 格式：
{
  "summary": "一句话概括：问题类型 + 关键方法 + 所有满足条件的值",
  "steps": [
    { "title": "分析必要条件", "content": "推导必要条件，缩小搜索范围" },
    { "title": "确定搜索范围", "content": "利用数论工具确定参数范围" },
    { "title": "逐一验证候选值", "content": "对每个候选值严格验证" },
    { "title": "完备性证明", "content": "证明不存在其他解" }
  ],
  "final_answer": "所有满足条件的值（LaTeX 格式）",
  "verification": "如何验证每个解的正确性和完备性"
}`;

// ── Main Functions ──────────────────────────────────────────────────

/**
 * Generate a detailed natural language solution for a computational problem.
 */
export async function generateNLSolution(args: {
  problemText: string;
  problemType?: "computational" | "theorem" | "find_all_values";
  method?: {
    title: string;
    category: string;
    inspiration: string;
    lean_sketch: string;
  };
  computeResult?: {
    answer: string;
    answer_decimal: string;
    solution_steps?: string[];
  };
}): Promise<NaturalLanguageSolution> {
  // Determine system prompt based on problem type
  let systemPrompt: string;
  if (args.problemType === "find_all_values" || isFindAllProblem(args.problemText)) {
    systemPrompt = NL_SOLUTION_FIND_ALL_SYSTEM;
  } else if (args.problemType === "theorem") {
    systemPrompt = NL_SOLUTION_SYSTEM;
  } else {
    systemPrompt = NL_SOLUTION_COMPUTATIONAL_SYSTEM;
  }

  let userPrompt = `请详细解答以下数学问题：\n\n${args.problemText}`;

  // Add method context if provided
  if (args.method) {
    userPrompt += `\n\n---\n采用的解题方法：${args.method.title} (${args.method.category})\n`;
    userPrompt += `方法思路：${args.method.inspiration}\n`;
    userPrompt += `Lean 草稿：${args.method.lean_sketch}\n`;
    userPrompt += `\n请基于此方法给出完整的自然语言解答。`;
  }

  // If we already have a computed answer, provide it as context
  if (args.computeResult) {
    userPrompt += `\n\n---\n参考信息（已由计算引擎得出）：\n`;
    userPrompt += `答案: ${args.computeResult.answer} (≈${args.computeResult.answer_decimal})\n`;
    if (args.computeResult.solution_steps?.length) {
      userPrompt += `求解步骤:\n${args.computeResult.solution_steps.join("\n")}\n`;
    }
    userPrompt += `\n请基于以上参考信息，给出完整的自然语言解答。注意：参考信息可能有误，请自行验证。`;
  }

  return chatJson({
    system: systemPrompt,
    user: userPrompt,
    schema: nlSolutionSchema,
    schemaName: "nlSolution",
    temperature: 0.2,
  });
}

/**
 * Generate a detailed natural language solution for a theorem problem,
 * incorporating the proof strategy context.
 */
export async function generateNLTheoremSolution(args: {
  problemText: string;
  methodTitle?: string;
  proofSteps?: Array<{ plain_goal: string; plain_explanation: string }>;
}): Promise<NaturalLanguageSolution> {
  let userPrompt = `请详细解答以下数学定理证明问题：\n\n${args.problemText}`;

  if (args.methodTitle) {
    userPrompt += `\n\n采用的证明方法：${args.methodTitle}`;
  }

  if (args.proofSteps?.length) {
    userPrompt += `\n\n证明步骤概要：`;
    for (const step of args.proofSteps) {
      userPrompt += `\n- ${step.plain_goal}${step.plain_explanation ? `：${step.plain_explanation}` : ""}`;
    }
  }

  userPrompt += `\n\n请用自然语言详细描述完整的证明过程，使读者能够理解每一步的动机和逻辑。`;

  return chatJson({
    system: NL_SOLUTION_SYSTEM,
    user: userPrompt,
    schema: nlSolutionSchema,
    schemaName: "nlTheoremSolution",
    temperature: 0.2,
  });
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Detect if a problem asks to "find all" values of a parameter.
 */
function isFindAllProblem(text: string): boolean {
  const patterns = [
    /determine\s+all/i,
    /find\s+all/i,
    /求所有/,
    /确定所有/,
    /找出所有/,
    /all\s+(?:integers?|values?|real\s+numbers?|positive\s+integers?)/i,
    /for\s+which.*all/i,
    /such\s+that.*all/i,
    /consists\s+exclusively/i,
    /every\s+term/i,
  ];
  return patterns.some((p) => p.test(text));
}
