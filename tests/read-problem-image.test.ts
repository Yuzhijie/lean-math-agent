import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/read-problem-image/route";
import { encodePng } from "@/lib/bank/import/images";
import { resetGlobalCache } from "@/lib/llm/cache";

// A problem pasted or dropped onto the solving page as an image.

type Msg = { role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> };
let sent: Msg[] = [];
let reply: unknown;

beforeEach(() => {
  process.env.LLM_API_KEY = "k";
  process.env.LLM_BASE_URL = "https://llm.test/v1";
  process.env.LLM_MODEL = "m";
  process.env.LLM_LOG_LEVEL = "silent";
  process.env.LLM_CACHE_ENABLED = "false";
  resetGlobalCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init: RequestInit) => {
      sent = (JSON.parse(String(init.body)) as { messages: Msg[] }).messages;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }), { status: 200 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "LLM_LOG_LEVEL", "LLM_CACHE_ENABLED"]) delete process.env[k];
});

const png = () => Buffer.from(encodePng({ data: new Uint8Array(40 * 30 * 3).fill(200), width: 40, height: 30, channels: 3 }));
const post = (body: Buffer | string, name = "q.png") => {
  const form = new FormData();
  form.set("image", new File([typeof body === "string" ? body : new Uint8Array(body)], name));
  return POST(new Request("http://t/api/read-problem-image", { method: "POST", body: form }));
};

describe("POST /api/read-problem-image", () => {
  it("returns the question text and the figure, and sends the image to the vision model", async () => {
    reply = { readable: true, question: "In the triangle $ABC$, $AB = 5$. Find $BC$.\nA. 3\nB. 4", has_figure: true, figure: "right angle at $C$; $AC = 3$" };
    const res = await post(png());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "In the triangle $ABC$, $AB = 5$. Find $BC$.\nA. 3\nB. 4", figure: "right angle at $C$; $AC = 3$" });
    const user = sent[sent.length - 1];
    expect(JSON.stringify(user.content)).toContain("data:image/");
    expect(JSON.stringify(sent[0].content)).toContain("transcribe the problem text exactly");
  });

  it("no figure, an unreadable image, not an image, nothing sent", async () => {
    reply = { readable: true, question: "2 + 3 = ?", has_figure: false, figure: "" };
    expect(await (await post(png())).json()).toEqual({ text: "2 + 3 = ?" });
    reply = { readable: false, question: "" };
    const bad = await post(png());
    expect(bad.status).toBe(422);
    expect((await bad.json()).error).toMatch(/没有读到|No maths problem/);
    expect((await post("hello", "a.txt")).status).toBe(415);
    expect((await POST(new Request("http://t/api/read-problem-image", { method: "POST", body: new FormData() }))).status).toBe(400);
  });
});
