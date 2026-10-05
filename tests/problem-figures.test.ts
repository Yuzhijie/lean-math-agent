import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodePng } from "@/lib/bank/import/images";
import { _closeAllBanks, createBank, saveAsset } from "@/lib/bank/store";
import { resetGlobalCache } from "@/lib/llm/cache";
import { withOutputLocale } from "@/lib/llm/output-locale";
import { _resetStoreForTests, getSession } from "@/lib/session-store";

// A bank question's figures are read once by the vision model; the
// description is appended to the problem text that every solving step sees.

const { seen } = vi.hoisted(() => ({ seen: { classify: [] as string[], enumerate: [] as string[] } }));

vi.mock("next-auth", () => ({ getServerSession: async () => null }));
vi.mock("@/lib/llm/classify-problem", () => ({
  classifyProblem: vi.fn(async (text: string) => {
    seen.classify.push(text);
    return { problem_type: "computational", confidence: 1, reasoning: "" };
  }),
}));
vi.mock("@/lib/compute/solver", () => ({
  solveComputational: vi.fn().mockResolvedValue({ answer: "20", answer_exact: "20", answer_decimal: 20, cross_validated: true, confidence: 1, methods_used: ["sympy"], solution_steps: ["2(6+4)=20"], method_results: [] }),
}));
vi.mock("@/lib/llm/nl-solution", () => ({ generateNLSolution: vi.fn().mockResolvedValue({ summary: "20", steps: [{ title: "P", content: "2(6+4)=20" }], answer: "20" }) }));
vi.mock("@/lib/llm/enumerate", () => ({
  enumerateMethods: vi.fn(async (text: string) => {
    seen.enumerate.push(text);
    return { methods: [], comparison_summary: "" };
  }),
}));

const { describeProblemFigures, problemWithFigure } = await import("@/lib/bank/problem-figures");
const { POST: solveStream } = await import("@/app/api/solve-stream/route");
const { POST: enumerate } = await import("@/app/api/enumerate/route");

let root: string;
const OWNER = "local";
const ENV = ["BANK_STORE_PATH", "SESSION_STORE_PATH", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "LLM_VISION_MODEL", "LLM_LOG_LEVEL", "LLM_CACHE_ENABLED", "LLM_RETRY_MAX", "LLM_MAX_HTTP_RETRIES"];
const DESCRIPTION = "A rectangle; the top side is labelled 6 cm and the right side 4 cm.";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "problem-figures-"));
  process.env.BANK_STORE_PATH = path.join(root, "banks");
  process.env.SESSION_STORE_PATH = path.join(root, "sessions");
  process.env.LLM_API_KEY = "k";
  process.env.LLM_BASE_URL = "https://llm.test/v1";
  process.env.LLM_MODEL = "text-model";
  process.env.LLM_VISION_MODEL = "vision-model";
  process.env.LLM_LOG_LEVEL = "silent";
  process.env.LLM_CACHE_ENABLED = "false";
  process.env.LLM_RETRY_MAX = "0";
  process.env.LLM_MAX_HTTP_RETRIES = "0";
  resetGlobalCache();
  _resetStoreForTests();
  seen.classify.length = 0;
  seen.enumerate.length = 0;
});
afterEach(() => {
  _closeAllBanks();
  vi.unstubAllGlobals();
  for (const k of ENV) delete process.env[k];
  fs.rmSync(root, { recursive: true, force: true });
});

function bankWithFigure(allow_model = true) {
  const bankId = createBank(OWNER, { name: "B", allow_model }).id;
  const w = 40, h = 30;
  const asset = saveAsset(OWNER, bankId, encodePng({ data: new Uint8Array(w * h * 3).fill(200), width: w, height: h, channels: 3 }), "png");
  return { bankId, figures: [{ bank_id: bankId, asset }] };
}

type Call = { model: string; system: string; user: string; images: string[] };
function fakeVision(fail = false) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { model: string; messages: Array<{ content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }> };
      const last = body.messages[body.messages.length - 1].content;
      calls.push({
        model: body.model,
        system: String(body.messages[0].content),
        user: typeof last === "string" ? last : last.filter((p) => p.type === "text").map((p) => p.text).join(""),
        images: typeof last === "string" ? [] : last.filter((p) => p.type === "image_url").map((p) => p.image_url!.url),
      });
      if (fail) return new Response("this model does not accept images", { status: 400 });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ description: DESCRIPTION, readable: true }) } }] }), { status: 200 });
    }),
  );
  return calls;
}

