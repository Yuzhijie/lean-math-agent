/**
 * Lean 4 formalization attempt for a solved problem: computational, optimization,
 * find-all-values, or a claim to prove (then without an answer).
 *
 * This is the last step of solving and is started by hand: the solve
 * pipelines return `{ attempted: false }` and the user starts it from the
 * Lean tab (POST /api/lean-attempt). Passing `options.lean_attempt: true`
 * to /api/solve or /api/solve-stream runs the formal proof in the same call
 * (a computational problem: this attempt; a proof problem: the theorem
 * pipeline, lib/pipeline/theorem-pipeline.ts).
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
import { orderConditions, orderHint } from "../lean/order-proof";
import { readingForm } from "../lean/reading-form";
import { runProverStages, triedTexts, type StageRun } from "../lean/prover-stages";
import { checkLeanAvailable, type LeanVerifyResult } from "../lean/sandbox";
import { scopeNotes, statementScope } from "../lean/statement-scope";
import { CancelledError } from "../jobs";
import { CostCapError } from "../llm/client";
import { costCapReached } from "../llm/usage-tracker";
import { budgetPreset } from "../prover/budget";
import { buildProverContext, rememberVerifiedProof } from "../prover/context";
import { replayRecalled } from "../prover/replay";
import { rememberRepair } from "../lean/proof-memory";
import { proveWholeTheorem, wholeProofEnabled, type WholeProofResult } from "../prover/whole-proof";
import type { LeanProofAttempt, NaturalLanguageSolution, ProgramStrategy } from "../types";

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
  /** The stored attempt this one runs again ("再试一次"): its statement is reused or its faults told to the formalizer. */
  previous?: LeanProofAttempt;
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
  if (/\bncard\b|\.card\b/.test(t) && /Orbit|orbit|MulAction|Rot\b|Ref\b|rotat|reflect/.test(t)) hints.push(orbitHint());
  if (/Relation\.ReflTransGen/.test(t) && /Multiset/.test(t)) hints.push(processHint());
  // recognised in the form the provers read (`n ≥ B` is `B ≤ n` there): the orders do not depend on the spelling
  const orders = orderConditions(readingForm(theoremType).type.replace(/^\s*:\s*/, ""));
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
 * Counting configurations up to rotation / reflection ("the number of orbits is 16"). `decide` on
 * the set of orbits cannot work (a Set of Sets), and the kernel fails on Finsets of Finsets (a
 * list of two Finset literals already gives "deep recursion"); the route below — representatives
 * as lists, finite facts on lists — was checked in Lean on 5 of 15 seats around a table, no two
 * adjacent, up to rotation and reflection (16 orbits).
 */
