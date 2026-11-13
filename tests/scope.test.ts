import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { FROZEN, FROZEN_NAMES, closedAt, frozenResponse, frozenRoute, overdue, readThaw, requireThawed, thawed, type FrozenName } from "@/lib/scope";
import { proxy } from "@/proxy";
import { PLAN_LIMITS, defaultPlan, isPlan } from "@/lib/plans";
import { isPublicPath } from "@/lib/access";
import { startupReport } from "@/lib/startup-checks";

// What is frozen (lib/scope.ts, docs/SCOPE.md): the list is true to the repository, nothing outside a
// frozen feature depends on it, and every door into one is closed unless THAW opens it.

const ROOT = process.cwd();
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");

function walk(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).flatMap((name) => {
    const p = path.join(abs, name);
    if (name === "node_modules" || name === "generated" || name.startsWith(".")) return [];
    return statSync(p).isDirectory() ? walk(rel(p)) : /\.(ts|tsx|mts|mjs)$/.test(name) ? [rel(p)] : [];
  });
}

const SOURCES = [...["app", "lib", "scripts", "components"].flatMap(walk), ...["proxy.ts", "instrumentation.ts", "instrumentation-node.ts", "next.config.ts", "prisma.config.ts"].filter((f) => existsSync(path.join(ROOT, f)))];
const TESTS = walk("tests");

/** Is the file (or the module path without its extension) inside one of these entries? */
function inside(file: string, entries: readonly string[]): boolean {
  return entries.some((e) => (e.endsWith("/") ? file.startsWith(e) || file === e.slice(0, -1) : file === e || file === e.replace(/\.(ts|tsx)$/, "")));
}

/** What a file imports: modules of the repository as paths from its root (no extension), packages by name. */
function importsOf(file: string): { modules: string[]; packages: string[] } {
  const text = readFileSync(path.join(ROOT, file), "utf8");
  const specs = [...text.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"'\n]+)["']/g), ...text.matchAll(/\b(?:require|mock|doMock|importActual)\s*\(\s*["']([^"'\n]+)["']/g)].map((m) => m[1]);
  const modules: string[] = [];
  const packages: string[] = [];
  for (const s of specs) {
    if (s.startsWith("@/")) modules.push(s.slice(2).replace(/\.(ts|tsx|js)$/, ""));
    else if (s.startsWith(".")) modules.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), s)).replace(/\.(ts|tsx|js)$/, ""));
    else packages.push(s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0]);
  }
  return { modules, packages };
}

const featureOf = (file: string): FrozenName | undefined => FROZEN_NAMES.find((n) => inside(file, FROZEN[n].code));

describe("the frozen list is true to the repository", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string>; dependencies: Record<string, string> };

  it.each(FROZEN_NAMES)("%s: its code, tests, scripts and packages exist", (name) => {
    const f = FROZEN[name];
    for (const p of [...f.code, ...f.tests]) expect(existsSync(path.join(ROOT, p)), p).toBe(true);
    for (const s of f.scripts) {
      expect(pkg.scripts[s], `npm script ${s}`).toBeTruthy();
      // the npm script runs a file of this feature
      const file = pkg.scripts[s].split(/\s+/).find((w) => w.startsWith("scripts/"));
      expect(file && inside(file, f.code), `${s} → ${file}`).toBe(true);
    }
    for (const d of f.deps) expect(pkg.dependencies[d], `dependency ${d}`).toBeTruthy();
    expect(f.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(f.reason.length).toBeGreaterThan(10);
  });

  it("the scope document names every frozen feature, how to thaw it and when it is deleted", () => {
    const doc = readFileSync(path.join(ROOT, "docs", "SCOPE.md"), "utf8");
    for (const name of FROZEN_NAMES) {
      expect(doc, name).toContain(FROZEN[name].title);
      expect(doc, name).toContain(`THAW=${name}`);
      expect(doc, name).toContain(FROZEN[name].deleteAfter);
      // the deletion checklist lists each code path and test of the feature
      for (const p of [...FROZEN[name].code, ...FROZEN[name].tests]) expect(doc, `${name}: ${p} in the deletion checklist`).toContain(`\`${p}\``);
    }
  });
});

