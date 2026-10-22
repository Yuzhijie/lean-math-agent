import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ chatJson: vi.fn() }));
vi.mock("@/lib/llm/client", async (orig) => ({ ...(await orig<typeof import("@/lib/llm/client")>()), chatJson: m.chatJson }));

const { compareAnswers, deriveVerdict, judgeWork, markWork } = await import("@/lib/grading/mark");
const { learningStats } = await import("@/lib/grading/stats");
const store = await import("@/lib/grading/store");
const { resolveProblem } = await import("@/lib/grading/reference");
import type { Reading, Submission } from "@/lib/grading/types";

const reading = (steps: string[], final?: string): Reading => ({ readable: true, steps: steps.map((text) => ({ text })), ...(final ? { final_answer: final } : {}) });

beforeEach(() => m.chatJson.mockReset());

describe("comparing a student's answer with the reference (program first)", () => {
  it("decides equal values, choices and sets", () => {
    expect(compareAnswers("x = 3", "3")).toBe(true);
    expect(compareAnswers("答：共 18 个", "18")).toBe(true);
    expect(compareAnswers("$\\frac{1}{2}$", "0.5")).toBe(true);
    expect(compareAnswers("(C)", "C")).toBe(true);
    expect(compareAnswers("选 B", "C")).toBe(false);
    expect(compareAnswers("A、D", "D, A")).toBe(true);
    expect(compareAnswers("x=2 或 x=3", "3, 2")).toBe(true);
    expect(compareAnswers("2, 3", "2, 3, 4")).toBe(false);
    expect(compareAnswers("17", "18")).toBe(false);
    expect(compareAnswers("18 cm", "18")).toBe(true);
  });

  it("does not mark a wrong answer right (review cases)", () => {
    const wrongButClose: [string, string][] = [
      ["2", "2\\pi"],
      ["2", "2π"],
      ["3", "3x"],
      ["2 + x", "2"],
      ["5", "5!"],
      ["2a", "2b"],
      ["2 < x", "2 > x"],
      ["3 cm", "3 m"],
      ["23", "2, 3"],
      ["12", "(1, 2)"],
      ["x=2, y=1", "x=1, y=2"],
      ["y=3", "x=3"],
      ["bad", "A, B, D"],
      ["CAD", "A, C, D"],
      ["(2, 1)", "(1, 2)"],
    ];
    for (const [s, r] of wrongButClose) expect(compareAnswers(s, r), `${s} vs ${r}`).not.toBe(true);
    expect(compareAnswers("3 cm", "3 m")).toBe(false);
    expect(compareAnswers("x=2, y=1", "x=1, y=2")).toBe(false);
    expect(compareAnswers("(1, 2)", "(1, 2)")).toBe(true);
    expect(compareAnswers("y = 2, x = 1", "x=1, y=2")).toBe(true);
    expect(compareAnswers("A and D", "D, A")).toBe(true);
    expect(compareAnswers("−3", "-3")).toBe(true);
    expect(compareAnswers("60°", "60^\\circ")).toBe(true);
    // forms the program must leave to the model
    expect(compareAnswers("10%", "0.1")).toBeUndefined();
    expect(compareAnswers("0.333", "1/3")).toBe(false);
  });

  it("leaves forms it cannot compare to the model", () => {
    expect(compareAnswers("2\\sqrt{2}", "\\sqrt{8}")).toBeUndefined();
    expect(compareAnswers("", "3")).toBeUndefined();
    expect(compareAnswers("3", undefined)).toBeUndefined();
  });
});

describe("the overall verdict follows fixed rules", () => {
  const v = (o: Partial<Parameters<typeof deriveVerdict>[0]>) =>
    deriveVerdict({ readable: true, hasAnswer: true, answerCorrect: true, approachValid: true, hasError: false, ...o });
  it("maps answer and working to a verdict", () => {
    expect(v({})).toBe("correct");
    expect(v({ hasError: true })).toBe("correct_answer_flawed");
    expect(v({ answerCorrect: false })).toBe("partially_correct");
    expect(v({ answerCorrect: false, approachValid: false })).toBe("incorrect");
    expect(v({ hasAnswer: false, answerCorrect: false, approachValid: false })).toBe("no_answer");
    expect(v({ hasAnswer: false, answerCorrect: false })).toBe("partially_correct");
    expect(v({ readable: false })).toBe("unreadable");
    // an answer nobody could decide is not called wrong unless the approach fails
    expect(v({ answerCorrect: null, approachValid: null })).toBe("partially_correct");
    expect(v({ answerCorrect: null, approachValid: false })).toBe("incorrect");
  });
});

