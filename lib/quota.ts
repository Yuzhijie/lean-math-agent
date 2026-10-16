/**
 * Per-user quotas and rate limits for solves.
 *
 * - Plan limits (lib/payments/stripe.ts PLANS): solves per month (`proofsPerMonth`, -1 = unlimited)
 *   and solves at once (`concurrentSolvers`, used as the job limit). The plan comes from the user's
 *   active subscription; signed-in users without one are on "free".
 * - Daily spend (optional): QUOTA_DAILY_USD_FREE / _PRO / _ENTERPRISE, in the LLM_PRICES currency.
 *   What is left today also caps the cost of the run (with PROOF_COST_CAP_USD).
 * - Rate limit: at most RATE_LIMIT_PER_MIN solve starts per minute per user (default 6), and
 *   RATE_LIMIT_CALLS_PER_MIN calls of the other model routes (default 30; admitCall).
 * - Spend: every model call made for a user is charged to them as it happens (withOwnerBilling →
 *   usage-tracker billing), streaming routes included; what is left of today's limit stops new calls.
 *
 * The local single user (no sign-in, owner "local") is not limited unless QUOTA_LOCAL_PLAN names a
 * plan for it. Usage is counted in SQLite (QUOTA_DB_PATH, default .data/usage.db), in memory when
 * better-sqlite3 cannot be loaded.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { PLANS } from "./payments/stripe";
import { withBilling } from "./llm/usage-tracker";

export interface QuotaStatus {
  plan: string;
  /** Solves started this month, and the plan's monthly limit (-1 = unlimited). */
  monthSolves: number;
  monthLimit: number;
  /** Spent today, and the plan's daily limit (undefined = none). */
  dayCost: number;
  dayLimit?: number;
  /** Solves the plan allows at once (-1 = unlimited). */
  concurrent: number;
  /** Not limited at all (the local single user). */
  unlimited: boolean;
}

export interface QuotaCheck extends QuotaStatus {
  ok: boolean;
  /** Why not (when !ok); a 429 for the client. */
  reason?: string;
  /** Spend left today, to cap the run's cost (undefined = no daily limit). */
  remainingUsd?: number;
}

// ── Storage ──────────────────────────────────────────────────────────

interface UsageStore {
  get(owner: string, period: string): { solves: number; cost: number };
  add(owner: string, period: string, solves: number, cost: number): void;
}

let usage: UsageStore | null = null;
let usageInit: Promise<UsageStore> | null = null;

function memoryStore(): UsageStore {
  const m = new Map<string, { solves: number; cost: number }>();
  return {
    get: (o, p) => m.get(`${o}\u0000${p}`) ?? { solves: 0, cost: 0 },
    add: (o, p, s, c) => {
      const k = `${o}\u0000${p}`;
      const cur = m.get(k) ?? { solves: 0, cost: 0 };
      m.set(k, { solves: cur.solves + s, cost: cur.cost + c });
    },
  };
}

async function store(): Promise<UsageStore> {
  if (usage) return usage;
  usageInit ??= (async () => {
    try {
      const Database = (await import("better-sqlite3")).default;
      const file = process.env.QUOTA_DB_PATH ?? ".data/usage.db";
      await fs.mkdir(path.dirname(file), { recursive: true });
      const db = new Database(file);
      db.pragma("journal_mode = WAL");
      db.exec(`CREATE TABLE IF NOT EXISTS usage (owner TEXT NOT NULL, period TEXT NOT NULL, solves INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, PRIMARY KEY (owner, period))`);
      const get = db.prepare(`SELECT solves, cost FROM usage WHERE owner = ? AND period = ?`);
      const add = db.prepare(`INSERT INTO usage (owner, period, solves, cost) VALUES (?, ?, ?, ?) ON CONFLICT(owner, period) DO UPDATE SET solves = solves + excluded.solves, cost = cost + excluded.cost`);
      usage = {
        get: (o, p) => (get.get(o, p) as { solves: number; cost: number } | undefined) ?? { solves: 0, cost: 0 },
        add: (o, p, s, c) => void add.run(o, p, s, c),
      };
    } catch {
      usage = memoryStore();
    }
    return usage;
  })();
  return usageInit;
}

export function _resetQuotaForTests(mem = true): void {
  usage = mem ? memoryStore() : null;
  usageInit = null;
  buckets.clear();
}

const month = (d = new Date()) => d.toISOString().slice(0, 7);
const day = (d = new Date()) => d.toISOString().slice(0, 10);

// ── Plans ────────────────────────────────────────────────────────────

/** The owner's plan id: the active subscription's, "free" for other signed-in users; null = unlimited. */
async function planOf(owner: string): Promise<string | null> {
  if (owner === "local") return process.env.QUOTA_LOCAL_PLAN || null;
  try {
    const { prisma } = await import("./db");
    const sub = await prisma.subscription.findUnique({ where: { userId: owner } });
    if (sub && sub.status === "active" && PLANS[sub.plan]) return sub.plan;
  } catch {
    // no database: treat as free
  }
  return "free";
}