describe("frozen is for three months", () => {
  it("every frozen feature has a deletion date: a real day, after the day it was frozen", () => {
    for (const name of FROZEN_NAMES) {
      const { since, deleteAfter } = FROZEN[name];
      expect(deleteAfter, name).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${deleteAfter}T00:00:00Z`).toISOString().slice(0, 10), name).toBe(deleteAfter);
      expect(deleteAfter > since, name).toBe(true);
    }
  });

  it("overdue: nothing up to the date, what is still listed from the day after", () => {
    const dates = FROZEN_NAMES.map((n) => FROZEN[n].deleteAfter).sort();
    const last = dates[dates.length - 1];
    const dayAfter = new Date(new Date(`${last}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
    expect(overdue(FROZEN.payments.since)).toEqual([]);
    expect(overdue(dates[0])).toEqual([]); // the last day itself is still inside the freeze
    expect(overdue(dayAfter)).toEqual(FROZEN_NAMES);
  });

  // The deadline itself. From the day after `deleteAfter` this fails — on purpose, and for every
  // run of the suite — until each feature it names is deleted (docs/SCOPE.md, "删除清单") or was
  // taken out of FROZEN because it is wanted after all. Moving the date is the owner's decision.
  it("no frozen feature is past its deletion date", () => {
    const late = overdue();
    expect(
      late,
      late.length
        ? `冻结期限已过：${late.map((n) => `${FROZEN[n].title}（${n}，期限 ${FROZEN[n].deleteAfter}）`).join("、")}。按 docs/SCOPE.md 的“删除清单”删除；想留下的从 lib/scope.ts 的 FROZEN 里移除；改期限由项目所有者决定。`
        : undefined,
    ).toEqual([]);
  });
});

describe("nothing outside a frozen feature depends on it", () => {
  it("no source file imports a frozen module of another feature (or from outside any)", () => {
    const crossings: string[] = [];
    for (const file of SOURCES) {
      const own = featureOf(file);
      for (const m of importsOf(file).modules) {
        const target = featureOf(m);
        if (target && target !== own) crossings.push(`${file} → ${m} (${target})`);
      }
    }
    expect(crossings).toEqual([]);
  });

  it("a test that imports a frozen module is one of that feature's tests", () => {
    const crossings: string[] = [];
    for (const file of TESTS) {
      for (const m of importsOf(file).modules) {
        const target = featureOf(m);
        if (target && !(FROZEN[target].tests as readonly string[]).includes(file)) crossings.push(`${file} → ${m} (${target})`);
      }
    }
    expect(crossings).toEqual([]);
  });

  it("the packages only a frozen feature needs are imported nowhere else", () => {
    const crossings: string[] = [];
    for (const name of FROZEN_NAMES) {
      const f = FROZEN[name];
      for (const file of [...SOURCES, ...TESTS]) {
        if (inside(file, f.code) || (f.tests as readonly string[]).includes(file)) continue;
        for (const p of importsOf(file).packages) if ((f.deps as readonly string[]).includes(p)) crossings.push(`${file} → ${p} (${name})`);
      }
    }
    expect(crossings).toEqual([]);
  });

  it("the import reader sees aliased, relative and dynamic imports", () => {
    expect(importsOf("lib/quota.ts").modules).toEqual(expect.arrayContaining(["lib/plans", "lib/llm/usage-tracker", "lib/db"]));
    expect(importsOf("lib/payments/stripe.ts")).toMatchObject({ modules: ["lib/plans"], packages: ["stripe"] });
    expect(featureOf("lib/payments/stripe")).toBe("payments");
    expect(featureOf("app/components/Header")).toBe("knowledge");
    expect(featureOf("lib/prover/dataset")).toBeUndefined();
    expect(featureOf("lib/lean/geometry/prove")).toBeUndefined(); // the coordinate prover is not the Clingo solver
  });
});

describe("every door into a frozen feature is closed by default", () => {
  it.each(FROZEN_NAMES)("%s: API routes behind frozenRoute, pages behind a layout, scripts behind requireThawed", (name) => {
    const f = FROZEN[name];
    const files = SOURCES.filter((s) => inside(s, f.code));
    for (const route of files.filter((s) => /^app\/api\/.*\/route\.ts$/.test(s))) {
      const text = readFileSync(path.join(ROOT, route), "utf8");
      expect(text, `${route}: a handler exported directly`).not.toMatch(/export\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/);
      const exported = [...text.matchAll(/export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=\s*(.*)/g)];
      expect(exported.length, route).toBeGreaterThan(0);
      for (const e of exported) expect(e[2], `${route} ${e[1]}`).toMatch(new RegExp(`^frozenRoute\\(["']${name}["']`));
    }
    for (const page of files.filter((s) => /^app\/(?!api\/).*\/page\.tsx$/.test(s))) {
      const layout = path.posix.join(path.posix.dirname(page), "layout.tsx");
      expect(existsSync(path.join(ROOT, layout)), layout).toBe(true);
      const text = readFileSync(path.join(ROOT, layout), "utf8");
      expect(text, layout).toContain(`if (!thawed("${name}")) notFound();`);
      expect(text, layout).toContain(`export const dynamic = "force-dynamic";`);
    }
    for (const script of files.filter((s) => s.startsWith("scripts/"))) {
      expect(readFileSync(path.join(ROOT, script), "utf8"), script).toContain(`requireThawed("${name}"`);
    }
  });

  it("a frozen route answers 404 and names the feature; thawed, the handler runs", async () => {
    const handler = vi.fn(async (who: string) => Response.json({ hello: who }));
    const route = frozenRoute("payments", handler);
    const closed = await route("a");
    expect(closed.status).toBe(404);
    expect(await closed.json()).toMatchObject({ frozen: "payments", error: expect.stringContaining("THAW=payments") });
    expect(handler).not.toHaveBeenCalled();
    process.env.THAW = "payments";
    const open = await route("b");
    expect(open.status).toBe(200);
    expect(await open.json()).toEqual({ hello: "b" });
    expect((await frozenRoute("knowledge", handler)("c")).status).toBe(404); // only what THAW names
    expect(frozenResponse("clingo").status).toBe(404);
  });

  it("the proxy answers a frozen path with a real 404 — whoever asks, signed in or not", async () => {
    const before = process.env.AUTH_REQUIRED;
    for (const auth of ["false", "true"]) {
      process.env.AUTH_REQUIRED = auth;
      const api = await proxy(new NextRequest("http://localhost/api/knowledge/search", { method: "POST" }));
      expect(api.status).toBe(404);
      expect(await api.json()).toMatchObject({ frozen: "knowledge" });
      // a page: sent to a path that does not exist, so the app's own not-found page answers with 404
      const page = await proxy(new NextRequest("http://localhost/subscription?success=true"));
      expect(page.headers.get("x-middleware-rewrite")).toBe("http://localhost/_frozen/payments");
    }
    process.env.AUTH_REQUIRED = "false";
    // what is not frozen passes, and so does a thawed feature
    expect((await proxy(new NextRequest("http://localhost/bank"))).headers.get("x-middleware-next")).toBe("1");
    process.env.THAW = "payments";
    const open = await proxy(new NextRequest("http://localhost/subscription"));
    expect(open.headers.get("x-middleware-rewrite")).toBeNull();
    expect(open.headers.get("x-middleware-next")).toBe("1");
    if (before === undefined) delete process.env.AUTH_REQUIRED;
    else process.env.AUTH_REQUIRED = before;
  });

  it("closedAt: a frozen feature's own paths, on segment boundaries, until thawed", () => {
    expect(closedAt("/subscription")).toBe("payments");
    expect(closedAt("/api/payments/webhook")).toBe("payments");
    expect(closedAt("/knowledge/anything")).toBe("knowledge");
    expect(closedAt("/api/solve-geometry")).toBe("clingo");
    expect(closedAt("/subscriptions")).toBeUndefined(); // another word
    expect(closedAt("/api/solve")).toBeUndefined();
    expect(closedAt("/api/banks/b1/items")).toBeUndefined();
    expect(closedAt("/")).toBeUndefined();
    expect(closedAt("/subscription", "payments")).toBeUndefined();
    expect(closedAt("/knowledge", "payments")).toBe("knowledge");
  });

  it("a frozen script says so and exits with 2; thawed, it goes on", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    requireThawed("expert-iteration", "npm run expert:iterate");
    expect(exit).toHaveBeenCalledWith(2);
    const said = err.mock.calls.flat().join("\n");
    expect(said).toMatch(/已冻结[\s\S]*THAW=expert-iteration npm run expert:iterate/);
    expect(said).toContain(`${FROZEN["expert-iteration"].deleteAfter} 之后仍在冻结清单里就会被删除`);
    exit.mockClear();
    process.env.THAW = "expert-iteration";
    requireThawed("expert-iteration", "npm run expert:iterate");
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
    err.mockRestore();
  });
});