describe("judging the working", () => {
  const ref = { answer: "18", source: "session" as const };
  it("lets the program's answer check win over the model and derives the verdict", async () => {
    m.chatJson.mockResolvedValue({
      answer_correct: true, // the model is wrong: 17 ≠ 18
      approach: "按大小分类计数",
      approach_valid: true,
      steps: [
        { index: 1, verdict: "correct" },
        { index: 2, verdict: "error", comment: "漏数了由两个小三角形拼成的三角形" },
      ],
      error_types: ["incomplete", "bogus"],
      feedback: "分类的思路很好……",
      hint: "再看看两个小三角形能不能拼成大三角形？",
      knowledge_points: ["图形计数", "图形计数", " 分类讨论 "],
      score: 95,
    });
    const mk = await judgeWork({ problem: "图中有几个三角形？", reference: ref, reading: reading(["小三角形 10 个", "大三角形 7 个，共 17 个"], "17") });
    expect(mk).toMatchObject({ verdict: "partially_correct", answer_correct: false, answer_check: "program", first_error_step: 2, error_types: ["incomplete"] });
    expect(mk.knowledge_points).toEqual(["图形计数", "分类讨论"]);
    expect(mk.score).toBeLessThanOrEqual(79); // clamped into the verdict's band
    expect(mk.hint).toContain("拼成");
  });

  it("uses the model for forms the program cannot compare, and marks steps it skipped as unclear", async () => {
    m.chatJson.mockResolvedValue({ answer_correct: true, approach: "勾股定理", approach_valid: true, steps: [{ index: 1, verdict: "correct" }], error_types: [], feedback: "很好", knowledge_points: ["勾股定理"], score: 100 });
    const mk = await judgeWork({ problem: "p", reference: { answer: "2\\sqrt{2}", source: "teacher" }, reading: reading(["a", "b"], "\\sqrt{8}") });
    expect(mk.answer_check).toBe("model");
    expect(mk.needs_review).toBeUndefined();
    expect(mk.steps[1].verdict).toBe("unclear");
    expect(mk.verdict).toBe("correct");
    expect(mk.hint).toBeUndefined();
  });

  it("does not call the model for unreadable photos; a missing answer is incomplete", async () => {
    const mk = await judgeWork({ problem: "p", reference: ref, reading: { readable: false, steps: [] } });
    expect(mk.verdict).toBe("unreadable");
    expect(m.chatJson).not.toHaveBeenCalled();
    m.chatJson.mockResolvedValue({ approach: "列方程", approach_valid: true, steps: [{ index: 1, verdict: "correct" }], error_types: [], feedback: "f", knowledge_points: [], score: 50 });
    const noAns = await judgeWork({ problem: "p", reference: ref, reading: reading(["设 x"]) });
    expect(noAns).toMatchObject({ verdict: "partially_correct", answer_correct: false, answer_check: "none" });
    expect(noAns.error_types).toContain("incomplete");
  });

  it("reads the photos, solves the problem when there is no reference, then judges", async () => {
    m.chatJson
      .mockResolvedValueOnce({ readable: true, steps: ["$x+1=4$", { text: "$x=3$" }], final_answer: "x=3" }) // read
      .mockResolvedValueOnce({ answer: "3", solution: "x = 4 - 1" }) // reference
      .mockResolvedValueOnce({ approach: "移项", approach_valid: true, steps: [{ index: 1, verdict: "correct" }, { index: 2, verdict: "correct" }], error_types: [], feedback: "对", knowledge_points: ["一元一次方程"], score: 100 });
    const r = await markWork({ problem: "解方程 x+1=4", imageUrls: ["data:image/jpeg;base64,AA=="], reference: { source: "none" } });
    expect(r.reference).toMatchObject({ answer: "3", source: "model" });
    expect(r.marking.needs_review).toBe(true); // the reference was solved by a model
    expect(r.reading.steps).toHaveLength(2);
    expect(r.marking).toMatchObject({ verdict: "correct", answer_check: "program" });
    expect(m.chatJson.mock.calls[0][0]).toMatchObject({ role: "vision", images: ["data:image/jpeg;base64,AA=="] });
  });
});

