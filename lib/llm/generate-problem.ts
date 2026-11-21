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
import { generationStats, logGeneration, measured, type StageClock } from "../generation-stats";
import type { ExamKind } from "../exam/types";

/**
 * What the questions of one part of a paper must be (lib/exam): the kind of question, the skills,
 * the difficulty on a 1–5 scale, and questions a student got wrong to write variants of.
 */
export interface GenerationFocus {
  kind?: ExamKind;
  knowledge_points?: string[];
  /** 1 = basic … 5 = hard. */
  difficulty?: number;
  like?: string[];
}

const KIND_RULES: Record<ExamKind, string> = {
  choice:
    "题型：单项选择题。statement 先写题干，然后另起一行列出 4 个选项，每个选项单独一行，依次写成“A. …”“B. …”“C. …”“D. …”；四个选项互不相同、只有一个正确，错误选项来自学生常见的错误；answer 只写正确选项的字母（例如 B）。",
  blank: "题型：填空题。题干里用“____”标出唯一的一个空；answer 只写应填的内容（一个数、一个式子或一个短语），不写过程。",
  solve: "题型：解答题。需要写出完整过程的计算题或应用题，有唯一确定的最终答案；answer 写最终答案。",
  proof: "题型：证明题。题目要求证明一个结论（“求证……”），结论必须为真（先用具体数值和特殊情形检验）；answer 写证明的要点。",
};

/** The writer's instructions for a focus (empty without one). */
export function focusPrompt(f: GenerationFocus | undefined): string {
  if (!f) return "";
  const lines: string[] = [];
  if (f.kind) lines.push(KIND_RULES[f.kind]);
  const kps = (f.knowledge_points ?? []).map((k) => k.trim()).filter(Boolean);
  if (kps.length) lines.push(`每道题都必须考查这些知识点：${kps.join("、")}。`);
  if (f.difficulty) lines.push(`难度：${Math.max(1, Math.min(5, Math.round(f.difficulty)))}/5（1 = 基础题，3 = 中等题，5 = 难题）。`);
  const like = (f.like ?? []).map((t) => t.replace(/\s+/g, " ").trim().slice(0, 600)).filter(Boolean);
  if (like.length)
    lines.push(
      `下面是学生做错的题。请出它们的变式题：考查同一个知识点、同一种题型、相近难度，但换数字和情境；不要照抄，也不要只改一个数：\n${like.map((t, i) => `${i + 1}. ${t}`).join("\n")}`,
    );
  return lines.length ? `\n\n${lines.join("\n")}` : "";
}

export interface GenerateProblemOptions {
  gradeLevel: GradeLevel;
  difficulty: DifficultyLevel;
  domain: CompetitionDomain;
  count: number;
  /** One part of a paper: kind of question, skills, difficulty, variants of wrong questions. */
  focus?: GenerationFocus;
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
  const userPrompt = `请生成 ${count} 道${getGradeLabel(gradeLevel)}${getDifficultyLabel(difficulty)}的${getDomainLabel(domain)}题目。每道题都必须有确定、正确的答案；要证明的结论必须为真（先用具体数值和特殊情形检验）。${focusPrompt(options.focus)}${feedback}`;
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
  // timed and its model usage counted: one line in the generation log (lib/generation-stats.ts)
  const m = await measured((clock) => generateChecked(options, requested, clock));
  const { result, written, rounds } = m.result;
  logGeneration({
    at: Date.now(),
    kind: "builtin",
    label: `${options.gradeLevel} · ${options.difficulty} · ${options.domain}`,
    requested,
    stats: {
      ...generationStats(m, { rounds, written: written.length, passed: written.filter((p) => p.verification?.passed).length }),
      model_checks_skipped: written.filter((p) => p.verification?.proof_skipped).length,
      solved_by_program: written.filter((p) => p.verification?.solved_by === "program").length,
      solve_escalated: written.filter((p) => p.verification?.escalated).length,
    },
    outcomes: written.map((p) => ({
      passed: !!p.verification?.passed,
      failed: Object.fromEntries(Object.entries(p.verification?.checks ?? {}).filter(([, c]) => !c.ok && !c.skipped).map(([k, c]) => [k, c.detail.slice(0, 300)])),
      ...(p.verification?.ms ? { check_ms: p.verification.ms } : {}),
    })),
  });
  return result;
}

async function generateChecked(options: GenerateProblemOptions, requested: number, clock: StageClock): Promise<{ result: BuiltinResult; written: GeneratedProblem[]; rounds: number }> {
  const written: GeneratedProblem[] = [];
  let rounds = 0;
  const passed: GeneratedProblem[] = [];
  const failed: GeneratedProblem[] = [];
  const rejected: string[] = [];
  const progress = (stage: BuiltinProgress["stage"], round: number, detail: string) => {
    clock.enter(stage);
    options.onProgress?.({ stage, round, rounds: BUILTIN_ROUNDS, requested, passed: passed.length, detail });
  };
  for (let round = 1; round <= BUILTIN_ROUNDS && passed.length < requested; round++) {
    const need = requested - passed.length;
    rounds = round;
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
    written.push(...checked);
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
  return { result: { problems: [...passed, ...(passed.length < requested ? failed : [])], requested, ...(note ? { note } : {}) }, written, rounds };
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
    word_problem: "应用题",
    sequence: "数列",
  };
  return labels[domain];
}
