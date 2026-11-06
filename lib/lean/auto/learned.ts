/**
 * Rules learned from proofs: a proof found by a model (or replayed from memory) is stored with
 * the statement's goal as Lean prints it (hypotheses and target), and becomes a finisher of the
 * tactic search: on a goal that is the same up to renaming — other names for the variables and
 * hypotheses (P / Q, U / α, h / hmem), hypotheses in another order, extra hypotheses — the proof
 * is replayed with the names substituted. Lean checks every replay; a wrong match only costs one
 * failed tactic.
 *
 * Kept in AUTO_LEARNED_PATH (default .data/auto-learned.json, at most AUTO_LEARNED_MAX rules,
 * default 500: the least used go first); AUTO_LEARN=off stops learning (the rules still apply).
 * `npm run auto:learn` learns from the proof memory's stored proofs.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isInaccessible, parseGoal, type GoalState, type Hyp } from "../geometry/goal";

export interface LearnedRule {
  id: string;
  /** the goal the proof starts from, as Lean printed it */
  goal: { hyps: Hyp[]; target: string };
  tactics: string;
  opens?: string[];
  source: string;
  strategy?: string;
  theorem?: string;
  learned_at: string;
  /** times a replay closed a goal */
  hits: number;
  tried: number;
}

interface LearnedFile {
  version: 1;
  rules: LearnedRule[];
}

export const learnedPath = () => process.env.AUTO_LEARNED_PATH ?? path.join(process.cwd(), ".data", "auto-learned.json");
const maxRules = () => Math.max(1, Number(process.env.AUTO_LEARNED_MAX ?? 500));
/** Longest proof worth replaying (characters). */
const MAX_TACTICS = 20_000;

// ── tokens and renaming ──

const TOKEN = /[\p{L}_][\p{L}\p{N}_'!?₀-₉ₐ-ₜ.]*|\d+(?:\.\d+)?|\s+|./gu;

export function tokens(s: string): string[] {
  return (s.match(TOKEN) ?? []).filter((t) => !/^\s+$/.test(t));
}

/** A token's local part: `P.natDegree` → `P` when P is local. */
function localBase(tok: string, locals: Set<string>): { base: string; rest: string } | undefined {
  if (locals.has(tok)) return { base: tok, rest: "" };
  const dot = tok.indexOf(".");
  if (dot > 0 && locals.has(tok.slice(0, dot))) return { base: tok.slice(0, dot), rest: tok.slice(dot) };
  return undefined;
}

const localsOf = (g: { hyps: Hyp[] }) => new Set(g.hyps.flatMap((h) => h.names).filter((n) => !isInaccessible(n)));

type Sigma = Map<string, string>;

/** Align two texts token by token, extending σ (locals of a → locals of b); undefined when they differ otherwise. */
function align(a: string, b: string, la: Set<string>, lb: Set<string>, sigma: Sigma, used: Set<string>): Sigma | undefined {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length !== tb.length) return undefined;
  const s = new Map(sigma);
  const u = new Set(used);
  for (let i = 0; i < ta.length; i++) {
    const x = localBase(ta[i], la);
    if (!x) {
      if (ta[i] !== tb[i]) return undefined;
      continue;
    }
    const y = localBase(tb[i], lb);
    if (!y || y.rest !== x.rest) return undefined;
    const prev = s.get(x.base);
    if (prev !== undefined) {
      if (prev !== y.base) return undefined;
    } else {
      if (u.has(y.base)) return undefined;
      s.set(x.base, y.base);
      u.add(y.base);
    }
  }
  return s;
}

/**
 * A renaming of the learned goal's names onto the current goal's: the targets align, and every
 * hypothesis of the learned goal (inaccessible instances apart) has a counterpart of the same
 * type under the renaming. Hypotheses of the current goal may be in another order or extra.
 */
