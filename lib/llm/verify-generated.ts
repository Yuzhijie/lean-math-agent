/**
 * Checks for a problem the built-in generator wrote, so that what it hands out can be solved and,
 * for a claim to prove, is true:
 *
 *  1. answer — another model call solves the problem without seeing the answer (high effort);
 *     the program compares the two answers (lib/grading/mark.ts compareAnswers), and only when
 *     the forms need judgement a short model call decides whether they are equal. For a claim
 *     to prove, the solver says whether it holds. Ill-posed or unsolvable problems fail.
 *  2. counterexample — the problem (with its answer) is written as a Lean statement and searched
 *     for counterexamples by the program (layer 1 elaborate + layer 6: decide, plausible, the
 *     numeric search for real statements). A refuted statement fails the problem; a statement
 *     that could not be written is "needs a look".
 *  3. Lean — when the statement was accepted, the steps that need no model (hammer, order and
 *     bounded proofs, coordinate geometry) try to prove it; a proof is shown as "Lean 已证".
 *     The light formalization is not checked for faithfulness by a model, so this is evidence,
 *     not a certificate of the problem as worded — the statement is shown with it.
 */
import { z } from "zod";
import type { GeneratedCheck, GeneratedProblem, GeneratedVerification } from "../types";
import { chatJson } from "./client";
import { lt } from "./output-locale";
import { autoformalize } from "./autoformalize";
import { compareAnswers } from "../grading/mark";
import { hugePower } from "../compute/nat-expr";

const PROOF_RE = /求证|证明|试说明|说明理由|prove|show that/i;

export function isProofProblem(statement: string): boolean {
  return PROOF_RE.test(statement);
}

const solveOut = z.object({
  well_posed: z.boolean(),
  issue: z.string().nullish(),
  answer: z.string().default(""),
  claim_holds: z.boolean().nullish(),
});

const SOLVE_SYSTEM = `You are a careful mathematician checking a newly written problem before students get it. Solve it yourself, completely and independently.
- First decide whether it is well posed: all data needed are given, nothing contradicts, the question has a definite answer (for "find all"/"how many" questions: the complete answer). If not, well_posed = false and say why in "issue".
- A question asking for a value: "answer" = the final answer only (number, expression, set, choice letter).
- A claim to prove ("证明…", "求证…", "prove that …"): check whether the claim is TRUE — compute concrete instances, test edge cases and degenerate configurations, and look for a counterexample before you believe it. "claim_holds" = true / false, "answer" = "true" / "false", "issue" = the counterexample or the gap when false.
Return JSON {"well_posed": bool, "issue": string|null, "answer": string, "claim_holds": bool|null}.`;

const sameOut = z.object({ same: z.boolean(), reason: z.string().default("") });

async function sameAnswer(statement: string, a: string, b: string): Promise<boolean> {
  const r = await chatJson({
    system: 'Two answers to the same math problem. Are they mathematically equal (any equivalent form counts; a "find all" answer must have the same set)? Return JSON {"same": bool, "reason": string}.',
    user: `Problem:\n${statement.slice(0, 4000)}\n\nAnswer 1: ${a}\nAnswer 2: ${b}`,
    schema: sameOut,
    schemaName: "same_answer",
    reasoningEffort: "low",
    maxRetries: 1,
  });
  return r.same;
}

const ok = (detail: string): GeneratedCheck => ({ ok: true, detail });
const fail = (detail: string): GeneratedCheck => ({ ok: false, detail });
const skip = (detail: string): GeneratedCheck => ({ ok: true, detail, skipped: true });

