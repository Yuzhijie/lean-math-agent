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
import { geometryProof, looksGeometric } from "../lean/geometry";
import { inductionProof, looksInductive } from "../lean/induction";
import { assembleLeanSource } from "../lean/assemble";
import { hammerTheorem } from "../lean/hammer";
import { checkLeanAvailable, verifyLeanSource, type LeanVerifyResult } from "../lean/sandbox";
import { tryTrivialProof } from "../lean/trivial-proof";
import { CancelledError } from "../jobs";
import { CostCapError } from "../llm/client";
import { costCapReached } from "../llm/usage-tracker";
import { budgetPreset } from "../prover/budget";
import { buildProverContext, rememberVerifiedProof } from "../prover/context";
import { replayRecalled } from "../prover/replay";
import { rememberRepair } from "../lean/proof-memory";
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
  const bigExp = !opts.huge && bigClosedExponent(t);
  if (bigExp) {
    hints.push(
      [
        `The statement has a power with exponent ${bigExp} (above 256). Plain \`decide\` and \`rfl\` refuse such powers ("exponent too big"); the kernel and norm_num do not:`,
        "- a closed fact such as `341 ∣ 2 ^ 340 - 1` or `2 ^ 340 % 341 = 1`: `by decide +kernel` (or `by norm_num`); `Nat.Prime 31`: `by norm_num`;",
        "- split a conjunction of closed facts with `refine ⟨⟨by norm_num, by norm_num, …, by decide +kernel⟩, ?_⟩` rather than one big tactic.",
      ].join("\n"),
    );
  }
  if (/∀\s*[\w\s]+:\s*ℕ\s*,/.test(t) && /\w\s*<\s*\d+/.test(t) && /\^\s*\(?\s*[a-z]/.test(t)) {
    hints.push(
      [
        "\"Smallest n\" part — no n below the bound works: turn it into a bounded statement and let the kernel check every case.",
        "- from `n = p * q` with `2 ≤ p < q` get bounds `p < B₁`, `q < B₂` (`nlinarith`), `subst` n, then prove a finite statement such as",
        "    `have key : ∀ p < 19, ∀ q < 171, 2 ≤ p → p < q → p * q < 341 → ¬ p * q ∣ 2 ^ (p * q - 1) - 1 := by decide +kernel`",
        "  (leave `Nat.Prime` out of what the kernel decides — its decision procedure is slow there; `hp.two_le` gives `2 ≤ p`) and finish with `exact key p hp' q hq' hp.two_le hpq hlt`;",
        "- or `interval_cases n` and close each case with `all_goals first | decide +kernel | (simp_all; omega)` — only when the range is small.",
      ].join("\n"),
    );
  }
  const orders = orderConditions(t);
  if (orders) hints.push(orderHint(orders));
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
        "- a parameter fixed by a quadratic condition (a point on a circle through a known point): substitute the point, factor out the known root and exclude it with the `≠` hypothesis —",
        "    `have hq : t * (25 * t - 16) = 0 := by linear_combination hCircle`, `have ht0 : t ≠ 0 := by rintro rfl; exact hne (by norm_num)`,",
        "    `have ht : t = 16 / 25 := by rcases mul_eq_zero.mp hq with h | h; · exact absurd h ht0; · linarith`, then `subst ht` and `norm_num` — never leave `t` unsolved and try to close `t * 3 = 48 / 25` directly;",
        "- distances written with `Real.sqrt`: first turn `ed O A = ed O B` into a polynomial equation (`Real.sqrt_inj (by positivity) (by positivity)` then `.mp`), and `ed B D` with `D.2 = 0` into `|D.1|` (`Real.sqrt_sq_eq_abs`), then `abs_of_nonneg`;",
        "- find the unknown coordinates one at a time, each in its own `have hO1 : O.1 = 15 / 2 := by nlinarith [h1, h2]` (or `linarith only [h1, h2]`) naming only the hypotheses it needs, then `obtain ⟨o1, o2⟩ := O` / `simp only [hO1] at *`; calling `linarith` / `nlinarith` with every hypothesis in context makes it time out (`Linarith…Gauss…heartbeats`) — `clear` the ones already used;",
        "- the final value: once every coordinate is a number, rewrite the distance as `Real.sqrt (c ^ 2)` (`rw [show … = (910 / 9) ^ 2 by norm_num]`) and use `Real.sqrt_sq (by norm_num)`; for a ratio, show numerator and denominator equal and use `div_self (by positivity)`;",
        "- if a step is heavy but correct, `set_option maxHeartbeats 400000 in` before the theorem is allowed (0 is not).",
      ].join("\n"),
    );
  }
  if (/arccos|∠|InnerProductGeometry\.angle|EuclideanGeometry\.angle/.test(t)) hints.push(angleHint(t));
  if (/Real\.sqrt|√/.test(t)) {
    hints.push(
      [
        "Square roots (names below are the current Mathlib ones — `Real.sqrt_eq_iff_sq_eq` no longer exists):",
        "- goal `Real.sqrt E = c` with c ≥ 0: `rw [Real.sqrt_eq_iff_eq_sq (by positivity) (by norm_num)]` leaves `E = c ^ 2`; or `rw [show E = c ^ 2 by …]; exact Real.sqrt_sq (by norm_num)`;",
        "- also `Real.sqrt_eq_iff_mul_self_eq (hx : 0 ≤ x) (hy : 0 ≤ y) : √x = y ↔ x = y * y`, `Real.sq_sqrt (h : 0 ≤ a) : √a ^ 2 = a`, `Real.sqrt_sq (h : 0 ≤ a) : √(a ^ 2) = a`, `Real.mul_self_sqrt (h : 0 ≤ a) : √a * √a = a`;",
        "- hypotheses that fix the numbers (`ax = -4 ∧ ay = 3`): `obtain ⟨rfl, rfl⟩ := h` first, then find the unknowns from the linear conditions with `linarith` (`have hx : px = 0 := by linarith`), substitute them and finish with `norm_num`.",
      ].join("\n"),
    );
  }
  hints.push("Never write `sorry` or `admit`: a proof that contains them is rejected.");
  return hints;
}

