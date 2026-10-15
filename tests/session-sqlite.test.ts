import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { ownerMock } = vi.hoisted(() => ({ ownerMock: vi.fn(async () => "alice") }));
vi.mock("@/lib/bank/http", async (orig) => ({ ...(await orig<typeof import("@/lib/bank/http")>()), requestOwner: ownerMock }));

import { _resetStoreForTests, createSession, getSessionAsync, listSessionsPaginated, searchSessions, updateSession } from "@/lib/session-store";
import { createSessionForRequest, getSessionForRequest } from "@/lib/session-access";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "lma-sqlite-"));
  process.env.SESSION_BACKEND = "sqlite";
  process.env.SQLITE_DB_PATH = path.join(dir, "sessions.db");
  process.env.SESSION_STORE_PATH = path.join(dir, "sessions");
  _resetStoreForTests();
});
afterEach(() => {
  _resetStoreForTests();
  process.env.SESSION_BACKEND = "json";
});

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("sessions in SQLite", () => {
  it("imports the JSON session files the first time, owned by the local user", async () => {
    mkdirSync(process.env.SESSION_STORE_PATH!, { recursive: true });
    for (const [id, t] of [["a1", 1], ["b2", 2]] as const)
      writeFileSync(path.join(process.env.SESSION_STORE_PATH!, `${id}.json`), JSON.stringify({ id, problem_text: `old ${id}`, pipeline_stage: "complete", created_at: t, updated_at: t, methods: [], steps: [] }));
    const page = await listSessionsPaginated(1, 10, "local");
    expect(page.total).toBe(2);
    expect(page.sessions.map((s) => s.id)).toEqual(["b2", "a1"]);
    expect((await listSessionsPaginated(1, 10, "alice")).total).toBe(0);
  });

  it("persists, survives a restart, lists and searches by owner", async () => {
    const a = createSession("prove that 2 + 2 = 4", "alice");
    const b = createSession("the sum of two odd numbers is even", "bob");
    updateSession(a.id, { theorem_name: "two_plus_two" });
    await settle();
    _resetStoreForTests(); // a new server process
    expect((await getSessionAsync(a.id))?.theorem_name).toBe("two_plus_two");
    expect((await listSessionsPaginated(1, 10, "alice")).sessions.map((s) => s.id)).toEqual([a.id]);
    expect((await listSessionsPaginated(1, 10)).total).toBe(2);
    expect((await searchSessions("TWO_PLUS", 1, 10, "alice")).total).toBe(1); // theorem name, any case
    expect((await searchSessions("odd", 1, 10, "alice")).total).toBe(0); // bob's
    expect((await searchSessions("odd", 1, 10, "bob")).sessions[0].id).toBe(b.id);
  });

  it("a request sees only its owner's sessions", async () => {
    const mine = await createSessionForRequest("mine");
    const theirs = createSession("theirs", "bob");
    const legacy = createSession("no owner"); // older sessions: the local user's
    expect(mine.owner).toBe("alice");
    expect(await getSessionForRequest(mine.id)).toBeTruthy();
    expect(await getSessionForRequest(theirs.id)).toBeUndefined();
    expect(await getSessionForRequest(legacy.id)).toBeUndefined();
    ownerMock.mockResolvedValueOnce("local");
    expect(await getSessionForRequest(legacy.id)).toBeTruthy();
  });
});
