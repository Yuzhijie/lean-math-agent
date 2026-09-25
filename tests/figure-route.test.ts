import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateMock } = vi.hoisted(() => ({ generateMock: vi.fn() }));
vi.mock("@/lib/figure/generate", () => ({ generateFigure: generateMock }));

import { POST } from "@/app/api/figure/route";
import { createSession, getSession, updateSession } from "@/lib/session-store";
import type { SolvedFigure } from "@/lib/figure/spec";

const FIG = { spec: { needed: true, constructions: [], draw: [], claims: [], functions: [], hidden_points: [], step_highlights: [] }, points: {}, circles: {}, claims: [], verified: true, warnings: [] } as unknown as SolvedFigure;
const post = (body: unknown) => POST(new Request("http://x/api/figure", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }));

beforeEach(() => {
  generateMock.mockReset();
});

describe("POST /api/figure", () => {
  it("generates a figure for a session, passes the NL solution and caches it", async () => {
    const s = createSession("等腰三角形 ABC 中 AB=AC");
    updateSession(s.id, { nl_solution: { summary: "s", steps: [{ title: "t", content: "c" }], final_answer: "4", verification: "" } });
    generateMock.mockResolvedValue({ figure: FIG, attempts: 1 });
    const r1 = await post({ session_id: s.id });
    expect(r1.status).toBe(200);
    expect((await r1.json()).figure.verified).toBe(true);
    expect(generateMock.mock.calls[0][0]).toMatchObject({ problemText: "等腰三角形 ABC 中 AB=AC", solution: { final_answer: "4" } });
    expect(getSession(s.id)?.figure).toBeDefined();
    const r2 = await post({ session_id: s.id });
    expect((await r2.json()).cached).toBe(true);
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("reports problems that need no figure, bad input and LLM failures", async () => {
    generateMock.mockResolvedValue({ reason: "not_needed", attempts: 0 });
    const r = await post({ problem_text: "计算 1+1" });
    expect(await r.json()).toMatchObject({ figure: null, reason: "not_needed" });
    expect((await post({})).status).toBe(400);
    expect((await post({ session_id: "nope" })).status).toBe(404);
    generateMock.mockRejectedValue(new Error("boom"));
    expect((await post({ problem_text: "圆 O" })).status).toBe(502);
  });
});
