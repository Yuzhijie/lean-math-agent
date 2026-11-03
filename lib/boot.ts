/**
 * This server process's start id: a page kept from before a restart (lib/resume-view.ts) sees a
 * different id and starts fresh instead of restoring its old view. Kept on globalThis so a dev
 * server's hot reload of this module does not count as a restart.
 */
import { randomUUID } from "node:crypto";

const g = globalThis as typeof globalThis & { __serverBootId?: string };

export function bootId(): string {
  g.__serverBootId ??= randomUUID();
  return g.__serverBootId;
}