describe("THAW", () => {
  it("nothing is on by default", () => {
    expect(readThaw(undefined)).toEqual({ on: [], unknown: [] });
    for (const n of FROZEN_NAMES) expect(thawed(n, "")).toBe(false);
  });

  it("names features by comma or space, in any case; `all` is every one; other words are reported", () => {
    expect(readThaw("payments, Knowledge").on).toEqual(["payments", "knowledge"]);
    expect(readThaw("expert-iteration clingo").on).toEqual(["clingo", "expert-iteration"]);
    expect(readThaw("all").on).toEqual(FROZEN_NAMES);
    expect(readThaw("payment,stripe,knowledge")).toEqual({ on: ["knowledge"], unknown: ["payment", "stripe"] });
    expect(thawed("payments", "true")).toBe(false); // "true" is not a feature
  });

  it("is read on every call (no restart, no build-time value)", () => {
    expect(thawed("clingo")).toBe(false);
    process.env.THAW = "clingo";
    expect(thawed("clingo")).toBe(true);
  });
});

describe("what the product needs is outside the frozen code", () => {
  it("plan limits live in lib/plans.ts (the payment module adds prices to them: tests/stripe.test.ts)", () => {
    expect(PLAN_LIMITS.free).toEqual({ proofsPerMonth: 10, sessionHistory: 7, concurrentSolvers: 1 });
    expect(PLAN_LIMITS.pro).toEqual({ proofsPerMonth: 500, sessionHistory: -1, concurrentSolvers: 4 });
    expect(PLAN_LIMITS.enterprise.proofsPerMonth).toBe(-1);
    expect(importsOf("lib/quota.ts").modules).not.toContain("lib/payments/stripe");
    expect(isPlan("pro")).toBe(true);
    expect(isPlan("gold")).toBe(false);
    expect(isPlan("toString")).toBe(false);
  });

  it("QUOTA_DEFAULT_PLAN names the plan of signed-in users; anything else is free", () => {
    expect(defaultPlan(undefined)).toBe("free");
    expect(defaultPlan(" Pro ")).toBe("pro");
    expect(defaultPlan("enterprise")).toBe("enterprise");
    expect(defaultPlan("gold")).toBe("free");
  });

  it("Stripe's webhook is reachable without signing in only while payments are thawed", () => {
    expect(isPublicPath("/auth/signin")).toBe(true);
    expect(isPublicPath("/api/auth/callback/github")).toBe(true);
    expect(isPublicPath("/api/health")).toBe(true);
    expect(isPublicPath("/api/solve")).toBe(false);
    expect(isPublicPath("/api/payments/webhook")).toBe(false);
    process.env.THAW = "payments";
    expect(isPublicPath("/api/payments/webhook")).toBe(true);
    expect(isPublicPath("/api/payments/checkout")).toBe(false);
  });
});

