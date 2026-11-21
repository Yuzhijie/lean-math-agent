import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ chatJson: vi.fn(), generateProblems: vi.fn(), generateFromTemplate: vi.fn() }));
vi.mock("next-auth", () => ({ getServerSession: async () => null })); // the local single user
vi.mock("@/lib/llm/client", async (orig) => ({ ...(await orig<typeof import("@/lib/llm/client")>()), chatJson: m.chatJson }));
vi.mock("@/lib/llm/generate-problem", async (orig) => ({ ...(await orig<typeof import("@/lib/llm/generate-problem")>()), generateProblems: m.generateProblems }));
vi.mock("@/lib/bank/generate", async (orig) => ({ ...(await orig<typeof import("@/lib/bank/generate")>()), generateFromTemplate: m.generateFromTemplate }));

const store = await import("@/lib/grading/store");
const { bootId } = await import("@/lib/boot");
const { choiceLetter, fromBuiltin, fromCandidate, reconcile, runExam, splitChoice } = await import("@/lib/exam/run");
const service = await import("@/lib/exam/service");
const { runPaper } = await import("@/lib/grading/paper-run");
const examsRoute = await import("@/app/api/exams/route");
const examRoute = await import("@/app/api/exams/[id]/route");
const fillRoute = await import("@/app/api/exams/[id]/fill/route");
const planRoute = await import("@/app/api/exams/plan/route");
const paperRoute = await import("@/app/api/grading/papers/[id]/route");
const remarkRoute = await import("@/app/api/grading/submissions/[id]/remark/route");
import type { Exam, ExamPart, ExamQuestion } from "@/lib/exam/types";
import type { PartWriter } from "@/lib/exam/run";
import type { Candidate } from "@/lib/bank/types";
import type { GeneratedProblem } from "@/lib/types";
import type { Marking, Paper, Submission } from "@/lib/grading/types";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "exam-"));
  process.env.GRADING_STORE_PATH = dir;
  process.env.QUOTA_DB_PATH = path.join(dir, "usage.db");
  process.env.GENERATION_LOG = "off";
  store._resetGradingStore();
  for (const f of Object.values(m)) f.mockReset();
});
afterEach(async () => {
  delete process.env.EXAM_PART_CONCURRENCY;
  await fs.rm(dir, { recursive: true, force: true });
});

const part = (id: string, kind: ExamPart["kind"], count: number, extra: Partial<ExamPart> = {}): ExamPart => ({
  id,
  kind,
  count,
  points: kind === "solve" ? 10 : 4,
  difficulty: 2,
  knowledge_points: [`kp-${id}`],
  source: { kind: "builtin", domain: "algebra" },
  like: [],
  ...extra,
});
const question = (p: ExamPart, n: number): ExamQuestion => ({
  id: `${p.id}-${n}`,
  no: "",
  part_id: p.id,
  kind: p.kind,
  stem: `${p.id} 第 ${n} 题`,
  answer: String(n),
  hints: [],
  knowledge_points: p.knowledge_points,
  difficulty: p.difficulty,
  points: p.points,
  source: { kind: "builtin" },
});
const exam = (parts: ExamPart[], extra: Partial<Exam> = {}): Exam =>
  store.putExamDoc({ id: "e1", owner: "local", title: "单元测验", grade_level: "middle", parts, questions: [], rejected: [], status: "generating", run: bootId(), created_at: 1, updated_at: 1, ...extra });
/** A writer that writes `got(part)` questions of each part (all it needs by default). */
const writer =
  (got: (p: ExamPart, need: number) => number = (_p, need) => need): PartWriter =>
  async (p, need) => ({
    questions: Array.from({ length: got(p, need) }, (_, i) => question(p, i + 1)),
    rejected: got(p, need) < need ? [{ part_id: p.id, stem: "没过的题", answer: "?", reason: "独立重解不一致" }] : [],
  });

