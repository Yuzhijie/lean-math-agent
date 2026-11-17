/**
 * The provers the program drives without a model, as one table — what each stage is for (`fit`),
 * how long it may take (`limitMs`), where it stands in the order (`phase`, then the table's order)
 * — and the one runner every caller uses: the Lean attempt and its re-runs (proveWithoutModel in
 * lib/pipeline/lean-attempt.ts: the Lean tab, `npm run lean:recheck`, `npm run lean:regress`, the
 * check of generated problems), the theorem pipeline, and the holes of a proof sketch
 * (lib/prover/program-holes.ts). A new prover is one entry here.
 *
 * Order (planStages), the stage most likely to prove the statement first:
 *   1. the automation cascade (seconds when it proves: a fifth of the regression list);
 *   2. the stages whose kind of statement this is (fit 2) and on which the single tactics prove
 *      nothing the cascade did not: the scripts the program writes (multiplicative orders,
 *      bounded minima), coordinates, an extremum, and a count the program has a proof written
 *      for (round a circle, up to rotation / reflection, in a row: writtenCount);
 *   3. the single tactics — the cascade's tactics as whole proofs with the verifier's longer
 *      limit: what a long `decide +kernel` over any other count needs;
 *   4. the other provers, best fit first (a count: combinatorics before the rest), the table's
 *      order among equals;
 *   5. the tactic search, the fallback.
 * Measured on the 169 statements of bench/provers.json (bench/PROVERS.md, "时间花在哪一级"): in
 * every statement a prover proves, that prover is the first prover tried (in the order the code
 * had grown in, 28 statements had another prover first: induction before an extremum's or a
 * count's, optimization before a count of orbits); and the single tactics, which cost 9 minutes
 * before the proofs of the scripts, the coordinate and the extremum prover and proved none of
 * those statements, now run after them (on 64 statements). The counts with a written proof came
 * after the single tactics until one of them cost 130 s there before a 36 s proof (the rows of
 * 1 … 8 whose neighbours never differ by 1: `decide` over 40 320 permutations); on the ten such
 * counts the list had, the single tactics proved none.
 *
 * Reading form. The stages that read the statement — every one but the cascade and the single
 * tactics — get it in the one way of writing the provers read (lib/lean/reading-form.ts: `≤`/`<`
 * for `≥`/`>`, bounds in binders written out, bound names without primes and subscripts),
 * so a prover written on one spelling proves the others; what it proves is then checked by Lean
 * against the statement as written (inOriginal). A statement already in that form (nearly all:
 * 174 of the 178 of the regression list) goes through as before, with no second check. Measured
 * by `npm run lean:variants` (bench/VARIANTS.md).
 *
 * Budget. Every stage has its own limit, and all of them together have PROVER_STAGES_BUDGET_MS
 * (default 15 minutes): a stage gets the smaller of its limit and what is left, and a stage there
 * is no time left for is recorded as skipped — what was tried and what was not is always said.
 * A stage that throws has failed with what it threw (a cancelled job still ends the run).
 */
import { CancelledError } from "../jobs";
import { lt } from "../llm/output-locale";
import { PROGRAM_STRATEGIES, type ProgramStrategy } from "../types";
import { assembleLeanSource } from "./assemble";
import { autoProof } from "./auto";
import { combinatorialFit, combinatoricsProof, writtenCount } from "./combinatorics";
import { geometryProof, looksGeometric } from "./geometry";
import { hammerTheorem } from "./hammer";
import { inductionProof, looksInductive } from "./induction";
import { optimizationFit, optimizationProof } from "./optimize";
import { boundedMinScripts, orderProofScripts } from "./order-proof";
import { bridgeBody, originalSource, readingForm, scriptInOriginalNames, unindent, type ReadingForm } from "./reading-form";
import { verifyLeanSource, type LeanVerifyResult } from "./sandbox";
import { tryTrivialProof } from "./trivial-proof";

/** The statement a run of the stages is about. */
export interface StageStatement {
  sessionId: string;
  theoremName: string;
  theoremType: string;
  expectedSignature?: string;
  useMathlib: boolean;
  /** A power too big to compute is in the statement: the stages that would evaluate it do not apply. */
  huge?: boolean;
  /** Namespaces the statement is written under (the tactic search opens them). */
  opens?: string[];
}

