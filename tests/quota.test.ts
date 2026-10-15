import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { subMock } = vi.hoisted(() => ({ subMock: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { subscription: { findUnique: subMock } } }));

import { _resetQuotaForTests, admitSolve, quotaStatus, recordSpend, runCostCap } from "@/lib/quota";

beforeEach(() => {
  _resetQuotaForTests();
  subMock.mockReset();
  subMock.mockResolvedValue(null);
});
afterEach(() => {
  for (const v of ["RATE_LIMIT_PER_MIN", "QUOTA_DAILY_USD_FREE", "QUOTA_DAILY_USD_PRO", "QUOTA_LOCAL_PLAN", "PROOF_COST_CAP_USD"]) delete process.env[v];
});

describe("quotas", () => {
  it("the local single user is not limited", async () => {
    process.env.RATE_LIMIT_PER_MIN = "1";
    for (let i = 0; i < 20; i++) expect((await admitSolve("local")).ok).toBe(true);
    expect(await quotaStatus("local")).toMatchObject({ plan: "local", unlimited: true, monthLimit: -1 });
  });

  it("free plan: 10 solves a month, one at a time", async () => {
    process.env.RATE_LIMIT_PER_MIN = "0"; // off for this test
    for (let i = 0; i < 10; i++) expect((await admitSolve("u1")).ok).toBe(true);
    const r = await admitSolve("u1");
    expect(r).toMatchObject({ ok: false, plan: "free", monthSolves: 10, monthLimit: 10, concurrent: 1 });
    expect(r.reason).toMatch(/10 solves are used up/);
    // Another user has their own count.
    expect((await admitSolve("u2")).ok).toBe(true);
  });

  it("an active pro subscription lifts the limits; a cancelled one does not", async () => {
    process.env.RATE_LIMIT_PER_MIN = "0";
    subMock.mockResolvedValue({ plan: "pro", status: "active" });
    expect(await quotaStatus("p1")).toMatchObject({ plan: "pro", monthLimit: 500, concurrent: 4 });
    subMock.mockResolvedValue({ plan: "pro", status: "cancelled" });
    expect((await quotaStatus("p1")).plan).toBe("free");
  });

  it("daily spend limit stops further solves and caps the run", async () => {
    process.env.RATE_LIMIT_PER_MIN = "0";
    process.env.QUOTA_DAILY_USD_FREE = "0.10";
    process.env.PROOF_COST_CAP_USD = "0.05";
    const first = await admitSolve("u1");
    expect(first.remainingUsd).toBeCloseTo(0.1);
    expect(runCostCap(first)).toBe(0.05); // the per-run cap is lower
    await recordSpend("u1", 0.08);
    const second = await admitSolve("u1");
    expect(second.ok).toBe(true);
    expect(runCostCap(second)).toBeCloseTo(0.02); // only $0.02 left today
    await recordSpend("u1", 0.03);
    expect((await admitSolve("u1")).reason).toMatch(/spend limit/);
  });

  it("rate limit: at most N starts a minute", async () => {
    process.env.RATE_LIMIT_PER_MIN = "3";
    const r = [];
    for (let i = 0; i < 4; i++) r.push((await admitSolve("u1", (zh) => zh)).ok);
    expect(r).toEqual([true, true, true, false]);
    expect((await admitSolve("u1", (zh) => zh)).reason).toBe("求解太频繁，请一分钟后再试");
  });
});