const PROBLEM = "The rectangle below. What is its perimeter?";
const post = (body: unknown) => new Request("http://t/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("reading a problem's figures", () => {
  it("sends the images to the vision model with the problem text, in the problem's language", async () => {
    const { figures } = bankWithFigure();
    const calls = fakeVision();
    const res = await withOutputLocale("en-US", () => describeProblemFigures({ owner: OWNER, problemText: PROBLEM, figures }));
    expect(res.description).toBe(DESCRIPTION);
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("vision-model");
    expect(calls[0].images).toHaveLength(1);
    expect(calls[0].images[0]).toMatch(/^data:image\/(png|jpeg);base64,/);
    expect(calls[0].user).toContain(PROBLEM);
    expect(calls[0].user).not.toMatch(/Answer in English/);
    expect(problemWithFigure(PROBLEM, DESCRIPTION)).toBe(`${PROBLEM}\n\n【题目图形（由模型从图中读取）】\n${DESCRIPTION}`);
  });

  it("does not send a bank's figures when the bank forbids it, and reports failures instead of throwing", async () => {
    const calls = fakeVision();
    const denied = await describeProblemFigures({ owner: OWNER, problemText: PROBLEM, figures: bankWithFigure(false).figures });
    expect(denied.description).toBeUndefined();
    expect(denied.note).toMatch(/不允许/);
    expect(calls).toHaveLength(0);

    fakeVision(true);
    const failed = await withOutputLocale("en-US", () => describeProblemFigures({ owner: OWNER, problemText: PROBLEM, figures: bankWithFigure().figures }));
    expect(failed.description).toBeUndefined();
    expect(failed.note).toMatch(/LLM_VISION_MODEL/);
  });

  it("cannot read another account's figure", async () => {
    const { figures } = bankWithFigure();
    fakeVision();
    const res = await describeProblemFigures({ owner: "someone-else", problemText: PROBLEM, figures });
    expect(res.description).toBeUndefined();
    expect(res.note).toBeTruthy();
  });
});

describe("solving with figures", () => {
  it("solve-stream reads the figures first and solves the problem with the description", async () => {
    const { figures } = bankWithFigure();
    fakeVision();
    const text = await (await solveStream(post({ problem_text: PROBLEM, figures }))).text();
    const frames = text.split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)) as { type: string; stage?: string; data?: Record<string, unknown> });
    expect(frames[0]).toMatchObject({ type: "progress", stage: "reading_figure" });
    const result = frames.find((f) => f.type === "result")!.data!;
    expect(result.figure_description).toBe(DESCRIPTION);
    // Every later step sees the description.
    expect(seen.classify[0]).toContain(PROBLEM);
    expect(seen.classify[0]).toContain(DESCRIPTION);
    const session = getSession(result.session_id as string)!;
    expect(session.figure_description).toBe(DESCRIPTION);
    expect(session.problem_text).toContain(DESCRIPTION);
  });

  it("solves from the text when the figure cannot be read", async () => {
    const { figures } = bankWithFigure();
    fakeVision(true);
    const text = await (await solveStream(post({ problem_text: PROBLEM, figures }))).text();
    expect(text).toMatch(/reading_figure/);
    expect(text).toMatch(/"type":"result"/);
    expect(seen.classify[0]).toBe(PROBLEM);
  });

  it("without figures nothing is sent to the vision model", async () => {
    const calls = fakeVision();
    await (await solveStream(post({ problem_text: PROBLEM }))).text();
    expect(calls).toHaveLength(0);
    expect(seen.classify[0]).toBe(PROBLEM);
  });

  it("rejects malformed figure references", async () => {
    const res = await solveStream(post({ problem_text: PROBLEM, figures: [{ bank_id: "b", asset: "../../etc/passwd" }] }));
    expect(res.status).toBe(400);
  });

  it("enumerate also uses the description", async () => {
    const { figures } = bankWithFigure();
    fakeVision();
    const res = await enumerate(post({ problem_text: PROBLEM, figures }));
    const body = (await res.json()) as { figure_description?: string };
    expect(body.figure_description).toBe(DESCRIPTION);
    expect(seen.enumerate[0]).toContain(DESCRIPTION);
  });
});