function orbitHint(): string {
  return [
    "Counting configurations up to rotation/reflection (the number of orbits): never `decide` / `rfl` the `Set.ncard` of a set of orbits, and never let the kernel decide anything over a Finset of Finsets or a List of Finsets (\"deep recursion\") — do the finite checks on `List (List (Fin n))`, one Finset at a time. The route (checked in Lean on 5 of 15 seats, no two adjacent, 16 orbits):",
    "  intro Valid Rot Ref Orbit   -- the statement's lets",
    "  have rr : ∀ j k s, Rot k (Rot j s) = Rot (j + k) s := by intro j k s; simp only [Rot, Finset.image_image]; congr 1; funext i; simp only [Function.comp_apply]; abel",
    "  -- likewise Ref k (Rot j s) = Ref (k - j) s, Rot k (Ref j s) = Ref (j + k) s, Ref k (Ref j s) = Rot (k - j) s (`abel`, not `ring`, on Fin n), Rot 0 s = s (`simp only [Rot, add_zero, Finset.image_id']`)",
    "  have oRot : ∀ j s, Orbit (Rot j s) = Orbit s  -- ext t; simp only [Orbit, Set.mem_ofPred_eq]; constructor; rintro ⟨hv, k, h | h⟩ … with the composition lemmas (`congr 1; abel` for the index); same for oRef",
    "  have vRot : ∀ j s, Valid s → Valid (Rot j s)  -- card via Finset.card_image_of_injective _ (add_left_injective j); adjacency via add_right_cancel",
    "  have mapRot : ∀ (l : List (Fin 15)) k, Rot k l.toFinset = (l.map (· + k)).toFinset := by intro l k; ext x; simp only [Rot, Finset.mem_image, List.mem_toFinset, List.mem_map]",
    "  let srt : List (Fin 15) → List (Fin 15) := fun l => l.insertionSort (· ≤ ·)   -- not mergeSort: well-founded recursion, the kernel cannot run it",
    "  have hsrt : ∀ l r, srt l = r → l.toFinset = r.toFinset := by intro l r h; rw [← h]; exact (List.toFinset_eq_of_perm _ _ (List.perm_insertionSort _ _)).symm",
    "  let RL : List (List (Fin 15)) := [[0, 2, 4, 6, 8], …]   -- one sorted representative per orbit, from the solution",
    "  have hRv : ∀ r ∈ RL, r.length = 5 ∧ r.Nodup ∧ ∀ i : Fin 15, i ∈ r → i + 1 ∉ r := by decide +kernel",
    "  have hnd : RL.Nodup := by decide +kernel",
    "  have hsep : ∀ r1 ∈ RL, ∀ r2 ∈ RL, ∀ k : Fin 15, ((r1.map (· + k)).toFinset = r2.toFinset → r1 = r2) ∧ ((r1.map (k - ·)).toFinset = r2.toFinset → r1 = r2) := by decide +kernel",
    "  have hcov : ∀ l ∈ List.sublistsLen 4 (List.finRange 15).tail, (∀ i : Fin 15, i ∈ 0 :: l → i + 1 ∉ 0 :: l) → ∃ r ∈ RL, ∃ k : Fin 15, srt ((0 :: l).map (· + k)) = r ∨ srt ((0 :: l).map (k - ·)) = r := by decide +kernel",
    "  -- every valid s: rotate it so that 0 ∈ s' (vRot (-i)), take l := (List.finRange 15).tail.filter (· ∈ s'), so s' = (0 :: l).toFinset (List.toFinset_cons, Finset.insert_erase) and l ∈ sublistsLen 4 (List.mem_sublistsLen, List.filter_sublist, List.toFinset_card_of_nodup); hcov + mapRot + hsrt give Orbit s = Orbit r.toFinset",
    "  -- then {O | ∃ s, Valid s ∧ O = Orbit s} = (fun r => Orbit r.toFinset) '' {r | r ∈ RL}, InjOn from hsep (r₂.toFinset ∈ Orbit r₂.toFinset with k = 0), and",
    "  rw [hset, hinj.ncard_image, show {r | r ∈ RL} = (RL.toFinset : Set (List (Fin 15))) by ext; simp, Set.ncard_coe_finset, List.toFinset_card_of_nodup hnd]",
    "Plain `decide` hits maximum recursion depth here; `decide +kernel` does not. Quantify with `∀ i : Fin n, i ∈ r → …` rather than `∀ i ∈ r` over a Finset.",
    "With more than a few thousand lists (6 of 18 seats: 6188) a `∀ l ∈ list, …` decided as a proposition recurses once per element (\"(kernel) deep recursion detected\"): state the check as a Bool over the list — `have h : (list).all (fun l => …) = true := by decide +kernel`, then `List.all_eq_true.1 h` — and compare sets as numbers (bit i for seat i: `(l.map Fin.val).foldl (fun b c => b ||| 2 ^ c) 0`) instead of sorting and searching lists.",
  ].join("\n");
}

/**
 * A process stated with `Relation.ReflTransGen` over multisets ("erase two numbers, write one").
 * The program proves the |a − b| board itself (lib/lean/optimize/process.ts); for another number
 * written, or another shape, the model gets that proof's skeleton — models searched the boards or
 * lost the step's variables ("Unknown identifier `b`"). Checked in Lean on 1, …, 15 with |a − b|.
 */
