import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSession, saveSessionToDisk, updateSession } from "@/lib/session-store";

describe("session disk persistence", () => {
  it("leaves one valid JSON document after many overlapping updates", async () => {
    const s = createSession("并发写入测试");
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 40; i++) {
      // Growing and shrinking payloads: interleaved writes used to leave trailing garbage.
      updateSession(s.id, { problem_text: "x".repeat(i % 2 ? 5000 : 10) + i });
      writes.push(saveSessionToDisk(s.id));
    }
    await Promise.all(writes);
    const file = path.join(process.env.SESSION_STORE_PATH!, `${s.id}.json`);
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    expect(parsed.problem_text.endsWith("39")).toBe(true);
    const leftovers = (await fs.readdir(process.env.SESSION_STORE_PATH!)).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});