function dailyLimit(plan: string): number | undefined {
  const v = Number(process.env[`QUOTA_DAILY_USD_${plan.toUpperCase()}`]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

export async function quotaStatus(owner: string): Promise<QuotaStatus> {
  const plan = await planOf(owner);
  const s = await store();
  const m = s.get(owner, month());
  const d = s.get(owner, day());
  if (plan === null) return { plan: "local", monthSolves: m.solves, monthLimit: -1, dayCost: d.cost, concurrent: -1, unlimited: true };
  const limits = PLANS[plan]?.limits ?? PLANS.free.limits;
  return { plan, monthSolves: m.solves, monthLimit: limits.proofsPerMonth, dayCost: d.cost, dayLimit: dailyLimit(plan), concurrent: limits.concurrentSolvers, unlimited: false };
}

// ── Rate limit (token bucket per owner, in memory) ───────────────────

const buckets = new Map<string, { tokens: number; at: number }>();

function rateLimited(owner: string, perMinRaw: string | undefined = process.env.RATE_LIMIT_PER_MIN, dflt = 6): boolean {
  const perMin = Number(perMinRaw ?? dflt);
  if (!(perMin > 0)) return false;
  const now = Date.now();
  const b = buckets.get(owner) ?? { tokens: perMin, at: now };
  b.tokens = Math.min(perMin, b.tokens + ((now - b.at) / 60_000) * perMin);
  b.at = now;
  if (b.tokens < 1) {
    buckets.set(owner, b);
    return true;
  }
  b.tokens -= 1;
  buckets.set(owner, b);
  return false;
}

/**
 * May `owner` start a solve now? Counts the start (rate limit and monthly solves) when it may.
 * `lt` picks the message language (server code passes output-locale's).
 */
export async function admitSolve(owner: string, lt: (zh: string, en: string) => string = (_zh, en) => en): Promise<QuotaCheck> {
  const st = await quotaStatus(owner);
  if (st.unlimited) return { ...st, ok: true };
  if (st.monthLimit >= 0 && st.monthSolves >= st.monthLimit)
    return { ...st, ok: false, reason: lt(`本月 ${st.monthLimit} 次求解已用完（${st.plan} 套餐）`, `This month's ${st.monthLimit} solves are used up (${st.plan} plan)`) };
  if (st.dayLimit !== undefined && st.dayCost >= st.dayLimit)
    return { ...st, ok: false, reason: lt(`今天的费用额度 $${st.dayLimit} 已用完`, `Today's spend limit of $${st.dayLimit} is used up`) };
  if (rateLimited(owner)) return { ...st, ok: false, reason: lt("求解太频繁，请一分钟后再试", "Too many solves; try again in a minute") };
  (await store()).add(owner, month(), 1, 0);
  return { ...st, monthSolves: st.monthSolves + 1, ok: true, ...(st.dayLimit !== undefined ? { remainingUsd: Math.max(0, st.dayLimit - st.dayCost) } : {}) };
}

/**
 * May `owner` call a model route other than a solve now (formalize, plan, figure, read an image,
 * bank import/generation, …)? Checks today's spend limit and RATE_LIMIT_CALLS_PER_MIN (default 30);
 * does not count as a solve.
 */
export async function admitCall(owner: string, lt: (zh: string, en: string) => string = (_zh, en) => en): Promise<QuotaCheck> {
  const st = await quotaStatus(owner);
  if (st.unlimited) return { ...st, ok: true };
  if (st.dayLimit !== undefined && st.dayCost >= st.dayLimit)
    return { ...st, ok: false, reason: lt(`今天的费用额度 $${st.dayLimit} 已用完`, `Today's spend limit of $${st.dayLimit} is used up`) };
  if (rateLimited(`${owner}\u0000call`, process.env.RATE_LIMIT_CALLS_PER_MIN, 30))
    return { ...st, ok: false, reason: lt("操作太频繁，请稍后再试", "Too many requests; try again shortly") };
  return { ...st, ok: true, ...(st.dayLimit !== undefined ? { remainingUsd: Math.max(0, st.dayLimit - st.dayCost) } : {}) };
}

/** Run `fn` with every model call in it charged to `owner` as it happens; stops new calls past today's remaining budget. */
export function withOwnerBilling<T>(owner: string, check: Pick<QuotaCheck, "remainingUsd">, fn: () => Promise<T>): Promise<T> {
  return withBilling(owner, { remainingUsd: check.remainingUsd, onCost: (usd) => void recordSpend(owner, usd).catch(() => undefined) }, fn);
}

/** Add a finished run's cost to today's and this month's spend. */
export async function recordSpend(owner: string, cost: number | undefined): Promise<void> {
  if (!cost || !(cost > 0)) return;
  const s = await store();
  s.add(owner, day(), 0, cost);
  s.add(owner, month(), 0, cost);
}

/** The run's cost cap: PROOF_COST_CAP_USD and what is left of today's limit, whichever is lower. */
export function runCostCap(check: Pick<QuotaCheck, "remainingUsd">): number | undefined {
  const env = Number(process.env.PROOF_COST_CAP_USD);
  const caps = [process.env.PROOF_COST_CAP_USD && env > 0 ? env : undefined, check.remainingUsd].filter((v): v is number => v !== undefined);
  return caps.length ? Math.max(0.0001, Math.min(...caps)) : undefined;
}