describe("writing a paper's parts", () => {
  it("numbers the questions across sections in kind order and ends ready", async () => {
    const parts = [part("s", "solve", 1), part("c", "choice", 2), part("b", "blank", 1), part("c2", "choice", 1)];
    exam(parts);
    const done = (await runExam("e1", { write: writer() }))!;
    expect(done.status).toBe("ready");
    expect(done.progress).toBeUndefined();
    expect(done.note).toBeUndefined();
    expect(done.questions.map((q) => `${q.no}:${q.part_id}`)).toEqual(["1:c", "2:c", "3:c2", "4:b", "5:s"]);
  });

  it("a part short of questions or one that throws leaves the paper partial with the reasons; none at all = failed", async () => {
    process.env.EXAM_PART_CONCURRENCY = "1";
    exam([part("a", "choice", 3), part("b", "blank", 2), part("c", "solve", 1)]);
    const write: PartWriter = async (p, need, e, say) => {
      say("写题中");
      if (p.id === "c") throw new Error("模型超时");
      return writer((q) => (q.id === "a" ? 2 : 2))(p, need, e, say);
    };
    const done = (await runExam("e1", { write }))!;
    expect(done.status).toBe("partial");
    expect(done.questions).toHaveLength(4);
    expect(done.rejected).toEqual([{ part_id: "a", stem: "没过的题", answer: "?", reason: "独立重解不一致" }]);
    expect(done.note).toContain("第 3 部分出题失败：模型超时");
    expect(done.note).toContain("第 1 部分缺 1 道");
    expect(done.note).not.toContain("第 3 部分缺"); // said once, with its reason

    store._resetGradingStore();
    exam([part("a", "choice", 1)]);
    expect((await runExam("e1", { write: writer(() => 0) }))!.status).toBe("failed");

    // every part failing for the same reason: one line
    store._resetGradingStore();
    exam([part("a", "choice", 1), part("b", "blank", 1), part("c", "solve", 1)]);
    const none = (await runExam("e1", { write: async () => Promise.reject(new Error("LLM_API_KEY is not set")) }))!;
    expect(none.status).toBe("failed");
    expect(none.note).toBe("3 个部分出题失败：LLM_API_KEY is not set");
  });

  it("fills only what is missing, and a finished fill drops the old note", async () => {
    const parts = [part("a", "choice", 2), part("b", "solve", 2)];
    exam(parts, { questions: [question(parts[0], 1), question(parts[0], 2), question(parts[1], 1)], status: "partial", note: "生成被中断" });
    const write = vi.fn(writer());
    const done = (await runExam("e1", { write }))!;
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0].slice(0, 2)).toEqual([parts[1], 1]);
    expect(done.status).toBe("ready");
    expect(done.note).toBeUndefined();
    expect(done.questions.map((q) => q.no)).toEqual(["1", "2", "3", "4"]);
  });

  it("a stop finishes the part being written and starts no other; a deleted exam ends the run", async () => {
    process.env.EXAM_PART_CONCURRENCY = "1";
    exam([part("a", "choice", 1), part("b", "blank", 1), part("c", "solve", 1)]);
    const write = vi.fn<PartWriter>(async (p, need, e, say) => {
      service.changeExam("local", "e1", { cancel: true });
      return writer()(p, need, e, say);
    });
    const done = (await runExam("e1", { write }))!;
    expect(write).toHaveBeenCalledTimes(1);
    expect(done.status).toBe("cancelled");
    expect(done.questions).toHaveLength(1);
    expect(done.note).toContain("老师停止了生成");
    expect(done.note).toContain("第 2 部分缺 1 道");

    store._resetGradingStore();
    exam([part("a", "choice", 1), part("b", "blank", 1)]);
    const del = vi.fn<PartWriter>(async (p, need, e, say) => {
      store.deleteExamDoc("local", "e1");
      return writer()(p, need, e, say);
    });
    process.env.EXAM_PART_CONCURRENCY = "1";
    expect(await runExam("e1", { write: del })).toBeUndefined();
    expect(del).toHaveBeenCalledTimes(1);
    expect(store.examDoc("e1")).toBeUndefined();
  });

  it("a run of an earlier server process was interrupted: partial (or failed) with a note, when the exam is next read", () => {
    const parts = [part("a", "choice", 2)];
    exam(parts, { run: "an-earlier-run", questions: [question(parts[0], 1)], progress: { part: 0, parts: 1, message: "…" } });
    const r = reconcile(store.examDoc("e1")!);
    expect(r).toMatchObject({ status: "partial" });
    expect(r.progress).toBeUndefined();
    expect(r.note).toContain("缺 1 道题");
    expect(store.examDoc("e1")!.status).toBe("partial");
    // a run of this process is left alone
    exam(parts, { id: "e2" });
    expect(reconcile(store.examDoc("e2")!).status).toBe("generating");
  });
});

