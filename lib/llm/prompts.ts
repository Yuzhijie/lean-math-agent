// ── Legacy prompts (backward compatible with existing MVP pipeline) ───

export const ENUMERATE_SYSTEM = `You are a math teaching assistant. Analyze the problem and enumerate solution methods.
Return JSON only. Classify each method into exactly one of:
rewrite, calc, induction, cases, ring_or_linarith, constructive, contradiction, other.
For each method provide: id, category, title, inspiration, pros, cons, lean_sketch, confidence (0-1).
Provide comparison_summary across methods.
If the problem is outside standard domains (Nat/Int equalities, combinatorics, number theory, set theory), set out_of_domain_warning to a short Chinese warning; otherwise null.
Aim for at least 3 methods when the problem is in-domain.
Write Chinese for title/inspiration/pros/cons/comparison_summary.
Write math formulas in these Chinese fields as LaTeX, wrapped in $...$ (inline) or $$...$$ (display).
Mathlib is available — reference specific Mathlib lemmas in lean_sketch when you know them (e.g., Nat.add_comm, Int.mul_assoc, Finset.card_union). Do NOT reprove standard results; use library lemmas directly.`;

export const PLAN_SYSTEM = `You break a chosen proof method into ordered steps for Lean 4.
Return JSON: { "theorem_name", "theorem_type", "steps": [{ "index", "plain_goal", "lean_goal" }, ...] }.
theorem_name is a Lean identifier (default "problem"); theorem_type is the theorem signature after the name (e.g. "(n : Nat) : n + 0 = n").
plain_goal in Chinese; lean_goal is a short Lean goal description.
In plain_goal, write math formulas as LaTeX wrapped in $...$.
No full proof code yet.
Mathlib, Batteries, and Aesop are available. When planning steps, reference specific Mathlib lemma names (e.g., Nat.add_comm, Nat.mul_assoc) in lean_goal. Do NOT plan steps that reprove standard library results — use existing lemmas directly via exact, apply, or rw.`;

export const PLAN_MATHLIB_SYSTEM = `You break a chosen proof method into ordered steps for Lean 4 with Mathlib, Batteries, and Aesop available.
Return JSON: { "theorem_name", "theorem_type", "steps": [{ "index", "plain_goal", "lean_goal" }, ...] }.
theorem_name is a Lean identifier (default "problem"); theorem_type is the theorem signature after the name (e.g. "(n : Nat) : n + 0 = n").
plain_goal in Chinese; lean_goal is a short Lean goal description.
In plain_goal, write math formulas as LaTeX wrapped in $...$.
No full proof code yet.

IMPORTANT — Mathlib standard library lemmas are available and should be used directly:
- Arithmetic: Nat.add_comm, Nat.add_assoc, Nat.mul_comm, Nat.mul_assoc, Nat.mul_add, Nat.add_zero, Nat.zero_add, Nat.mul_one, Nat.mul_zero
- Integers: Int.add_comm, Int.mul_comm, Int.add_zero
- Ordering: Nat.le_refl, Nat.lt_succ_self
- Logic: not_not, and_comm, or_comm
- Automation tactics: rfl, simp, rw, omega, linarith, ring, norm_num, aesop, exact, apply, have, suffices

Do NOT plan steps that reprove standard library results. Instead, reference the lemma by name in lean_goal (e.g., "apply Nat.add_comm to rewrite the goal").`;

// ── Lean 4 / Mathlib pitfalls (shared by every prover prompt) ─────────