export function matchGoal(learned: { hyps: Hyp[]; target: string }, current: GoalState): Sigma | undefined {
  const la = localsOf(learned);
  const lb = localsOf(current);
  const start = align(learned.target, current.target, la, lb, new Map(), new Set());
  if (!start) return undefined;
  const hyps = learned.hyps.filter((h) => h.names.some((n) => !isInaccessible(n)));
  const instances = learned.hyps.filter((h) => h.names.every((n) => isInaccessible(n)));
  const cands = current.hyps.filter((h) => h.names.some((n) => !isInaccessible(n)));
  const taken = new Set<number>();

  const go = (i: number, s: Sigma): Sigma | undefined => {
    if (i === hyps.length) return s;
    const h = hyps[i];
    for (let j = 0; j < cands.length; j++) {
      if (taken.has(j) || cands[j].names.length !== h.names.length) continue;
      const used = new Set(s.values());
      let s2: Sigma | undefined = new Map(s);
      for (let k = 0; k < h.names.length && s2; k++) {
        const prev = s2.get(h.names[k]);
        if (prev !== undefined) s2 = prev === cands[j].names[k] ? s2 : undefined;
        else if (used.has(cands[j].names[k])) s2 = undefined;
        else {
          s2.set(h.names[k], cands[j].names[k]);
          used.add(cands[j].names[k]);
        }
      }
      if (!s2) continue;
      const s3 = align(h.type, cands[j].type, la, lb, s2, new Set(s2.values()));
      if (!s3) continue;
      taken.add(j);
      const r = go(i + 1, s3);
      if (r) return r;
      taken.delete(j);
    }
    return undefined;
  };
  const sigma = go(0, start);
  if (!sigma) return undefined;
  // the instances the proof relies on implicitly ([Fintype α], [DecidableEq α]) must be there too
  for (const inst of instances) {
    const want = renameText(inst.type, sigma, la);
    if (!current.hyps.some((h) => h.type.replace(/\s+/g, " ").trim() === want.replace(/\s+/g, " ").trim())) return undefined;
  }
  return sigma;
}

/** The text with the learned goal's local names renamed (tokens only — not inside other names). */
export function renameText(text: string, sigma: Sigma, locals: Set<string>): string {
  if (![...sigma].some(([a, b]) => a !== b)) return text;
  return text.replace(TOKEN, (tok) => {
    const x = localBase(tok, locals);
    if (!x) return tok;
    const to = sigma.get(x.base);
    return to === undefined ? tok : to + x.rest;
  });
}

/**
 * The proof with the learned goal's names renamed; names the proof binds itself (`∀ S`, `fun p`,
 * `have e`) that a renamed name would collide with are renamed first (S → S_1).
 */
export function renameProof(text: string, sigma: Sigma, locals: Set<string>): string {
  const targets = new Set([...sigma].filter(([a, b]) => a !== b).map(([, b]) => b));
  if (!targets.size) return text;
  const own = new Set((text.match(TOKEN) ?? []).filter((t) => !localBase(t, locals)).map((t) => t.split(".")[0]));
  const clash = [...own].filter((t) => targets.has(t));
  let out = text;
  if (clash.length) {
    const taken = new Set([...own, ...targets, ...locals]);
    const fresh = new Map<string, string>();
    for (const c of clash) {
      let k = 1;
      while (taken.has(`${c}_${k}`)) k++;
      fresh.set(c, `${c}_${k}`);
      taken.add(`${c}_${k}`);
    }
    out = out.replace(TOKEN, (tok) => {
      if (localBase(tok, locals)) return tok;
      const dot = tok.indexOf(".");
      const base = dot > 0 ? tok.slice(0, dot) : tok;
      const to = fresh.get(base);
      return to === undefined ? tok : to + (dot > 0 ? tok.slice(dot) : "");
    });
  }
  return renameText(out, sigma, locals);
}

// ── the store ──

let cache: { path: string; mtime: number; file: LearnedFile } | undefined;

export function readLearned(p = learnedPath()): LearnedRule[] {
  try {
    if (!existsSync(p)) return [];
    const mtime = statSync(p).mtimeMs;
    if (cache && cache.path === p && cache.mtime === mtime) return cache.file.rules;
    const file = JSON.parse(readFileSync(p, "utf8")) as LearnedFile;
    const rules = file?.version === 1 && Array.isArray(file.rules) ? file.rules : [];
    cache = { path: p, mtime, file: { version: 1, rules } };
    return rules;
  } catch {
    return [];
  }
}

function writeLearned(rules: LearnedRule[], p = learnedPath()): void {
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, rules }, null, 1));
  renameSync(tmp, p);
  cache = undefined;
}

/** The goal with its names replaced by position: equal for goals that differ only by renaming. */
export function canonicalGoal(g: { hyps: Hyp[]; target: string }): string {
  const locals = localsOf(g);
  const sigma: Sigma = new Map();
  let k = 0;
  const visit = (s: string) => {
    for (const t of tokens(s)) {
      const x = localBase(t, locals);
      if (x && !sigma.has(x.base)) sigma.set(x.base, `v${k++}`);
    }
  };
  visit(g.target);
  for (const h of g.hyps) {
    for (const n of h.names) if (locals.has(n) && !sigma.has(n)) sigma.set(n, `v${k++}`);
    visit(h.type);
  }
  const hyps = g.hyps.map((h) => `${h.names.map((n) => sigma.get(n) ?? "_").join(" ")} : ${renameText(h.type, sigma, locals).replace(/\s+/g, " ")}`).sort();
  return [...hyps, `⊢ ${renameText(g.target, sigma, locals).replace(/\s+/g, " ")}`].join("\n");
}