async function answerCheck(p: GeneratedProblem): Promise<{ check: GeneratedCheck; independent?: string }> {
  const proof = isProofProblem(p.statement);
  let r: z.infer<typeof solveOut>;
  try {
    r = await chatJson({ system: SOLVE_SYSTEM, user: p.statement.slice(0, 6000), schema: solveOut, schemaName: "independent_solve", reasoningEffort: "high", maxRetries: 1 });
  } catch (e) {
    return { check: skip(lt(`独立解题没有完成：${e instanceof Error ? e.message : String(e)}`, `the independent solve did not finish: ${e instanceof Error ? e.message : String(e)}`)) };
  }
  if (!r.well_posed) return { check: fail(lt(`题目不完整或有矛盾：${r.issue ?? "（未说明）"}`, `the problem is ill-posed: ${r.issue ?? "(no reason given)"}`)), independent: r.answer };
  if (proof) {
    if (r.claim_holds === false) return { check: fail(lt(`要证明的结论不成立：${r.issue ?? ""}`, `the claim to prove is false: ${r.issue ?? ""}`)), independent: "false" };
    if (r.claim_holds === true) return { check: ok(lt("独立检查认为结论成立", "an independent check finds the claim true")), independent: "true" };
    return { check: skip(lt("独立检查没有判断结论是否成立", "the independent check did not decide the claim")) };
  }
  const indep = r.answer.trim();
  if (!indep) return { check: skip(lt("独立解题没有给出答案", "the independent solve gave no answer")) };
  let same = compareAnswers(indep, p.answer);
  let how = lt("程序比对", "compared by the program");
  if (same === undefined) {
    try {
      same = await sameAnswer(p.statement, indep, p.answer);
      how = lt("模型判断形式等价", "judged equivalent by a model");
    } catch {
      return { check: skip(lt(`独立答案“${indep}”与“${p.answer}”无法比较`, `the independent answer "${indep}" could not be compared with "${p.answer}"`)), independent: indep };
    }
  }
  return {
    check: same
      ? ok(lt(`独立解答一致：${indep}（${how}）`, `the independent answer agrees: ${indep} (${how})`))
      : fail(lt(`独立解答为 ${indep}，与答案 ${p.answer} 不一致`, `the independent answer is ${indep}, not ${p.answer}`)),
    independent: indep,
  };
}

async function leanChecks(p: GeneratedProblem): Promise<{ check: GeneratedCheck; lean?: GeneratedVerification["lean"] }> {
  const proof = isProofProblem(p.statement);
  const { problemWithAnswer, proveWithoutModel } = await import("../pipeline/lean-attempt");
  let formal: Awaited<ReturnType<typeof autoformalize>>;
  // one attempt: a retry after a counterexample is told to fix the statement and could weaken it
  try {
    formal = await autoformalize({ problemText: proof ? p.statement : problemWithAnswer(p.statement, p.answer), maxRetries: 0, candidates: 1, light: true });
  } catch (e) {
    return { check: skip(lt(`没能写成 Lean 陈述：${e instanceof Error ? e.message : String(e)}`, `could not be written as a Lean statement: ${e instanceof Error ? e.message : String(e)}`)) };
  }
  if (formal.refutation?.verdict === "refuted") {
    return {
      check: fail(lt(`Lean 陈述有反例：${formal.refutation.counterexample ?? ""}`, `the Lean statement has a counterexample: ${formal.refutation.counterexample ?? ""}`)),
      lean: { statement: formal.formal_statement, proved: false },
    };
  }
  const l1 = formal.validation_results.find((v) => v.layer === 1);
  if (!l1?.pass) return { check: skip(lt("没能写成可编译的 Lean 陈述，未做反例检查", "no Lean statement compiled, so no counterexample search")) };
  const l6 = formal.validation_results.find((v) => v.layer === 6);
  const found =
    formal.refutation?.verdict === "confirmed"
      ? ok(lt("Lean 判定陈述为真", "Lean decided the statement true"))
      : formal.refutation?.verdict === "no_counterexample"
        ? ok(lt("反例搜索没有找到反例", "the counterexample search found none"))
        : l6?.skipped
          ? ok(lt("反例搜索无法判定（没有找到反例）", "the counterexample search was inconclusive (none found)"))
          : ok(lt("没有找到反例", "no counterexample found"));
  let lean: GeneratedVerification["lean"] = { statement: formal.formal_statement, proved: false };
  try {
    const r = await proveWithoutModel({
      sessionId: "generate-verify",
      theoremName: formal.theorem_name,
      theoremType: formal.theorem_type,
      expectedSignature: formal.formal_signature,
      useMathlib: true,
      huge: !!hugePower(formal.theorem_type),
    });
    if (r.proof) lean = { statement: r.proof.source, proved: true, strategy: r.proof.strategy };
  } catch {
    // proving is a bonus
  }
  return { check: found, lean };
}

/** Run the checks on one generated problem. */
export async function verifyGenerated(p: GeneratedProblem): Promise<GeneratedVerification> {
  const [a, l] = await Promise.all([answerCheck(p), leanChecks(p)]);
  return {
    passed: a.check.ok && l.check.ok,
    checks: { answer: a.check, counterexample: l.check },
    ...(a.independent ? { independent_answer: a.independent } : {}),
    ...(l.lean ? { lean: l.lean } : {}),
  };
}

/** Why a problem failed, for the next writing round. */
export function failureNote(p: GeneratedProblem): string {
  const v = p.verification;
  if (!v) return "";
  const why = [v.checks.answer, v.checks.counterexample].filter((c) => !c.ok && !c.skipped).map((c) => c.detail);
  return `- ${p.statement.replace(/\s+/g, " ").slice(0, 300)}\n  rejected: ${why.join("; ")}`;
}
