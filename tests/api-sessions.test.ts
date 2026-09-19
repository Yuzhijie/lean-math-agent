import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createSession,
  updateSession,
  _resetStoreForTests,
  saveSessionToDisk,
  deleteSessionFromDisk,
  listSessionsFromDisk,
  listSessionsPaginated,
  searchSessions,
} from "@/lib/session-store";

beforeEach(() => {
  _resetStoreForTests();
  // Fresh on-disk store per test so listing/search totals are exact.
  process.env.SESSION_STORE_PATH = mkdtempSync(path.join(tmpdir(), "lma-sessions-"));
});

/** Create a session and persist it (listing reads from disk). */
async function createPersisted(problemText: string) {
  const s = createSession(problemText);
  await saveSessionToDisk(s.id);
  return s;
}

describe("session store — pagination", () => {
  it("listSessionsPaginated returns correct page", async () => {
    for (let i = 0; i < 5; i++) {
      await createPersisted(`problem ${i}`);
    }

    const result = await listSessionsPaginated(1, 3);
    expect(result.sessions.length).toBe(3);
    expect(result.page).toBe(1);
    expect(result.perPage).toBe(3);
    // The store path is a fresh temp dir (tests/setup-env.ts), so the
    // total is exactly what this test created.
    expect(result.total).toBe(5);
  });

  it("listSessionsPaginated page 2 returns remaining", async () => {
    for (let i = 0; i < 5; i++) {
      await createPersisted(`problem ${i}`);
    }

    const result = await listSessionsPaginated(2, 3);
    expect(result.page).toBe(2);
    expect(result.sessions.length).toBe(2);
    expect(result.total).toBe(5);
  });
});

describe("session store — search", () => {
  it("searchSessions finds persisted sessions by problem text", async () => {
    await createPersisted("证明勾股定理");
    await createPersisted("求解二次方程");

    const result = await searchSessions("证明");
    expect(result.total).toBe(1);
    expect(result.sessions.map((s) => s.problem_text)).toEqual(["证明勾股定理"]);
    expect(result.page).toBe(1);
    expect(result.perPage).toBe(20);
  });

  it("searchSessions returns empty for no match", async () => {
    const result = await searchSessions("xyzzy_nonexistent_query_12345");
    expect(result.sessions.length).toBe(0);
  });
});

describe("session store — schema version", () => {
  it("createSession sets schema_version", () => {
    const s = createSession("test");
    expect(s.schema_version).toBe(1);
  });
});

describe("session store — updateSession auto-save hook", () => {
  it("updateSession returns updated session", () => {
    const s = createSession("original");
    const updated = updateSession(s.id, { pipeline_stage: "solving" });
    expect(updated.pipeline_stage).toBe("solving");
    expect(updated.id).toBe(s.id);
  });

  it("updateSession preserves id", () => {
    const s = createSession("test");
    const updated = updateSession(s.id, { build_status: "ok" });
    expect(updated.id).toBe(s.id);
    expect(updated.updated_at).toBeGreaterThanOrEqual(s.updated_at);
  });
});
