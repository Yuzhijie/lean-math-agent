import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { chatJson, sampleText } from "@/lib/llm/client";
import { resetGlobalCache } from "@/lib/llm/cache";
import { englishDirectives, localizeMessages, lt, outputLocale, withOutputLocale, withRequestLocale } from "@/lib/llm/output-locale";

// Model-written text follows the UI language: prompts written for Chinese
// output are switched to English when the request runs in English.

function okResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
}
const bodies = () => vi.mocked(fetch).mock.calls.map((c) => JSON.parse(c[1]?.body as string) as { messages: { role: string; content: string }[] });

beforeEach(() => {
  process.env.LLM_API_KEY = "k";
  process.env.LLM_BASE_URL = "https://llm.test/v1";
  process.env.LLM_MODEL = "m";
  process.env.LLM_LOG_LEVEL = "silent";
  process.env.LLM_CACHE_ENABLED = "false";
  vi.stubGlobal("fetch", vi.fn(async () => okResponse('{"x":"ok"}')));
  resetGlobalCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const v of ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "LLM_LOG_LEVEL", "LLM_CACHE_ENABLED"]) delete process.env[v];
});

describe("prompt language switch", () => {
  it("switches Chinese-output directives but not the Chinese Remainder Theorem", () => {
    expect(englishDirectives("Write Chinese for title/inspiration. Use the Chinese Remainder Theorem.")).toBe(
      "Write English for title/inspiration. Use the Chinese Remainder Theorem.",
    );
    expect(englishDirectives("请用中文作答")).toBe("请用英文作答");
  });

  it("adds an output-language instruction for English only", () => {
    const msgs = [
      { role: "system", content: "Return JSON. Write in Chinese." },
      { role: "user", content: "题目：1+1" },
    ];
    expect(localizeMessages(msgs, "zh-CN")).toBe(msgs);
    const en = localizeMessages(msgs, "en-US");
    expect(en[0].content).toContain("Write in English.");
    expect(en[0].content).toContain("OUTPUT LANGUAGE: English");
    expect(en[1].content).toMatch(/题目：1\+1[\s\S]*Answer in English/);
    // Prover (Lean) calls: only the language words change.
    const minimal = localizeMessages(msgs, "en-US", { minimal: true });
    expect(minimal[0].content).toBe("Return JSON. Write in English.");
    expect(minimal[1].content).toBe("题目：1+1");
  });
});

describe("LLM calls follow the request language", () => {
  const schema = z.object({ x: z.string() });

  it("defaults to Chinese outside a request", async () => {
    expect(await outputLocale()).toBe("zh-CN");
    await chatJson({ system: "Write Chinese.", user: "q", schema, schemaName: "t" });
    expect(bodies()[0].messages[0].content).toBe("Write Chinese.");
  });

  it("sends English instructions inside an English request", async () => {
    await withOutputLocale("en-US", () => chatJson({ system: "Write Chinese.", user: "q", schema, schemaName: "t" }));
    const sys = bodies()[0].messages[0].content;
    expect(sys).toContain("Write English.");
    expect(sys).toContain("OUTPUT LANGUAGE: English");
  });

  it("leaves prover prompts without extra instructions", async () => {
    await withOutputLocale("en-US", () => sampleText({ role: "prover", n: 1, messages: [{ role: "user", content: "theorem t : 1 = 1 := by" }] }));
    expect(bodies()[0].messages).toEqual([{ role: "user", content: "theorem t : 1 = 1 := by" }]);
  });
});

describe("server messages", () => {
  it("lt follows the scope, including async work started inside it", async () => {
    expect(lt("完成", "Done")).toBe("完成");
    const handler = withRequestLocale(async () => {
      await new Promise((r) => setTimeout(r, 1));
      return lt("完成", "Done");
    });
    // Outside Next's request scope the wrapped handler falls back to Chinese…
    expect(await handler()).toBe("完成");
    // …and inside an explicit English scope it is English.
    expect(await withOutputLocale("en-US", handler)).toBe("Done");
  });
});
