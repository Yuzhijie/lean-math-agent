import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseHeldout, selectProblems, type HeldoutProblem } from "@/lib/e2e/heldout";
import { needsLeanAttempt, parseRun, rowOf, solved, stopOf, type EvalRow, type RunFile } from "@/lib/e2e/outcome";
import { e2eReport, wilson } from "@/lib/e2e/report";
import { EVAL_HEADER, evalMode, withEvalMode } from "@/lib/eval-mode";
import { allProofs, recallProofs, rememberProof, rememberRepair, readRepairs } from "@/lib/lean/proof-memory";
import { addLearned, readLearned } from "@/lib/lean/auto/learned";
import { runProblem } from "../scripts/e2e-eval";

const find: HeldoutProblem = { id: "nt-01", topic: "number_theory", kind: "find", level: 2, seen_family: true, split: "dev", text: "求最小的正整数 n …", answer: "1470", value: 1470 };
const prove: HeldoutProblem = { id: "al-06", topic: "algebra", kind: "prove", level: 1, seen_family: true, split: "test", text: "证明 …" };

// ── a stand-in for the app ───────────────────────────────────────────────────────────────────

interface Seen {
  method: string;
  url: string;
  evalRun: boolean;
  body: Record<string, unknown>;
}
const seen: Seen[] = [];
const sessions = new Map<string, Record<string, unknown>>();
let busyOnce = false;
let server: http.Server;
let base = "";