export interface StageProof {
  verification: LeanVerifyResult;
  source: string;
  tactics: string;
  /** Scripts verified until one went through. */
  attempts: number;
}

export interface StageResult {
  proof?: StageProof;
  /** Why it did not go through, in the prover's own words. */
  reason?: string;
  /** What the prover found against the statement (a larger family, another count), when it says so. */
  counterexample?: string;
}

/**
 * cascade = the automation in tactic mode, first; tactics = its tactics one by one as whole
 * proofs; script = a proof the program writes from the statement's text alone; prover = written
 * for a kind of statement; fallback = the generic search, last.
 */
export type StagePhase = "cascade" | "tactics" | "script" | "prover" | "fallback";

/** What a stage says, in the language of the request (built when asked for, never at load time). */
export interface StageTexts {
  /** In the "tried" list of a failed attempt. */
  tried: (reason?: string) => string;
  /** Progress line when the stage starts (the quick stages start without one). */
  trying?: string;
  /** Progress line when its proof passed Lean. */
  passed: (tactics: string) => string;
  /** Progress line when it did not go through. */
  failed: (reason?: string) => string;
  /** The method shown with the proof. */
  title: (tactics: string) => string;
  /** The last progress line of a solve this stage finished. */
  done: string;
}

export interface ProverStage {
  id: ProgramStrategy;
  phase: StagePhase;
  /** The pipeline stage its progress lines are shown under. */
  progress: string;
  /** 0 = not for this statement, 1 = its gate passes, 2 = the kind of statement it was written for. */
  fit: (s: StageStatement) => 0 | 1 | 2;
  /**
   * On its kind of statement (fit 2) it runs before the single tactics: they repeat the cascade's
   * tactics with a longer limit, which proves nothing there (no coordinate, extremum, order or
   * bounded-minimum statement of the regression list). For counts only where the program has a
   * proof written for that very count (the predicate: writtenCount) — a long `decide +kernel` is
   * how several of the other counts are proved.
   */
  beforeSingleTactics?: boolean | ((s: StageStatement) => boolean);
  /** The most one attempt may take, ms (the search stops starting work then; a final check may still run). */
  limitMs: () => number;
  /** Not started with less time than this left. */
  minMs: number;
  run: (s: StageStatement, budgetMs: number) => Promise<StageResult>;
  texts: () => StageTexts;
}

const env = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** One script after the other, each verified as a whole, until one goes through or the time is up. */
async function verifyScripts(s: StageStatement, scripts: string[], budgetMs: number): Promise<StageResult> {
  const deadline = Date.now() + budgetMs;
  for (const [i, tactics] of scripts.entries()) {
    if (i > 0 && Date.now() > deadline) break;
    const source = assembleLeanSource({ theoremName: s.theoremName, theoremType: s.theoremType, stepCodes: [tactics], useMathlib: s.useMathlib });
    const v = await verifyLeanSource(s.sessionId, source, { theoremName: s.theoremName, expectedSignature: s.expectedSignature });
    if (v.ok) return { proof: { verification: v, source, tactics, attempts: i + 1 } };
  }
  return {};
}

/** A prover of lib/lean/<name>: its own proof object narrowed to what the stages hand on. */
async function proverResult(run: Promise<{ proof?: { verification: LeanVerifyResult; source: string; tactics: string }; reason: string; counterexample?: string }>): Promise<StageResult> {
  const r = await run;
  if (r.proof) return { proof: { verification: r.proof.verification, source: r.proof.source, tactics: r.proof.tactics, attempts: 1 } };
  return { reason: r.reason, ...(r.counterexample ? { counterexample: r.counterexample } : {}) };
}

const proverArgs = (s: StageStatement, timeLimitMs: number) => ({
  sessionId: s.sessionId,
  theoremName: s.theoremName,
  theoremType: s.theoremType,
  expectedSignature: s.expectedSignature,
  useMathlib: s.useMathlib,
  timeLimitMs,
});

const automationTexts = (): Pick<StageTexts, "passed" | "failed" | "title" | "done"> => ({
  passed: (tactic) => lt(`✅ 自动化策略直接证明 (${tactic})`, `✅ Proved directly by an automation tactic (${tactic})`),
  failed: () => lt("自动化策略没有直接证出", "The automation did not prove it directly"),
  title: (tactic) => lt(`自动化策略 (${tactic})`, `Automation tactic (${tactic})`),
  done: lt("✅ 完全形式化验证通过（自动化策略）", "✅ Fully formally verified (automation tactic)"),
});

