/**
 * Plans as limits (lib/quota.ts): solves per month, sessions kept, solves at once. They hold
 * whether or not anything is sold, so they live here and not in the payment module, which is
 * frozen (lib/scope.ts) — lib/payments/stripe.ts adds names, prices and Stripe price ids on top.
 *
 * Without payments a signed-in user's plan is `QUOTA_DEFAULT_PLAN` (default "free"): an
 * invite-only server whose teachers need more than 10 solves a month sets it to "pro".
 */

export interface PlanLimits {
  /** Solves a month (-1 = unlimited). */
  proofsPerMonth: number;
  /** Days of session history (-1 = unlimited). */
  sessionHistory: number;
  /** Solves at once (-1 = unlimited). */
  concurrentSolvers: number;
}

export const PLAN_LIMITS = {
  free: { proofsPerMonth: 10, sessionHistory: 7, concurrentSolvers: 1 },
  pro: { proofsPerMonth: 500, sessionHistory: -1, concurrentSolvers: 4 },
  enterprise: { proofsPerMonth: -1, sessionHistory: -1, concurrentSolvers: -1 },
} as const satisfies Record<string, PlanLimits>;

export type PlanId = keyof typeof PLAN_LIMITS;

export const isPlan = (x: string | null | undefined): x is PlanId => !!x && Object.hasOwn(PLAN_LIMITS, x);

/** The plan of a signed-in user who has no active subscription: QUOTA_DEFAULT_PLAN when it names a plan, else "free". */
export function defaultPlan(value: string | undefined = process.env.QUOTA_DEFAULT_PLAN): PlanId {
  const v = value?.trim().toLowerCase();
  return isPlan(v) ? v : "free";
}
