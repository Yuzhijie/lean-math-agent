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
import { lt } from "./output-locale";
import { failureNote, verifyGenerated } from "./verify-generated";

export interface GenerateProblemOptions {
  gradeLevel: GradeLevel;
  difficulty: DifficultyLevel;
  domain: CompetitionDomain;
  count: number;
  /** Check every problem (independent solve, Lean counterexample search) and write again for the failed ones (default true). */
  verify?: boolean;
  onProgress?: (p: BuiltinProgress) => void;
}

/** Progress of a built-in generation (same shape as the bank's ProgressLine). */
export interface BuiltinProgress {
  stage: "writing" | "checking" | "round_done";
  round: number;
  rounds: number;
  requested: number;
  passed: number;
  detail: string;
}

export interface BuiltinResult {
  /** Problems that passed the checks first, then (when too few passed) the failed ones with their reasons. */
  problems: GeneratedProblem[];
  requested: number;
  note?: string;
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

/** Writing rounds: while fewer than requested pass, write again with the rejected ones as feedback. */
export const BUILTIN_ROUNDS = 3;
const CHECK_CONCURRENCY = 3;

async function writeProblems(options: GenerateProblemOptions, count: number, rejected: string[]): Promise<GeneratedProblem[]> {
  const { gradeLevel, difficulty, domain } = options;
  const systemPrompt = buildGeneratorPrompt(gradeLevel, difficulty, domain, count);
  const feedback = rejected.length
    ? `\n\n下面这些题已被检查否决（答案与独立解答不一致、结论不成立、题目有缺陷或 Lean 陈述有反例），不要再出类似的错误题：\n${rejected.slice(-8).join("\n")}`
    : "";
  const userPrompt = `请生成 ${count} 道${getGradeLabel(gradeLevel)}${getDifficultyLabel(difficulty)}的${getDomainLabel(domain)}题目。每道题都必须有确定、正确的答案；要证明的结论必须为真（先用具体数值和特殊情形检验）。${feedback}`;
  const response = await chatJson({
    system: systemPrompt,
    user: userPrompt,
    schema: generateProblemResponseSchema,
    schemaName: "generateProblemResponse",
    temperature: 0.8,
    timeoutMs: GENERATE_TIMEOUT_MS,
    maxRetries: 0, // skip Zod retry to stay within time budget
  });
  return response.problems.slice(0, count).map((p) => ({ ...verifyAndFixAnswer(p), id: randomUUID() }));
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/**
 * Generates math problems via LLM with Zod validation, then checks each one (independent solve,
 * Lean counterexample search, a Lean proof when the program can find one) and writes again for
 * the ones that failed, up to BUILTIN_ROUNDS rounds.
 */
export async function generateProblems(options: GenerateProblemOptions): Promise<BuiltinResult> {
  const requested = Math.max(1, Math.min(10, options.count));
  if (options.verify === false) return { problems: await writeProblems(options, requested, []), requested };
  const passed: GeneratedProblem[] = [];
  const failed: GeneratedProblem[] = [];
  const rejected: string[] = [];
  const progress = (stage: BuiltinProgress["stage"], round: number, detail: string) =>
    options.onProgress?.({ stage, round, rounds: BUILTIN_ROUNDS, requested, passed: passed.length, detail });
  for (let round = 1; round <= BUILTIN_ROUNDS && passed.length < requested; round++) {
    const need = requested - passed.length;
    progress("writing", round, lt(`第 ${round} 轮：正在写 ${need} 道题…`, `Round ${round}: writing ${need} problem(s)…`));
    let drafts: GeneratedProblem[];
    try {
      drafts = await writeProblems(options, need, rejected);
    } catch (e) {
      if (round === 1 && !passed.length) throw e;
      break;
    }
    let done = 0;
    progress("checking", round, lt(`第 ${round} 轮：独立解题并在 Lean 里找反例（0/${drafts.length}）…`, `Round ${round}: solving independently and searching for counterexamples in Lean (0/${drafts.length})…`));
    const checked = await pool(drafts, CHECK_CONCURRENCY, async (p) => {
      const verification = await verifyGenerated(p);
      done++;
      progress("checking", round, lt(`第 ${round} 轮：独立解题并在 Lean 里找反例（${done}/${drafts.length}）…`, `Round ${round}: solving independently and searching for counterexamples in Lean (${done}/${drafts.length})…`));
      return { ...p, verification };
    });
    for (const p of checked) {
      if (p.verification!.passed && passed.length < requested) passed.push(p);
      else if (!p.verification!.passed) {
        failed.push(p);
        rejected.push(failureNote(p));
      }
    }
    progress("round_done", round, lt(`第 ${round} 轮结束：已通过 ${passed.length}/${requested} 道`, `Round ${round} done: ${passed.length}/${requested} passed`));
  }
  const note =
    passed.length < requested
      ? lt(
          `${BUILTIN_ROUNDS} 轮后只有 ${passed.length} 道通过检查；没通过的题列在后面，写明了原因。`,
          `After ${BUILTIN_ROUNDS} rounds only ${passed.length} passed the checks; the failed ones follow, each with its reason.`,
        )
      : undefined;
  return { problems: [...passed, ...(passed.length < requested ? failed : [])], requested, ...(note ? { note } : {}) };
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