/** The table (the order of the routes everywhere they are listed; the order they run in on a statement is planStages). */
export const PROVER_STAGES: readonly ProverStage[] = [
  {
    // rfl, decide, simp, omega, norm_num, … on the root goal, in REPL tactic mode
    id: "hammer",
    phase: "cascade",
    progress: "trivial_proof",
    fit: (s) => (s.huge || process.env.LEAN_SERVER_MODE === "spawn" ? 0 : 1),
    limitMs: () => env("LEAN_HAMMER_BUDGET_MS", 30_000),
    minMs: 1_000,
    run: async (s, budgetMs) => {
      const root = assembleLeanSource({ theoremName: s.theoremName, theoremType: s.theoremType, stepCodes: ["sorry"], useMathlib: s.useMathlib });
      const hit = await hammerTheorem(root, { useMathlib: s.useMathlib, budgetMs });
      return hit ? verifyScripts(s, [hit.tactic], budgetMs) : {};
    },
    texts: () => ({
      tried: () => lt("自动化策略组合（rfl、decide、decide +kernel、simp、omega、norm_num、ring、linarith、aesop 等）", "the automation cascade (rfl, decide, decide +kernel, simp, omega, norm_num, ring, linarith, aesop, …)"),
      ...automationTexts(),
    }),
  },
  {
    // the same tactics one by one as whole proofs: works without the REPL, and with the verifier's longer time limit
    id: "trivial",
    phase: "tactics",
    progress: "trivial_proof",
    fit: (s) => (s.huge ? 0 : 1),
    limitMs: () => env("TRIVIAL_TIME_LIMIT_MS", 300_000),
    minMs: 1_000,
    run: async (s, budgetMs) => {
      const hit = await tryTrivialProof(s.sessionId, s.theoremName, s.theoremType, s.useMathlib, { expectedSignature: s.expectedSignature, deadline: Date.now() + budgetMs });
      return hit ? { proof: { verification: hit.verification, source: hit.source, tactics: hit.tactic, attempts: 1 } } : {};
    },
    texts: () => ({
      tried: () => lt("单条策略（rfl、simp、norm_num、omega、decide、decide +kernel、ring、linarith 等）", "single tactics (rfl, simp, norm_num, omega, decide, decide +kernel, ring, linarith, …)"),
      ...automationTexts(),
    }),
  },
  {
    // "smallest n with m ∣ a ^ n - 1": the proof from the multiplicative orders (also with a huge power: the scripts split it)
    id: "order",
    phase: "script",
    beforeSingleTactics: true,
    progress: "order",
    fit: (s) => (orderProofScripts(s.theoremType).length ? 2 : 0),
    limitMs: () => Number.POSITIVE_INFINITY,
    minMs: 1_000,
    run: (s, budgetMs) => verifyScripts(s, orderProofScripts(s.theoremType), budgetMs),
    texts: () => ({
      tried: () => lt("按乘法阶由程序写出的证明", "a proof the program wrote from the multiplicative orders"),
      trying: lt("尝试按乘法阶由程序写证明", "Trying a proof the program writes from the multiplicative orders"),
      passed: () => lt("✅ 程序按乘法阶写出的证明通过 Lean 检查", "✅ The program's proof from the multiplicative orders passed Lean"),
      failed: () => lt("按乘法阶写出的证明没有通过", "The proof from the multiplicative orders did not pass"),
      title: () => lt("乘法阶（程序写的证明）", "Multiplicative orders (proof written by the program)"),
      done: lt("✅ 完全形式化验证通过（乘法阶）", "✅ Fully formally verified (multiplicative orders)"),
    }),
  },
  {
    // "smallest m" with a small bound: the kernel checks every m below it
    id: "bounded",
    phase: "script",
    beforeSingleTactics: true,
    progress: "bounded",
    fit: (s) => (!s.huge && boundedMinScripts(s.theoremType).length ? 2 : 0),
    limitMs: () => Number.POSITIVE_INFINITY,
    minMs: 1_000,
    run: async (s, budgetMs) => {
      const r = await verifyScripts(s, boundedMinScripts(s.theoremType), budgetMs);
      return r.proof ? { proof: { ...r.proof, attempts: 1 } } : r;
    },
    texts: () => ({
      tried: () => lt("程序写的逐个检查（内核算完界以下的每个数）", "a check the program wrote (the kernel tries every number below the bound)"),
      trying: lt("尝试由内核逐个检查界以下的每个数", "Trying a check of every number below the bound by the kernel"),
      passed: () => lt("✅ 程序写出的逐个检查通过 Lean 检查", "✅ The program's check of every number below the bound passed Lean"),
      failed: () => lt("逐个检查没有通过", "The check of every number below the bound did not pass"),
      title: () => lt("逐个检查（程序写的证明）", "Checked one by one (proof written by the program)"),
      done: lt("✅ 完全形式化验证通过（逐个检查）", "✅ Fully formally verified (checked one by one)"),
    }),
  },
  {
    // coordinates: the algebraic proof with a polynomial certificate from SymPy
    id: "geometry",
    phase: "prover",
    beforeSingleTactics: true,
    progress: "geometry",
    fit: (s) => (!s.huge && looksGeometric(s.theoremType) ? 2 : 0),
    limitMs: () => env("GEOMETRY_TIME_LIMIT_MS", 600_000),
    minMs: 5_000,
    run: (s, budgetMs) => proverResult(geometryProof(proverArgs(s, budgetMs))),
    texts: () => ({
      tried: (r) => lt(`程序写的坐标代数证明（${r}）`, `an algebraic proof in coordinates the program wrote (${r})`),
      trying: lt("尝试程序写的坐标代数证明（SymPy 求系数）", "Trying an algebraic proof in coordinates written by the program (coefficients from SymPy)"),
      passed: () => lt("✅ 程序写出的坐标代数证明通过 Lean 检查", "✅ The program's algebraic proof in coordinates passed Lean"),
      failed: (r) => lt(`坐标代数证明没有成功：${r}`, `The coordinate proof did not work: ${r}`),
      title: () => lt("坐标代数（程序写的证明）", "Coordinate algebra (proof written by the program)"),
      done: lt("✅ 完全形式化验证通过（坐标代数）", "✅ Fully formally verified (coordinate algebra)"),
    }),
  },
  {
    // statements over ℕ: the scheme chosen, base and step closed (divisibility quotients computed exactly)
    id: "induction",
    phase: "prover",
    progress: "induction",
    fit: (s) => (!s.huge && looksInductive(s.theoremType) ? 1 : 0),
    limitMs: () => env("INDUCTION_TIME_LIMIT_MS", 120_000),
    minMs: 5_000,
    run: (s, budgetMs) => proverResult(inductionProof(proverArgs(s, budgetMs))),
    texts: () => ({
      tried: (r) => lt(`程序写的归纳证明（${r}）`, `an induction proof the program wrote (${r})`),
      trying: lt("尝试程序写的归纳证明（选归纳方式，逐个关闭奠基与归纳步）", "Trying an induction proof written by the program (scheme chosen, base and step closed one by one)"),
      passed: () => lt("✅ 程序写出的归纳证明通过 Lean 检查", "✅ The program's induction proof passed Lean"),
      failed: (r) => lt(`归纳证明没有成功：${r}`, `The induction proof did not work: ${r}`),
      title: () => lt("数学归纳法（程序写的证明）", "Induction (proof written by the program)"),
      done: lt("✅ 完全形式化验证通过（数学归纳法）", "✅ Fully formally verified (induction)"),
    }),
  },
  {
    // "the largest / smallest value is M": the witness found by Lean, the bound decided over a box
    id: "optimize",
    phase: "prover",
    beforeSingleTactics: true,
    progress: "optimize",
    fit: (s) => (s.huge ? 0 : optimizationFit(s.theoremType)),
    limitMs: () => env("OPTIMIZE_TIME_LIMIT_MS", 180_000),
    minMs: 5_000,
    run: (s, budgetMs) => proverResult(optimizationProof(proverArgs(s, budgetMs))),
    texts: () => ({
      tried: (r) => lt(`程序写的组合优化证明（${r}）`, `an optimization proof the program wrote (${r})`),
      trying: lt("尝试程序写的组合优化证明（Lean 自己找取到最值的例子，再在有界范围内逐一核对上下界）", "Trying an optimization proof written by the program (Lean finds an example attaining the value, then the bound is checked over a finite range)"),
      passed: () => lt("✅ 程序写出的组合优化证明通过 Lean 检查", "✅ The program's optimization proof passed Lean"),
      failed: (r) => lt(`组合优化证明没有成功：${r}`, `The optimization proof did not work: ${r}`),
      title: () => lt("组合优化（程序写的证明）", "Optimization (proof written by the program)"),
      done: lt("✅ 完全形式化验证通过（组合优化）", "✅ Fully formally verified (optimization)"),
    }),
  },
  {
    // finite / counting statements: a circle, orbit representatives, rows built place by place, Venn regions, kernel decision after rewriting
    id: "combinatorics",
    phase: "prover",
    beforeSingleTactics: (s) => writtenCount(s.theoremType),
    progress: "combinatorics",
    fit: (s) => (s.huge ? 0 : combinatorialFit(s.theoremType)),
    limitMs: () => env("COMBINATORICS_TIME_LIMIT_MS", 180_000),
    minMs: 5_000,
    run: (s, budgetMs) => proverResult(combinatoricsProof(proverArgs(s, budgetMs))),
    texts: () => ({
      tried: (r) => lt(`程序写的组合证明（${r}）`, `a combinatorial proof the program wrote (${r})`),
      trying: lt("尝试程序写的组合证明（轨道代表元 / 逐位排列 / 韦恩图分区 / 有限枚举）", "Trying a combinatorial proof written by the program (orbit representatives / rows built place by place / Venn regions / finite enumeration)"),
      passed: () => lt("✅ 程序写出的组合证明通过 Lean 检查", "✅ The program's combinatorial proof passed Lean"),
      failed: (r) => lt(`组合证明没有成功：${r}`, `The combinatorial proof did not work: ${r}`),
      title: () => lt("组合计数（程序写的证明）", "Combinatorics (proof written by the program)"),
      done: lt("✅ 完全形式化验证通过（组合计数）", "✅ Fully formally verified (combinatorics)"),
    }),
  },
  {
    // the generic fallback: split, cases, every value, then automation — for anything but coordinates (their own prover handles those)
    id: "auto",
    phase: "fallback",
    progress: "auto",
    fit: (s) => (!s.huge && !looksGeometric(s.theoremType) ? 1 : 0),
    limitMs: () => env("AUTO_TIME_LIMIT_MS", 60_000),
    minMs: 5_000,
    run: (s, budgetMs) => proverResult(autoProof({ ...proverArgs(s, budgetMs), opens: s.opens })),
    texts: () => ({
      tried: (r) => lt(`策略组合搜索（${r}）`, `a search over tactic combinations (${r})`),
      trying: lt("尝试策略组合搜索（拆分目标、分情况、逐值检查，再用自动化策略收尾）", "Trying a search over tactic combinations (split the goal, cases, every value, then the automation closes each part)"),
      passed: () => lt("✅ 策略组合搜索找到的证明通过 Lean 检查", "✅ The tactic-combination search found a proof that passed Lean"),
      failed: (r) => lt(`策略组合搜索没有成功：${r}`, `The tactic-combination search did not work: ${r}`),
      title: () => lt("策略组合搜索（程序找到的证明）", "Tactic-combination search (proof found by the program)"),
      done: lt("✅ 完全形式化验证通过（策略组合搜索）", "✅ Fully formally verified (tactic-combination search)"),
    }),
  },
];