/** What the stand-in answers per problem text. */
function solveReply(text: string): { status: number; body: Record<string, unknown>; session: Record<string, unknown> } {
  const metrics = { llm_calls: 3, estimated_cost: 0.02, by_model: { "test/model": {} } };
  if (text.includes("证明")) {
    return {
      status: 200,
      body: { problem_type: "theorem", fully_verified: true, build_status: "ok", lean_proof_attempt: { attempted: true, success: true, strategy: "auto", formal_statement: "theorem t (a b c : ℝ) : a^2+b^2+c^2 ≥ a*b+b*c+c*a := by nlinarith [sq_nonneg (a-b)]" } },
      session: { formal_validated: true, metrics },
    };
  }
  if (text.includes("优化")) {
    // an optimization problem: the Lean step is left to the Lean tab
    return { status: 200, body: { problem_type: "optimization", answer: "1470", lean_proof_attempt: { attempted: false, success: false } }, session: { computation_result: { answer: "1470" }, metrics } };
  }
  if (text.includes("形式化失败")) {
    return { status: 422, body: { error: "autoformalize_failed", detail: "Layer 6: 陈述有反例" }, session: { formal_validated: false, metrics } };
  }
  return {
    status: 200,
    body: { problem_type: "computational", answer: "$n = 1470$", answer_decimal: "1470", lean_proof_attempt: { attempted: true, success: false, statement_accepted: true, formal_statement: "theorem s : True := by sorry", failure_reason: "已尝试：自动化策略组合", limitations: ["最接近的一个证明卡在：unsolved goals"] } },
    session: { computation_result: { answer: "$n = 1470$" }, metrics },
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
      const url = req.url ?? "";
      seen.push({ method: req.method ?? "", url, evalRun: req.headers[EVAL_HEADER] === "1", body });
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (url === "/api/health") return send(200, { ok: true, lean: true });
      if (url === "/api/solve" && req.method === "POST") {
        const id = `s${sessions.size + 1}`;
        if (busyOnce) {
          busyOnce = false;
          sessions.set(id, { id, refused: true });
          return send(429, { error: "too many jobs", session_id: id });
        }
        const r = solveReply(String(body.problem_text));
        sessions.set(id, { id, problem_text: body.problem_text, ...r.session });
        return send(r.status, { session_id: id, ...r.body });
      }
      if (url === "/api/lean-attempt" && req.method === "POST") {
        const attempt = { attempted: true, success: true, strategy: "optimize", statement_accepted: true, formal_statement: "theorem o : IsLeast S 1470 := by decide" };
        const s = sessions.get(String(body.session_id));
        if (s) s.lean_proof_attempt = attempt;
        return send(200, { lean_proof_attempt: attempt, metrics: { llm_calls: 2, estimated_cost: 0.01, by_model: { "test/model": {} } } });
      }
      const m = /^\/api\/session\/(\w+)$/.exec(url);
      if (m && req.method === "GET") return sessions.has(m[1]) ? send(200, sessions.get(m[1])) : send(404, { error: "session not found" });
      if (m && req.method === "DELETE") return send(sessions.delete(m[1]) ? 200 : 404, { ok: true });
      send(404, { error: "not found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const opts = () => ({ base, lean: true, keepSessions: false, timeoutMs: 10_000, headers: {}, busyWaitMs: 5 });

describe("one problem through the app", () => {
  it("a computational problem: one solve with the Lean step, marked as an evaluation run, its session removed", async () => {
    seen.length = 0;
    const row = rowOf(find, await runProblem(find, opts()));
    expect(seen.map((s) => `${s.method} ${s.url.replace(/s\d+$/, ":id")}`)).toEqual(["POST /api/solve", "GET /api/session/:id", "DELETE /api/session/:id"]);
    expect(seen[0]).toMatchObject({ evalRun: true, body: { problem_text: find.text, options: { lean_attempt: true } } });
    expect(sessions.size).toBe(0);
    expect(row).toMatchObject({ status: "done", problem_type: "computational", answer_ok: true, lean_attempted: true, formalized: true, proved: false, cost_usd: 0.02, llm_calls: 3, models: ["test/model"] });
    expect(row.failure).toMatch(/已尝试/);
    expect(stopOf(row)).toBe("not_proved");
    expect(solved(row)).toBe(false);
  });

  it("an optimization problem: the Lean step is started as the Lean tab would, and its cost counts", async () => {
    seen.length = 0;
    const p = { ...find, text: "优化：求最小值" };
    const row = rowOf(p, await runProblem(p, opts()));
    expect(seen.map((s) => s.url.replace(/s\d+$/, ":id"))).toEqual(["/api/solve", "/api/lean-attempt", "/api/session/:id", "/api/session/:id"]);
    expect(seen[1].evalRun).toBe(true);
    expect(row).toMatchObject({ proved: true, strategy: "optimize", answer_ok: true, cost_usd: 0.03, llm_calls: 5 });
    expect(solved(row)).toBe(true);
  });

  it("solve only: nothing is started by hand", async () => {
    seen.length = 0;
    const p = { ...find, text: "优化：求最小值" };
    const row = rowOf(p, await runProblem(p, { ...opts(), lean: false }));
    expect(seen.some((s) => s.url === "/api/lean-attempt")).toBe(false);
    expect(seen[0].body.options).toEqual({ lean_attempt: false });
    expect(stopOf(row)).toBe("no_lean");
  });

  it("a proof problem and a rejected formalization", async () => {
    const proved = rowOf(prove, await runProblem(prove, opts()));
    expect(proved).toMatchObject({ problem_type: "theorem", answer_ok: null, proved: true, formalized: true, strategy: "auto" });
    expect(solved(proved)).toBe(true);
    const p = { ...prove, text: "证不了：形式化失败" };
    // the stand-in answers "证明"-less text as computational unless it says 形式化失败
    const rejected = rowOf(p, await runProblem({ ...p, text: "形式化失败" }, opts()));
    expect(rejected).toMatchObject({ status: "done", problem_type: "theorem", formalized: false, proved: false, lean_attempted: true });
    expect(rejected.failure).toMatch(/反例/);
    expect(stopOf(rejected)).toBe("not_formalized");
  });

  it("waits when the app is busy, and removes the session the refused solve left", async () => {
    busyOnce = true;
    seen.length = 0;
    const row = rowOf(find, await runProblem(find, opts()));
    expect(seen.filter((s) => s.url === "/api/solve")).toHaveLength(2);
    expect(row.status).toBe("done");
    expect(sessions.size).toBe(0);
  });

  it("keeps the session when asked; an unreachable app is an error row, not a wrong answer", async () => {
    await runProblem(find, { ...opts(), keepSessions: true });
    expect(sessions.size).toBe(1);
    sessions.clear();
    const row = rowOf(find, await runProblem(find, { ...opts(), base: "http://127.0.0.1:1" }));
    expect(row).toMatchObject({ status: "error", proved: false, answer_ok: null });
    expect(stopOf(row)).toBe("error");
  });
});

describe("rows", () => {
  it("a proof next to a wrong answer is not a solve", () => {
    const row = rowOf(find, { ms: 10, solve: { status: 200, body: { problem_type: "computational", answer: "1480", lean_proof_attempt: { attempted: true, success: true, strategy: "hammer" } } } });
    expect(row).toMatchObject({ proved: true, answer_ok: false });
    expect(solved(row)).toBe(false);
    expect(stopOf(row)).toBe("proved_wrong_answer");
  });

  it("server errors are errors; the product's own time limit is a verdict", () => {
    expect(rowOf(find, { ms: 1, solve: { status: 502, body: { error: "Invalid LLM JSON" } } })).toMatchObject({ status: "error", error: expect.stringContaining("502") });
    expect(rowOf(find, { ms: 1, solve: { status: 504, body: { error: "time_limit", detail: "超过 40 分钟" } } })).toMatchObject({ status: "done", proved: false, failure: expect.stringContaining("time limit") });
  });

  it("needsLeanAttempt: only a solve that left the Lean step undone", () => {
    expect(needsLeanAttempt({ status: 200, body: { lean_proof_attempt: { attempted: false, success: false } } })).toBe(true);
    expect(needsLeanAttempt({ status: 200, body: { lean_proof_attempt: { attempted: true, success: false } } })).toBe(false);
    expect(needsLeanAttempt({ status: 200, body: { fully_verified: true } })).toBe(false);
    expect(needsLeanAttempt({ status: 422, body: {} })).toBe(false);
  });
});

describe("the set and its selection", () => {
  const mk = (id: string, topic: string, split: "dev" | "test") => ({ id, topic, kind: "prove", split, text: `证明 ${id}` });
  const doc = { name: "t", problems: [...Array.from({ length: 12 }, (_, i) => mk(`a${i}`, "algebra", i % 3 ? "test" : "dev")), ...Array.from({ length: 6 }, (_, i) => mk(`g${i}`, "geometry", i % 3 ? "test" : "dev"))] };

  it("validates: ids once, an answer where one is asked for", () => {
    expect(() => parseHeldout(JSON.stringify({ name: "t", problems: [mk("x", "a", "dev"), mk("x", "a", "dev")] }))).toThrow(/duplicate id x/);
    expect(() => parseHeldout(JSON.stringify({ name: "t", problems: [{ ...mk("y", "a", "dev"), kind: "find" }] }))).toThrow(/y asks for a value/);
    expect(() => parseHeldout(JSON.stringify({ name: "t", problems: [{ ...mk("z", "a", "dev"), answer: "1", value: 1 }] }))).toThrow(/z is a claim to prove/);
  });

  it("the hash follows the content, not the labels", () => {
    const a = parseHeldout(JSON.stringify(doc));
    const relabelled = parseHeldout(JSON.stringify({ ...doc, problems: doc.problems.map((p) => ({ ...p, level: 3, seen_family: true })) }));
    const moved = parseHeldout(JSON.stringify({ ...doc, problems: doc.problems.map((p, i) => (i ? p : { ...p, split: "test" })) }));
    expect(relabelled.hash).toBe(a.hash);
    expect(moved.hash).not.toBe(a.hash);
  });

  it("selects by split / topic / ids and samples every group evenly, the same way every time", () => {
    const set = parseHeldout(JSON.stringify(doc));
    expect(selectProblems(set, { split: "dev" })).toHaveLength(6);
    expect(selectProblems(set, { topics: ["geometry"], split: "test" }).map((p) => p.id)).toEqual(["g1", "g2", "g4", "g5"]);
    expect(selectProblems(set, { ids: ["g0", "a3"] }).map((p) => p.id)).toEqual(["a3", "g0"]);
    const s = selectProblems(set, { sample: 9 });
    expect(s).toHaveLength(9);
    expect(s.filter((p) => p.topic === "algebra")).toHaveLength(6);
    expect(s.filter((p) => p.split === "dev")).toHaveLength(3);
    expect(selectProblems(set, { sample: 9 }).map((p) => p.id)).toEqual(s.map((p) => p.id));
    expect(selectProblems(set, { limit: 2 })).toHaveLength(2);
  });
});

describe("run files and the report", () => {
  const row = (id: string, o: Partial<EvalRow>): EvalRow => ({ id, split: "test", topic: "algebra", kind: "find", level: 2, seen_family: false, status: "done", answer_ok: true, lean_attempted: true, formalized: true, proved: true, strategy: "whole_proof", ms: 60_000, cost_usd: 0.1, models: ["m"], ...o });
  const meta = (at: string) => ({ type: "run" as const, at, set: "heldout-zh-v1", set_hash: "abcdef123456", set_size: 120, selected: 6, base: "http://localhost:3000", commit: "0123456789", lean: true, args: [] });
  const first: RunFile = {
    file: "a",
    meta: meta("2026-11-12T01:00:00.000Z"),
    rows: [row("al-01", { split: "dev", seen_family: true, strategy: "auto" }), row("al-02", { split: "dev", proved: false, failure: "已尝试：…；最接近的一个证明卡在：unsolved goals" }), row("al-03", {}), row("al-04", { proved: false, formalized: false }), row("ge-01", { topic: "geometry", answer_ok: false, answer: "√6", proved: false }), row("ge-02", { topic: "geometry", status: "error", error: "no answer after 60 min", proved: false, formalized: false, answer_ok: null })],
    ended: { at: "2026-11-12T02:00:00.000Z", wall_ms: 3_600_000 },
  };
  const second: RunFile = { ...first, file: "b", meta: meta("2026-11-13T01:00:00.000Z"), rows: first.rows.map((r) => (r.id === "al-02" || r.id === "al-04" ? { ...r, proved: true, formalized: true, strategy: "optimize", failure: undefined } : r.id === "al-03" ? { ...r, proved: false } : r)) };

  it("parses a run: the last row of an id wins, a line cut off by a crash is skipped", () => {
    const text = [JSON.stringify(first.meta), JSON.stringify(row("x", { status: "error" })), JSON.stringify(row("x", { retried: true })), '{"id":"y","spl', JSON.stringify({ type: "end", at: "t", wall_ms: 5 })].join("\n");
    const r = parseRun("f", text)!;
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ id: "x", status: "done", retried: true });
    expect(r.ended).toMatchObject({ wall_ms: 5 });
    expect(parseRun("f", '{"id":"x"}')).toBeUndefined();
  });

  it("wilson interval", () => {
    const [lo, hi] = wilson(40, 80);
    expect(lo).toBeGreaterThan(38.5);
    expect(lo).toBeLessThan(40);
    expect(hi).toBeGreaterThan(60);
    expect(hi).toBeLessThan(61.5);
    expect(wilson(0, 0)).toEqual([0, 0]);
  });

  it("reports the headline, the funnel, families, who proves and where it stops", () => {
    const md = e2eReport([first]);
    expect(md).toContain("**端到端解决 2/6（33%）**");
    expect(md).toMatch(/留出（test） \| 4 \| 2\/3（67%） \| 2\/4（50%） \| 1\/4（25%） \| \*\*1\/4（25%）\*\*/);
    expect(md).toMatch(/见过的题型 \| 1 /);
    expect(md).toContain("程序自己写的 1 个（不调模型），证明记忆重放 0 个，模型写的 1 个");
    expect(md).toMatch(/答案错 \| 1 \| 17%/);
    expect(md).toMatch(/运行出错（无结论） \| 1 /);
    expect(md).toContain("总花费 $0.600");
  });

  it("lists dev problems one by one and never a test problem", () => {
    const md = e2eReport([first]);
    expect(md).toMatch(/\| al-02 \| 代数 .*卡在：unsolved goals/);
    expect(md).not.toMatch(/al-03|al-04|ge-01|ge-02/);
  });

  it("compares with the previous run on the same set: test problems only as counts", () => {
    const md = e2eReport([second, first]);
    expect(md).toContain("与上一次（2026-11-12 01:00）相比");
    expect(md).toContain("端到端解决 2/6（33%） → 3/6（50%）；新解决 2 题，丢掉 1 题");
    expect(md).toContain("dev 新解决：al-02。");
    expect(md).toContain("test：新解决 1 题，丢掉 1 题（不列题号）。");
    // a run on another version of the set is not compared
    const other = e2eReport([second, { ...first, meta: { ...first.meta, set_hash: "ffffffffffff" } }]);
    expect(other).not.toContain("与上一次");
  });

  it("says what to do when there is no run yet", () => {
    expect(e2eReport([])).toContain("npm run e2e -- --sample 24");
  });
});

describe("evaluation mode leaves what the system has learned alone", () => {
  const proof = { theoremName: "t1", theoremType: "(n : ℕ) : n + 0 = n", tactics: "simp", source: "solve" };

  it("nothing is remembered, no use is counted, no rule is learned inside the scope", async () => {
    expect(evalMode()).toBe(false);
    await withEvalMode(async () => {
      expect(evalMode()).toBe(true);
      expect(await rememberProof(proof)).toBeUndefined();
      expect(await rememberRepair({ theorem_name: "t", theorem_type: "T", failed_tactics: "omega", feedback: "x", fixed_tactics: "simp", source: "solve" })).toBe(false);
      expect(addLearned({ goal: "n : ℕ\n⊢ n + 0 = n", tactics: "simp", source: "solve" })).toBe(false);
      // the scope reaches work left running in the background
      await new Promise<void>((done) => setTimeout(() => void rememberProof({ ...proof, theoremName: "t2" }).then(() => done()), 5));
    });
    expect(await allProofs()).toHaveLength(0);
    expect(await readRepairs()).toHaveLength(0);
    expect(readLearned()).toHaveLength(0);
  });

  it("the memory is still read, without touching it", async () => {
    expect(await rememberProof(proof)).toBeDefined();
    const hits = await withEvalMode(() => recallProofs({ theoremType: "(m : ℕ) : m + 0 = m" }));
    expect(hits).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 20));
    expect((await allProofs())[0].uses).toBe(0);
    await recallProofs({ theoremType: "(m : ℕ) : m + 0 = m" });
    expect((await allProofs())[0].uses).toBe(1);
  });
});

