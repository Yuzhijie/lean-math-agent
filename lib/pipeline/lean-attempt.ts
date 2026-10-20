/**
 * Lean 4 formalization attempt for a solved non-theorem problem
 * (computational, optimization, find-all-values).
 *
 * This is the last step of solving and is started by hand: the solve
 * pipelines return `{ attempted: false }` and the user starts it from the
 * Lean tab (POST /api/lean-attempt). Passing `options.lean_attempt: true`
 * to /api/solve or /api/solve-stream still runs it automatically.
 *
 * The known answer goes into the formalization, so the statement says "the
 * answer is X". An accepted statement is then really proved: the automation
 * cascade first (a computation such as `Nat.gcd (2^2024+1) (2^3036-1) = 1` is
 * closed by `decide +kernel`), then the whole-proof prover loop with the
 * natural-language solution as its sketch. A failure says what was tried and
 * what Lean reported — not a generic text about the kind of problem.
 */
import { autoformalize } from "../llm/autoformalize";
import { lt } from "../llm/output-locale";
import { assembleLeanSource } from "../lean/assemble";
import { hammerTheorem } from "../lean/hammer";
import { checkLeanAvailable, verifyLeanSource, type LeanVerifyResult } from "../lean/sandbox";
import { tryTrivialProof } from "../lean/trivial-proof";
import { CancelledError } from "../jobs";
import { CostCapError } from "../llm/client";
import { costCapReached } from "../llm/usage-tracker";
import { budgetPreset } from "../prover/budget";
import { proveWholeTheorem, wholeProofEnabled, type WholeProofResult } from "../prover/whole-proof";
import type { LeanProofAttempt, NaturalLanguageSolution } from "../types";

/** The placeholder a solve returns when the Lean step was not run automatically. */
export function manualLeanAttempt(): LeanProofAttempt {
  return { attempted: false, success: false };
}

/** Whether a solve run should attempt Lean automatically (default: no — it is started by hand). */
export function shouldAutoAttemptLean(opts: { lean_attempt?: boolean; skip_lean_attempt?: boolean }): boolean {
  return opts.lean_attempt === true && !opts.skip_lean_attempt;
}

export interface LeanAttemptContext {
  /** The answer found by solving; the statement should assert it. */
  answer?: string;
  /**
   * Answers to try in order when solving produced more than one (the computation and the written
   * solution disagree): a statement the numeric or counterexample check refutes is formalized
   * again with the next one.
   */
  answers?: string[];
  /** The natural-language solution, given to the prover as a sketch. */
  solution?: Pick<NaturalLanguageSolution, "summary" | "steps">;
  /** Session id for verification bookkeeping. */
  sessionId?: string;
  /** Proof budget preset (default PROOF_BUDGET, else "low" for this optional step). */
  budget?: string;
}

/** An answer as plain text: no `$`, `\\boxed{}`, `\\displaystyle` or surrounding spaces. */
export function plainAnswer(a: string | undefined): string {
  let t = (a ?? "").trim().replace(/^\$+|\$+$/g, "").trim();
  for (let k = 0; k < 3; k++) t = t.replace(/^\\(?:boxed|displaystyle)\s*\{([\s\S]*)\}$/, "$1").trim();
  return t.replace(/^\$+|\$+$/g, "").trim();
}

/**
 * The answers to formalize, most trusted first: a cross-validated computation, else the written
 * solution's final answer (it re-checks the result), then the other one when it differs.
 */
export function answerCandidates(s: {
  computation_result?: { answer?: string; cross_validated?: boolean };
  nl_solution?: { final_answer?: string };
}): string[] {
  const computed = plainAnswer(s.computation_result?.answer);
  const written = plainAnswer(s.nl_solution?.final_answer);
  const order = s.computation_result?.cross_validated ? [computed, written] : [written, computed];
  const key = (x: string) => x.replace(/\s+/g, "");
  const out: string[] = [];
  for (const a of order) if (a && !out.some((b) => key(b) === key(a))) out.push(a);
  return out;
}

/** The problem text with the known answer, for the formalizer. */
export function problemWithAnswer(problemText: string, answer?: string): string {
  const a = answer?.trim();
  if (!a) return problemText;
  return `${problemText}\n\nThe answer found by solving is: ${a}\nState the theorem so that it asserts exactly this answer (for example \`expression = value\`, or the set of all solutions equals the given set).`;
}

