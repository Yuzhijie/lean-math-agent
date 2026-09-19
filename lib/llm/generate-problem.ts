import { randomUUID } from "node:crypto";
import type {
  GradeLevel,
  DifficultyLevel,
  CompetitionDomain,
  GeneratedProblem,
} from "../types";
import { generateProblemResponseSchema } from "../schemas";
import { chatJson } from "./client";
import { buildGeneratorPrompt } from "./agent-prompt";
import { verifyAndFixAnswer } from "./answer-verifier";

export interface GenerateProblemOptions {
  gradeLevel: GradeLevel;
  difficulty: DifficultyLevel;
  domain: CompetitionDomain;
  count: number;
}

/**
 * Per-request timeout for problem generation LLM calls (ms).
 * The deadline-aware retry loop in client.ts caps total wall time at
 * ~2.5× this value (≈450s), so the route's maxDuration must be ≥ 480s.
 *
 * qwen3.7-max on Aliyun routinely takes 120-200s for complex generation
 * prompts, so 100s was too aggressive.
 */
const GENERATE_TIMEOUT_MS = 180_000; // 180 seconds

/**
 * Generates math problems via LLM with Zod validation.
 * Returns an array of GeneratedProblem objects with client-generated IDs.
 */
export async function generateProblems(
  options: GenerateProblemOptions,
): Promise<GeneratedProblem[]> {
  const { gradeLevel, difficulty, domain, count } = options;
  const clampedCount = Math.max(1, Math.min(10, count));

  const systemPrompt = buildGeneratorPrompt(
    gradeLevel,
    difficulty,
    domain,
    clampedCount,
  );

  const userPrompt = `请生成 ${clampedCount} 道${getGradeLabel(gradeLevel)}${getDifficultyLabel(difficulty)}的${getDomainLabel(domain)}题目。`;

  const response = await chatJson({
    system: systemPrompt,
    user: userPrompt,
    schema: generateProblemResponseSchema,
    schemaName: "generateProblemResponse",
    temperature: 0.8,
    timeoutMs: GENERATE_TIMEOUT_MS,
    maxRetries: 0, // skip Zod retry to stay within time budget
  });

  const problems = response.problems.slice(0, clampedCount);

  return problems.map((p) => ({
    ...verifyAndFixAnswer(p),
    id: randomUUID(),
  }));
}

// ── Label helpers ────────────────────────────────────────────────────

function getGradeLabel(level: GradeLevel): string {
  const labels: Record<GradeLevel, string> = {
    elementary: "小学",
    middle: "初中",
    high: "高中",
    university: "大学",
  };
  return labels[level];
}

function getDifficultyLabel(level: DifficultyLevel): string {
  const labels: Record<DifficultyLevel, string> = {
    standard: "标准难度",
    advanced: "提高难度",
    competition: "竞赛难度",
  };
  return labels[level];
}

function getDomainLabel(domain: CompetitionDomain): string {
  const labels: Record<CompetitionDomain, string> = {
    competition_elementary: "竞赛初等",
    competition_inequality: "竞赛不等式",
    competition_number_theory: "竞赛数论",
    competition_combinatorics: "竞赛组合",
    competition_set_theory: "竞赛集合",
    number_theory: "数论",
    combinatorics: "组合",
    set_theory: "集合",
    algebra: "代数",
    geometry: "几何",
    inequality: "不等式",
    logic: "逻辑",
    computation: "计算",
  };
  return labels[domain];
}