// the table and the list of routes everything else reads (lib/types.ts) are the same list
const tableIds: readonly ProgramStrategy[] = PROVER_STAGES.map((s) => s.id);
if (tableIds.join() !== PROGRAM_STRATEGIES.join()) throw new Error(`prover stages ${tableIds.join()} ≠ PROGRAM_STRATEGIES ${PROGRAM_STRATEGIES.join()}`);

export function stageOf(id: ProgramStrategy): ProverStage {
  return PROVER_STAGES.find((s) => s.id === id)!;
}

export interface PlannedStage {
  stage: ProverStage;
  fit: 1 | 2;
}

/** Where a stage that fits stands (see the order at the top of this file). */
function rank(stage: ProverStage, fit: number, s: StageStatement): number {
  if (stage.phase === "cascade") return 1;
  if (stage.phase === "fallback") return 5;
  if (stage.phase === "tactics") return 3;
  const before = typeof stage.beforeSingleTactics === "function" ? stage.beforeSingleTactics(s) : stage.beforeSingleTactics;
  return fit === 2 && before ? 2 : 4;
}

/** Whether a stage reads the statement (its text, the goals Lean prints): then it gets the reading form. */
const readsStatement = (stage: ProverStage) => stage.phase !== "cascade" && stage.phase !== "tactics";