function sketchOf(solution: LeanAttemptContext["solution"]): string | undefined {
  if (!solution) return undefined;
  const steps = (solution.steps ?? []).map((s, i) => `${i + 1}. ${s.title}: ${s.content}`.trim());
  const text = [solution.summary, ...steps].filter(Boolean).join("\n").slice(0, 3000);
  return text || undefined;
}

import { evalNatExpr, hugePower } from "../compute/nat-expr";
export { evalNatExpr };

/** The argument of `name (...)` starting at `from` (balanced parentheses), or undefined. */
function parenArg(s: string, from: number): { arg: string; end: number } | undefined {
  if (s[from] !== "(") return undefined;
  let depth = 0;
  for (let j = from; j < s.length; j++) {
    if (s[j] === "(") depth++;
    else if (s[j] === ")" && --depth === 0) return { arg: s.slice(from + 1, j), end: j + 1 };
  }
  return undefined;
}

/**
 * How many cases a statement asks Lean to go through one by one: the size of the largest
 * `Finset.range n` / `Finset.Icc a b` / `Finset.Ico a b` with constant bounds (undefined when none).
 */
export function enumerationSize(statement: string): bigint | undefined {
  let best: bigint | undefined;
  const keep = (n: bigint | undefined) => {
    if (n !== undefined && (best === undefined || n > best)) best = n;
  };
  for (const m of statement.matchAll(/Finset\.(range|Icc|Ico|Ioc|Ioo)\s*/g)) {
    const first = parenArg(statement, m.index! + m[0].length);
    const a = first ? evalNatExpr(first.arg) : evalNatExpr(/^\d+/.exec(statement.slice(m.index! + m[0].length))?.[0] ?? "");
    if (m[1] === "range") {
      keep(a);
      continue;
    }
    const afterFirst = first ? first.end : m.index! + m[0].length + (/^\d+/.exec(statement.slice(m.index! + m[0].length))?.[0].length ?? 0);
    const rest = statement.slice(afterFirst).replace(/^\s+/, "");
    const offset = statement.length - rest.length;
    const second = parenArg(statement, offset);
    const b = second ? evalNatExpr(second.arg) : evalNatExpr(/^\d+/.exec(rest)?.[0] ?? "");
    if (a !== undefined && b !== undefined && b >= a) keep(b - a + 1n);
  }
  return best;
}

/** Above this many cases, checking them one by one in Lean is out of reach. */
const ENUMERATION_LIMIT = 1_000_000n;

/** "2.8×10^11" style. */
function sizeText(n: bigint): string {
  const s = n.toString();
  if (s.length <= 7) return Number(n).toLocaleString("en-US");
  return `${s[0]}.${s[1]}×10^${s.length - 1}`;
}

/**
 * Advice for the prover from the shape of the statement: `let` definitions to introduce first,
 * and finite statements that can be settled by explicit witnesses + kernel computation.
 */
