#!/usr/bin/env node
/**
 * Apply prisma/migrations/<name>/migration.sql to the SQLite database (DATABASE_URL, relative
 * file: paths against prisma/ as lib/db-url.ts does), each once, in name order, recorded in
 * _app_migrations. Runs at container start (the standalone image has no Prisma CLI); safe to run
 * again. A database made earlier with `prisma db push` (tables there, no record) is adopted:
 * 0001_init is recorded without running it.
 *
 *   node scripts/migrate.mjs            # apply
 *   node scripts/migrate.mjs --status   # list applied / pending
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const root = process.cwd();
const url = (process.env.DATABASE_URL || "file:.data/prod.db").trim();
if (!url.startsWith("file:")) {
  console.error(`[migrate] only SQLite file: URLs are supported (got ${url})`);
  process.exit(1);
}
let file = url.slice("file:".length);
if (!path.isAbsolute(file)) file = path.join(root, "prisma", file);
fs.mkdirSync(path.dirname(file), { recursive: true });

const dir = path.join(root, "prisma", "migrations");
const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => fs.existsSync(path.join(dir, n, "migration.sql"))).sort() : [];

const db = new Database(file);
db.pragma("foreign_keys = ON");
db.exec(`CREATE TABLE IF NOT EXISTS "_app_migrations" ("name" TEXT NOT NULL PRIMARY KEY, "applied_at" TEXT NOT NULL)`);
const applied = new Set(db.prepare(`SELECT name FROM "_app_migrations"`).all().map((r) => r.name));
const record = db.prepare(`INSERT INTO "_app_migrations" (name, applied_at) VALUES (?, ?)`);

if (process.argv.includes("--status")) {
  for (const n of names) console.log(`${applied.has(n) ? "applied" : "pending"}  ${n}`);
  process.exit(0);
}

const hasUserTable = !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'User'`).get();
let ran = 0;
for (const n of names) {
  if (applied.has(n)) continue;
  if (n === "0001_init" && hasUserTable) {
    record.run(n, new Date().toISOString());
    console.log(`[migrate] ${n}: tables already there (made by prisma db push) — recorded`);
    continue;
  }
  const sql = fs.readFileSync(path.join(dir, n, "migration.sql"), "utf8");
  db.transaction(() => {
    db.exec(sql);
    record.run(n, new Date().toISOString());
  })();
  ran++;
  console.log(`[migrate] applied ${n}`);
}
console.log(`[migrate] ${file}: ${ran} applied, ${names.length - ran} already up to date`);
db.close();