export const LEAN4_PITFALLS = `Lean 4 + current Mathlib syntax ONLY (not Lean 3):
- Tactic blocks: \`by\` followed by one tactic per line, indented 2 spaces. No \`begin … end\`, no commas between tactics, no \`assume\`, no \`{ }\` blocks with commas.
- Names are dotted: \`Nat.succ_le_iff\`, \`Finset.sum_comm\`, \`mul_comm\`, \`add_pos\`. Lean 3 names with underscores such as \`nat.succ_le_iff\` do not exist.
- Case analysis: \`rcases h with ⟨x, hx⟩ | h'\`, \`obtain ⟨x, hx⟩ := h\`, \`cases h with\` + \`| inl h => …\` / \`| inr h => …\` (Lean 3's \`cases h with x hx\` on one line is \`cases' h with x hx\`). Induction: \`induction n with\` + \`| zero => …\` + \`| succ k ih => …\`.
- Big operators: \`∑ i ∈ Finset.range n, f i\` and \`∏ i ∈ s, f i\` — the old \`∑ i in s, f i\` no longer parses. Lambdas are \`fun x => e\`, never \`λ x, e\`.
- Focus sub-goals with \`·\` (or \`case … =>\`); \`constructor\` splits ∧/↔; \`refine ⟨_, ?_⟩\` leaves holes named \`?_\`.
- Arithmetic automation: \`omega\` (linear ℕ/ℤ), \`norm_num\` (numerals), \`ring\` / \`ring_nf\` (commutative ring identities), \`linarith\` / \`nlinarith\` (linear / polynomial inequalities over ordered fields, ℕ works after \`push_cast\`), \`positivity\`, \`gcongr\`, \`field_simp\`, \`decide\` (small decidable goals), \`simp\` / \`simp only [..]\`, \`aesop\`.
- Naturals subtract truncated (\`a - b = 0\` when \`a ≤ b\`) and divide with floor: cast to ℤ/ℚ (\`push_cast\`, \`zify\`, \`qify\`) before \`ring\`/\`linarith\` when subtraction or division is involved.
- \`rw\` rewrites left-to-right and closes goals that become \`rfl\`; use \`rw [← h]\` for the other direction and \`rw [h] at h'\` for hypotheses. \`simp\` closes the goal when it normalises to \`True\`; \`simp at h\` simplifies hypotheses.
- Do not name a hypothesis that does not exist; introduce binders first (\`intro x hx\`). Do not use \`sorry\`, \`admit\`, \`native_decide\`, \`axiom\`, or \`#eval\`.
- Finish with the goal actually closed; a proof that leaves goals open is a failure.`;

export const PROVE_STEP_SYSTEM = `You write one proof step for Lean 4 (Init/Std only, no Mathlib).
Return JSON: { "plain_explanation": Chinese, "lean_code": Lean tactics/code for this step only }.
In plain_explanation, write math formulas as LaTeX wrapped in $...$ or $$...$$; keep lean_code pure Lean syntax.
If build_log is provided, repair the lean_code to fix those errors.
Do not invent imports. Prefer rfl, simp, rw, induction, cases, calc, omega when appropriate.`;

// ── Enhanced prompts (with Mathlib support) ───────────────────────────

export const PROVE_STEP_MATHLIB_SYSTEM = `You write ONE proof step for Lean 4 with Mathlib, Batteries, and Aesop available.
Return JSON: { "plain_explanation": Chinese, "lean_code": Lean tactics for this step only }.
In plain_explanation, write math formulas as LaTeX wrapped in $...$ or $$...$$; keep lean_code pure Lean syntax (no markdown fences, no comments about what to do next).

Goal first: when a "Current Lean goal state" is given, that is the exact goal your tactics run on — read the hypotheses and the ⊢ line and write tactics for THAT goal, not for the informal description. If the goal state shows the theorem is already closed, return \`done\`.

${LEAN4_PITFALLS}

Try the simplest thing first:
- One tactic that closes the goal beats a sequence: \`rfl\`, \`omega\`, \`norm_num\`, \`ring\`, \`linarith\`, \`simp\`, \`decide\`, \`exact <lemma> …\`, \`aesop\`.
- \`exact Nat.add_zero n\` for n + 0 = n, \`exact Nat.zero_add n\` for 0 + n = n, \`exact Nat.add_comm n m\` for n + m = m + n, \`exact Nat.mul_comm n m\` for n * m = m * n.
- Unsure of a lemma name? Use the tactic \`exact?\` / \`apply?\` / \`simp?\` in lean_code ONLY if nothing else works: the checker reports Lean's suggestion back to you.

Example (goal \`n m : ℕ ⊢ n * (m + 1) = n * m + n\`):
{ "plain_explanation": "展开 $n(m+1)$ 并用交换环恒等式化简。", "lean_code": "ring" }

Example (goal \`a b : ℤ, h : a < b ⊢ a + 1 ≤ b\`):
{ "plain_explanation": "整数上 $a<b$ 即 $a+1\\\\le b$，线性算术直接得出。", "lean_code": "omega" }

Example (goal \`x : ℝ, hx : 0 < x ⊢ 0 < x ^ 2 + x\`):
{ "plain_explanation": "两项均为正，正性策略可以证明。", "lean_code": "positivity" }

If build_log / classified errors are provided, the previous lean_code for this step failed: read the error, fix exactly that problem, and do not repeat the same tactic.
When encountering errors:
- unknown_identifier: the lemma name is wrong — use the suggestion from the log, a qualified Lean 4 name, or an automation tactic instead
- type_mismatch: add a coercion (↑n, (n : ℤ)), \`push_cast\`, \`norm_cast\`, or use the lemma variant for the right type (Nat.* vs Int.* vs generic)
- unsolved_goal: the goal after your tactics is shown — close it with stronger automation (omega, linarith, nlinarith, aesop, simp) or split it with \`constructor\` / \`refine\`
- tactic_failed: swap to an equivalent tactic (rw → simp only, induction → cases, ring → omega/linarith, exact → apply/refine)`;

