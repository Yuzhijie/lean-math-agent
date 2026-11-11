/**
 * One problem of an end-to-end run, as measured from outside the product: what `/api/solve`
 * (with the Lean step) and `/api/lean-attempt` answered, reduced to the funnel
 *
 *     answer right → statement accepted → proved in Lean
 *
 * `solved` (the headline) needs the Lean proof and, where a value was asked for, the right
 * answer; a proof next to a wrong answer is counted apart — it means the statement that was
 * proved is not the problem.
 */
import { matchAnswer } from "./answer-match";
import type { HeldoutProblem } from "./heldout";

/** The strategies the program runs without a model (lib/pipeline/lean-attempt.ts proveWithoutModel). */
export const PROGRAM_STRATEGIES = new Set(["trivial", "hammer", "order", "bounded", "geometry", "induction", "optimize", "combinatorics", "auto"]);

export interface EvalRow {
  id: string;
  split: "dev" | "test";
  topic: string;
  kind: "find" | "prove";
  level: number;
  seen_family: boolean;
  /** error = no verdict (the server could not be reached, failed or timed out); such rows are run again once. */
  status: "done" | "error";
  error?: string;
  /** How the product classified the problem. */
  problem_type?: string;
  /** The product's answer (problems that ask for a value). */
  answer?: string;
  /** Right / wrong; null when the program could not compare the forms, or nothing was asked for. */
  answer_ok: boolean | null;
  lean_attempted: boolean;
  /** A Lean statement passed every check. */
  formalized: boolean;
  proved: boolean;
  /** How the proof was found. */
  strategy?: string;
  /** The accepted statement (kept for later re-checks). */
  statement?: string;
  /** Why there is no proof (the product's own words, cut short). */
  failure?: string;
  ms: number;
  cost_usd?: number;
  llm_calls?: number;
  models?: string[];
  /** Run a second time after an error (the row is the second attempt). */
  retried?: boolean;
  session_id?: string;
}

/** Proved in Lean, with the right answer where one was asked for. */
export function solved(r: EvalRow): boolean {
  return r.status === "done" && r.proved && (r.kind === "prove" || r.answer_ok === true);
}

/** Where a problem stopped. */
export type Stop = "solved" | "proved_wrong_answer" | "proved_unchecked_answer" | "wrong_answer" | "not_formalized" | "not_proved" | "no_lean" | "error";

export function stopOf(r: EvalRow): Stop {
  if (r.status === "error") return "error";
  if (solved(r)) return "solved";
  if (r.proved) return r.answer_ok === false ? "proved_wrong_answer" : "proved_unchecked_answer";
  if (r.kind === "find" && r.answer_ok === false) return "wrong_answer";
  if (!r.lean_attempted) return "no_lean";
  return r.formalized ? "not_proved" : "not_formalized";
}

interface Json {
  [k: string]: unknown;
}

export interface Capture {
  /** `/api/solve` */
  solve?: { status: number; body: Json };
  /** the session afterwards (`/api/session/:id`): metrics, stored answer, formal_validated */
  session?: Json;
  /** `/api/lean-attempt`, when the solve left the Lean step to be started by hand */
  lean?: { status: number; body: Json };
  ms: number;
  /** a transport failure (no response) */
  error?: string;
}

const obj = (x: unknown): Json | undefined => (x && typeof x === "object" && !Array.isArray(x) ? (x as Json) : undefined);
const str = (x: unknown): string | undefined => (typeof x === "string" && x.trim() ? x.trim() : undefined);
const num = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) ? x : undefined);