describe("generated problems as questions", () => {
  it("splits a choice question into its stem and options and keeps the letter", () => {
    expect(splitChoice("下列哪个数是质数？\nA. 4\nB. 7\nC. 9\nD. 15\n")).toEqual({ stem: "下列哪个数是质数？", options: ["4", "7", "9", "15"] });
    expect(splitChoice("$x^2=4$ 的解是\n(A) 2　(B) −2　(C) ±2　(D) 4".replace(/　/g, "  "))).toEqual({ stem: "$x^2=4$ 的解是", options: ["2", "−2", "±2", "4"] });
    expect(splitChoice("计算 1 + 2")).toEqual({ stem: "计算 1 + 2" });
    expect(splitChoice("题\nB. 1\nC. 2")).toEqual({ stem: "题\nB. 1\nC. 2" }); // not A, B, …
    expect(choiceLetter("B", 4)).toBe("B");
    expect(choiceLetter("（c）. 9", 4)).toBe("C");
    expect(choiceLetter("E", 4)).toBeUndefined();
    expect(choiceLetter("Because 7 is prime", 4)).toBeUndefined();
  });

  it("a built-in problem: the part's kind, skills, points; its checks in words", () => {
    const p = part("c", "choice", 1, { points: 5, knowledge_points: ["质数"], difficulty: 3 });
    const g = {
      id: "g1",
      statement: "下列哪个数是质数？\nA. 4\nB. 7\nC. 9\nD. 15",
      answer: "B. 7",
      hints: ["试除"],
      diagram_svg: "<svg/>",
      verification: { passed: true, checks: { answer: { ok: true, detail: "" }, counterexample: { ok: true, detail: "" } }, lean: { proved: true } },
    } as unknown as GeneratedProblem;
    const q = fromBuiltin(g, p);
    expect(q).toMatchObject({ part_id: "c", kind: "choice", stem: "下列哪个数是质数？", options: ["4", "7", "9", "15"], answer: "B", points: 5, difficulty: 3, knowledge_points: ["质数"], figure_svg: "<svg/>", lean_proved: true, source: { kind: "builtin" } });
    expect(q.checked).toBe("独立重解一致 · Lean 未找到反例 · Lean 已证");
    // options the program cannot find: left as written
    expect(fromBuiltin({ ...g, statement: "哪个是质数？4、7、9" } as GeneratedProblem, p)).toMatchObject({ stem: "哪个是质数？4、7、9", answer: "B. 7" });
    expect(fromBuiltin({ ...g, statement: "解方程 x + 1 = 3", answer: "x = 2" } as GeneratedProblem, part("s", "solve", 1)).options).toBeUndefined();
  });

  it("a bank candidate: its kind follows the template's type", () => {
    const c = { id: "cand1", type: "multiple_choice", stem: "3 + 4 = ?", options: ["6", "7", "8", "9"], answer: "B. 7", hints: [], knowledge_points: ["加法"], difficulty: 1, solution: "3 + 4 = 7", passed: true, checks: {} } as unknown as Candidate;
    expect(fromCandidate(c, part("x", "solve", 1, { knowledge_points: [] }), "bk", "gen")).toMatchObject({
      kind: "choice",
      options: ["6", "7", "8", "9"],
      answer: "B",
      solution: "3 + 4 = 7",
      knowledge_points: ["加法"],
      difficulty: 1,
      points: 10,
      source: { kind: "bank", bank_id: "bk", generation_id: "gen", candidate_id: "cand1" },
    });
  });
});