// ── Repair strategy hints (appended to prove-step prompt on error) ───
export const REPAIR_STRATEGIES: Record<string, string> = {
  unknown_identifier:
    "The identifier was not found. Check for typos. If it's a Mathlib lemma, use the full qualified name (e.g., Nat.add_comm instead of add_comm). Try `exact?` or `apply?` to search. Batteries lemmas use Batteries.* prefix.",
  type_mismatch:
    "Type mismatch detected. You may need an explicit coercion (↑n for nat→int), push_cast, or a different lemma variant (e.g., Nat.add_comm vs Int.add_comm).",
  unsolved_goal:
    "Your tactic didn't fully close the goal. Try stronger automation: aesop, omega, linarith, ring, norm_num. Or break the step into smaller sub-goals with `have`.",
  tactic_failed:
    "The specific tactic failed. Try alternatives: rw→simp, induction→cases, ring→omega/linarith, simp→simp only [...]. For simple propositional goals, try aesop.",
  missing_lemma:
    "The lemma you referenced doesn't exist. State it as a local `have` lemma, or search for the correct Mathlib name. Batteries provides additional lemmas under Batteries.* namespace.",
  scope_error:
    "The variable is not in scope. Check if you need to introduce it with `intro`, `obtain`, or `cases`.",
  syntax_error:
    "Fix the Lean syntax. Check parentheses, commas, keyword spelling, and indentation.",
  timeout:
    "Lean timed out. Simplify the step: break into smaller sub-goals, use more direct tactics, restrict simp set with `simp only [...]`. Avoid aesop on complex arithmetic goals.",
};


// ── Whole-proof prompts (prover role: complete proof in one shot) ─────

export const WHOLE_PROOF_SYSTEM = `You are an expert Lean 4 + Mathlib prover. You receive a theorem statement with \`sorry\` and must produce a COMPLETE, machine-checkable proof.

Output format — nothing else:
\`\`\`lean
theorem <name> <exactly the given statement> := by
  <tactics>
\`\`\`
Copy the statement verbatim (it is checked against the validated formalization; changing it fails). No imports, no \`open\`, no comments outside the block, no explanation. You may prepend \`open Nat Real in\` as the first tactic line if you need short names.

${LEAN4_PITFALLS}

Method:
1. Read the goal state (hypotheses, ⊢). Decide the proof at the informal level first (the sketch, when given, is a hint, not a script).
2. Prefer decisive automation: \`omega\` / \`norm_num\` / \`ring\` / \`linarith\` / \`nlinarith [sq_nonneg (a - b), …]\` / \`positivity\` / \`simp\` / \`decide\` / \`aesop\`. Give \`nlinarith\` helpful products and squares as hints.
3. Structure only when needed: \`intro\`, \`rcases\`/\`obtain\`, \`constructor\`, \`refine\`, \`induction … with\`, \`calc\`, \`have h : … := by …\`.
4. When a previous attempt and Lean's errors are shown, fix exactly the reported problem; if Lean's library search offers a tactic ("closes the goal"), use it verbatim.

Example:
\`\`\`lean
theorem ex1 (a b : ℕ) (h : a ≤ b) : a * a ≤ b * b := by
  exact Nat.mul_le_mul h h
\`\`\`
Example:
\`\`\`lean
theorem ex2 (x y : ℝ) : x * y ≤ (x ^ 2 + y ^ 2) / 2 := by
  nlinarith [sq_nonneg (x - y)]
\`\`\`
Example:
\`\`\`lean
theorem ex3 (n : ℕ) : ∑ i ∈ Finset.range (n + 1), (2 * i + 1) = (n + 1) ^ 2 := by
  induction n with
  | zero => simp
  | succ k ih =>
    rw [Finset.sum_range_succ, ih]
    ring
\`\`\``;

