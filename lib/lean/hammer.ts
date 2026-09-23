/**
 * The automation "hammer": a cascade of decision procedures and finishing
 * tactics tried on a proof state before any language model is asked.
 *
 * Competition-style subgoals are very often closable by `omega`, `simp`,
 * `norm_num`, `linarith`, `nlinarith` with the right square/product hints,
 * `positivity`, `ring`, `decide`, `aesop` or a library lemma (`exact?`).
 * Each attempt is a single tactic-mode command (milliseconds, no
 * re-elaboration), so trying a dozen of them costs less than one LLM call.
 *
 * Hints for `nlinarith` are generated from the goal: squares of the
 * differences/sums of numeric variables and products of positivity
 * hypotheses — the standard trick for AM-GM-style inequalities.
 */
import type { ProofSession, TacticOutcome } from "./proof-state";
import { parseTryThis } from "./suggest";

export interface HammerOptions {
  useMathlib: boolean;
  /** Wall-clock budget for the whole cascade (default LEAN_HAMMER_BUDGET_MS or 30 s). */
  budgetMs?: number;
  /** Override the tactic list (hint generation still applies to `nlinarith`). */
  tactics?: string[];
}

export interface HammerAttempt {
  tactic: string;
  ok: boolean;
  solved: boolean;
  goalsLeft: number;
  error?: string;
  ms: number;
}

export interface HammerOutcome {
  /** A tactic closed every goal of the state. */
  solved: boolean;
  /** The closing tactic (an `exact?` hit is replaced by its suggestion). */
  tactic?: string;
  /** Resulting state handle when solved. */
  state?: number;
  /** Best partial result: the attempt that left the fewest goals (> 0). */
  progressed?: { tactic: string; state: number; goals: string[] };
  attempts: HammerAttempt[];
  durationMs: number;
}

const NUMERIC_TYPES = new Set(["ℝ", "ℚ", "ℤ", "ℕ", "Real", "Rat", "Int", "Nat"]);
const ORDERED_FIELD_TYPES = new Set(["ℝ", "ℚ", "Real", "Rat"]);

interface GoalShape {
  vars: Array<{ name: string; type: string }>;
  positive: string[]; // hypothesis names of `0 < x` / `x > 0`
  nonneg: string[]; // hypothesis names of `0 ≤ x` / `x ≥ 0`
  target: string;
  binders: boolean; // target starts with ∀ / → (intro first)
  hasDivision: boolean;
  isEquation: boolean;
  isInequality: boolean;
  field: boolean; // some variable lives in an ordered field
}

