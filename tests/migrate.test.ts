import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

// The schema the migration creates must be the one the Prisma client and NextAuth use.

describe("scripts/migrate.mjs", () => {
  it("creates the tables once, then is a no-op; the Prisma client can use them", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-"));
    const file = path.join(dir, "prod.db");
    const env = { ...process.env, DATABASE_URL: `file:${file}` };
    const first = execFileSync("node", ["scripts/migrate.mjs"], { env, encoding: "utf8" });
    expect(first).toContain("applied 0001_init");
    const again = execFileSync("node", ["scripts/migrate.mjs"], { env, encoding: "utf8" });
    expect(again).toContain("0 applied");

    const db = new Database(file);
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map((r) => (r as { name: string }).name);
    expect(tables).toEqual(expect.arrayContaining(["User", "Account", "Session", "VerificationToken", "Subscription", "ProofSession", "_app_migrations"]));
    db.close();

    process.env.DATABASE_URL = `file:${file}`;
    const { PrismaClient } = await import("@/lib/generated/prisma/client");
    const { PrismaBetterSqlite3 } = await import("@prisma/adapter-better-sqlite3");
    const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) });
    const user = await prisma.user.create({ data: { email: "a@b.com", name: "A" } });
    await prisma.account.create({ data: { userId: user.id, type: "oauth", provider: "github", providerAccountId: "1" } });
    await prisma.subscription.create({ data: { userId: user.id, plan: "pro", status: "active", startDate: new Date() } });
    await prisma.proofSession.create({ data: { userId: user.id, problemText: "p", problemType: "theorem", status: "pending" } });
    const found = await prisma.user.findUnique({ where: { email: "a@b.com" }, include: { subscription: true, accounts: true } });
    expect(found?.subscription?.plan).toBe("pro");
    expect(found?.accounts).toHaveLength(1);
    await prisma.$disconnect();
  });

  it("adopts a database made by prisma db push", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-"));
    const file = path.join(dir, "prod.db");
    const db = new Database(file);
    db.exec(`CREATE TABLE "User" ("id" TEXT NOT NULL PRIMARY KEY)`);
    db.close();
    const out = execFileSync("node", ["scripts/migrate.mjs"], { env: { ...process.env, DATABASE_URL: `file:${file}` }, encoding: "utf8" });
    expect(out).toContain("recorded");
  });
});