/**
 * User message for the first whole-proof round.
 */
export function wholeProofUserMessage(args: {
  theoremName: string;
  theoremType: string;
  goalState?: string;
  problemText?: string;
  sketch?: string;
  /** Retrieved premises / remembered proofs (prompt block). */
  premises?: string;
}): string {
  const parts: string[] = [];
  parts.push(`Prove the following theorem in Lean 4 with Mathlib.\n\n\`\`\`lean\ntheorem ${args.theoremName} ${args.theoremType} := by\n  sorry\n\`\`\``);
  if (args.goalState) {
    parts.push(`Initial goal state (from Lean):\n\`\`\`\n${args.goalState}\n\`\`\``);
  }
  if (args.problemText) {
    parts.push(`Original problem (natural language): ${args.problemText}`);
  }
  if (args.sketch) {
    parts.push(`Informal proof sketch (a hint; verify each step formally):\n${args.sketch}`);
  }
  if (args.premises) parts.push(args.premises);
  parts.push("Return the complete theorem with its proof in one ```lean block.");
  return parts.join("\n\n");
}

/**
 * User message for a repair round: previous attempt + Lean feedback.
 */
export function wholeProofRepairMessage(args: {
  theoremName: string;
  theoremType: string;
  previousTactics: string;
  feedback: string;
  suggestions?: string;
  round: number;
}): string {
  const parts: string[] = [];
  parts.push(`Repair round ${args.round}. Your previous proof of\n\`\`\`lean\ntheorem ${args.theoremName} ${args.theoremType} := by\n  sorry\n\`\`\`\nwas:\n\`\`\`lean\ntheorem ${args.theoremName} ${args.theoremType} := by\n${indentBlock(args.previousTactics)}\n\`\`\``);
  parts.push(`Lean's verdict:\n${args.feedback}`);
  if (args.suggestions) parts.push(args.suggestions);
  parts.push("Write a corrected complete proof. Keep the statement verbatim, fix the reported errors (do not repeat a failing tactic unchanged), and close every goal. Return one ```lean block.");
  return parts.join("\n\n");
}

function indentBlock(s: string): string {
  return s
    .split("\n")
    .map((l) => (l.trim().length ? `  ${l}` : l))
    .join("\n");
}

// ── Goal-level tactic step (tactic mode search) ───────────────────────

export const TACTIC_STEP_SYSTEM = `You are a Lean 4 + Mathlib tactic expert working goal by goal, like a person in the infoview.
You are shown the current goal (hypotheses and ⊢), the tactics already applied, and tactics that already FAILED at this goal.
Reply with exactly ONE tactic on ONE line — no explanation, no code fence, no leading \`by\`. It is applied to the first goal.
Rules:
- Prefer a finishing tactic when the goal looks closable: omega, norm_num, linarith, nlinarith [sq_nonneg (a - b), …], positivity, ring, simp, simp_all, decide, aesop, exact <lemma> ….
- Otherwise make real structural progress: intro x hx / rcases h with ⟨x, hx⟩ / obtain ⟨x, hx⟩ := h / constructor / refine ⟨?_, ?_⟩ / induction n with | zero => … | succ k ih => … / cases h with | inl h => … | inr h => … / by_contra h / push_neg at h / rw [lemma] / rw [lemma] at h / have h2 : P := by <tactic> / calc … (on one line).
- Several tactics may be combined on the line as (tac1; tac2) or tac1 <;> tac2.
- Never repeat a tactic listed as failed; never use sorry, admit, native_decide or exact?.

${LEAN4_PITFALLS}`;

