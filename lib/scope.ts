/**
 * What is frozen (docs/SCOPE.md). The product is solving, question generation and marking for
 * students and teachers (the owner's decision, 2026-11-13); the features below are outside it.
 * Frozen means: the code and its tests stay, nothing is added to them, and by default they are
 * off — their API routes answer 404, their pages are not found, their scripts refuse to run.
 * `THAW=payments,knowledge` (or `THAW=all`) in the environment turns named ones back on. Frozen is
 * for three months: what is still in the list after `deleteAfter` is deleted.
 *
 * The rule the list enforces (tests/scope.test.ts): nothing outside a frozen feature imports it,
 * so the product builds and can be reasoned about without it, and deleting it later is a removal
 * and nothing else. What the product needs and used to live inside one — the plan limits of
 * lib/quota.ts — has been moved out (lib/plans.ts).
 *
 * Three gates, each for what the others cannot do: the route handlers themselves (`frozenRoute` —
 * closed even where the proxy's matcher does not reach), the page directories' layouts (`notFound()`
 * — but a page that streams has already answered 200), and proxy.ts (`closedAt` — a real 404).
 *
 * No imports: this file is read by route handlers, layouts, proxy.ts and the scripts.
 */

export interface FrozenFeature {
  /** What it is, in the words of docs/SCOPE.md. */
  title: string;
  /** Since when (the date of the decision). */
  since: string;
  /** The last day it may stay frozen: after it, what is still in this list is deleted (docs/SCOPE.md). */
  deleteAfter: string;
  /** Why it is outside the product, in one sentence. */
  reason: string;
  /** Its code: directories end with "/"; everything else is one file. */
  code: readonly string[];
  /** URL prefixes it answers (pages and API routes). */
  routes: readonly string[];
  /** npm scripts that belong to it. */
  scripts: readonly string[];
  /** Its test files (they keep running; one that breaks on an upgrade is skipped, not repaired). */
  tests: readonly string[];
  /** Environment variables only it reads (prefixes end with "*"). */
  env: readonly string[];
  /** npm packages only it needs. */
  deps: readonly string[];
}

/**
 * The freeze is not a parking place: the owner set three months (decided 2026-11-13). A feature
 * that is wanted after all is taken out of the list before this day (thawed for good); what is
 * still listed after it is deleted — code, tests, npm scripts, packages (docs/SCOPE.md has the
 * checklist per feature). tests/scope.test.ts fails from the day after, until that is done or the
 * owner moves the date.
 */
const DELETE_AFTER = "2027-02-13";

export const FROZEN = {
  payments: {
    title: "付费（Stripe 订阅）",
    since: "2026-11-13",
    deleteAfter: DELETE_AFTER,
    reason: "没有一个付费用户，结账流程从未在真实 Stripe 上走通；内测靠邀请名单和额度控制，不靠收费",
    code: ["lib/payments/", "app/api/payments/", "app/subscription/", "app/components/PricingCards.tsx"],
    routes: ["/subscription", "/api/payments"],
    scripts: [],
    tests: ["tests/stripe.test.ts"],
    env: ["STRIPE_*"],
    deps: ["stripe"],
  },
  knowledge: {
    title: "知识图谱（Neo4j）",
    since: "2026-11-13",
    deleteAfter: DELETE_AFTER,
    reason: "求解、出题、批改都不读它；题库有自己的知识点词表，批改的学情按技能统计",
    code: ["lib/knowledge/", "app/api/knowledge/", "app/knowledge/", "app/components/KnowledgeGraph.tsx", "app/components/Header.tsx"],
    routes: ["/knowledge", "/api/knowledge"],
    scripts: [],
    tests: ["tests/neo4j-client.test.ts"],
    env: ["NEO4J_*"],
    deps: ["neo4j-driver"],
  },
  clingo: {
    title: "Clingo 几何求解（ASP）",
    since: "2026-11-13",
    deleteAfter: DELETE_AFTER,
    reason: "界面没有入口，求解流程不调用它；几何题走图形模块（lib/figure）和坐标证明器（lib/lean/geometry）",
    code: ["lib/geometry/", "app/api/solve-geometry/", "app/components/GeometryDiagram.tsx"],
    routes: ["/api/solve-geometry"],
    scripts: [],
    tests: ["tests/clingo-solver.test.ts"],
    env: ["CLINGO_PATH"],
    deps: [],
  },
  "expert-iteration": {
    title: "专家迭代（微调本地证明模型）",
    since: "2026-11-13",
    deleteAfter: DELETE_AFTER,
    reason: "属于“定理证明研究”那条路；从未跑过一轮（没有训练记录，也没有微调出的模型），端到端评测的 16 个证明里模型写的只有 4 个",
    code: ["lib/prover/expert-iteration.ts", "scripts/expert-iterate.ts", "scripts/prover-serve.ts", "scripts/proofs-export.ts"],
    routes: [],
    scripts: ["expert:iterate", "prover:serve", "proofs:export"],
    tests: ["tests/expert-iteration.test.ts"],
    env: ["EXPERT_*"],
    deps: [],
  },
} as const satisfies Record<string, FrozenFeature>;