/**
 * Angles written as `Real.arccos (dot / (dist * dist))`. Models evaluate arccos or argue by
 * contradiction and end at `⊢ False`; the working route compares the cosines (checked in Lean on
 * "AB = AC, ∠BAC = 40°, D on AC with BD = BC → ∠CBD = 40°").
 */
function angleHint(t: string): string {
  // the asked angle is one of the given values (2 * π / 9 both in a hypothesis and after the arrow)
  const goal = /→\s*([^→]*)$/.exec(t)?.[1] ?? "";
  const value = /=\s*([^=∧]+?)\s*$/.exec(goal)?.[1]?.trim();
  const same = !!value && t.split(value).length > 2;
  return [
    "Angles defined with `Real.arccos` of a cosine `dot / (dist Q P * dist Q R)`: never evaluate `Real.arccos` and do not argue by contradiction (`exfalso` / `nlinarith` toward `False` leaves `⊢ False`). Compare cosines instead:",
    same
      ? `- the asked angle equals the given one (both \`${value}\`): \`rw [← hA]\` (hA the hypothesis \`angle … = ${value}\`), then \`congr 1\` — what is left is that the two cosine fractions are equal, a polynomial fact;`
      : "- to show `Real.arccos x = c`: `rw [show c = Real.arccos (Real.cos c) from (Real.arccos_cos (by positivity) (by linarith [Real.pi_pos])).symm]`, `congr 1`, then prove `x = Real.cos c` from the given angle (`Real.cos_arccos (h₁ : -1 ≤ x) (h₂ : x ≤ 1)`, `Real.cos_sq_half`, `Real.cos_pi_sub`, `Real.cos_two_mul`); if the asked angle equals a given one, `rw [← hA]; congr 1` instead;",
    "- `obtain ⟨a1, a2⟩ := A` for every point, `rintro ⟨hAB, hA, …, ⟨t, -, -, rfl, hDC⟩, hBD⟩` (substitute the point on the segment), `simp only [dist, angle] at hAB hA hBD ⊢`;",
    "- each `dist X Y = dist X Z` becomes a polynomial equation: `have hAB2 : … = … := (Real.sqrt_inj (by positivity) (by positivity)).mp hAB`;",
    "- denominators: rewrite an equal distance so the product is `√S * √S`, then `Real.mul_self_sqrt (by positivity)` gives `S`; `rw [div_eq_div_iff (ne_of_gt h1) (ne_of_gt h2)]`; positivity of `(b1 - c1) ^ 2 + (b2 - c2) ^ 2` from `B ≠ C`: `have : b1 ≠ c1 ∨ b2 ≠ c2 := by by_contra h; push Not at h; exact hBC (Prod.ext h.1 h.2)`, then per case `have := pow_pos (abs_pos.mpr (sub_ne_zero.mpr h)) 2; rw [sq_abs] at this; positivity`;",
    "- a parameter fixed by the conditions (D = (1 - t) • A + t • C with BD = BC): factor out the excluded root — `have hfac : (t - 1) * ((t + 1) * U - 2 * W) = 0 := by linear_combination hBD2`, `ht : t ≠ 1` from `D ≠ C` (`rintro rfl; apply hDC; ext <;> simp`), then `rcases mul_eq_zero.mp hfac` → `key : (t + 1) * U = 2 * W` (U, W the squared side and dot product written out);",
    "- finish with `linear_combination (U - W) * key + (U - W) * hAB2` — the coefficients are polynomials; if `ring` reports leftover terms, change the signs or the coefficients rather than switching to `nlinarith`.",
  ].join("\n");
}

/** Largest closed exponent above 256 (and below what Lean refuses outright), as text, else undefined. */
function bigClosedExponent(t: string): string | undefined {
  let best: bigint | undefined;
  for (const m of t.matchAll(/\^\s*(\d+|\(\s*[\d\s+\-*]+\))/g)) {
    const v = evalNatExpr(m[1].replace(/^\(|\)$/g, ""));
    if (v !== undefined && v > 256n && v < 2n ** 24n && (best === undefined || v > best)) best = v;
  }
  return best?.toString();
}

// ── "Smallest n with m ∣ a ^ n - 1": multiplicative orders ─────────────────

export interface OrderCondition {
  /** As written, e.g. "(3 : ℕ) ^ 5 ∣ (2 : ℕ) ^ n - 1". */
  text: string;
  modulus: number;
  base: number;
  /** The multiplicative order of base mod modulus: m ∣ a ^ n - 1 ⇔ order ∣ n. */
  order: number;
  /** A prime-power part of a composite modulus as written (`257175` for 81, 25, 127). */
  partOf?: string;
  /** How the condition is written: `M ∣ a ^ n - 1` (or a helper / padicValNat), a congruence `≡ 1` / `% M = 1 % M`, or `a ^ n % M = 1`. */
  form?: "dvd" | "modeq" | "mod1";
  /** The modulus as written in the statement (for `mod1`). */
  modText?: string;
}