export function tacticStepUserMessage(args: {
  theoremName: string;
  theoremType: string;
  goals: string[];
  history: string[];
  failed: string[];
  problemText?: string;
  premises?: string;
}): string {
  const parts: string[] = [];
  parts.push(`Theorem:\n\`\`\`lean\ntheorem ${args.theoremName} ${args.theoremType}\n\`\`\``);
  if (args.problemText) parts.push(`Informal statement: ${args.problemText}`);
  if (args.history.length) parts.push(`Tactics applied so far:\n${args.history.map((t, i) => `${i + 1}. ${t}`).join("\n")}`);
  parts.push(`Current goal (the tactic is applied to this one):\n\`\`\`\n${args.goals[0] ?? "(no goal)"}\n\`\`\``);
  if (args.goals.length > 1) parts.push(`${args.goals.length - 1} more goal(s) are waiting after this one.`);
  if (args.premises) parts.push(args.premises);
  if (args.failed.length) parts.push(`Tactics that FAILED on this goal (do not repeat):\n${args.failed.map((t) => `- ${t}`).join("\n")}`);
  parts.push("Next tactic:");
  return parts.join("\n\n");
}

// ── Proof sketch with holes (subgoal decomposition) ───────────────────

export const SKETCH_SYSTEM = `You are an expert Lean 4 + Mathlib prover writing a PROOF SKETCH: the complete structure of the proof where each nontrivial intermediate fact is stated as \`have name : <statement> := by sorry\` and the remaining steps use real tactics. Each \`sorry\` will be closed later by automation and search, so:
- Make every hole a SMALL, self-contained fact that is true in context (a single inequality, equation, membership, bound, case), with all needed hypotheses already in scope. At most 6 holes.
- Everything outside the holes must elaborate: introductions, case splits (rcases/obtain/induction … with), the final combination step (linarith/nlinarith [h1, h2]/omega/simp/exact/calc) — write those with real tactics, or use a final \`sorry\` only when the combination itself is hard.
- Copy the statement verbatim. No imports, no \`open\`, no comments outside the block.

Output exactly one block:
\`\`\`lean
theorem <name> <statement> := by
  <tactics with sorry holes>
\`\`\`

${LEAN4_PITFALLS}

Example:
\`\`\`lean
theorem ex (a b : ℝ) (ha : 0 < a) (hb : 0 < b) : 2 ≤ a / b + b / a := by
  have hab : 0 < a * b := mul_pos ha hb
  have key : 2 * (a * b) ≤ a ^ 2 + b ^ 2 := by sorry
  have h : a / b + b / a = (a ^ 2 + b ^ 2) / (a * b) := by sorry
  rw [h, le_div_iff₀ hab]
  linarith
\`\`\``;

export function sketchUserMessage(args: {
  theoremName: string;
  theoremType: string;
  goalState?: string;
  problemText?: string;
  sketchHint?: string;
  previousErrors?: string;
  premises?: string;
}): string {
  const parts: string[] = [];
  parts.push(`Write a proof sketch with sorry holes for:\n\`\`\`lean\ntheorem ${args.theoremName} ${args.theoremType} := by\n  sorry\n\`\`\``);
  if (args.goalState) parts.push(`Initial goal state:\n\`\`\`\n${args.goalState}\n\`\`\``);
  if (args.problemText) parts.push(`Original problem: ${args.problemText}`);
  if (args.sketchHint) parts.push(`Informal proof idea (a hint):\n${args.sketchHint}`);
  if (args.premises) parts.push(args.premises);
  if (args.previousErrors) parts.push(`Your previous sketch did not elaborate. Lean said:\n${args.previousErrors}\nFix the structure (statements of the holes, tactic names, syntax) and write the sketch again.`);
  parts.push("Return the sketch in one ```lean block.");
  return parts.join("\n\n");
}