export type FrozenName = keyof typeof FROZEN;

export const FROZEN_NAMES = Object.keys(FROZEN) as FrozenName[];

const isFrozenName = (x: string): x is FrozenName => Object.hasOwn(FROZEN, x);

/** What `THAW` names: the frozen features switched back on, and the names it has that are none. */
export function readThaw(value: string | undefined = process.env.THAW): { on: FrozenName[]; unknown: string[] } {
  const words = (value ?? "")
    .split(/[\s,]+/)
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  if (words.includes("all")) return { on: [...FROZEN_NAMES], unknown: words.filter((w) => w !== "all" && !isFrozenName(w)) };
  return { on: FROZEN_NAMES.filter((n) => words.includes(n)), unknown: words.filter((w) => !isFrozenName(w)) };
}

/** Is this frozen feature switched back on (THAW)? Read on every call: no restart of a test, and no build-time value. */
export function thawed(name: FrozenName, value: string | undefined = process.env.THAW): boolean {
  return readThaw(value).on.includes(name);
}

/** The frozen feature a request path belongs to that is not thawed — the path is closed (proxy.ts). */
export function closedAt(pathname: string, value: string | undefined = process.env.THAW): FrozenName | undefined {
  const on = readThaw(value).on;
  return FROZEN_NAMES.find((n) => !on.includes(n) && FROZEN[n].routes.some((r) => pathname === r || pathname.startsWith(`${r}/`)));
}

/** The frozen features past their deletion date on `today` (YYYY-MM-DD; default: now, UTC). */
export function overdue(today: string = new Date().toISOString().slice(0, 10)): FrozenName[] {
  return FROZEN_NAMES.filter((n) => today > FROZEN[n].deleteAfter);
}

/** What a frozen feature says instead of working (both languages: there is no request locale here). */
export function frozenMessage(name: FrozenName): string {
  return `此功能已冻结，当前不提供（${FROZEN[name].title}；见 docs/SCOPE.md，THAW=${name} 可重新打开） / This feature is frozen and not offered (set THAW=${name} to turn it on; docs/SCOPE.md)`;
}

/** The answer of a frozen feature's API route: it is not there. */
export function frozenResponse(name: FrozenName): Response {
  return Response.json({ error: frozenMessage(name), frozen: name }, { status: 404 });
}

/** An API route handler of a frozen feature: 404 unless the feature is thawed. */
export function frozenRoute<A extends unknown[]>(name: FrozenName, handler: (...args: A) => Response | Promise<Response>): (...args: A) => Promise<Response> {
  return async (...args: A) => (thawed(name) ? handler(...args) : frozenResponse(name));
}

/** A script of a frozen feature: says so and exits (code 2) unless the feature is thawed. */
export function requireThawed(name: FrozenName, what: string): void {
  if (thawed(name)) return;
  console.error(`${what}: ${FROZEN[name].title} 已冻结（${FROZEN[name].since}，docs/SCOPE.md）——代码保留但不再维护，可能已经跑不通；${FROZEN[name].deleteAfter} 之后仍在冻结清单里就会被删除。`);
  console.error(`确实要运行：THAW=${name} ${what}`);
  process.exit(2);
}
