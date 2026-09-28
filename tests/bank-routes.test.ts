import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Signed-in user for the isolation test; null = not signed in (→ "local").
const session = vi.hoisted(() => ({ user: null as null | { id: string } }));
vi.mock("next-auth", () => ({ getServerSession: async () => (session.user ? { user: session.user } : null) }));

import * as banks from "@/app/api/banks/route";
import * as bankOne from "@/app/api/banks/[id]/route";
import * as items from "@/app/api/banks/[id]/items/route";
import * as itemOne from "@/app/api/banks/[id]/items/[itemId]/route";
import * as categories from "@/app/api/banks/[id]/categories/route";
import * as imports from "@/app/api/banks/[id]/imports/route";
import * as batchOne from "@/app/api/banks/[id]/imports/[batchId]/route";
import * as generate from "@/app/api/banks/[id]/generate/route";
import * as generationOne from "@/app/api/banks/[id]/generations/[generationId]/route";
import * as assets from "@/app/api/banks/[id]/assets/[name]/route";
import * as exporter from "@/app/api/banks/[id]/export/route";
import { _closeAllBanks } from "@/lib/bank/store";
import { resetGlobalCache } from "@/lib/llm/cache";

/** Route context for routes without dynamic segments. */
const NO_PARAMS = { params: Promise.resolve({}) };

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bank-routes-"));
  process.env.BANK_STORE_PATH = root;
  session.user = null;
});
afterEach(() => {
  _closeAllBanks();
  vi.unstubAllGlobals();
  delete process.env.BANK_STORE_PATH;
  for (const v of ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "LLM_LOG_LEVEL", "LLM_CACHE_ENABLED"]) delete process.env[v];
  fs.rmSync(root, { recursive: true, force: true });
});

const ctx = <P extends Record<string, string>>(params: P) => ({ params: Promise.resolve(params) });
const json = (url: string, method: string, body?: unknown) =>
  new Request(`http://t${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
async function call<T = Record<string, unknown>>(p: Promise<Response>): Promise<{ status: number; body: T }> {
  const r = await p;
  const text = await r.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON body (export) */
  }
  return { status: r.status, body: body as T };
}
function upload(url: string, name: string, content: string, extra: Record<string, string> = {}) {
  const form = new FormData();
  form.set("file", new File([content], name));
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  return new Request(`http://t${url}`, { method: "POST", body: form });
}

const PAPER = `# Practice paper

1. What is 3 + 4?
A. 6
B. 7
C. 8
D. 9

2. A rectangle is 5 cm wide and 8 cm long. What is its area?
A. 13 cm²
B. 26 cm²
C. 40 cm²
D. 45 cm²

3. What is 3 + 4?
A. 6
B. 7
C. 8
D. 9

Answers
1. B
2. C
3. B
`;