/** The statement as the reading stages get it (itself when it is already written that way). */
function readingStatement(s: StageStatement): { statement: StageStatement; form: ReadingForm } {
  const form = readingForm(s.theoremType);
  // the signature Lean prints for the reading form is not the statement's: it is checked when the proof is brought back
  return { form, statement: form.changed ? { ...s, theoremType: form.type, expectedSignature: undefined } : s };
}

/**
 * A proof of the reading form, as a proof of the statement as written: the same script with the
 * statement's own names; when that does not run (a step matches the reading form's spelling), the
 * reading form proved inside and the statement concluded from it. Lean checks either.
 */
async function inOriginal(s: StageStatement, form: ReadingForm, proof: StageProof): Promise<StageResult> {
  const check = async (source: string, tactics: string): Promise<StageResult | undefined> => {
    const v = await verifyLeanSource(s.sessionId, source, { theoremName: s.theoremName, expectedSignature: s.expectedSignature });
    return v.ok ? { proof: { verification: v, source, tactics, attempts: proof.attempts } } : undefined;
  };
  const head = `theorem ${s.theoremName} ${s.theoremType} := by\n`;
  // as the prover assembled it (its options, its opens); else assembled anew
  const direct =
    originalSource(proof.source, s.theoremName, s.theoremType, form) ??
    (() => {
      const tactics = scriptInOriginalNames(proof.tactics, form);
      return { source: assembleLeanSource({ theoremName: s.theoremName, theoremType: s.theoremType, stepCodes: [tactics], useMathlib: s.useMathlib, opens: s.opens }), tactics };
    })();
  const ok = await check(direct.source, direct.tactics);
  if (ok) return ok;
  const at = direct.source.indexOf(head);
  const bridged = at < 0 ? undefined : bridgeBody(form, direct.source.slice(at + head.length));
  const viaReading = bridged ? await check(`${direct.source.slice(0, at)}${head}${bridged}\n`, unindent(bridged)) : undefined;
  return viaReading ?? { reason: lt("按规范写法证出了，但证明没能搬回原陈述", "proved as the provers read it, but the proof did not carry over to the statement as written") };
}

