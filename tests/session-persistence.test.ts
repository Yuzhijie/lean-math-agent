import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  createSession,
  updateSession,
  saveSessionToDisk,
  loadSessionFromDisk,
  listSessionsFromDisk,
  _resetStoreForTests,
} from "@/lib/session-store";

const TEST_DIR = ".data/test-sessions";

beforeEach(() => {
  _resetStoreForTests();
  process.env.SESSION_STORE_PATH = TEST_DIR;
});

afterEach(async () => {
  try {
    const files = await fs.readdir(TEST_DIR);
    for (const file of files) {
      await fs.unlink(path.join(TEST_DIR, file));
    }
    await fs.rmdir(TEST_DIR);
  } catch {
    // ignore cleanup errors
  }
  delete process.env.SESSION_STORE_PATH;
});

describe("session persistence", () => {
  it("saves and loads a session from disk", async () => {
    const session = createSession("prove 1 + 1 = 2");
    await saveSessionToDisk(session.id);

    _resetStoreForTests(); // clear memory
    const loaded = await loadSessionFromDisk(session.id);
    expect(loaded).toBeTruthy();
    expect(loaded?.problem_text).toBe("prove 1 + 1 = 2");
    expect(loaded?.id).toBe(session.id);
  });

  it("returns undefined for non-existent session", async () => {
    const loaded = await loadSessionFromDisk("non-existent-id");
    expect(loaded).toBeUndefined();
  });

  it("lists sessions sorted by created_at desc", async () => {
    const s1 = createSession("problem 1");
    await saveSessionToDisk(s1.id);

    // Ensure different timestamps
    const s2 = createSession("problem 2");
    updateSession(s2.id, { created_at: s1.created_at + 1000 });
    await saveSessionToDisk(s2.id);

    const sessions = await listSessionsFromDisk();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].problem_text).toBe("problem 2");
    expect(sessions[1].problem_text).toBe("problem 1");
  });

  it("preserves all session fields through save/load cycle", async () => {
    const session = createSession("test persistence");
    updateSession(session.id, {
      pipeline_stage: "complete",
      theorem_name: "test_thm",
      theorem_type: "(n : Nat) : n = n",
      formal_validated: true,
    });
    await saveSessionToDisk(session.id);

    _resetStoreForTests();
    const loaded = await loadSessionFromDisk(session.id);
    expect(loaded?.pipeline_stage).toBe("complete");
    expect(loaded?.theorem_name).toBe("test_thm");
    expect(loaded?.formal_validated).toBe(true);
  });
});