export function proofHints(theoremType: string, opts: { tooMany?: boolean; huge?: string } = {}): string[] {
  const hints: string[] = [];
  const t = theoremType.replace(/^\s*:\s*/, "");
  if (/^let\b/.test(t)) {
    const names = [...t.matchAll(/(?:^|;\s*)let\s+([A-Za-z_][\w']*)/g)].map((m) => m[1]);
    hints.push(
      `The statement begins with \`let\` definitions. Start the proof with \`intro ${names.join(" ")}\` (one name per let), then work with them; unfold a definition with \`simp only [${names[0] ?? "name"}]\` or \`show\` when needed.`,
    );
  }
  const finite = /\b(Fin\s+\d+|ZMod\s+\d+|Finset\s*\(\s*Fin\b)/.test(t) && !/[ℝℚℂ]|\bReal\b|\bComplex\b/.test(t) && !/[∀∃]\s*\(?\s*\w+\s*:\s*(ℕ|ℤ|Nat|Int)\b/.test(t);
  if (finite && !opts.tooMany) {
    hints.push(
      "Everything in the statement ranges over finite types (Fin n, Finset (Fin n), ZMod n). Give explicit witnesses (e.g. `refine ⟨![{0, 2, 4, 6}, …], ?_, ?_, ?_⟩`, taking them from the solution) and close each remaining finite check with `decide +kernel` (the kernel evaluates it; plain `decide` hits recursion limits), or `fin_cases` + `simp` / `decide`.",
    );
  }
  if (opts.huge) {
    hints.push(
      [
        `The statement contains \`${opts.huge}\`: Lean cannot compute it ("Nat.pow exponent is too big" — exponents above 2^24 are refused). Never let a tactic evaluate it: no decide, decide +kernel, rfl, norm_num, simp or omega on goals that contain it, and do not unfold it into digits. Keep it symbolic (\`intro\` the lets, \`set m := … with hm\`) and argue with divisibility and p-adic valuations:`,
        "- `padicValNat_dvd_iff_le (ha : a ≠ 0) : p ^ n ∣ a ↔ n ≤ padicValNat p a` (needs `[Fact p.Prime]`, e.g. `haveI := Fact.mk (by norm_num : Nat.Prime 11)`);",
        "- lifting the exponent, odd prime p: `padicValNat.pow_sub_pow (hp1 : Odd p) (hyx : y < x) (hxy : p ∣ x - y) (hx : ¬p ∣ x) (hn : n ≠ 0) : padicValNat p (x ^ n - y ^ n) = padicValNat p (x - y) + padicValNat p n` (with y = 1, `one_pow`);",
        "- p = 2: `padicValNat.pow_two_sub_one (h1x : 1 < x) (hx : ¬2 ∣ x) (hn : n ≠ 0) (hneven : Even n) : padicValNat 2 (x ^ n - 1) + 1 = padicValNat 2 (x + 1) + padicValNat 2 (x - 1) + padicValNat 2 n`;",
        "- `padicValNat.pow (a n) : padicValNat p (a ^ n) = n * padicValNat p a`; small facts such as `padicValNat 11 2024 = 1` by `norm_num [padicValNat]` or `decide` on the small number only;",
        "- a composite modulus: split it into coprime prime powers (2024 ^ e = 2 ^ (3e) * 11 ^ e * 23 ^ e) and use `Nat.Coprime.mul_dvd_of_dvd_of_dvd`, or `Nat.factorization_le_iff_dvd`;",
        "- nonzero / positivity side conditions: `Nat.sub_ne_zero_of_lt`, `Nat.one_lt_pow (hn : n ≠ 0) (ha : 1 < a) : 1 < a ^ n`, `pow_pos`.",
      ].join("\n"),
    );
  }
  if (/∣/.test(t) && /\(\s*\w+\s*:\s*(ℕ|ℤ|Nat|Int)\s*\)|∀\s*\w+\s*:\s*(ℕ|ℤ)/.test(t) && /↔|∃/.test(t)) {
    hints.push(
      [
        "Divisibility conditions on an integer variable (\"find all n\"): bound n, then check the cases.",
        "- turn each `a ∣ f n` into `a ∣ constant` by adding or subtracting multiples of a: e.g. from `h : n + 5 ∣ n ^ 2 + 14`,",
        "    `have h2 : n + 5 ∣ (n ^ 2 + 14) + 10 * (n + 5) := dvd_add h (dvd_mul_left _ _)`,",
        "    `rw [show (n ^ 2 + 14) + 10 * (n + 5) = (n + 5) * (n + 5) + 39 by ring] at h2`,",
        "    `have h39 : n + 5 ∣ 39 := (Nat.dvd_add_right (dvd_mul_right _ _)).mp h2`",
        "  (in ℕ never subtract — `n - 5` truncates — add instead; or cast to ℤ and use `dvd_sub`);",
        "- `have hb : n + 5 ≤ 39 := Nat.le_of_dvd (by norm_num) h39`, then `interval_cases n` and close every case with `first | omega | (norm_num at *) | decide | simp_all`;",
        "- the ← direction: `rintro rfl` then `norm_num` or `decide`; split ↔ with `constructor` first.",
      ].join("\n"),
    );
  }
  if (/ℝ\s*×\s*ℝ|EuclideanSpace|Fin\s+2\s*→\s*ℝ/.test(t)) {
    hints.push(
      [
        "Coordinate geometry. Keep the computation small, or Lean runs out of heartbeats (`(deterministic) timeout at whnf`):",
        "- `intro` the lets and the points, then `rintro ⟨h1, h2, …⟩`; never `simp` / `norm_num` with all the let definitions unfolded at once — unfold one (`simp only [qdist] at h1`) where needed;",
        "- work componentwise: write each point as its two coordinates (`obtain ⟨x, y⟩ := P`, `Prod.ext_iff`, `Prod.fst_add`, `Prod.smul_fst`), turn every condition into equations over ℝ;",
        "- solve the parameters (t, s) of the ∃s with `field_simp` / `linarith` / `nlinarith [sq_nonneg …]`, or give their values explicitly and check them;",
        "- close polynomial identities with `linear_combination (coeff) * h1 + …` or `nlinarith`; absolute values with `abs_of_pos` / `abs_of_neg` once the sign is known;",
        "- if a step is heavy but correct, `set_option maxHeartbeats 400000 in` before the theorem is allowed (0 is not).",
      ].join("\n"),
    );
  }
  hints.push("Never write `sorry` or `admit`: a proof that contains them is rejected.");
  return hints;
}

/** The candidate that got furthest, for the failure report. */
function bestCandidate(w: WholeProofResult) {
  return [...w.candidates].sort((a, b) => (b.progress ?? 0) - (a.progress ?? 0) || a.errors - b.errors)[0];
}

export async function attemptLeanFormalization(problemText: string, ctx: LeanAttemptContext = {}): Promise<LeanProofAttempt> {
  const sessionId = ctx.sessionId ?? "lean-attempt";
  let formal_statement: string | undefined;
  try {
    // Formalize with the most trusted answer; when its statement does not pass the checks and
    // solving produced another answer, try that one (a wrong answer forces a statement that
    // misstates the problem: the numeric / counterexample checks refute it, or the
    // non-triviality check finds it built to fit — a figure encoded with 2 triangles for "2").
    const answers = ctx.answers?.length ? ctx.answers : ctx.answer ? [ctx.answer] : [undefined];
    const notes: string[] = [];
    let formal!: Awaited<ReturnType<typeof autoformalize>>;
    for (let k = 0; k < answers.length; k++) {
      formal = await autoformalize({ problemText: problemWithAnswer(problemText, answers[k]) });
      formal_statement = formal.formal_statement;
      if (formal.accepted) break;
      const refuted = formal.validation_results.some((v) => !v.pass && (v.layer === 4 || v.layer === 6));
      if (k === answers.length - 1 || answers[k] === undefined) break;
      const failedLayers = formal.validation_results.filter((v) => !v.pass).map((v) => `L${v.layer}`).join(", ");
      notes.push(
        refuted
          ? lt(
              `按答案 ${answers[k]} 写出的陈述被数值检查推翻，改用解答中的另一个答案 ${answers[k + 1]}`,
              `The statement with the answer ${answers[k]} was refuted by the numeric check; trying the solution's other answer ${answers[k + 1]}`,
            )
          : lt(
              `按答案 ${answers[k]} 写出的陈述没有通过检查（${failedLayers || "未给出原因"}），改用解答中的另一个答案 ${answers[k + 1]}`,
              `The statement with the answer ${answers[k]} did not pass the checks (${failedLayers || "no reason given"}); trying the solution's other answer ${answers[k + 1]}`,
            ),
      );
    }

    if (!formal.accepted) {
      const failed = formal.validation_results.filter((v) => !v.pass).map((v) => `L${v.layer}: ${v.detail}`);
      const refuted = formal.validation_results.some((v) => !v.pass && (v.layer === 4 || v.layer === 6));
      const last = answers[answers.length - 1];
      return {
        attempted: true,
        success: false,
        formal_statement,
        failure_reason: refuted && last
          ? lt(
              `按答案 ${last} 写出的陈述没有通过数值检查——这个答案可能有误，请先核对答案`,
              `The statement with the answer ${last} failed the numeric check — the answer may be wrong; check it first`,
            )
          : lt("没能写出一条通过检查的 Lean 陈述，所以没有开始证明", "No Lean statement passed the checks, so no proof was attempted"),
        limitations: [...notes, ...(failed.length ? failed : [lt("形式化未通过检查（没有给出原因）", "The formalization did not pass the checks (no reason given)")])],
      };
    }

    const theoremName = formal.theorem_name;
    const theoremType = formal.theorem_type;
    const expectedSignature = formal.formal_signature;
    const useMathlib = true;
    const done = (v: LeanVerifyResult, source: string, extra: Partial<LeanProofAttempt>): LeanProofAttempt => ({
      attempted: true,
      success: true,
      formal_statement,
      proof_code: source,
      axioms: v.axioms?.axioms,
      statement_locked: expectedSignature !== undefined && v.signatureMatch === true,
      verifier: v.backend,
      ...(notes.length ? { limitations: notes } : {}),
      ...extra,
    });

    const avail = await checkLeanAvailable();
    if (!avail.ok) {
      return {
        attempted: true,
        success: false,
        formal_statement,
        verifier: "none",
        failure_reason: lt("陈述已写好，但这里没有可用的 Lean，无法证明", "The statement is ready, but Lean is not available here, so it could not be proved"),
        limitations: [avail.message ?? lt("Lean 不可用", "Lean is not available")],
      };
    }

    // A number far too big to compute (2025 ^ (2024 ^ 2024)): the automation would only try to
    // evaluate it and Lean refuses ("Nat.pow exponent is too big"), so go straight to the prover.
    const huge = hugePower(formal.formal_statement ?? theoremType);

    // 1. Automation: the hammer cascade in REPL tactic mode, then single-tactic probes.
    const tried: string[] = [];
    if (huge) {
      tried.push(lt("跳过了会去直接计算的自动化策略（数太大，无法计算）", "skipped the automation that would compute (the number is too big to compute)"));
    } else if (process.env.LEAN_SERVER_MODE !== "spawn") {
      const root = assembleLeanSource({ theoremName, theoremType, stepCodes: ["sorry"], useMathlib });
      const hit = await hammerTheorem(root, { useMathlib });
      tried.push(lt("自动化策略组合（rfl、decide、decide +kernel、simp、omega、norm_num、ring、linarith、aesop 等）", "the automation cascade (rfl, decide, decide +kernel, simp, omega, norm_num, ring, linarith, aesop, …)"));
      if (hit) {
        const source = assembleLeanSource({ theoremName, theoremType, stepCodes: [hit.tactic], useMathlib });
        const v = await verifyLeanSource(sessionId, source, { theoremName, expectedSignature });
        if (v.ok) return done(v, source, { strategy: "hammer", attempts: 1 });
      }
    }
    const trivial = huge ? undefined : await tryTrivialProof(sessionId, theoremName, theoremType, useMathlib, { expectedSignature });
    if (trivial) return done(trivial.verification, trivial.source, { strategy: "trivial", attempts: 1 });
    if (!tried.length) tried.push(lt("单条策略（rfl、simp、norm_num、omega、decide、decide +kernel、ring、linarith 等）", "single tactics (rfl, simp, norm_num, omega, decide, decide +kernel, ring, linarith, …)"));

    // A statement over a huge finite range cannot be settled by computation: say so to the
    // prover (no `decide` over the range) and to the user.
    const cases = enumerationSize(formal.formal_statement ?? theoremType);
    const tooMany = cases !== undefined && cases > ENUMERATION_LIMIT;
    const limitations: string[] = [];
    if (huge) {
      const digits = Number.isFinite(huge.exponentDigits) ? lt(`约 ${huge.exponentDigits} 位`, `about ${huge.exponentDigits} digits`) : lt("天文数字级", "astronomically large");
      limitations.push(
        lt(
          `陈述里的 ${huge.text} 无法直接计算：它的指数本身就有${digits}，而 Lean 拒绝计算指数超过 2^24 的幂（报“Nat.pow exponent is too big”）。要证明它，必须保持符号形式，用 p 进赋值和“升幂引理”（LTE，Mathlib 的 padicValNat.pow_sub_pow 等）分别算出每个素因子的次数，这需要较长的结构化证明`,
          `${huge.text} in the statement cannot be computed: its exponent alone has ${digits}, and Lean refuses powers with an exponent above 2^24 ("Nat.pow exponent is too big"). A proof has to keep it symbolic and count each prime factor with p-adic valuations and the lifting-the-exponent lemma (Mathlib's padicValNat.pow_sub_pow etc.) — a long structured proof`,
        ),
      );
    }
    if (tooMany) {
      limitations.push(
        lt(
          `这条陈述要在约 ${sizeText(cases!)} 个数里逐个检查，Lean 无法逐个算完（自动化策略和逐个计算都会超出递归深度或时间）；要证明它，需要用数学结构推出结果，例如把模数分解成互素的部分分别计数，这需要较长的结构化证明`,
          `The statement asks Lean to check about ${sizeText(cases!)} cases one by one, which it cannot do (automation and direct computation run out of recursion depth or time); a proof has to derive the count from the structure, e.g. split the modulus into coprime parts and count each — a long structured proof`,
        ),
      );
    }

    // 2. The whole-proof prover loop, with the solution as sketch.
    if (wholeProofEnabled() && !costCapReached()) {
      const { preset } = budgetPreset(ctx.budget ?? process.env.PROOF_BUDGET ?? "low");
      const whole = await proveWholeTheorem({
        sessionId,
        theoremName,
        theoremType,
        expectedSignature,
        problemText,
        sketch: [
          sketchOf(ctx.solution),
          tooMany ? `Note: the statement ranges over about ${sizeText(cases!)} cases. Do NOT try decide / rfl / norm_num [Finset.filter] over the range: it cannot finish. Prove it structurally (e.g. Chinese remainder theorem, counting in cyclic groups, bijections).` : undefined,
          proofHints(theoremType, { tooMany, huge: huge?.text }).join("\n"),
        ]
          .filter(Boolean)
          .join("\n\n") || undefined,
        config: { ...preset.wholeProof, useMathlib },
      });
      if (whole.ok && whole.verification && whole.source) {
        return done(whole.verification, whole.source, { strategy: "whole_proof", attempts: whole.samples, rounds: whole.rounds });
      }
      tried.push(lt(`模型写的完整证明 ${whole.samples} 个（${whole.rounds} 轮，含按 Lean 报错修改）`, `${whole.samples} complete proofs written by the model (${whole.rounds} round(s), including repairs from Lean's errors)`));
      const best = whole.candidates.length ? bestCandidate(whole) : undefined;
      if (best?.summary && /sorry/.test(best.summary)) {
        limitations.push(lt("模型写出了证明的框架，但其中有步骤没能补完（留下了 sorry），所以不算证明", "The model wrote the outline of a proof but left steps unfinished (`sorry`), so it does not count as a proof"));
      } else if (best?.summary && /Nat\.pow exponent is too big/.test(best.summary)) {
        if (!huge) limitations.push(lt("最接近的一个证明试图直接计算一个大到 Lean 拒绝计算的幂（指数超过 2^24）", "The closest proof tried to compute a power Lean refuses to compute (exponent above 2^24)"));
      } else if (best?.summary && /maximum number of heartbeats|\(deterministic\) timeout/.test(best.summary)) {
        limitations.push(
          lt(
            `最接近的一个证明在 Lean 里算到一半超出了计算步数上限（${best.summary}）：通常是一次展开或化简的式子太大。这不说明陈述有错，需要把证明拆成更小的步骤`,
            `The closest proof ran out of Lean's computation budget part-way (${best.summary}): usually one unfolding or simplification was too big. This does not mean the statement is wrong; the proof needs smaller steps`,
          ),
        );
      } else if (best?.summary) {
        limitations.push(lt(`最接近的一个证明卡在：${best.summary}`, `The closest proof failed at: ${best.summary}`));
      }
      if (whole.gaveUpEarly) limitations.push(lt("所有证明在第一步就出错，提前停止", "Every proof failed at its first step, so the loop stopped early"));
      if (whole.costCapped) limitations.push(lt("达到本次费用上限后停止", "Stopped at this run's cost cap"));
    } else if (costCapReached()) {
      limitations.push(lt("已达到本次费用上限，没有再让模型写证明", "This run's cost cap was reached, so the model did not write proofs"));
    }

    return {
      attempted: true,
      success: false,
      formal_statement,
      failure_reason: lt("陈述通过了检查，但这次没有找到能通过 Lean 检查的证明", "The statement passed the checks, but no proof that Lean accepts was found this time"),
      limitations: [...notes, lt(`已尝试：${tried.join("；")}`, `Tried: ${tried.join("; ")}`), ...limitations],
    };
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    return {
      attempted: true,
      success: false,
      formal_statement,
      failure_reason:
        e instanceof CostCapError
          ? lt("已达到本次费用上限，形式化停止", "This run's cost cap was reached; formalization stopped")
          : lt(`形式化过程出错：${msg}`, `Formalization error: ${msg}`),
      limitations: [],
    };
  }
}

/** Whether a stored attempt may be run again (it failed, or was never run). */
export function leanAttemptRetryable(a: LeanProofAttempt | undefined): boolean {
  return !a?.attempted || !a.success;
}