describe("classes, roster, joining and access", () => {
  beforeEach(async () => {
    process.env.GRADING_STORE_PATH = await fs.mkdtemp(path.join(os.tmpdir(), "grading-"));
    store._resetGradingStore();
  });

  it("a teacher makes a class, students join by code and see only their own work", async () => {
    const cls = store.createClass("teacher", "七年级 2 班");
    expect(cls.join_code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    const ming = store.addMember("teacher", cls.id, "小明");
    expect(() => store.addMember("other-teacher", cls.id, "x")).toThrow();
    // a student claims the roster name with the code (case-insensitive)
    const j = store.joinClass("u-ming", cls.join_code.toLowerCase(), { memberId: ming.id });
    expect(j.member).toMatchObject({ id: ming.id, user_id: "u-ming" });
    expect(() => store.joinClass("u-other", cls.join_code, { memberId: ming.id })).toThrow(/另一个账号|another account/);
    const hong = store.joinClass("u-hong", cls.join_code, { name: "小红" }).member;
    expect(store.enrolments("u-hong").map((e) => e.member.id)).toEqual([hong.id]);
    // joining twice returns the same entry
    expect(store.joinClass("u-hong", cls.join_code, { name: "别名" }).member.id).toBe(hong.id);

    expect(store.accessToMember("teacher", ming.id).role).toBe("teacher");
    expect(store.accessToMember("u-ming", ming.id).role).toBe("student");
    expect(() => store.accessToMember("u-hong", ming.id)).toThrow();

    const sub: Submission = {
      id: store.newSubmissionId(),
      class_id: cls.id,
      member_id: ming.id,
      submitted_by: "teacher",
      problem: { text: "1+1" },
      reference: { answer: "2", source: "teacher" },
      images: store.saveSubmissionImages("s1x", [{ data: Buffer.from([1, 2, 3]), ext: "jpg" }]),
      status: "marked",
      created_at: Date.now(),
    };
    store.putSubmission({ ...sub, id: "s1x" });
    expect(store.visibleSubmission("u-ming", "s1x").role).toBe("student");
    expect(() => store.visibleSubmission("u-hong", "s1x")).toThrow();
    expect([...store.readSubmissionImage("teacher", "s1x", "1.jpg")]).toEqual([1, 2, 3]);
    expect(() => store.readSubmissionImage("teacher", "s1x", "../grading.sqlite")).toThrow();

    // students delete only their own uploads; teachers anything in the class
    expect(() => store.deleteSubmission("u-ming", "s1x")).toThrow(/老师|teacher/);
    const { publicSubmission } = await import("@/lib/grading/view");
    const pub = publicSubmission({ ...store.getSubmission("s1x"), problem: { text: "1+1", session_id: "teacher-session" } }, "student");
    expect(pub).not.toHaveProperty("submitted_by");
    expect(pub.problem).not.toHaveProperty("session_id");

    // a marking that finishes after the class was deleted writes nothing back
    const draft = { ...store.getSubmission("s1x"), id: "late1" };
    expect(store.saveMarkingResult(draft, { status: "marked" }, { isNew: true })?.id).toBe("late1");
    store.putSubmission({ ...store.getSubmission("late1"), teacher: { note: "看第 2 步", at: 1 } });
    // re-marking keeps the teacher's note made meanwhile
    expect(store.saveMarkingResult(draft, { status: "failed" })?.teacher?.note).toBe("看第 2 步");
    store.deleteSubmission("teacher", "late1");
    expect(store.saveMarkingResult(draft, { status: "marked" })).toBeUndefined();

    // the store survives a restart
    store._resetGradingStore();
    expect(store.submissionsOf(ming.id)).toHaveLength(1);
    store.deleteClass("teacher", cls.id);
    expect(store.enrolments("u-hong")).toEqual([]);
    expect(() => store.getSubmission("s1x")).toThrow();
  });

  it("keeps one student list per teacher, folding older classes into it", () => {
    expect(store.teacherGroup("t2")).toBeUndefined();
    const a = store.createClass("t2", "老师甲");
    const b = store.createClass("t2", "第二个班");
    const x = store.addMember("t2", a.id, "甲");
    const y = store.addMember("t2", b.id, "乙");
    store.putSubmission({ id: "sub-b", class_id: b.id, member_id: y.id, submitted_by: "t2", problem: { text: "p" }, reference: { source: "none" }, images: [], status: "failed", created_at: 1 });
    const g = store.teacherGroup("t2")!;
    expect(g.id).toBe(a.id);
    expect(store.classesTaughtBy("t2")).toHaveLength(1);
    expect(store.membersOf(g.id).map((m) => m.id).sort()).toEqual([x.id, y.id].sort());
    expect(store.getSubmission("sub-b").class_id).toBe(a.id);
    expect(store.classByCode(b.join_code)).toBeUndefined();
    expect(store.ensureTeacherGroup("t2", "x").id).toBe(a.id);
    expect(store.ensureTeacherGroup("t3", "王老师").name).toBe("王老师");
  });

  it("works without SQLite (JSONL fallback)", () => {
    process.env.GRADING_STORE_BACKEND = "jsonl";
    try {
      const cls = store.createClass("t", "c");
      store.addMember("t", cls.id, "a");
      store._resetGradingStore();
      expect(store.membersOf(cls.id).map((x) => x.name)).toEqual(["a"]);
    } finally {
      delete process.env.GRADING_STORE_BACKEND;
    }
  });
});

describe("reference answers", () => {
  it("takes the teacher's answer, else a solved session's", async () => {
    const getSession = vi.fn(async () => ({
      id: "s1",
      problem_text: "求 1+2",
      computation_result: { answer: "3", cross_validated: true },
      nl_solution: { summary: "加法", steps: [{ title: "相加", content: "1+2=3" }], final_answer: "$3$", verification: "" },
    }) as never);
    const a = await resolveProblem("me", { session_id: "s1" }, { getSession });
    expect(a.problem).toMatchObject({ text: "求 1+2", session_id: "s1" });
    expect(a.reference).toMatchObject({ answer: "3", source: "session" });
    expect(a.reference.solution).toContain("1+2=3");
    const b = await resolveProblem("me", { session_id: "s1", answer: "4" }, { getSession });
    expect(b.reference).toMatchObject({ answer: "4", source: "teacher" });
    const c = await resolveProblem("me", { text: "只有题目" }, { getSession });
    expect(c.reference.source).toBe("none");
    await expect(resolveProblem("me", {}, { getSession: async () => undefined })).rejects.toThrow();
  });
});

describe("learning record", () => {
  const sub = (verdict: Submission["marking"] extends infer M ? (M extends { verdict: infer V } ? V : never) : never, extra: Partial<Submission> = {}, kp = ["方程"], errs: string[] = []): Submission => ({
    id: Math.random().toString(36).slice(2),
    class_id: "c",
    member_id: "m",
    submitted_by: "t",
    problem: { text: "p" },
    reference: { source: "none" },
    images: [],
    status: "marked",
    created_at: Date.now(),
    marking: {
      verdict,
      answer_correct: verdict === "correct" || verdict === "correct_answer_flawed",
      answer_check: "program",
      approach: "",
      approach_valid: true,
      steps: [],
      first_error_step: null,
      error_types: errs as never,
      feedback: "",
      knowledge_points: kp,
      score: verdict === "correct" ? 100 : 40,
    },
    ...extra,
  });

  it("counts verdicts, mistakes and weak skills; the teacher's correction counts", () => {
    const st = learningStats([
      sub("correct"),
      sub("partially_correct", {}, ["几何"], ["calculation"]),
      sub("incorrect", {}, ["几何"], ["concept", "calculation"]),
      sub("incorrect", { teacher: { verdict: "correct", at: 1 } }, ["方程"], ["method"]),
      { ...sub("correct"), status: "failed", marking: undefined },
    ]);
    expect(st).toMatchObject({ submissions: 5, marked: 4, correct: 2, answer_correct: 2 });
    expect(st.correct_rate).toBe(0.5);
    expect(st.error_types).toMatchObject({ calculation: 2, concept: 1, method: 0 });
    expect(st.knowledge[0]).toMatchObject({ name: "几何", attempts: 2, correct: 0 });
    expect(st.knowledge[1]).toMatchObject({ name: "方程", attempts: 2, correct: 2 });
    expect(st.verdicts.correct).toBe(2);
    // the teacher's "correct" moves the model's 40 into the correct band
    expect(st.mean_score).toBe(Math.round((100 + 40 + 40 + 90) / 4));
  });
});
