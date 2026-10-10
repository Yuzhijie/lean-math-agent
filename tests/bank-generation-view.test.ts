import { describe, expect, it } from "vitest";
import { cardStatus, checkIssues, readNdjson } from "@/lib/bank/generation-view";

const ok = (detail = "ok") => ({ ok: true, detail });
const base = { format: ok(), answer: ok("independent answer agrees: B"), novelty: ok(), fit: ok("fit 5/5") };

describe("the generator's card status", () => {
  it("ready, needs a look, failed", () => {
    expect(cardStatus({ passed: true, checks: { ...base, figure: { ok: true, detail: "this question has no figure", skipped: true } } })).toBe("ok");
    expect(cardStatus({ passed: true, checks: { ...base, figure: { ok: true, detail: "此题不需要图形", skipped: true } } })).toBe("ok");
    const review = { ...base, answer: { ok: true, detail: "other answers are not checked automatically; please review", skipped: true } };
    expect(cardStatus({ passed: true, checks: review })).toBe("review");
    expect(checkIssues({ checks: review })).toEqual([{ key: "answer", kind: "review", detail: expect.stringContaining("please review") }]);
    const failed = { ...base, fit: { ok: false, detail: "fit 2/5 — no grid diagram" }, answer: { ok: false, detail: "independent answer is A, not B" }, figure: { ok: true, detail: "the figure was drawn by the model and is not checked; please review", skipped: true } };
    expect(cardStatus({ passed: false, checks: failed })).toBe("failed");
    // failures first (answer before fit), then what to look at
    expect(checkIssues({ checks: failed }).map((i) => `${i.kind}:${i.key}`)).toEqual(["failed:answer", "failed:fit", "review:figure"]);
  });
});

describe("reading streamed lines", () => {
  it("splits lines across chunks and ignores junk", async () => {
    const enc = new TextEncoder();
    const chunks = ['{"type":"progress","de', 'tail":"a"}\n{"type":"ping"}\nnot json\n{"type":"res', 'ult","n":1}'];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const x of chunks) c.enqueue(enc.encode(x));
        c.close();
      },
    });
    const got: Array<Record<string, unknown>> = [];
    await readNdjson(body, (l) => got.push(l));
    expect(got).toEqual([{ type: "progress", detail: "a" }, { type: "ping" }, { type: "result", n: 1 }]);
  });
});
