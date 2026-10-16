import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Invite-only beta: who may sign in, who may call what, who pays.

const session = vi.hoisted(() => ({ user: null as null | { id: string } }));
vi.mock("next-auth", () => ({ getServerSession: async () => (session.user ? { user: session.user } : null) }));

const access = await import("@/lib/access");
const quota = await import("@/lib/quota");
const tracker = await import("@/lib/llm/usage-tracker");
const { modelRoute } = await import("@/lib/model-route");
const { startupReport } = await import("@/lib/startup-checks");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "beta-access-"));
const ENV_KEYS = ["AUTH_REQUIRED", "INVITE_EMAILS", "INVITE_DOMAINS", "INVITE_FILE", "QUOTA_DAILY_USD_FREE", "RATE_LIMIT_CALLS_PER_MIN", "LLM_PRICES", "LLM_MODEL", "LLM_API_KEY", "NEXTAUTH_SECRET", "GITHUB_ID", "GITHUB_SECRET"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.INVITE_FILE = path.join(dir, "none.txt");
  delete process.env.INVITE_EMAILS;
  delete process.env.INVITE_DOMAINS;
  session.user = null;
  quota._resetQuotaForTests();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("who may sign in", () => {
  it("development without a list: everyone; auth required without a list: nobody", async () => {
    process.env.AUTH_REQUIRED = "false";
    expect(await access.isInvited("a@b.com")).toBe(true);
    process.env.AUTH_REQUIRED = "true";
    expect(await access.isInvited("a@b.com")).toBe(false);
  });

  it("listed emails and domains from the environment and the invite file (re-read every time)", async () => {
    process.env.AUTH_REQUIRED = "true";
    process.env.INVITE_EMAILS = "Teacher@School.org, x@y.com";
    process.env.INVITE_DOMAINS = "@uni.edu";
    expect(await access.isInvited("teacher@school.org")).toBe(true);
    expect(await access.isInvited("kid@uni.edu")).toBe(true);
    expect(await access.isInvited("kid@evil-uni.edu")).toBe(false);
    expect(await access.isInvited(null)).toBe(false);
    const file = path.join(dir, "invites.txt");
    process.env.INVITE_FILE = file;
    fs.writeFileSync(file, "# beta\nnew@friend.net\n@club.org\n");
    expect(await access.isInvited("new@friend.net")).toBe(true);
    expect(await access.isInvited("a@club.org")).toBe(true);
  });

  it("no anonymous 'local' user when auth is required", async () => {
    process.env.AUTH_REQUIRED = "true";
    await expect(access.requestOwner()).rejects.toThrow(access.UnauthorizedError);
    session.user = { id: "u1" };
    expect(await access.requestOwner()).toBe("u1");
    process.env.AUTH_REQUIRED = "false";
    session.user = null;
    expect(await access.requestOwner()).toBe("local");
  });
});

describe("model routes", () => {
  const route = modelRoute(async (req: Request) => {
    // A model call inside the route: charged to the caller.
    tracker.recordUsage({ model: "m", role: "general", promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, latencyMs: 1, cached: false } as never);
    return Response.json({ ok: true, url: req.url });
  });
  const call = () => route(new Request("http://t/api/x", { method: "POST" }));

  it("401 when auth is required and nobody is signed in", async () => {
    process.env.AUTH_REQUIRED = "true";
    const res = await call();
    expect(res.status).toBe(401);
  });

  it("charges every call to the caller and stops at today's limit", async () => {
    process.env.AUTH_REQUIRED = "true";
    process.env.QUOTA_DAILY_USD_FREE = "2";
    tracker.setPriceTable({ m: { input: 1, output: 1 } });
    session.user = { id: "u2" };
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect((await quota.quotaStatus("u2")).dayCost).toBeCloseTo(2);
    const res = await call();
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/spend limit|费用额度/);
  });

  it("rate-limits calls per minute", async () => {
    process.env.AUTH_REQUIRED = "true";
    process.env.RATE_LIMIT_CALLS_PER_MIN = "2";
    tracker.setPriceTable({});
    session.user = { id: "u3" };
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429);
  });

  it("a request's remaining budget stops new model calls inside it", async () => {
    tracker.setPriceTable({ m: { input: 1, output: 1 } });
    await tracker.withBilling("u4", { remainingUsd: 0.5, onCost: () => undefined }, async () => {
      expect(tracker.billingCapReached()).toBe(false);
      tracker.recordUsage({ model: "m", role: "general", promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, latencyMs: 1, cached: false } as never);
      expect(tracker.billingCapReached()).toBe(true);
      expect(tracker.billingOwner()).toBe("u4");
    });
  });
});

describe("startup checks", () => {
  it("nothing to check in development", async () => {
    process.env.AUTH_REQUIRED = "false";
    expect(await startupReport()).toEqual({ fatal: [], warn: [] });
  });

  it("refuses a server without secrets, sign-in or prices", async () => {
    process.env.AUTH_REQUIRED = "true";
    delete process.env.NEXTAUTH_SECRET;
    delete process.env.GITHUB_ID;
    process.env.LLM_MODEL = "openai/gpt-x";
    process.env.LLM_API_KEY = "k";
    delete process.env.LLM_PRICES;
    const r = await startupReport();
    expect(r.fatal.join("\n")).toMatch(/NEXTAUTH_SECRET/);
    expect(r.fatal.join("\n")).toMatch(/sign-in provider/);
    expect(r.fatal.join("\n")).toMatch(/no price for openai\/gpt-x/);
    expect(r.warn.join("\n")).toMatch(/nobody can sign in/);
  });

  it("passes when configured", async () => {
    process.env.AUTH_REQUIRED = "true";
    process.env.NEXTAUTH_SECRET = "s";
    process.env.GITHUB_ID = "g";
    process.env.GITHUB_SECRET = "g";
    process.env.LLM_API_KEY = "k";
    process.env.LLM_MODEL = "openai/gpt-x";
    process.env.LLM_PRICES = JSON.stringify({ "openai/gpt-x": { input: 1, output: 2 } });
    process.env.INVITE_EMAILS = "a@b.com";
    process.env.QUOTA_DAILY_USD_FREE = "1";
    const r = await startupReport();
    expect(r.fatal).toEqual([]);
  });
});