const NUM = String.raw`\(?\s*(\d+)\s*(?::\s*(?:ℕ|ℤ|Nat|Int)\s*)?\)?`;
/** `v (a ^ n - 1) e`-style valuation conditions: `padicValNat 3 (2 ^ n - 1) = 5`, or a helper such as `ExactValuation 3 (2 ^ m - 1) 5` (p ^ e ∣ …). */
const PADIC_ATOM = new RegExp(String.raw`(¬\s*\(*\s*)?padicValNat\s+${NUM}\s+\(\s*${NUM}\s*\^\s*([a-z]\w*)\s*-\s*1\s*\)\s*(=|≥)\s*(\d+)`, "g");
const HELPER_ATOM = new RegExp(String.raw`(¬\s*\(*\s*)?\b([A-Za-z_][\w']*)\s+${NUM}\s+\(\s*${NUM}\s*\^\s*([a-z]\w*)\s*-\s*1\s*\)\s+(\d+)`, "g");
/** A product modulus `(3 ^ 4 * 5 ^ 2 * 127 : ℕ) ∣ 2 ^ m - 1` (parenthesised or not). */
const FACTOR = String.raw`\d+(?:\s*\^\s*\d+)?`;
const PRODUCT_ATOM = new RegExp(String.raw`(¬\s*\(*\s*)?\(?\s*(${FACTOR}(?:\s*\*\s*${FACTOR})+)\s*(?::\s*(?:ℕ|ℤ|Nat|Int)\s*)?\)?\s*∣\s*\(?\s*${NUM}\s*\^\s*([a-z]\w*)\s*\)?\s*-\s*1\b`, "g");

/** Value of `3 ^ 4 * 5 ^ 2 * 127`. */
function productValue(expr: string): bigint {
  return expr
    .split("*")
    .map((f) => f.split("^").map((x) => BigInt(x.trim())))
    .reduce((acc, [b, e]) => acc * b ** (e ?? 1n), 1n);
}

/** The prime of a prime power. */
function primeOf(q: bigint): bigint {
  for (let p = 2n; p * p <= q; p++) if (q % p === 0n) return p;
  return q;
}

/** Prime-power factors of n (trial division; undefined when a factor above 10^6 is left over). */
export function primePowers(n: bigint): bigint[] | undefined {
  const out: bigint[] = [];
  let m = n;
  for (let p = 2n; p * p <= m; p++) {
    if (p > 1_000_000n) return undefined;
    if (m % p) continue;
    let q = 1n;
    while (m % p === 0n) {
      m /= p;
      q *= p;
    }
    out.push(q);
  }
  if (m > 1n) out.push(m);
  return out;
}

/**
 * A modulus written at `i`: a number, `3 ^ 5`, or a product in parentheses
 * (`((3 : ℕ) ^ 6 * 5 ^ 3 * 7 ^ 2)`); its value, and where it ends.
 */
function modulusAt(t: string, i: number, opts: { bareProduct?: boolean } = {}): { value: bigint; end: number; text: string } | undefined {
  let j = i;
  while (t[j] === " ") j++;
  let text: string;
  if (t[j] === "(") {
    let depth = 0;
    let k = j;
    for (; k < t.length; k++) {
      if (t[k] === "(") depth++;
      else if (t[k] === ")" && --depth === 0) break;
    }
    if (k >= t.length) return undefined;
    text = t.slice(j, k + 1);
    j = k + 1;
  } else {
    // after `%` a bare product binds wrongly (`a % 3 ^ 5 * 5 ^ 3` is `(a % 3 ^ 5) * 5 ^ 3`)
    const m = (opts.bareProduct === false ? /^\d+(?:\s*\^\s*\d+)?/ : /^\d+(?:\s*\^\s*\d+)?(?:\s*\*\s*\d+(?:\s*\^\s*\d+)?)*/).exec(t.slice(j));
    if (!m) return undefined;
    text = m[0];
    j += m[0].length;
  }
  const clean = text.replace(/:\s*(?:ℕ|ℤ|Nat|Int)/g, "").replace(/[()]/g, "").trim();
  if (!/^\d+(?:\s*\^\s*\d+)?(?:\s*\*\s*\d+(?:\s*\^\s*\d+)?)*$/.test(clean)) return undefined;
  return { value: productValue(clean), end: j, text: text.trim() };
}

/** `a ^ n` with a variable exponent, possibly cast: `2 ^ n`, `(2 ^ n : ℕ)`, `((2 : ℕ) ^ n)`. */
const VAR_POW = String.raw`\(?\s*\(?\s*(\d+)\s*(?::\s*(?:ℕ|Nat)\s*)?\)?\s*\^\s*([a-z]\w*)\s*(?::\s*(?:ℕ|Nat)\s*)?\)?`;

/**
 * Congruences `a ^ n ≡ 1` written as `Nat.ModEq M (a ^ n) 1`, `a ^ n ≡ 1 [MOD M]` or
 * `a ^ n % M = 1 % M` (also `= 1`): the same condition as `M ∣ a ^ n - 1`.
 */
type CongruenceAtom = { text: string; value: bigint; base: string; v: string; negated: boolean; form: "modeq" | "mod1"; modText: string };
function congruenceAtoms(t: string): CongruenceAtom[] {
  const out: CongruenceAtom[] = [];
  const neg = (at: number) => /¬\s*\(*\s*$/.test(t.slice(Math.max(0, at - 12), at));
  // `3 * 2 ^ n % 7`, `f 2 ^ n` are not `2 ^ n …`: nothing may be applied to the power on the left
  const freeLeft = (at: number) => {
    while (t[at] === " ") at++; // a match may start at the space before the power
    return !/(?:[*\/%]|[\w')\]])\s*\(*\s*$/.test(t.slice(Math.max(0, at - 8), at));
  };
  // and the condition ends there (`= 1 + k` is not `= 1`)
  const ends = (at: number) => /^\s*(?:$|[)∧∨→↔,\]])/.test(t.slice(at));
  for (const m of t.matchAll(/Nat\.ModEq\s+/g)) {
    const mod = modulusAt(t, m.index! + m[0].length);
    if (!mod) continue;
    const rest = new RegExp(String.raw`^\s*${VAR_POW}\s+1\b`).exec(t.slice(mod.end));
    if (rest && ends(mod.end + rest[0].length)) out.push({ text: t.slice(m.index!, mod.end + rest[0].length), value: mod.value, base: rest[1], v: rest[2], negated: neg(m.index!), form: "modeq", modText: mod.text });
  }
  for (const m of t.matchAll(new RegExp(String.raw`${VAR_POW}\s*≡\s*1\s*\[MOD\s*`, "g"))) {
    if (!freeLeft(m.index!)) continue;
    const mod = modulusAt(t, m.index! + m[0].length);
    if (mod && /^\s*\]/.test(t.slice(mod.end))) out.push({ text: t.slice(m.index!, mod.end), value: mod.value, base: m[1], v: m[2], negated: neg(m.index!), form: "modeq", modText: mod.text });
  }
  for (const m of t.matchAll(new RegExp(String.raw`${VAR_POW}\s*%\s*`, "g"))) {
    if (!freeLeft(m.index!)) continue;
    const mod = modulusAt(t, m.index! + m[0].length, { bareProduct: false });
    if (!mod) continue;
    const eq = /^\s*=\s*1\b/.exec(t.slice(mod.end));
    if (!eq) continue;
    let end = mod.end + eq[0].length;
    const pct = /^\s*%\s*/.exec(t.slice(end));
    const form: "modeq" | "mod1" = pct ? "modeq" : "mod1";
    if (pct) {
      const again = modulusAt(t, end + pct[0].length, { bareProduct: false });
      if (!again || again.value !== mod.value) continue;
      end = again.end;
    }
    if (ends(end)) out.push({ text: t.slice(m.index!, end), value: mod.value, base: m[1], v: m[2], negated: neg(m.index!), form, modText: mod.text });
  }
  return out;
}