function cut(s: string | undefined, n: number): string | undefined {
  if (!s) return undefined;
  const t = s.replace(/\s+\n/g, "\n").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** The row of one problem from what the server answered. */
export function rowOf(p: HeldoutProblem, c: Capture): EvalRow {
  const base = { id: p.id, split: p.split, topic: p.topic, kind: p.kind, level: p.level, seen_family: p.seen_family, ms: Math.round(c.ms) };
  const failed = (error: string): EvalRow => ({ ...base, status: "error", error: cut(error, 400), answer_ok: null, lean_attempted: false, formalized: false, proved: false });
  if (c.error) return failed(c.error);
  if (!c.solve) return failed("no response");
  const body = c.solve.body;
  const session = c.session ?? {};
  const st = c.solve.status;
  // 422 = the statement was rejected, 504 = the solve's own time limit: verdicts of the product, not errors
  if (st !== 200 && st !== 422 && st !== 504) return failed(`solve: HTTP ${st}${str(body.error) ? ` ${str(body.error)}` : ""}${str(body.detail) ? ` — ${str(body.detail)}` : ""}`);

  const metrics = [obj(session.metrics), obj(c.lean?.body.metrics)].filter((m): m is Json => !!m);
  const costs = metrics.map((m) => num(m.estimated_cost)).filter((x): x is number => x !== undefined);
  const models = [...new Set(metrics.flatMap((m) => Object.keys(obj(m.by_model) ?? {})))];
  const usage = {
    ...(costs.length ? { cost_usd: Math.round(costs.reduce((a, b) => a + b, 0) * 1e6) / 1e6 } : {}),
    ...(metrics.length ? { llm_calls: metrics.reduce((a, m) => a + (num(m.llm_calls) ?? 0), 0) } : {}),
    ...(models.length ? { models } : {}),
    ...(str(body.session_id) ?? str(session.id) ? { session_id: str(body.session_id) ?? str(session.id) } : {}),
  };

  const computed = obj(session.computation_result);
  const nl = obj(body.nl_solution) ?? obj(session.nl_solution);
  const answer = str(body.answer) ?? str(computed?.answer) ?? str(nl?.final_answer);
  const decimal = str(body.answer_decimal) ?? str(computed?.answer_decimal);
  const answerOk = p.kind === "find" ? (matchAnswer(p, answer, decimal) ?? null) : null;

  const leanBody = c.lean && c.lean.status === 200 ? obj(c.lean.body.lean_proof_attempt) : undefined;
  const attempt = leanBody ?? obj(body.lean_proof_attempt) ?? obj(session.lean_proof_attempt) ?? {};
  const proved = attempt.success === true || body.fully_verified === true;
  const formalized = proved || attempt.statement_accepted === true || session.formal_validated === true;
  const leanError = c.lean && c.lean.status !== 200 ? `lean-attempt: HTTP ${c.lean.status}${str(c.lean.body.error) ? ` ${str(c.lean.body.error)}` : ""}` : undefined;
  const why = proved
    ? undefined
    : [st === 504 ? "time limit" : undefined, leanError, str(attempt.failure_reason), ...(Array.isArray(attempt.limitations) ? attempt.limitations.map(str) : []), str(body.failure_reason), str(body.detail), st === 422 ? str(body.error) : undefined]
        .filter((x): x is string => !!x)
        .filter((x, i, a) => a.indexOf(x) === i)
        .join("\n");

  return {
    ...base,
    status: "done",
    problem_type: str(body.problem_type) ?? str(session.problem_type) ?? (str(session.theorem_type) || st === 422 ? "theorem" : undefined),
    ...(p.kind === "find" && answer ? { answer: cut(answer, 300) } : {}),
    answer_ok: answerOk,
    lean_attempted: attempt.attempted === true || proved || st === 422,
    formalized,
    proved,
    ...(str(attempt.strategy) ? { strategy: str(attempt.strategy) } : {}),
    ...(formalized && (str(attempt.formal_statement) ?? str(session.formal_statement)) ? { statement: cut(str(attempt.formal_statement) ?? str(session.formal_statement), 6000) } : {}),
    ...(why ? { failure: cut(why, 1500) } : {}),
    ...usage,
  };
}

/** Whether the Lean step still has to be started by hand after this solve (as the user would, from the Lean tab). */
export function needsLeanAttempt(solve: { status: number; body: Json } | undefined): boolean {
  if (!solve || solve.status !== 200) return false;
  const a = obj(solve.body.lean_proof_attempt);
  if (solve.body.fully_verified === true) return false;
  return !a || (a.attempted !== true && a.success !== true);
}

// ── a run on disk: one JSON line per record ──────────────────────────────────────────────────

export interface RunMeta {
  type: "run";
  at: string;
  set: string;
  set_hash: string;
  set_size: number;
  /** how many problems this run was asked to cover */
  selected: number;
  base: string;
  commit?: string;
  lean: boolean;
  args: string[];
}

export interface RunFile {
  file: string;
  meta: RunMeta;
  rows: EvalRow[];
  /** total wall time, when the run reached its end */
  ended?: { at: string; wall_ms: number; stopped?: string };
}

/** Read a run (JSON lines: the run record, the rows as they finished, the end record). A later row of the same id replaces the earlier one. */
export function parseRun(file: string, text: string): RunFile | undefined {
  let meta: RunMeta | undefined;
  let ended: RunFile["ended"];
  const rows = new Map<string, EvalRow>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec: Json;
    try {
      rec = JSON.parse(line) as Json;
    } catch {
      continue; // a line cut off by a crash
    }
    if (rec.type === "run") meta ??= rec as unknown as RunMeta;
    else if (rec.type === "end") ended = { at: String(rec.at), wall_ms: Number(rec.wall_ms) || 0, ...(str(rec.stopped) ? { stopped: str(rec.stopped) } : {}) };
    else if (typeof rec.id === "string") rows.set(rec.id, rec as unknown as EvalRow);
  }
  return meta ? { file, meta, rows: [...rows.values()], ended } : undefined;
}