describe("startup checks follow the scope", () => {
  const KEYS = ["AUTH_REQUIRED", "NEXTAUTH_SECRET", "GITHUB_ID", "GITHUB_SECRET", "LLM_API_KEY", "LLM_MODEL", "LLM_PRICES", "INVITE_EMAILS", "INVITE_FILE", "QUOTA_DAILY_USD_FREE", "QUOTA_DAILY_USD_PRO", "QUOTA_DEFAULT_PLAN", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    Object.assign(process.env, { AUTH_REQUIRED: "true", NEXTAUTH_SECRET: "s", GITHUB_ID: "g", GITHUB_SECRET: "g", LLM_API_KEY: "k", LLM_MODEL: "openai/gpt-x", LLM_PRICES: JSON.stringify({ "openai/gpt-x": { input: 1, output: 2 } }), INVITE_EMAILS: "a@b.com", INVITE_FILE: path.join(ROOT, "tests", "no-such-invites.txt"), QUOTA_DAILY_USD_FREE: "1" });
    for (const k of ["QUOTA_DAILY_USD_PRO", "QUOTA_DEFAULT_PLAN", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("a configured server with everything frozen has nothing to say", async () => {
    expect(await startupReport()).toEqual({ fatal: [], warn: [] });
  });

  it("a Stripe key without its webhook secret matters only while payments are thawed", async () => {
    process.env.STRIPE_SECRET_KEY = "sk";
    expect((await startupReport()).warn).toEqual([]);
    process.env.THAW = "payments";
    const warn = (await startupReport()).warn.join("\n");
    expect(warn).toMatch(/STRIPE_WEBHOOK_SECRET/);
    expect(warn).toMatch(/frozen features switched on: payments/);
  });

  it("the daily limit that must be set is the default plan's; a name that is no plan or no feature is reported", async () => {
    process.env.QUOTA_DEFAULT_PLAN = "pro";
    expect((await startupReport()).warn.join("\n")).toMatch(/QUOTA_DAILY_USD_PRO is not set/);
    process.env.QUOTA_DAILY_USD_PRO = "3";
    expect((await startupReport()).warn).toEqual([]);
    process.env.QUOTA_DEFAULT_PLAN = "gold";
    expect((await startupReport()).warn.join("\n")).toMatch(/QUOTA_DEFAULT_PLAN=gold is not a plan/);
    delete process.env.QUOTA_DEFAULT_PLAN;
    process.env.THAW = "payment";
    expect((await startupReport()).warn.join("\n")).toMatch(/THAW names no frozen feature: payment/);
  });
});

// THAW never leaks from one test into the next
const thawBefore = process.env.THAW;
beforeEach(() => {
  delete process.env.THAW;
});
afterEach(() => {
  if (thawBefore === undefined) delete process.env.THAW;
  else process.env.THAW = thawBefore;
});