const ORDER_ATOM = new RegExp(String.raw`(¬\s*\(*\s*)?\(?\s*${NUM}(?:\s*\^\s*(\d+))?\s*\)?\s*∣\s*\(?\s*${NUM}\s*\^\s*([a-z]\w*)\s*\)?\s*-\s*1\b`, "g");

/** Multiplicative order of a mod m (a, m coprime), or undefined when too large to search. */
export function multiplicativeOrder(a: number, m: number, cap = 2_000_000): number | undefined {
  if (m < 2) return undefined;
  const g = (x: number, y: number): number => (y ? g(y, x % y) : x);
  if (g(a % m, m) !== 1) return undefined;
  let x = a % m;
  for (let k = 1; k <= cap; k++) {
    if (x === 1) return k;
    x = Number((BigInt(x) * BigInt(a)) % BigInt(m));
  }
  return undefined;
}

/**
 * The positive conditions `m ∣ a ^ n - 1` (variable exponent) of a statement that also asks for the
 * smallest such n (`→ B ≤ n`, `n ≥ B`, `IsLeast`). Brute force over all n < B times out when B is
 * large; the orders make it a divisibility argument.
 */
export function orderConditions(t: string): OrderCondition[] | undefined {
  // "smallest": `→ B ≤ n`, `n ≥ B`, `IsLeast`, or `n < B → ¬ …`
  if (!/→\s*\d+\s*≤\s*[a-z]\w*|[a-z]\w*\s*≥\s*\d+|IsLeast|[a-z]\w*\s*<\s*\d+\s*→/.test(t)) return undefined;
  const out: OrderCondition[] = [];
  // A composite modulus is split into prime powers: their orders are small, while the order mod
  // the whole number can be large enough that `decide` over r < k hits Lean's recursion limit.
  const add = (text: string, value: bigint, b: string, form: OrderCondition["form"] = "dvd", modText?: string) => {
    const base = Number(b);
    const parts = primePowers(value);
    if (!parts?.length) return;
    for (const q of parts) {
      const modulus = Number(q);
      if (!Number.isSafeInteger(modulus) || modulus > 10_000_000 || out.some((o) => o.modulus === modulus && o.base === base)) continue;
      const order = multiplicativeOrder(base, modulus);
      if (order) out.push({ text: text.trim(), modulus, base, order, form, ...(modText ? { modText } : {}), ...(parts.length > 1 ? { partOf: value.toString() } : {}) });
    }
  };
  // a helper (let-defined) whose definition says p ^ e ∣ m
  const helpers = new Set([...t.matchAll(/let\s+([A-Za-z_][\w']*)\s*:[^:=]*:=\s*fun\s+(\w+)\s+(\w+)\s+(\w+)\s*=>\s*\2\s*\^\s*\4\s*∣\s*\3/g)].map((m) => m[1]));
  let atoms: { text: string; p: string; e?: string; base: string; v: string; negated: boolean; value?: bigint; form?: "modeq" | "mod1"; modText?: string }[] = [
    ...[...t.matchAll(PRODUCT_ATOM)].map((m) => ({ text: m[0], p: m[2], value: productValue(m[2]), base: m[3], v: m[4], negated: !!m[1] })),
    ...[...t.matchAll(ORDER_ATOM)].map((m) => ({ text: m[0], p: m[2], e: m[3], base: m[4], v: m[5], negated: !!m[1] })),
    ...[...t.matchAll(PADIC_ATOM)].map((m) => ({ text: m[0], p: m[2], e: m[6], base: m[3], v: m[4], negated: !!m[1] })),
    ...[...t.matchAll(HELPER_ATOM)].filter((m) => helpers.has(m[2])).map((m) => ({ text: m[0], p: m[3], e: m[6], base: m[4], v: m[5], negated: !!m[1] })),
    ...congruenceAtoms(t).map((c) => ({ ...c, p: c.value.toString() })),
  ];
  // only conditions on the variable being minimised (`B ≤ n`, `n < B →`, `IsLeast {n : ℕ | …}`)
  const minVar = /→\s*\d+\s*≤\s*([a-z]\w*)/.exec(t)?.[1] ?? /([a-z]\w*)\s*<\s*\d+\s*→/.exec(t)?.[1] ?? /([a-z]\w*)\s*≥\s*\d+/.exec(t)?.[1] ?? /IsLeast\s*\{\s*([a-z]\w*)/.exec(t)?.[1];
  if (minVar) atoms = atoms.filter((a) => a.v === minVar);
  // ORDER_ATOM also matches the last factor of a product (`127 ∣ 2 ^ m - 1` inside `3 ^ 4 * 5 ^ 2 * 127 ∣ …`).
  const productTexts = atoms.filter((a) => a.value !== undefined).map((a) => a.text);
  for (let i = atoms.length - 1; i >= 0; i--) {
    if (atoms[i].value === undefined && productTexts.some((p) => p !== atoms[i].text && p.includes(atoms[i].text.trim()))) atoms.splice(i, 1);
  }
  // `¬ p ^ (e+1) ∣ …` next to `p ^ e ∣ …` is the "exactly e" half and does not constrain n; a negated
  // conjunction (`n < B → ¬ (… ∧ …)`) does, through each of its conditions.
  const positive = atoms.filter((a) => !a.negated);
  const primesOf = (a: (typeof atoms)[number]) => new Set((primePowers(a.value ?? BigInt(a.p) ** BigInt(a.e ?? "1")) ?? []).map(primeOf));
  for (const a of atoms) {
    if (a.negated) {
      const mine = primesOf(a);
      if (positive.some((q) => q.base === a.base && [...primesOf(q)].some((p) => mine.has(p)))) continue;
    }
    add(a.text, a.value ?? BigInt(a.p) ** BigInt(a.e ?? "1"), a.base, a.form ?? "dvd", a.modText);
  }
  return out.length ? out : undefined;
}

const ORD_LEMMA = [
  "have ord : ∀ a m k n : ℕ, 0 < a → 0 < k → a ^ k % m = 1 → (∀ r < k, a ^ r % m = 1 → r = 0) → m ∣ a ^ n - 1 → k ∣ n := by",
  "  intro a m k n ha hk0 hk hmin h",
  "  have h1 : a ^ n % m = 1 % m := ((Nat.modEq_iff_dvd' (Nat.one_le_pow _ _ ha)).mpr h).symm",
  "  have hm : 1 % m = 1 := by rw [← hk, Nat.mod_mod]",
  "  have h2 : a ^ n % m = a ^ (n % k) % m := by",
  "    conv_lhs => rw [← Nat.div_add_mod n k, pow_add, pow_mul, Nat.mul_mod, Nat.pow_mod, hk, one_pow, hm, one_mul, Nat.mod_mod]",
  "  exact Nat.dvd_of_mod_eq_zero (hmin _ (Nat.mod_lt _ hk0) (by rw [← h2, h1, hm]))",
];

/** Largest order the program-written proof checks with `decide +kernel` over r < k. */
const ORDER_SCRIPT_MAX = 5000;

/**
 * Exponents above 2^24 (Lean's limit for computing a power) in `t`, each as N = d * e + r with
 * d, e, r below it, so `a ^ N` can be rewritten `(a ^ d) ^ e * a ^ r` before the kernel computes.
 * Undefined when that is not safe: an exponent that is not a plain literal (`2 ^ (N * 2)` — the
 * rewrite would miss it and the kernel would meet the whole power), or a power whose value would
 * have more than 2^27 bits (the kernel builds the number; far beyond that it runs out of memory).
 */
export function bigExponents(t: string): { n: string; d: string; e: string; r: string }[] | undefined {
  const out = new Map<string, { n: string; d: string; e: string; r: string }>();
  for (const m of t.matchAll(/(\d+)?\s*(?::\s*ℕ\s*)?\)?\s*\^\s*(\(?)\s*(\d+)(\s*\)?)(\s*[*+\-/^%])?/g)) {
    const n = BigInt(m[3]);
    if (n <= 1n << 24n) continue;
    // `^ (N` must close right after the literal (`^ (N * 2)` is not N); `^ N ^ k` is a tower
    if (m[2] && !m[4].includes(")")) return undefined;
    if (!m[2] && /\^/.test(m[5] ?? "")) return undefined;
    const base = m[1] ? Number(m[1]) : 2;
    if (Number(n) * Math.log2(Math.max(2, base)) > 2 ** 27) return undefined;
    let d = BigInt(Math.floor(Math.sqrt(Number(n))));
    while (d * d > n) d--;
    while ((d + 1n) * (d + 1n) <= n) d++;
    const e = n / d;
    out.set(m[3], { n: m[3], d: d.toString(), e: e.toString(), r: (n - d * e).toString() });
  }
  return [...out.values()];
}

/** Where a condition `q ∣ a ^ n - 1` can sit in a hypothesis with `depth` conjunctions: itself, a conjunct, or the first half of a helper. */
function hypPaths(depth: number): string[] {
  return [
    ...new Set(
      Array.from({ length: Math.min(6, depth) + 1 }, (_, k) => {
        const rest = ".2".repeat(k);
        return [`${rest}.1`, rest]; // the k-th conjunct, or what is left after k of them
      })
        .flat()
        .flatMap((p) => [p, `${p}.1`]),
    ),
  ];
}

/**
 * Proofs the program writes itself for "the smallest n with m ∣ a ^ n - 1 …": the statement's closed
 * facts by `decide +kernel`, then one order lemma per prime power and their lcm. Shapes: `… ∧ ∀ n,
 * 0 < n → P n → B ≤ n` (P one hypothesis or several curried ones) and `… ∀ n, 0 < n → n < B → ¬ P n`.
 * Checked in Lean 4.33.1 + Mathlib for the forms in the tests; Lean decides whether a candidate fits.
 */
export function orderProofScripts(theoremType: string): string[] {
  const t = theoremType.replace(/^\s*:\s*/, "");
  const all = orderConditions(t);
  // the script's `decide +kernel` over r < k must stay small
  const orders = all?.filter((o) => o.order <= ORDER_SCRIPT_MAX);
  if (!orders?.length || orders.length !== all?.length) return [];
  const big = bigExponents(t);
  if (!big) return [];
  const g = (x: number, y: number): number => (y ? g(y, x % y) : x);
  const l = orders.reduce((acc, o) => (acc / g(acc, o.order)) * o.order, 1);
  const lets = [...t.matchAll(/(?:^|;\s*|\(\s*)let\s+([A-Za-z_][\w']*)/g)].map((m) => m[1]);
  const script = (hyps: string[], lt: boolean) => {
    // The condition turned into `M ∣ a ^ n - 1` the way it is written (only that conversion: a
    // wrong one can be logged by Lean instead of failing, and `first` would stop there), then the
    // prime-power part q ∣ M.
    const asDvd = (o: OrderCondition, e: string) =>
      o.form === "modeq"
        ? `((Nat.modEq_iff_dvd' (Nat.one_le_pow _ _ (by norm_num))).mp (${e}).symm)`
        : o.form === "mod1"
          ? `((Nat.modEq_iff_dvd' (Nat.one_le_pow _ _ (by norm_num))).mp ((${e}).trans (Nat.mod_eq_of_lt (show (1 : ℕ) < ${o.modText} by norm_num)).symm).symm)`
          : e;
    const pick = (o: OrderCondition) =>
      `first | ${hyps.flatMap((h) => hypPaths(depth).map((p) => `(refine Nat.dvd_trans ?_ ${asDvd(o, `${h}${p}`)}; norm_num; done)`)).join(" | ")}`;
    const lcmExpr = orders.slice(1).reduce((acc, o) => `Nat.lcm (${acc}) ${o.order}`, String(orders[0].order));
    const lcmProof = orders.slice(1).reduce((acc, _o, i) => `Nat.lcm_dvd (${acc}) o${i + 1}`, "o0");
    return [
      ...(lets.length ? [`intro ${lets.join(" ")}`] : []),
      ...ORD_LEMMA,
      // every closed conjunct (however many) by the kernel; what is left is the "no smaller n" part
      "and_intros",
      // a power too big for the kernel (exponent above 2^24) is split, a ^ N = (a ^ d) ^ e * a ^ r,
      // and only the split goal goes to the kernel — never the power as written
      ...(big.length
        ? big.map(({ n, d, e, r }) => `all_goals try (rw [show (${n} : ℕ) = ${d} * ${e} + ${r} by norm_num, pow_add, pow_mul]; decide +kernel)`)
        : ["all_goals try decide +kernel"]),
      `intro n hn ${lt ? "hlt " : ""}${hyps.join(" ")}`,
      ...orders.map(
        (o, i) => `have o${i} : ${o.order} ∣ n := ord ${o.base} ${o.modulus} ${o.order} n (by norm_num) (by norm_num) (by decide +kernel) (by decide +kernel) (by ${pick(o)})`,
      ),
      `have hl : ${l} ∣ n := by`,
      `  have := ${lcmProof}`,
      `  rwa [show ${lcmExpr} = ${l} by norm_num] at this`,
      lt ? "exact absurd (Nat.le_of_dvd hn hl) (Nat.not_le.mpr hlt)" : "exact Nat.le_of_dvd hn hl",
    ].join("\n");
  };
  const ltForm = /<\s*\d+\s*→\s*¬/.test(t);
  const names = ["h", "h2", "h3", "h4"];
  // The hypotheses after `0 < n →`: how many (curried) and how deeply they are conjunctions.
  const seg = /0\s*<\s*[a-z]\w*\s*→([\s\S]*?)→\s*\d+\s*≤\s*[a-z]\w*\s*$/.exec(t)?.[1] ?? /<\s*\d+\s*→\s*¬([\s\S]*)$/.exec(t)?.[1];
  // (a let-defined predicate hides its conjunctions: then every depth)
  const depth = seg && !lets.length ? (seg.match(/∧/g) ?? []).length : 6;
  const count = seg && !ltForm ? Math.min(4, Math.max(1, seg.split("→").length)) : undefined;
  if (ltForm) return [script(["h"], true)];
  if (count) return [script(names.slice(0, count), false)];
  return [1, 2, 3, 4].slice(0, Math.max(1, Math.min(4, orders.length))).map((k) => script(names.slice(0, k), false));
}

/**
 * "The smallest m with P m is B" where B is small: the kernel checks every m below B
 * (`have key : ∀ m : ℕ, m < B → (P m → False) := by decide +kernel`), then each m ≥ B is fine.
 * For `… ∧ ∀ m : ℕ, H₁ → H₂ → B ≤ m` with decidable hypotheses, B ≤ 2000; checked in Lean 4.33.1 +
 * Mathlib (2025 ∣ m² − 1 over ℤ, B = 649; 7 ∣ 2 ^ n − 1, B = 3; two curried hypotheses, B = 2).
 */
export function boundedMinScripts(theoremType: string): string[] {
  const t = theoremType.replace(/^\s*:\s*/, "").trim();
  const m = /∀\s*([a-z]\w*)\s*:\s*(?:ℕ|Nat)\s*,\s*([\s\S]*?)→\s*(\d+)\s*≤\s*\1\s*\)*\s*$/.exec(t);
  if (!m) return [];
  const [, v, rawBody, bound] = m;
  const body = rawBody.trim();
  const B = Number(bound);
  // the kernel walks m < B by recursion: it stops with "deep recursion detected" between 2500 and
  // 3000 (Lean 4.33.1), so B stays at 2000 or below
  const cap = 2000;
  if (!Number.isSafeInteger(B) || B < 1 || B > cap || hugePower(t)) return [];
  let depth = 0;
  for (const c of body) {
    if ("([{⟨".includes(c)) depth++;
    else if (")]}⟩".includes(c) && --depth < 0) return [];
  }
  if (depth !== 0 || !body) return [];
  const lets = [...t.matchAll(/(?:^|;\s*|\(\s*)let\s+([A-Za-z_][\w']*)/g)].map((x) => x[1]);
  const close = [1, 2, 3, 4].map((k) => {
    const xs = ["a", "b", "c", "d"].slice(0, k).join(" ");
    return `exact fun ${xs} => (this ${xs}).elim`;
  });
  return [
    [
      ...(lets.length ? [`intro ${lets.join(" ")}`] : []),
      `have key : ∀ ${v} : ℕ, ${v} < ${B} → (${body} → False) := by decide +kernel`,
      "and_intros",
      "all_goals try decide +kernel",
      `intro ${v}`,
      `by_cases hlt : ${v} < ${B}`,
      `· have := key ${v} hlt`,
      `  first | ${close.join(" | ")}`,
      "· intros",
      "  exact Nat.le_of_not_lt hlt",
    ].join("\n"),
  ];
}

function orderHint(orders: OrderCondition[]): string {
  const g = (x: number, y: number): number => (y ? g(y, x % y) : x);
  const l = orders.reduce((acc, o) => (acc / g(acc, o.order)) * o.order, 1);
  return [
    `"Smallest n" with \`m ∣ a ^ n - 1\` conditions: do NOT check every n below the bound (\`interval_cases\`, \`decide\` over n < B time out — "Lean REPL command timed out"). Use multiplicative orders: m ∣ a ^ n - 1 holds exactly when ord ∣ n. Here (computed):`,
    ...orders.map(
      (o) =>
        `- \`${o.modulus} ∣ ${o.base} ^ n - 1\` ⇔ \`${o.order} ∣ n\` (${o.order} = order of ${o.base} mod ${o.modulus})` +
        (o.partOf ? ` — a part of ${o.partOf}: get it with \`Nat.dvd_trans (by norm_num) h\` from \`h : … ∣ ${o.base} ^ n - 1\`` : ""),
    ),
    ...(orders.some((o) => o.partOf)
      ? ["- a composite modulus: work with each prime-power part as above, never with the order mod the whole number (`decide` over r < k with k in the thousands hits \"maximum recursion depth\")."]
      : []),
    ...(orders.length > 1 ? [`- together: the lcm ${l} divides n, so n ≥ ${l}.`] : []),
    "A proof that Lean accepts (adapt the numbers):",
    "```lean",
    "  have ord : ∀ a m k n : ℕ, 0 < a → 0 < k → a ^ k % m = 1 → (∀ r < k, a ^ r % m = 1 → r = 0) → m ∣ a ^ n - 1 → k ∣ n := by",
    "    intro a m k n ha hk0 hk hmin h",
    "    have h1 : a ^ n % m = 1 % m := ((Nat.modEq_iff_dvd' (Nat.one_le_pow _ _ ha)).mpr h).symm",
    "    have hm : 1 % m = 1 := by rw [← hk, Nat.mod_mod]",
    "    have h2 : a ^ n % m = a ^ (n % k) % m := by",
    "      conv_lhs => rw [← Nat.div_add_mod n k, pow_add, pow_mul, Nat.mul_mod, Nat.pow_mod, hk, one_pow, hm, one_mul, Nat.mod_mod]",
    "    exact Nat.dvd_of_mod_eq_zero (hmin _ (Nat.mod_lt _ hk0) (by rw [← h2, h1, hm]))",
    "  -- closed facts about the answer (huge powers are fine for the kernel): one `by decide +kernel` per conjunct",
    "  refine ⟨⟨by decide +kernel, by decide +kernel, …⟩, ?_⟩",
    "  rintro n hn ⟨h3, -, h5, -, h7, -⟩   -- with a helper `ExactValuation p m e := p ^ e ∣ m ∧ …`: `rintro n hn hlt ⟨⟨h3, -⟩, ⟨h5, -⟩, ⟨h7, -⟩⟩`",
    "  have a := ord 2 243 162 n (by norm_num) (by norm_num) (by norm_num) (by decide +kernel) (by simpa using h3)",
    "  -- … one per condition (b, c), then",
    "  have hl := Nat.lcm_dvd (Nat.lcm_dvd a b) c",
    "  rw [show Nat.lcm (Nat.lcm 162 100) 21 = 56700 by norm_num] at hl",
    "  exact Nat.le_of_dvd hn hl   -- for `n < 56700 → ¬ …`: exact absurd (Nat.le_of_dvd hn hl) (Nat.not_le.mpr hlt)",
    "```",
    "Do not finish with `omega` or `simp_all` while `let` definitions about these huge powers are in context: they unfold them and run out of heartbeats.",
  ].join("\n");
}

/** The candidate that got furthest, for the failure report. */
function bestCandidate(w: WholeProofResult) {
  return [...w.candidates].sort((a, b) => (b.progress ?? 0) - (a.progress ?? 0) || a.errors - b.errors)[0];
}

/**
 * The steps that need no model: the hammer cascade in REPL tactic mode, single-tactic probes, and
 * for "smallest n with m ∣ a ^ n - 1" the order proof the program writes. Shared by the Lean
 * attempt and `npm run lean:recheck` (which re-runs them on stored statements).
 */
export async function proveWithoutModel(args: {
  sessionId: string;
  theoremName: string;
  theoremType: string;
  expectedSignature?: string;
  useMathlib: boolean;
  /** A power too big to compute is in the statement: skip what would evaluate it. */
  huge: boolean;
}): Promise<{
  proof?: { verification: LeanVerifyResult; source: string; tactics: string; strategy: "hammer" | "trivial" | "order" | "bounded" | "geometry" | "induction"; attempts: number };
  tried: string[];
}> {
  const { sessionId, theoremName, theoremType, expectedSignature, useMathlib, huge } = args;
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
      if (v.ok) return { proof: { verification: v, source, tactics: hit.tactic, strategy: "hammer", attempts: 1 }, tried };
    }
  }
  const trivial = huge ? undefined : await tryTrivialProof(sessionId, theoremName, theoremType, useMathlib, { expectedSignature });
  if (trivial) return { proof: { verification: trivial.verification, source: trivial.source, tactics: trivial.tactic, strategy: "trivial", attempts: 1 }, tried };
  if (!tried.length) tried.push(lt("单条策略（rfl、simp、norm_num、omega、decide、decide +kernel、ring、linarith 等）", "single tactics (rfl, simp, norm_num, omega, decide, decide +kernel, ring, linarith, …)"));

  // "Smallest n with m ∣ a ^ n - 1": the program writes the order proof itself (models kept
  // getting the order argument wrong: omega on `n % q`, `decide` over r < 3780); also with a huge
  // power — the scripts split exponents above 2^24 before the kernel computes.
  const orderScripts = orderProofScripts(theoremType);
  for (const [i, tactics] of orderScripts.entries()) {
    const source = assembleLeanSource({ theoremName, theoremType, stepCodes: [tactics], useMathlib });
    const v = await verifyLeanSource(sessionId, source, { theoremName, expectedSignature });
    if (v.ok) return { proof: { verification: v, source, tactics, strategy: "order", attempts: i + 1 }, tried };
  }
  if (orderScripts.length) tried.push(lt("按乘法阶由程序写出的证明", "a proof the program wrote from the multiplicative orders"));

  // "Smallest m" with a small bound: the kernel checks every m below it.
  const boundedScripts = huge ? [] : boundedMinScripts(theoremType);
  for (const tactics of boundedScripts) {
    const source = assembleLeanSource({ theoremName, theoremType, stepCodes: [tactics], useMathlib });
    const v = await verifyLeanSource(sessionId, source, { theoremName, expectedSignature });
    if (v.ok) return { proof: { verification: v, source, tactics, strategy: "bounded", attempts: 1 }, tried };
  }
  if (boundedScripts.length) tried.push(lt("程序写的逐个检查（内核算完界以下的每个数）", "a check the program wrote (the kernel tries every number below the bound)"));

  // Coordinate geometry: the program writes the algebraic proof (polynomial certificate from SymPy).
  if (!huge && looksGeometric(theoremType)) {
    const geo = await geometryProof({ sessionId, theoremName, theoremType, expectedSignature, useMathlib });
    if (geo.proof) return { proof: { ...geo.proof, strategy: "geometry", attempts: 1 }, tried };
    tried.push(lt(`程序写的坐标代数证明（${geo.reason}）`, `an algebraic proof in coordinates the program wrote (${geo.reason})`));
  }

  // Induction over ℕ: the program picks the scheme and closes base and step (divisibility quotients computed exactly).
  if (!huge && looksInductive(theoremType)) {
    const ind = await inductionProof({ sessionId, theoremName, theoremType, expectedSignature, useMathlib });
    if (ind.proof) {
      const { verification, source, tactics } = ind.proof;
      return { proof: { verification, source, tactics, strategy: "induction", attempts: 1 }, tried };
    }
    tried.push(lt(`程序写的归纳证明（${ind.reason}）`, `an induction proof the program wrote (${ind.reason})`));
  }
  return { tried };
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
    // Expert iteration: every proof Lean accepts here is remembered (source "lean-attempt"), so a
    // similar problem later can replay it or see it as a worked example, and it becomes training data.
    const done = async (v: LeanVerifyResult, source: string, extra: Partial<LeanProofAttempt>, tactics?: string): Promise<LeanProofAttempt> => {
      const remembered = tactics?.trim()
        ? await rememberVerifiedProof({ theoremName, theoremType, tactics, strategy: extra.strategy, problemText, source: LEAN_ATTEMPT_SOURCE })
        : false;
      return {
      attempted: true,
      success: true,
      formal_statement,
      proof_code: source,
      axioms: v.axioms?.axioms,
      statement_locked: expectedSignature !== undefined && v.signatureMatch === true,
      verifier: v.backend,
      ...(notes.length ? { limitations: notes } : {}),
      ...extra,
      ...(remembered ? { remembered: true } : {}),
      };
    };

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

    // 1. Without a model: automation, single tactics, the order proof the program writes.
    const auto = await proveWithoutModel({ sessionId, theoremName, theoremType, expectedSignature, useMathlib, huge: !!huge });
    const tried = auto.tried;
    if (auto.proof) return done(auto.proof.verification, auto.proof.source, { strategy: auto.proof.strategy, attempts: auto.proof.attempts }, auto.proof.tactics);

    // Proof memory: verified proofs of similar statements, tried verbatim first (no model call),
    // then given to the prover as worked examples together with the retrieved Mathlib lemmas.
    const proverContext = await buildProverContext({ theoremType, problemText, useMathlib });
    if (proverContext.recalled.length && !huge) {
      const replay = await replayRecalled({ sessionId, theoremName, theoremType, recalled: proverContext.recalled, expectedSignature, useMathlib });
      if (replay) return done(replay.verification, replay.source, { strategy: "memory", attempts: replay.tried }, replay.tactics);
      tried.push(lt(`证明记忆里 ${proverContext.recalled.length} 个相似题的已验证证明（原样重放）`, `${proverContext.recalled.length} verified proof(s) of similar problems from memory (replayed as is)`));
    }

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
        premises: proverContext.block || undefined,
        config: { ...preset.wholeProof, useMathlib },
      });
      if (whole.ok && whole.verification && whole.source) {
        if (whole.repairedFrom && whole.tactics) {
          void rememberRepair({
            theorem_name: theoremName,
            theorem_type: theoremType,
            failed_tactics: whole.repairedFrom.tactics,
            feedback: whole.repairedFrom.feedback,
            fixed_tactics: whole.tactics,
            source: LEAN_ATTEMPT_SOURCE,
          }).catch(() => false);
        }
        return done(whole.verification, whole.source, { strategy: "whole_proof", attempts: whole.samples, rounds: whole.rounds }, whole.tactics);
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

/** Proof-memory / repair-pair source of proofs found by the Lean attempt. */
export const LEAN_ATTEMPT_SOURCE = "lean-attempt";

/** Whether a stored attempt may be run again (it failed, or was never run). */
export function leanAttemptRetryable(a: LeanProofAttempt | undefined): boolean {
  return !a?.attempted || !a.success;
}
