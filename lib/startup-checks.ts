/**
 * Configuration checks for a server other people use (auth required, lib/access.ts). Fatal
 * problems stop the server at start (instrumentation.ts) — STARTUP_CHECKS=warn only logs them.
 *
 * Fatal: no NEXTAUTH_SECRET, no sign-in provider, no LLM key, a configured model without a price
 * in LLM_PRICES (spend could not be measured, so no limit would hold).
 * Warnings: no invite list (nobody can sign in), no daily spend limit for the free plan, a Stripe
 * key without its webhook secret.
 */
import { authRequired, inviteList } from "./access";
import { loadConfig } from "./llm/config";

export interface StartupReport {
  fatal: string[];
  warn: string[];
}

/** Models any role may call (primary, fallbacks, prover, planner, vision). */
export function modelsInUse(): string[] {
  const cfg = loadConfig();
  return [...new Set(Object.values(cfg.roles).flatMap((chain) => chain.map((e) => e.model)))].filter(Boolean);
}

export async function startupReport(): Promise<StartupReport> {
  const fatal: string[] = [];
  const warn: string[] = [];
  if (!authRequired()) return { fatal, warn };
  const env = process.env;
  if (!env.NEXTAUTH_SECRET) fatal.push("NEXTAUTH_SECRET is not set");
  const github = !!(env.GITHUB_ID && env.GITHUB_SECRET);
  const google = !!(env.GOOGLE_ID && env.GOOGLE_SECRET);
  if (!github && !google) fatal.push("no sign-in provider: set GITHUB_ID/GITHUB_SECRET or GOOGLE_ID/GOOGLE_SECRET");
  if (!env.LLM_API_KEY) fatal.push("LLM_API_KEY is not set");
  try {
    const cfg = loadConfig();
    const unpriced = modelsInUse().filter((m) => !cfg.prices[m]);
    if (unpriced.length) fatal.push(`LLM_PRICES has no price for ${unpriced.join(", ")} — spend limits would not hold`);
  } catch (e) {
    fatal.push(`LLM configuration: ${e instanceof Error ? e.message : String(e)}`);
  }
  const invites = await inviteList();
  if (invites.emails.size === 0 && invites.domains.size === 0) warn.push("no invite list (INVITE_EMAILS / INVITE_DOMAINS / INVITE_FILE): nobody can sign in");
  if (!env.QUOTA_DAILY_USD_FREE) warn.push("QUOTA_DAILY_USD_FREE is not set: free-plan users have no daily spend limit");
  if (env.STRIPE_SECRET_KEY && !env.STRIPE_WEBHOOK_SECRET) warn.push("STRIPE_SECRET_KEY without STRIPE_WEBHOOK_SECRET: paid plans would never activate");
  return { fatal, warn };
}

/** Log the report; throw when something fatal is wrong (unless STARTUP_CHECKS=warn). */
export async function runStartupChecks(): Promise<StartupReport> {
  const report = await startupReport();
  for (const w of report.warn) console.warn(`[startup] warning: ${w}`);
  for (const f of report.fatal) console.error(`[startup] ${f}`);
  if (report.fatal.length && process.env.STARTUP_CHECKS !== "warn") {
    throw new Error(`refusing to start: ${report.fatal.join("; ")} (STARTUP_CHECKS=warn to start anyway)`);
  }
  return report;
}