/** The stages that would run on a statement, in the order they would run. */
export function planStages(s: StageStatement, phases?: readonly StagePhase[]): PlannedStage[] {
  const reading = readingStatement(s).statement;
  return PROVER_STAGES.map((stage, index) => {
    const seen = readsStatement(stage) ? reading : s;
    const fit = stage.fit(seen);
    return { stage, fit, index, rank: rank(stage, fit, seen) };
  })
    .filter((x) => x.fit > 0 && (!phases || phases.includes(x.stage.phase)))
    .sort((a, b) => a.rank - b.rank || b.fit - a.fit || a.index - b.index)
    .map(({ stage, fit }) => ({ stage, fit: fit as 1 | 2 }));
}

/** The time all stages of one statement have together, ms (PROVER_STAGES_BUDGET_MS, default 15 minutes). */
export function stagesBudgetMs(): number {
  return env("PROVER_STAGES_BUDGET_MS", 900_000);
}

/** One stage of one run: what happened and how long it took. */
export interface StageRun {
  id: ProgramStrategy;
  fit: 1 | 2;
  ms: number;
  /** skipped = no time was left for it. */
  outcome: "proved" | "failed" | "skipped";
  reason?: string;
  counterexample?: string;
}

export type StageEvent =
  | { type: "start"; stage: ProverStage; budgetMs: number }
  | { type: "proved"; stage: ProverStage; proof: StageProof; ms: number }
  | { type: "failed"; stage: ProverStage; reason?: string; ms: number }
  | { type: "skipped"; stage: ProverStage };