const passed = (statement: string, answer: string): GeneratedProblem =>
  ({ id: statement, statement, answer, hints: [], verification: { passed: true, checks: { answer: { ok: true, detail: "" }, counterexample: { ok: true, detail: "" } } } }) as unknown as GeneratedProblem;
const failed = (statement: string): GeneratedProblem =>
  ({ id: statement, statement, answer: "?", hints: [], verification: { passed: false, checks: { answer: { ok: false, detail: "独立重解得 5" }, counterexample: { ok: true, detail: "" } } } }) as unknown as GeneratedProblem;

const ctx = <P extends Record<string, string>>(params: P) => ({ params: Promise.resolve(params) });
const NO_PARAMS = { params: Promise.resolve({}) };
const req = (url: string, method: string, body?: unknown) => new Request(`http://t${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
async function call<T = Record<string, unknown>>(p: Promise<Response>): Promise<{ status: number; body: T }> {
  const r = await p;
  return { status: r.status, body: (await r.json()) as T };
}
const settled = async (id: string) => {
  await vi.waitFor(() => expect(store.examDoc(id)!.status).not.toBe("generating"), { timeout: 3000 });
  return store.examDoc(id)!;
};

describe("the exam routes", () => {
  const blueprint = {
    title: "期中测验",
    grade_level: "middle",
    parts: [
      { id: "x", kind: "choice", count: 2, points: 4, difficulty: 2, knowledge_points: ["质数"], source: { kind: "builtin", domain: "number_theory" } },
      { id: "y", kind: "solve", count: 1, points: 10, difficulty: 3, knowledge_points: ["一元一次方程"], source: { kind: "builtin", domain: "algebra" }, like: ["解方程 2x + 1 = 7"] },
    ],
  };

  it("creates an exam and writes it in the background with each part's focus; lists, reads, renames, removes, fills, deletes", async () => {
    m.generateProblems.mockImplementation(async (o: { count: number; focus: { kind: string } }) => ({
      problems: o.focus.kind === "choice" ? [passed("哪个是质数？\nA. 4\nB. 7\nC. 9\nD. 8", "B"), failed("坏题"), passed("哪个是偶数？\nA. 3\nB. 5\nC. 6\nD. 9", "C")] : [passed("解方程 3x − 2 = 7", "x = 3")],
      requested: o.count,
    }));
    const created = await call<{ exam: Exam }>(examsRoute.POST(req("/api/exams", "POST", { blueprint }), NO_PARAMS));
    expect(created.status).toBe(200);
    const id = created.body.exam.id;
    expect(created.body.exam.parts.map((p) => p.id)).not.toContain("x"); // new part ids
    const e = await settled(id);
    expect(e.status).toBe("ready");
    expect(e.questions.map((q) => [q.no, q.kind, q.answer, q.points])).toEqual([
      ["1", "choice", "B", 4],
      ["2", "choice", "C", 4],
      ["3", "solve", "x = 3", 10],
    ]);
    expect(e.rejected).toEqual([expect.objectContaining({ stem: "坏题", reason: "独立重解得 5" })]);
    const calls = m.generateProblems.mock.calls.map((c) => c[0]);
    expect(calls.find((c) => c.focus.kind === "solve")).toMatchObject({ gradeLevel: "middle", domain: "algebra", count: 1, focus: { knowledge_points: ["一元一次方程"], difficulty: 3, like: ["解方程 2x + 1 = 7"] } });
    expect(calls.find((c) => c.focus.kind === "choice")).toMatchObject({ domain: "number_theory", count: 2 });

    const list = await call<{ exams: { id: string; total: number; questions: number; planned: number }[] }>(examsRoute.GET(req("/api/exams", "GET"), NO_PARAMS));
    expect(list.body.exams).toEqual([expect.objectContaining({ id, total: 18, questions: 3, planned: 3 })]);

    const removed = await call<{ exam: Exam }>(examRoute.PATCH(req(`/api/exams/${id}`, "PATCH", { remove_question: e.questions[0].id, title: " 期中测验（修订） " }), ctx({ id })));
    expect(removed.body.exam).toMatchObject({ status: "partial", title: "期中测验（修订）" });
    expect(removed.body.exam.questions.map((q) => q.no)).toEqual(["1", "2"]);

    m.generateProblems.mockImplementation(async () => ({ problems: [passed("哪个是奇数？\nA. 2\nB. 4\nC. 5\nD. 8", "C")], requested: 1 }));
    expect((await call(fillRoute.POST(req(`/api/exams/${id}/fill`, "POST"), ctx({ id })))).status).toBe(200);
    expect((await settled(id)).status).toBe("ready");
    // nothing missing → 400
    expect((await call(fillRoute.POST(req(`/api/exams/${id}/fill`, "POST"), ctx({ id })))).status).toBe(400);
    expect((await call<{ exam: Exam }>(examRoute.GET(req(`/api/exams/${id}`, "GET"), ctx({ id })))).body.exam.questions).toHaveLength(3);

    expect((await call(examRoute.DELETE(req(`/api/exams/${id}`, "DELETE"), ctx({ id })))).status).toBe(200);
    expect((await call(examRoute.GET(req(`/api/exams/${id}`, "GET"), ctx({ id })))).status).toBe(404);
  });

  it("one exam at a time; a domain the level does not offer, an unknown bank or a bank closed to the model are refused", async () => {
    const waiting: (() => void)[] = [];
    const release = () => waiting.splice(0).forEach((r) => r());
    m.generateProblems.mockImplementation(() => new Promise((r) => waiting.push(() => r({ problems: [], requested: 1 }))));
    const first = await call<{ exam: Exam }>(examsRoute.POST(req("/api/exams", "POST", { blueprint }), NO_PARAMS));
    expect((await call(examsRoute.POST(req("/api/exams", "POST", { blueprint }), NO_PARAMS))).status).toBe(409);
    await vi.waitFor(() => expect(m.generateProblems).toHaveBeenCalled());
    // stop it: the part being written finishes, then it is cancelled
    expect((await call<{ exam: Exam }>(examRoute.PATCH(req(`/api/exams/${first.body.exam.id}`, "PATCH", { cancel: true }), ctx({ id: first.body.exam.id })))).body.exam.status).toBe("cancelled");
    release();
    await vi.waitFor(() => expect(store.examDoc(first.body.exam.id)!.note).toContain("缺"));
    expect(store.examDoc(first.body.exam.id)!.status).toBe("cancelled");

    const high = { ...blueprint, grade_level: "high", parts: [{ ...blueprint.parts[0], source: { kind: "builtin", domain: "word_problem" } }] };
    const r1 = await call<{ error: string }>(examsRoute.POST(req("/api/exams", "POST", { blueprint: high }), NO_PARAMS));
    expect(r1.status).toBe(400);
    expect(r1.body.error).toContain("第 1 部分");
    const bank = { ...blueprint, parts: [{ ...blueprint.parts[0], source: { kind: "bank", bank_id: "nope" } }] };
    expect((await call(examsRoute.POST(req("/api/exams", "POST", { blueprint: bank }), NO_PARAMS))).status).toBe(404);
    expect((await call(examsRoute.POST(req("/api/exams", "POST", { blueprint: { title: "x" } }), NO_PARAMS))).status).toBe(400);
  });
});

// ── marked work → the next paper, and a paper of an exam marked against it ───

const marking = (over: Partial<Marking> = {}): Marking => ({
  verdict: "correct",
  answer_correct: true,
  answer_check: "program",
  approach: "",
  approach_valid: true,
  steps: [],
  first_error_step: null,
  error_types: [],
  feedback: "",
  knowledge_points: [],
  score: 100,
  ...over,
});
let sid = 0;
const putSub = (memberId: string, classId: string, verdict: Marking["verdict"], kps: string[], extra: Partial<Submission> = {}) =>
  store.putSubmission({
    id: `sub${++sid}`,
    class_id: classId,
    member_id: memberId,
    submitted_by: "local",
    problem: { text: `题 ${sid}` },
    reference: { source: "teacher", answer: "1" },
    images: [],
    status: "marked",
    marking: marking({ verdict, knowledge_points: kps, score: verdict === "correct" ? 100 : 20 }),
    created_at: 100 + sid,
    ...extra,
  });

describe("planning the next paper from marked work", () => {
  it("a student's plan aims at the weak skills; the class's at what most students are weak on; teacher only", async () => {
    const cls = store.ensureTeacherGroup("local", "王老师");
    const ming = store.addMember("local", cls.id, "小明");
    const hong = store.addMember("local", cls.id, "小红");
    putSub(ming.id, cls.id, "incorrect", ["分数加减"], { problem: { text: "计算 1/2 + 1/3" }, difficulty: 2 });
    putSub(ming.id, cls.id, "incorrect", ["分数加减"], { problem: { text: "计算 2/5 + 1/4" } });
    putSub(ming.id, cls.id, "correct", ["一元一次方程"]);
    putSub(ming.id, cls.id, "correct", ["一元一次方程"]);
    putSub(hong.id, cls.id, "incorrect", ["分数加减"]);

    const r = await call<{ blueprint: { title: string; grade_level: string; parts: ExamPart[] }; basis: { scope: string; member_id: string; submissions: number }; records: { knowledge_point: string; level: string }[]; total: number }>(
      planRoute.POST(req("/api/exams/plan", "POST", { member_id: ming.id, questions: 6, grade_level: "elementary" }), NO_PARAMS),
    );
    expect(r.status).toBe(200);
    expect(r.body.blueprint.title).toMatch(/^小明 · 针对性练习卷/);
    expect(r.body.blueprint.grade_level).toBe("elementary");
    expect(r.body.basis).toMatchObject({ scope: "member", member_id: ming.id, submissions: 4 });
    expect(r.body.records.map((x) => [x.knowledge_point, x.level])).toEqual([
      ["分数加减", "not_yet"],
      ["一元一次方程", "mastered"],
    ]);
    expect(r.body.blueprint.parts[0]).toMatchObject({ like: ["计算 2/5 + 1/4", "计算 1/2 + 1/3"], knowledge_points: ["分数加减"], difficulty: 2 });
    expect(r.body.blueprint.parts.reduce((a, p) => a + p.count, 0)).toBe(6);

    // the plan becomes an exam with its basis; the next plan for the same student keeps its level
    m.generateProblems.mockResolvedValue({ problems: [], requested: 1 });
    const made = await call<{ exam: Exam }>(examsRoute.POST(req("/api/exams", "POST", { blueprint: r.body.blueprint, basis: r.body.basis }), NO_PARAMS));
    expect(made.body.exam.basis).toMatchObject({ scope: "member", member_id: ming.id });
    await settled(made.body.exam.id);
    const again = await call<{ blueprint: { grade_level: string } }>(planRoute.POST(req("/api/exams/plan", "POST", { member_id: ming.id }), NO_PARAMS));
    expect(again.body.blueprint.grade_level).toBe("elementary");

    const all = await call<{ records: { knowledge_point: string; students?: number }[]; basis: { scope: string } }>(planRoute.POST(req("/api/exams/plan", "POST", { scope: "class" }), NO_PARAMS));
    expect(all.body.basis.scope).toBe("class");
    expect(all.body.records[0]).toMatchObject({ knowledge_point: "分数加减", students: 2 });

    // nothing marked → 400; no student given → 400; someone else's student → 404; a student cannot plan
    const fresh = store.addMember("local", cls.id, "小刚");
    expect((await call(planRoute.POST(req("/api/exams/plan", "POST", { member_id: fresh.id }), NO_PARAMS))).status).toBe(400);
    expect((await call(planRoute.POST(req("/api/exams/plan", "POST", {}), NO_PARAMS))).status).toBe(400);
    const other = store.addMember("t2", store.ensureTeacherGroup("t2", "李老师").id, "别人的学生");
    expect((await call(planRoute.POST(req("/api/exams/plan", "POST", { member_id: other.id }), NO_PARAMS))).status).toBe(404);
    const joined = store.joinClass("u-gang", store.ensureTeacherGroup("t3", "赵老师").join_code, { name: "学生" }).member;
    expect(() => service.planFor("u-gang", { member_id: joined.id })).toThrow(/老师/);
    // a basis naming someone else's student is dropped
    m.generateProblems.mockResolvedValue({ problems: [], requested: 1 });
    const odd = service.createExam("local", { blueprint: r.body.blueprint, basis: { ...r.body.basis, member_id: other.id } });
    expect(odd.basis).toBeUndefined();
    await settled(odd.id);
  });
});

describe("marking a paper of an exam", () => {
  it("matches by the printed number, marks against the exam's answers, counts the exam's skills and points; the paper shows its score", async () => {
    const cls = store.ensureTeacherGroup("local", "王老师");
    const ming = store.addMember("local", cls.id, "小明");
    const parts = [part("c", "choice", 2, { knowledge_points: ["质数"] }), part("s", "solve", 1, { knowledge_points: ["一元一次方程"], difficulty: 3 })];
    const qs: ExamQuestion[] = [
      { ...question(parts[0], 1), stem: "哪个是质数？", options: ["4", "7", "9", "15"], answer: "B" },
      { ...question(parts[0], 2), stem: "哪个是偶数？", options: ["3", "5", "6", "9"], answer: "C" },
      { ...question(parts[1], 1), stem: "解方程 $3x-2=7$", answer: "x=3", solution: "移项得 3x = 9" },
    ];
    store.putExamDoc({ id: "ex1", owner: "local", title: "第三单元测验", grade_level: "high", parts, questions: (await import("@/lib/exam/types")).numberQuestions(qs, parts), rejected: [], status: "ready", created_at: 1, updated_at: 1 });

    const judged: string[] = [];
    m.chatJson.mockImplementation(async (o: { schemaName: string; user: string; schema: { parse: (x: unknown) => unknown } }) => {
      const raw = (() => {
        if (o.schemaName === "student_paper")
          return {
            readable: true,
            title: "",
            questions: [
              // read out of order, the printed text garbled; numbers decide
              { number: "3", question: "解方程 3x-2=?", steps: ["3x=9", "x=3"], final_answer: "x=3" },
              { number: "1", question: "哪个是质数", steps: [], final_answer: "B" },
              { number: "2", question: "", steps: [], final_answer: "A" },
            ],
          };
        if (o.schemaName === "marking") {
          judged.push(o.user);
          return !o.user.includes("偶数")
            ? { answer_correct: true, approach: "移项", approach_valid: true, steps: [{ index: 1, verdict: "correct" }], error_types: [], feedback: "好", knowledge_points: ["方程变形"], score: 100 }
            : { answer_correct: false, approach: "", approach_valid: false, steps: [], error_types: ["concept"], feedback: "", knowledge_points: ["整数"], score: 0 };
        }
        if (o.schemaName === "diagnosis") return { approach: "", strengths: [], weaknesses: [], next: [], summary: "方程好，质数概念需加强" };
        throw new Error(`unexpected ${o.schemaName}`);
      })();
      return o.schema.parse(raw);
    });

    const id = store.newPaperId();
    const draft: Paper = { id, class_id: cls.id, member_id: ming.id, submitted_by: "local", title: "", images: store.savePaperImages(id, [{ data: Buffer.from([1]), ext: "jpg" }]), source: { exam_id: "ex1" }, status: "failed", submission_ids: [], created_at: 9 };
    const saved = (await runPaper({ paper: draft, member: ming, imageUrls: ["x"] }))!;
    expect(saved.title).toBe("第三单元测验");
    const subs = saved.submission_ids.map((s) => store.getSubmission(s));
    const byNo = Object.fromEntries(subs.map((s) => [s.question_no, s]));
    expect(byNo["3"]).toMatchObject({ problem: { text: "解方程 $3x-2=7$" }, reference: { source: "exam", answer: "x=3", solution: "移项得 3x = 9" }, points: 10, difficulty: 3, skills: ["一元一次方程"] });
    expect(byNo["3"].marking!.knowledge_points).toEqual(["一元一次方程"]); // the exam's skill, not the marker's word
    expect(byNo["1"]).toMatchObject({ problem: { text: "哪个是质数？\nA. 4\nB. 7\nC. 9\nD. 15" }, reference: { source: "exam", answer: "B" }, points: 4, skills: ["质数"] });
    expect(byNo["1"].marking!.verdict).toBe("correct"); // B = B, decided by the program
    expect(byNo["2"]).toMatchObject({ reference: { answer: "C" }, points: 4 });
    expect(byNo["2"].question_unread).toBeUndefined(); // the exam has the question
    expect(byNo["2"].marking!.verdict).toBe("incorrect");

    const got = await call<{ score: { got: number; total: number }; exam: { id: string; title: string }; questions: { question_no: string; points: number; reference_source: string }[] }>(paperRoute.GET(req(`/api/grading/papers/${id}`, "GET"), ctx({ id })));
    expect(got.status).toBe(200);
    expect(got.body.score).toEqual({ got: 14, total: 18 });
    expect(got.body.exam).toEqual({ id: "ex1", title: "第三单元测验" });
    expect(got.body.questions.every((q) => q.reference_source === "exam")).toBe(true);

    // the teacher's correction counts in the score (moved into the band of the verdict: 90) and in the next plan
    store.putSubmission({ ...byNo["2"], teacher: { verdict: "correct", at: 1 } });
    expect((await call<{ score: { got: number } }>(paperRoute.GET(req(`/api/grading/papers/${id}`, "GET"), ctx({ id })))).body.score.got).toBe(17.6);
    const plan = service.planFor("local", { member_id: ming.id });
    expect(plan.basis.exam_ids).toEqual(["ex1"]);
    expect(plan.blueprint.grade_level).toBe("high"); // the level of the exam the student sat
    expect(plan.records.find((r) => r.knowledge_point === "质数")).toMatchObject({ attempts: 2 });

    // marked again: still counted under the exam's skill
    const again = await call<{ submission: Submission }>(remarkRoute.POST(req(`/api/grading/submissions/${byNo["3"].id}/remark`, "POST"), ctx({ id: byNo["3"].id })));
    expect(again.status).toBe(200);
    expect(again.body.submission.marking!.knowledge_points).toEqual(["一元一次方程"]);
    expect(again.body.submission.reference.source).toBe("exam");

    // a deleted exam: the paper is marked against solved answers, nothing breaks
    store.deleteExamDoc("local", "ex1");
    expect((await call<{ exam: null }>(paperRoute.GET(req(`/api/grading/papers/${id}`, "GET"), ctx({ id })))).body.exam).toBeNull();
  });
});