/** Store a proof of a goal as a rule; false when it is not worth keeping or already known. */
export function addLearned(args: { goal: string; tactics: string; source: string; strategy?: string; theorem?: string; opens?: string[] }): boolean {
  const st = parseGoal(args.goal);
  const tactics = args.tactics.trim();
  if (!st || !tactics || tactics.length > MAX_TACTICS || /\bsorry\b|\badmit\b|#eval|\baxiom\b|\bunsafe\b/.test(tactics)) return false;
  const key = canonicalGoal(st) + "\n@" + (args.opens ?? []).join(" ");
  const id = createHash("sha256").update(key).digest("hex").slice(0, 12);
  const rules = [...readLearned()];
  if (rules.some((r) => r.id === id)) return false;
  rules.push({ id, goal: { hyps: st.hyps, target: st.target }, tactics, opens: args.opens?.length ? args.opens : undefined, source: args.source, strategy: args.strategy, theorem: args.theorem, learned_at: new Date().toISOString(), hits: 0, tried: 0 });
  // over the cap: drop the least useful (fewest hits, then oldest)
  while (rules.length > maxRules()) {
    let worst = 0;
    for (let i = 1; i < rules.length - 1; i++) if (rules[i].hits < rules[worst].hits || (rules[i].hits === rules[worst].hits && rules[i].learned_at < rules[worst].learned_at)) worst = i;
    rules.splice(worst, 1);
  }
  writeLearned(rules);
  return true;
}

/** Count replays (called by the search after it tried learned tactics). */
export function noteLearnedUse(counts: Map<string, { tried: number; hits: number }>): void {
  if (!counts.size) return;
  try {
    const rules = readLearned().map((r) => {
      const c = counts.get(r.id);
      return c ? { ...r, tried: r.tried + c.tried, hits: r.hits + c.hits } : r;
    });
    writeLearned(rules);
  } catch {
    // never stops a proof
  }
}

export interface LearnedTactic {
  tactic: string;
  id: string;
}

/** Replays of learned proofs whose goal is this one up to renaming. */
export function learnedTactics(st: GoalState, opens: string[] = []): LearnedTactic[] {
  const out: LearnedTactic[] = [];
  const have = new Set(opens);
  const targetShape = (t: string, locals: Set<string>) => tokens(t).filter((x) => !localBase(x, locals)).join(" ");
  const curShape = targetShape(st.target, localsOf(st));
  for (const r of readLearned()) {
    if ((r.opens ?? []).some((o) => !have.has(o))) continue;
    const la = localsOf(r.goal);
    if (targetShape(r.goal.target, la) !== curShape) continue;
    const sigma = matchGoal(r.goal, st);
    if (!sigma) continue;
    out.push({ tactic: renameProof(r.tactics, sigma, la), id: r.id });
  }
  return out;
}

/** Strategies whose proofs the program finds again by itself: nothing to learn from them. */
const PROGRAM_STRATEGIES = new Set(["auto", "geometry", "induction", "optimize", "combinatorics", "order", "bounded", "hammer", "trivial"]);

export function worthLearning(strategy: string | undefined, source: string | undefined): boolean {
  if (process.env.AUTO_LEARN === "off") return false;
  if (source?.startsWith("bench:")) return false;
  return !PROGRAM_STRATEGIES.has(strategy ?? "");
}

/**
 * Learn from a verified proof: open the statement to read its goal as Lean prints it, then
 * store the rule. Quiet: a failure only means nothing was learned.
 */
export async function learnFromProof(args: { theoremName: string; theoremType: string; tactics: string; strategy?: string; source?: string; opens?: string[]; force?: boolean }): Promise<boolean> {
  if (!args.force && !worthLearning(args.strategy, args.source)) return false;
  try {
    const { openRunner } = await import("../tactic-runner");
    const opened = await openRunner({ theoremName: args.theoremName, theoremType: args.theoremType, useMathlib: true, opens: args.opens, timeLimitMs: 60_000, tacticTimeoutMs: 30_000, label: "learn" });
    if (typeof opened === "string") return false;
    try {
      const goal = opened.run.goals()[0];
      return goal ? addLearned({ goal, tactics: args.tactics, source: args.source ?? "solve", strategy: args.strategy, theorem: args.theoremName, opens: args.opens }) : false;
    } finally {
      opened.session.close();
    }
  } catch {
    return false;
  }
}