function processHint(): string {
  return [
    "A process stated with `Relation.ReflTransGen step` (\"erase two numbers, write a new one, until one is left\"): the bound is an invariant, not a search — find what every step keeps (the parity of the sum, the sum itself, a product, a gcd, a range the numbers stay in) and carry it along the process by induction. Never unfold `Relation.ReflTransGen` and never `decide` over all boards. The route (checked in Lean on 1, …, 15 with |a − b| written, largest last number 14: every number stays in 0 … 15 and the sum stays even):",
    "  intro initial step reach   -- the statement's lets",
    "  have hF : ∀ a b : ℤ, 0 ≤ a → a ≤ 15 → 0 ≤ b → b ≤ 15 → 0 ≤ ((Int.natAbs (a - b) : ℕ) : ℤ) ∧ ((Int.natAbs (a - b) : ℕ) : ℤ) ≤ 15 ∧ (((Int.natAbs (a - b) : ℕ) : ℤ) + a + b) % 2 = 0 := by intro a b h1 h2 h3 h4; omega   -- the facts about the number written, once (`|a - b|`: `rcases abs_cases (a - b) with ⟨h, _⟩ | ⟨h, _⟩ <;> rw [h] <;> omega`)",
    "  have hinv : ∀ t, Relation.ReflTransGen step initial t → (∀ x ∈ t, 0 ≤ x ∧ x ≤ 15) ∧ t.sum % 2 = 0 := by",
    "    intro t ht",
    "    induction ht with",
    "    | refl => exact ⟨by decide, by decide⟩",
    "    | tail _ hst ih =>",
    "      obtain ⟨a, b, ha, hb, rfl⟩ := hst   -- the step: ∃ a b, a ∈ s ∧ b ∈ s.erase a ∧ t = (s.erase a).erase b + {…}; a and b exist only from here on",
    "      have ha' := ih.1 a ha",
    "      have hb' := ih.1 b (Multiset.mem_of_mem_erase hb)",
    "      obtain ⟨hf0, hf1, hf2⟩ := hF a b ha'.1 ha'.2 hb'.1 hb'.2",
    "      have h1 := Multiset.sum_erase ha   -- a + (s.erase a).sum = s.sum",
    "      have h2 := Multiset.sum_erase hb",
    "      have hs0 := ih.2",
    "      generalize ((Int.natAbs (a - b) : ℕ) : ℤ) = f at hf0 hf1 hf2 ⊢   -- the number written as one variable: omega then needs nothing about it but hF",
    "      refine ⟨?_, ?_⟩",
    "      · intro x hx",
    "        rcases Multiset.mem_add.1 hx with h | h",
    "        · exact ih.1 x (Multiset.mem_of_mem_erase (Multiset.mem_of_mem_erase h))",
    "        · rw [Multiset.mem_singleton] at h; rw [h]; exact ⟨hf0, hf1⟩",
    "      · rw [Multiset.sum_add, Multiset.sum_singleton]",
    "        omega",
    "  constructor",
    "  · -- the value is reached: one step per move, the boards written out, each step `⟨a, b, by decide, by decide, by decide⟩`",
    "    show Relation.ReflTransGen step initial ({14} : Multiset ℤ)",
    "    have m1 : step initial ((([1, 2, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14] : List ℤ)) : Multiset ℤ) := ⟨15, 13, by decide, by decide, by decide⟩   -- 15 and 13 erased, 2 written",
    "    …",
    "    exact Relation.ReflTransGen.head m1 (Relation.ReflTransGen.head m2 (… Relation.ReflTransGen.refl))",
    "  · intro z hz",
    "    obtain ⟨hb0, hs0⟩ := hinv {z} hz",
    "    have hz0 := hb0 z (Multiset.mem_singleton_self z)",
    "    rw [Multiset.sum_singleton] at hs0",
    "    show z ≤ 14",
    "    omega",
  ].join("\n");
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

// "Smallest n with m ∣ a ^ n - 1" (multiplicative orders) and bounded minima: lib/lean/order-proof.ts
export { bigExponents, boundedMinScripts, multiplicativeOrder, orderConditions, orderProofScripts, primePowers, type OrderCondition } from "../lean/order-proof";

/** The candidate that got furthest, for the failure report. */
function bestCandidate(w: WholeProofResult) {
  return [...w.candidates].sort((a, b) => (b.progress ?? 0) - (a.progress ?? 0) || a.errors - b.errors)[0];
}

/**
 * The steps that need no model — the stages of lib/lean/prover-stages.ts: the automation cascade,
 * single tactics, the order and bounded-minimum scripts the program writes, its provers best fit
 * first, the tactic search — within their time budget. Shared by the Lean attempt, `npm run
 * lean:recheck` and `npm run lean:regress` (which re-run them on stored statements) and the check
 * of generated problems.
 */
export async function proveWithoutModel(args: {
  sessionId: string;
  theoremName: string;
  theoremType: string;
  expectedSignature?: string;
  useMathlib: boolean;
  /** A power too big to compute is in the statement: skip what would evaluate it. */
  huge: boolean;
  /** Time for all stages together (default PROVER_STAGES_BUDGET_MS). */
  budgetMs?: number;
}): Promise<{
  proof?: { verification: LeanVerifyResult; source: string; tactics: string; strategy: ProgramStrategy; attempts: number };
  /** What was tried, in words (the failure report). */
  tried: string[];
  /** Every stage that ran or was left out for lack of time: what happened and how long it took. */
  stages: StageRun[];
}> {
  const { budgetMs, ...statement } = args;
  const r = await runProverStages(statement, { budgetMs });
  return { ...(r.proof ? { proof: r.proof } : {}), tried: triedTexts(statement, r), stages: r.runs };
}

/** `theorem NAME TYPE := by sorry` → its name and type, or undefined. */
export function parseFormalStatement(stmt: string | undefined): { theorem_name: string; theorem_type: string } | undefined {
  const m = stmt?.trim().match(/^theorem\s+(\S+)\s+([\s\S]+?)\s*:=\s*by\s+sorry\s*$/);
  return m ? { theorem_name: m[1], theorem_type: m[2] } : undefined;
}

/** Whether an earlier attempt's statement passed every check (attempts stored before the flag: by their reason). */
export function statementWasAccepted(a: LeanProofAttempt | undefined): boolean {
  if (!a?.attempted) return false;
  return a.statement_accepted ?? /陈述通过了检查|statement passed the checks/.test(a.failure_reason ?? "");
}

/** What an earlier formalization got wrong, for the formalizer (autoformalize `feedback`). */
export function previousAttemptFeedback(prev: LeanProofAttempt, statement: string, recheck?: string): string {
  const said = (prev.limitations ?? []).join("\n").slice(0, 1200);
  const what = recheck
    ? `It no longer passes the program's checks: ${recheck}`
    : statementWasAccepted(prev)
      ? `It passed the checks, but neither the program's provers nor the model could prove it. What was tried:\n${said}\nWrite it in the forms the rules recommend (explicit coordinates, the circumcentre or other auxiliary points as lets or an ∃ with their defining equations, polynomial conditions), so the program's provers can read it.`
      : `It was rejected: ${prev.failure_reason ?? ""}\n${said}`;
  return `${statement}\n${what}`;
}

export async function attemptLeanFormalization(problemText: string, ctx: LeanAttemptContext = {}): Promise<LeanProofAttempt> {
  const mark = { accepted: false, reused: false };
  const r = await attemptLean(problemText, ctx, mark);
  const out = mark.accepted ? { ...r, statement_accepted: true, ...(mark.reused ? { reused_statement: true } : {}) } : r;
  return out.success ? withScopeNotes(out, problemText, ctx) : out;
}

/**
 * A proved statement with what its proof does not cover (lib/lean/statement-scope.ts): a figure
 * the model read, or a closed computation on numbers worked out while solving. Shown under
 * "Lean 已证" — of 62 proofs read in the formalization audit, 12 were of such statements.
 */
export function withScopeNotes(attempt: LeanProofAttempt, problemText: string, ctx: Pick<LeanAttemptContext, "answer" | "answers"> = {}): LeanProofAttempt {
  if (!attempt.success || !attempt.formal_statement) return attempt;
  const answers = [ctx.answer, ...(ctx.answers ?? [])].filter((a): a is string => !!a);
  const notes = scopeNotes(statementScope(problemText, attempt.formal_statement, answers));
  return notes.length ? { ...attempt, limitations: [...(attempt.limitations ?? []), ...notes] } : attempt;
}

async function attemptLean(problemText: string, ctx: LeanAttemptContext, mark: { accepted: boolean; reused: boolean }): Promise<LeanProofAttempt> {
  const sessionId = ctx.sessionId ?? "lean-attempt";
  let formal_statement: string | undefined;
  try {
    // Formalize with the most trusted answer; when its statement does not pass the checks and
    // solving produced another answer, try that one (a wrong answer forces a statement that
    // misstates the problem: the numeric / counterexample checks refute it, or the
    // non-triviality check finds it built to fit — a figure encoded with 2 triangles for "2").
    const answers = ctx.answers?.length ? ctx.answers : ctx.answer ? [ctx.answer] : [undefined];
    const notes: string[] = [];
    let formal: Awaited<ReturnType<typeof autoformalize>> | undefined;
    // "Try again": a statement that passed the checks last time is proved again with the current
    // code before anything is formalized anew (each new formalization is written differently, and a
    // good statement was being thrown away) — once: when that fails too, the next attempt formalizes
    // again, told what was wrong. The program checks it again first (layers 1, 6: they may have become stricter).
    const prev = ctx.previous;
    const prevStatement = parseFormalStatement(prev?.formal_statement);
    let feedback: string | undefined;
    if (prev && prevStatement && statementWasAccepted(prev) && !prev.reused_statement) {
      const again = await autoformalize({ problemText, reuse: prevStatement });
      if (again.accepted) {
        formal = again;
        formal_statement = again.formal_statement;
        mark.reused = true;
        notes.push(lt("沿用上次通过检查的陈述，用当前代码重新证明（没有重新形式化）", "The statement that passed the checks last time was proved again with the current code (not formalized anew)"));
      } else {
        const why = again.validation_results.filter((v) => !v.pass).map((v) => `L${v.layer}: ${v.detail}`).join("\n");
        feedback = previousAttemptFeedback(prev, prev.formal_statement!, why);
        notes.push(lt(`上次的陈述没有通过现在的检查，重新形式化（${why.split("\n")[0].slice(0, 160)}）`, `Last time's statement fails the current checks, so the problem was formalized anew (${why.split("\n")[0].slice(0, 160)})`));
      }
    } else if (prev && prevStatement) {
      feedback = previousAttemptFeedback(prev, prev.formal_statement!);
    }
    for (let k = 0; !formal?.accepted && k < answers.length; k++) {
      formal = await autoformalize({ problemText: problemWithAnswer(problemText, answers[k]), feedback });
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

    if (!formal) throw new Error("no formalization");
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

    mark.accepted = true;
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