describe("bank API", () => {
  it("creates a bank, imports, reviews and commits a batch, filters and exports", async () => {
    const created = await call<{ bank: { id: string } }>(banks.POST(json("/api/banks", "POST", { name: "Year 5 practice", language: "en" }), NO_PARAMS));
    expect(created.status).toBe(200);
    const id = created.body.bank.id;

    const up = await call<{ batch: { id: string; drafts: Array<{ status: string; stem: string; options?: string[]; answer?: string }>; report: { total: number; duplicate: number } } }>(
      imports.POST(upload(`/api/banks/${id}/imports`, "paper.md", PAPER), ctx({ id })),
    );
    expect(up.status).toBe(200);
    const batch = up.body.batch;
    expect(batch.report.total).toBe(3);
    // Question 3 repeats question 1 within the file.
    expect(batch.report.duplicate).toBe(1);
    expect(batch.drafts[1].options).toHaveLength(4);
    expect(batch.drafts[1].answer).toBe("C");

    // Edit a draft, then commit — refused without the rights confirmation.
    const drafts = batch.drafts.map((d, i) => (i === 1 ? { ...d, difficulty: 2, knowledge_points: ["Area"] } : d));
    const patched = await call(batchOne.PATCH(json("/x", "PATCH", { drafts }), ctx({ id, batchId: batch.id })));
    expect(patched.status).toBe(200);
    const refused = await call<{ error: string }>(batchOne.POST(json("/x", "POST", { action: "commit", rights_confirmed: false }), ctx({ id, batchId: batch.id })));
    expect(refused.status).toBe(400);
    const committed = await call<{ committed: number }>(batchOne.POST(json("/x", "POST", { action: "commit", rights_confirmed: true }), ctx({ id, batchId: batch.id })));
    expect(committed.body.committed).toBe(2);

    const listed = await call<{ total: number; items: Array<{ id: string; stem: string }> }>(items.GET(new Request(`http://t/api/banks/${id}/items?knowledge_points=Area`), ctx({ id })));
    expect(listed.body.total).toBe(1);
    expect(listed.body.items[0].stem).toContain("rectangle");

    // PATCH sends only the given fields.
    const itemId = listed.body.items[0].id;
    const patchedItem = await call<{ item: { difficulty: number; knowledge_points: string[] } }>(itemOne.PATCH(json("/x", "PATCH", { difficulty: 3 }), ctx({ id, itemId })));
    expect(patchedItem.body.item).toMatchObject({ difficulty: 3, knowledge_points: ["Area"] });

    const detail = await call<{ item_count: number; facets: { knowledge_points: Array<{ value: string }> } }>(bankOne.GET(new Request("http://t"), ctx({ id })));
    expect(detail.body.item_count).toBe(2);
    expect(detail.body.facets.knowledge_points[0].value).toBe("Area");

    // Export → import into a new bank round-trips the questions.
    const exported = await exporter.GET(new Request("http://t"), ctx({ id }));
    const jsonl = await exported.text();
    expect(jsonl.split("\n")[0]).toContain('"kind":"bank"');
    const other = (await call<{ bank: { id: string } }>(banks.POST(json("/api/banks", "POST", { name: "copy" }), NO_PARAMS))).body.bank.id;
    const again = await call<{ batch: { report: { total: number; error: number } } }>(imports.POST(upload(`/api/banks/${other}/imports`, "export.jsonl", jsonl), ctx({ id: other })));
    expect(again.body.batch.report).toMatchObject({ total: 2, error: 0 });

    // The original file was kept as an asset; traversal is refused.
    const bad = await assets.GET(new Request("http://t"), ctx({ id, name: "..%2F..%2Fbank.sqlite" }));
    expect(bad.status).toBe(404);
  });

  it("isolates banks per signed-in account", async () => {
    session.user = { id: "alice" };
    const a = (await call<{ bank: { id: string } }>(banks.POST(json("/api/banks", "POST", { name: "Alice's bank" }), NO_PARAMS))).body.bank.id;
    session.user = { id: "bob" };
    expect((await call<{ banks: unknown[] }>(banks.GET(new Request("http://t/api/banks"), NO_PARAMS))).body.banks).toEqual([]);
    expect((await call(bankOne.GET(new Request("http://t"), ctx({ id: a })))).status).toBe(404);
    session.user = null; // not signed in → the local user, also separate
    expect((await call<{ banks: unknown[] }>(banks.GET(new Request("http://t/api/banks"), NO_PARAMS))).body.banks).toEqual([]);
  });

  it("generates from a style template and adopts a candidate", async () => {
    process.env.LLM_API_KEY = "k";
    process.env.LLM_BASE_URL = "https://llm.test/v1";
    process.env.LLM_MODEL = "m";
    process.env.LLM_LOG_LEVEL = "silent";
    process.env.LLM_CACHE_ENABLED = "false";
    resetGlobalCache();
    const reply = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const system = JSON.parse(String(init.body)).messages[0].content as string;
        if (system.startsWith("You review generated")) return reply({ scores: [{ n: 1, score: 4, reason: "fits" }] });
        if (system.startsWith("You solve math questions independently")) return reply({ answers: [{ n: 1, answer: "B" }] });
        return reply({ questions: [{ stem: "Mia has 24 stickers and gives away 9. How many stickers does she have left?", type: "multiple_choice", options: ["13", "15", "16", "33"], answer: "B", solution: "24 − 9 = 15" }] });
      }),
    );
    const id = (await call<{ bank: { id: string } }>(banks.POST(json("/api/banks", "POST", { name: "ICAS style", language: "en" }), NO_PARAMS))).body.bank.id;
    const cat = await call<{ category: { id: string } }>(
      categories.POST(json("/x", "POST", { name: "Year 3 subtraction", kind: "style", style: { grade: "Year 3", knowledge_points: ["Addition and subtraction"], type: "multiple_choice", option_count: 4, difficulty: 2, language: "en" } }), ctx({ id })),
    );
    const gen = await call<{ generation: { id: string; candidates: Array<{ id: string; stem: string; checks: Record<string, { ok: boolean; skipped?: boolean }> }> } }>(
      generate.POST(json("/x", "POST", { template: { category_id: cat.body.category.id }, count: 1 }), ctx({ id })),
    );
    expect(gen.status).toBe(200);
    const cand = gen.body.generation.candidates[0];
    expect(cand.stem).toContain("stickers");
    expect(cand.checks.format.ok).toBe(true);
    expect(cand.checks.novelty.ok).toBe(true);

    const adopted = await call<{ items: Array<{ origin: string; tags: string[] }> }>(
      generationOne.POST(json("/x", "POST", { candidate_ids: [cand.id], category_id: cat.body.category.id }), ctx({ id, generationId: gen.body.generation.id })),
    );
    expect(adopted.body.items[0].origin).toBe("generated");
    expect(adopted.body.items[0].tags).toContain("generated");
  });

  it("returns clear errors", async () => {
    expect((await call(bankOne.GET(new Request("http://t"), ctx({ id: "nope" })))).status).toBe(404);
    expect((await call(bankOne.GET(new Request("http://t"), ctx({ id: "../etc" })))).status).toBe(400);
    const bad = await call<{ error: string }>(banks.POST(json("/api/banks", "POST", { name: "" }), NO_PARAMS));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/name/);
  });
});
