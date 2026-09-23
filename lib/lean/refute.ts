/**
 * Counterexample probing for formalized statements.
 *
 * A mistranslated theorem is usually *false* (a dropped hypothesis, ℕ
 * subtraction, an off-by-one bound), and a false statement can often be
 * refuted mechanically before any proof search is wasted on it:
 *
 *   - `decide`: `example : ¬ <statement> := by decide` succeeds exactly
 *     when the negation is decidable and evaluates to true — concrete
 *     numerals, bounded quantifiers (`∀ n < 10, …`), `Fin`, `Bool`.
 *     When Lean reports that the negation "evaluates to false" the
 *     statement itself is decidably TRUE (`confirmed`).
 *   - `plausible` (Mathlib's random tester, ex-`slim_check`): generates
 *     random instances of the universally quantified statement and reports
 *     the first counterexample as an error ("Found a counter-example!").
 *     Silence means "no counterexample in N random trials" — evidence, not
 *     proof.
 *
 * Everything else (no Decidable/Testable instance, ℝ variables, timeouts,
 * missing tactic) is `inconclusive`. Nothing here ever accepts a proof.
 */
import { verifyLeanSource, type LeanVerifyResult } from "./sandbox";
import { validateTheoremStatement } from "./sanitize";

export type RefuteVerdict = "refuted" | "confirmed" | "no_counterexample" | "inconclusive" | "unavailable";

export interface RefuteResult {
  verdict: RefuteVerdict;
  /** Probe that produced the verdict. */
  method?: "decide" | "plausible";
  /** Variable assignment reported by `plausible`, when refuted. */
  counterexample?: string;
  detail: string;
  durationMs: number;
}

export interface RefuteOptions {
  useMathlib?: boolean;
  /** Timeout per probe (default REFUTE_TIMEOUT_MS or 20 s). */
  timeoutMs?: number;
  /** Random trials for `plausible` (default REFUTE_TRIALS or 200). */
  trials?: number;
  /** Skip a probe (tests / spawn mode). */
  probes?: Array<"decide" | "plausible">;
  sessionId?: string;
}

/** Whether refutation runs in autoformalization (REFUTE_ENABLED, default true). */
export function refuteEnabled(): boolean {
  return process.env.REFUTE_ENABLED !== "false";
}

/**
 * Turn a theorem signature `(binders) : goal` into one proposition
 * `∀ (binders), goal` (or just `goal` without binders). Returns undefined
 * when the signature is malformed.
 */
export function statementToProp(theoremType: string): string | undefined {
  const t = theoremType.trim();
  if (!t) return undefined;
  // Find the top-level `:` separating binders from the goal.
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if ("([{⦃⟨".includes(c)) depth++;
    else if (")]}⦄⟩".includes(c)) depth = Math.max(0, depth - 1);
    else if (c === ":" && depth === 0 && t[i + 1] !== "=") {
      const binders = t.slice(0, i).trim();
      const goal = t.slice(i + 1).trim();
      if (!goal) return undefined;
      return binders ? `∀ ${binders}, ${goal}` : goal;
    }
  }
  return undefined;
}

const HEADER_MATHLIB = "import Mathlib\nimport Batteries\nimport Aesop\n\n";

function envNum(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

/** Extract the `x := v` lines of a plausible failure message. */
export function parseCounterexample(message: string): string | undefined {
  const lines = message
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[^\s:=]+\s*:=\s*/.test(l) || /^issue:/.test(l));
  return lines.length ? lines.join("; ") : undefined;
}

async function runProbe(sessionId: string, source: string, timeoutMs: number): Promise<LeanVerifyResult> {
  return verifyLeanSource(sessionId, source, { allowSorry: true, checkAxioms: false, wantSignature: false, timeoutMs });
}

function errorTexts(res: LeanVerifyResult): string[] {
  return res.messages.filter((m) => m.severity === "error").map((m) => m.message);
}

/**
 * Try to refute (or decidably confirm) a theorem statement. Never throws.
 */
export async function refuteStatement(theoremName: string, theoremType: string, opts: RefuteOptions = {}): Promise<RefuteResult> {
  const started = Date.now();
  const done = (r: Omit<RefuteResult, "durationMs">): RefuteResult => ({ ...r, durationMs: Date.now() - started });
  const shape = validateTheoremStatement(theoremName, theoremType);
  if (!shape.ok) return done({ verdict: "inconclusive", detail: shape.reason });
  const prop = statementToProp(theoremType);
  if (!prop) return done({ verdict: "inconclusive", detail: "无法从定理陈述构造命题" });
  const useMathlib = opts.useMathlib ?? true;
  const header = useMathlib ? HEADER_MATHLIB : "";
  const timeoutMs = opts.timeoutMs ?? envNum("REFUTE_TIMEOUT_MS", 20_000);
  const sessionId = opts.sessionId ?? "refute";
  const probes = opts.probes ?? ["decide", "plausible"];
  const notes: string[] = [];

  // ── decide on the negation ─────────────────────────────────────────
  if (probes.includes("decide")) {
    const src = `${header}example : ¬ (${prop}) := by decide\n`;
    try {
      const res = await runProbe(sessionId, src, timeoutMs);
      if (res.status === "unavailable") return done({ verdict: "unavailable", detail: res.log });
      const errors = errorTexts(res);
      if (res.ok && errors.length === 0 && !res.rejected) {
        return done({ verdict: "refuted", method: "decide", detail: "`decide` 证明了陈述的否定：该陈述为假（可判定域上存在反例）" });
      }
      const text = errors.join("\n");
      if (/evaluates to false|is false/.test(text) && /decide/i.test(text)) {
        return done({ verdict: "confirmed", method: "decide", detail: "`decide` 判定该陈述为真（可判定命题）" });
      }
      notes.push(`decide: ${text.split("\n")[0]?.slice(0, 120) || res.log.slice(0, 120)}`);
    } catch (e) {
      notes.push(`decide: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── plausible (random testing) ─────────────────────────────────────
  if (probes.includes("plausible") && useMathlib) {
    const trials = Math.floor(opts.trials ?? envNum("REFUTE_TRIALS", 200));
    const src = `${header}example : ${prop} := by\n  plausible (config := { numInst := ${trials}, quiet := true })\n`;
    try {
      const res = await runProbe(sessionId, src, timeoutMs);
      if (res.status === "unavailable") return done({ verdict: "unavailable", detail: res.log });
      const errors = errorTexts(res);
      const text = errors.join("\n");
      if (/Found a counter-example/i.test(text)) {
        const counterexample = parseCounterexample(text);
        return done({
          verdict: "refuted",
          method: "plausible",
          counterexample,
          detail: `随机测试找到反例${counterexample ? `：${counterexample}` : ""}`,
        });
      }
      if (errors.length === 0 && !res.rejected) {
        return done({ verdict: "no_counterexample", method: "plausible", detail: `随机测试 ${trials} 次未找到反例（不是证明）` });
      }
      notes.push(`plausible: ${text.split("\n")[0]?.slice(0, 120) || res.log.slice(0, 120)}`);
    } catch (e) {
      notes.push(`plausible: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return done({ verdict: "inconclusive", detail: notes.length ? `无法判定：${notes.join("；")}` : "无法判定" });
}