export interface StagesOptions {
  /** Time for all stages together (default stagesBudgetMs()). */
  budgetMs?: number;
  /** Only these phases (a sketch hole: the provers and the search — the sketch has run the automation on the hole). */
  phases?: readonly StagePhase[];
  /** Only these stages / every stage but these (lean:variants: the route a statement is recorded for alone, then the others). */
  only?: readonly ProgramStrategy[];
  except?: readonly ProgramStrategy[];
  /** The budget is the only limit: a stage may use all that is left, past its own limit (a sketch hole's share of the sketch's time). */
  budgetOnly?: boolean;
  /** Called before every stage; throws to end the run (a cancelled job). */
  checkpoint?: () => void;
  onStage?: (e: StageEvent) => void;
}

export interface StagesResult {
  proof?: StageProof & { strategy: ProgramStrategy };
  /** Every stage that fits the statement, in the order it ran or would have run. */
  runs: StageRun[];
  budgetMs: number;
}

/** The stages on one statement: the first proof Lean accepts, or what every stage said. */
export async function runProverStages(s: StageStatement, opts: StagesOptions = {}): Promise<StagesResult> {
  const budgetMs = opts.budgetMs ?? stagesBudgetMs();
  const deadline = Date.now() + budgetMs;
  const runs: StageRun[] = [];
  const reading = readingStatement(s);
  for (const { stage, fit } of planStages(s, opts.phases)) {
    if ((opts.only && !opts.only.includes(stage.id)) || opts.except?.includes(stage.id)) continue;
    opts.checkpoint?.();
    const left = deadline - Date.now();
    if (left < stage.minMs) {
      runs.push({ id: stage.id, fit, ms: 0, outcome: "skipped" });
      opts.onStage?.({ type: "skipped", stage });
      continue;
    }
    const stageBudget = opts.budgetOnly ? left : Math.min(stage.limitMs(), left);
    opts.onStage?.({ type: "start", stage, budgetMs: stageBudget });
    const started = Date.now();
    let r: StageResult;
    try {
      const reads = reading.form.changed && readsStatement(stage);
      r = await stage.run(reads ? reading.statement : s, stageBudget);
      if (reads && r.proof) r = await inOriginal(s, reading.form, r.proof);
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      r = { reason: (e instanceof Error ? e.message : String(e)).split("\n")[0] };
    }
    const ms = Date.now() - started;
    if (r.proof) {
      runs.push({ id: stage.id, fit, ms, outcome: "proved" });
      opts.onStage?.({ type: "proved", stage, proof: r.proof, ms });
      return { proof: { ...r.proof, strategy: stage.id }, runs, budgetMs };
    }
    runs.push({ id: stage.id, fit, ms, outcome: "failed", ...(r.reason ? { reason: r.reason } : {}), ...(r.counterexample ? { counterexample: r.counterexample } : {}) });
    opts.onStage?.({ type: "failed", stage, reason: r.reason, ms });
  }
  return { runs, budgetMs };
}

const minutes = (ms: number) => {
  const m = ms / 60_000;
  return Number.isInteger(m) ? String(m) : m.toFixed(1);
};

/**
 * What was tried, for the failure report of an attempt: one entry per stage that ran, in order
 * (the single tactics are the automation cascade's own tactics: named only when the cascade did
 * not run), then the stages no time was left for.
 */
export function triedTexts(s: Pick<StageStatement, "huge">, result: Pick<StagesResult, "runs" | "budgetMs">): string[] {
  const out: string[] = [];
  if (s.huge) out.push(lt("跳过了会去直接计算的自动化策略（数太大，无法计算）", "skipped the automation that would compute (the number is too big to compute)"));
  const ran = (id: ProgramStrategy) => result.runs.some((r) => r.id === id && r.outcome !== "skipped");
  for (const r of result.runs) {
    if (r.outcome !== "failed") continue;
    if (r.id === "trivial" && (ran("hammer") || out.length > 0)) continue;
    out.push(stageOf(r.id).texts().tried(r.reason));
  }
  const skipped = result.runs.filter((r) => r.outcome === "skipped").map((r) => r.id);
  if (skipped.length) {
    out.push(
      lt(
        `程序证明器合计 ${minutes(result.budgetMs)} 分钟的时间已用完，没有再试：${skipped.join("、")}`,
        `the ${minutes(result.budgetMs)} minutes the program's provers have together were used up; not tried: ${skipped.join(", ")}`,
      ),
    );
  }
  return out;
}