/** Parse the pretty-printed goal (`x y : ℝ`, `hx : 0 < x`, …, `⊢ target`). */
export function goalShape(goal: string): GoalShape {
  const lines = goal.split("\n").map((l) => l.trim()).filter((l) => l && !/^case\b/.test(l));
  const targetIdx = lines.findIndex((l) => l.startsWith("⊢"));
  const hyps = targetIdx >= 0 ? lines.slice(0, targetIdx) : lines;
  const target = targetIdx >= 0 ? lines.slice(targetIdx).join("\n").replace(/^⊢\s*/, "") : "";
  const vars: GoalShape["vars"] = [];
  const positive: string[] = [];
  const nonneg: string[] = [];
  for (const h of hyps) {
    const m = h.match(/^([^:]+?)\s*:\s*(.+)$/);
    if (!m) continue;
    const names = m[1].trim().split(/\s+/);
    const type = m[2].trim();
    if (NUMERIC_TYPES.has(type)) {
      for (const n of names) if (/^[A-Za-z_][\w']*$/.test(n)) vars.push({ name: n, type });
      continue;
    }
    if (names.length === 1) {
      if (/^0\s*<\s*\S+$/.test(type) || /^\S+\s*>\s*0$/.test(type)) positive.push(names[0]);
      else if (/^0\s*≤\s*\S+$/.test(type) || /^\S+\s*≥\s*0$/.test(type)) nonneg.push(names[0]);
    }
  }
  return {
    vars,
    positive,
    nonneg,
    target,
    binders: /^∀/.test(target) || /→/.test(target),
    hasDivision: target.includes("/"),
    isEquation: /(^|[^<>≤≥≠!])=(?![>=])/.test(target) && !/[<>≤≥]/.test(target),
    isInequality: /[<>≤≥]/.test(target),
    field: vars.some((v) => ORDERED_FIELD_TYPES.has(v.type)),
  };
}

/** `nlinarith` hint terms for a goal (at most `max`). */
export function nlinarithHints(shape: GoalShape, max = 8): string[] {
  const hints: string[] = [];
  const nums = shape.vars.filter((v) => v.type !== "ℕ" && v.type !== "Nat");
  for (let i = 0; i < nums.length && hints.length < max; i++) {
    for (let j = i + 1; j < nums.length && hints.length < max; j++) {
      hints.push(`sq_nonneg (${nums[i].name} - ${nums[j].name})`);
      if (hints.length < max) hints.push(`sq_nonneg (${nums[i].name} + ${nums[j].name})`);
    }
  }
  for (const v of nums) if (hints.length < max) hints.push(`sq_nonneg ${v.name}`);
  const pos = shape.positive;
  for (let i = 0; i < pos.length && hints.length < max; i++) {
    for (let j = i; j < pos.length && hints.length < max; j++) hints.push(`mul_pos ${pos[i]} ${pos[j]}`);
  }
  const nn = shape.nonneg;
  for (let i = 0; i < nn.length && hints.length < max; i++) {
    for (let j = i; j < nn.length && hints.length < max; j++) hints.push(`mul_nonneg ${nn[i]} ${nn[j]}`);
  }
  return hints;
}

/** Ordered tactic candidates for a goal. Cheap and likely first. */
export function hammerCandidates(goal: string, useMathlib: boolean): string[] {
  const shape = goalShape(goal);
  const intro = shape.binders ? "intros; " : "";
  const wrap = (t: string) => (intro ? `(${intro}${t})` : t);
  const out: string[] = [];
  const push = (t: string) => {
    if (!out.includes(t)) out.push(t);
  };

  push("rfl");
  push("decide");
  push(wrap("simp"));
  push(wrap("simp_all"));
  push(wrap("omega"));
  if (!useMathlib) {
    push(wrap("trivial"));
    push(wrap("simp_arith"));
    push("exact?");
    return out;
  }
  push(wrap("norm_num"));
  if (shape.isEquation) {
    push(wrap("ring"));
    if (shape.hasDivision) push(wrap("(field_simp; ring)"));
    push(wrap("(norm_num; ring)"));
  }
  if (shape.isInequality || shape.field || shape.positive.length || shape.nonneg.length) {
    push(wrap("linarith"));
    push(wrap("positivity"));
    const hints = nlinarithHints(shape);
    if (hints.length) push(wrap(`nlinarith [${hints.join(", ")}]`));
    push(wrap("nlinarith"));
    if (shape.hasDivision) push(wrap("(field_simp; nlinarith)"));
  }
  push(wrap("(simp_all; omega)"));
  push(wrap("(norm_num; omega)"));
  push(wrap("aesop"));
  push("exact?");
  return out;
}

/**
 * Try the cascade on `state`. Stops at the first tactic that closes every
 * goal; otherwise reports the attempt that left the fewest goals.
 */
export async function hammer(session: ProofSession, state: number, opts: HammerOptions): Promise<HammerOutcome> {
  const started = Date.now();
  const budget = opts.budgetMs ?? Number(process.env.LEAN_HAMMER_BUDGET_MS ?? 30_000);
  const goals = session.goals(state);
  const first = goals[0] ?? "";
  const candidates = opts.tactics ?? hammerCandidates(first, opts.useMathlib);
  const attempts: HammerAttempt[] = [];
  let progressed: HammerOutcome["progressed"];

  for (const tactic of candidates) {
    if (Date.now() - started > budget) break;
    const r = await session.apply(state, tactic);
    attempts.push(summarize(tactic, r));
    if (!r.ok) continue;
    if (r.solved) {
      const closing = await resolveSuggestion(session, state, tactic, r);
      return { solved: true, tactic: closing.tactic, state: closing.state, attempts, durationMs: Date.now() - started };
    }
    if (r.goals.length > 0 && r.goals.length < goals.length && (!progressed || r.goals.length < progressed.goals.length)) {
      progressed = { tactic, state: r.state, goals: r.goals };
    }
  }
  return { solved: false, progressed, attempts, durationMs: Date.now() - started };
}

/** Replace an `exact?` hit by the concrete suggestion (re-applied to be sure). */
async function resolveSuggestion(
  session: ProofSession,
  state: number,
  tactic: string,
  r: Extract<TacticOutcome, { ok: true }>,
): Promise<{ tactic: string; state: number }> {
  if (!/\?\s*$/.test(tactic)) return { tactic, state: r.state };
  const suggestion = parseTryThis(r.infos)[0]?.tactic;
  if (!suggestion) return { tactic, state: r.state };
  const again = await session.apply(state, suggestion);
  if (again.ok && again.solved) return { tactic: suggestion, state: again.state };
  return { tactic, state: r.state };
}

/**
 * Whole-theorem entry point: open `theorem name type := by sorry`, run the
 * cascade on the root goal and, on success, return the closing tactic. The
 * caller assembles and strictly verifies the result. Undefined when Lean /
 * the REPL is unavailable or the statement does not elaborate.
 */
export async function hammerTheorem(
  source: string,
  opts: HammerOptions,
): Promise<{ tactic: string; attempts: HammerAttempt[]; durationMs: number } | undefined> {
  const { openTheorem } = await import("./proof-state");
  let opened: Awaited<ReturnType<typeof openTheorem>>;
  try {
    opened = await openTheorem(source);
  } catch {
    return undefined;
  }
  if (!opened) return undefined;
  const { session, root } = opened;
  try {
    const out = await hammer(session, root.state, opts);
    return out.solved && out.tactic ? { tactic: out.tactic, attempts: out.attempts, durationMs: out.durationMs } : undefined;
  } finally {
    session.close();
  }
}

function summarize(tactic: string, r: TacticOutcome): HammerAttempt {
  return r.ok
    ? { tactic, ok: true, solved: r.solved, goalsLeft: r.goals.length, ms: r.durationMs }
    : { tactic, ok: false, solved: false, goalsLeft: -1, error: r.error.split("\n")[0].slice(0, 200), ms: r.durationMs };
}
