/**
 * SQLite URL for Prisma (CLI config and the runtime driver adapter).
 *
 * Prisma 5 resolved a relative `file:` URL against the schema's folder (prisma/), so the
 * default `file:.data/prod.db` meant prisma/.data/prod.db. The Prisma 7 driver adapter
 * resolves paths against the working directory instead; this keeps the old location.
 */
import path from "node:path";

export const DEFAULT_DATABASE_URL = "file:.data/prod.db";

export function sqliteUrl(raw = process.env.DATABASE_URL, root = process.cwd()): string {
  const url = raw?.trim() || DEFAULT_DATABASE_URL;
  if (!url.startsWith("file:")) return url;
  const file = url.slice("file:".length);
  if (file === ":memory:" || path.isAbsolute(file)) return url;
  return "file:" + path.join(root, "prisma", file);
}