describe("npm run e2e", () => {
  it("runs the selection against the app, writes the run file and the report, and resumes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "e2e-"));
    const setFile = path.join(dir, "set.json");
    writeFileSync(setFile, JSON.stringify({ name: "mini", problems: [find, prove, { ...find, id: "nt-02", split: "test", text: "优化：求最小值" }] }));
    const out = path.join(dir, "run.jsonl");
    const report = path.join(dir, "E2E.md");
    // not execFileSync: the stand-in app lives in this process and has to answer meanwhile
    const run = async (...extra: string[]) => (await promisify(execFile)("npx", ["tsx", "scripts/e2e-eval.ts", "--base", base, "--set", setFile, "--report", report, ...extra], { encoding: "utf8", cwd: process.cwd(), env: { ...process.env } })).stdout;
    const listed = await run("--list", "--split", "dev");
    expect(listed).toMatch(/1 of 3 problems/);
    const stdout = await run("--out", out, "--ids", "nt-01,al-06");
    expect(stdout).toMatch(/Solved end to end: 1\/2 \(50%\)/);
    const first = parseRun(out, readFileSync(out, "utf8"))!;
    expect(first.meta).toMatchObject({ set: "mini", selected: 2, lean: true });
    expect(first.rows.map((r) => r.id).sort()).toEqual(["al-06", "nt-01"]);
    expect(first.ended).toBeDefined();
    expect(readFileSync(report, "utf8")).toContain("**端到端解决 1/2（50%）**");
    // resume with a wider selection: only the new problem is run
    seen.length = 0;
    const again = await run("--resume", out, "--split", "all");
    expect(again).toMatch(/Resuming: 2 already done, 1 to go/);
    expect(seen.filter((s) => s.url === "/api/solve")).toHaveLength(1);
    expect(parseRun(out, readFileSync(out, "utf8"))!.rows).toHaveLength(3);
    expect(sessions.size).toBe(0);
  }, 120_000);
});
