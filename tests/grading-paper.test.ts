import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ chatJson: vi.fn() }));
vi.mock("@/lib/llm/client", async (orig) => ({ ...(await orig<typeof import("@/lib/llm/client")>()), chatJson: m.chatJson }));

const { parseAnswerKey, matchWorksheet, markPaperQuestions, readPaper } = await import("@/lib/grading/paper");
const { masteryLevel, masteryOf, matchBank, diagnose } = await import("@/lib/grading/diagnosis");
const { runPaper } = await import("@/lib/grading/paper-run");
const store = await import("@/lib/grading/store");
const { publicPaper, forStudent, paperSummary } = await import("@/lib/grading/view");
import type { Diagnosis, Marking, Paper, Submission } from "@/lib/grading/types";

beforeEach(() => {
  m.chatJson.mockReset();
});

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
const sub = (id: string, mk: Partial<Marking>, extra: Partial<Submission> = {}): Submission => ({
  id,
  class_id: "c",
  member_id: "mem",
  submitted_by: "t",
  problem: { text: `problem ${id}` },
  reference: { source: "teacher", answer: "1" },
  images: [],
  status: "marked",
  marking: marking(mk),
  created_at: 1,
  ...extra,
});

/** Model replies by what is being asked (several questions are judged at once). */
function modelReplies(judge: (user: string) => Record<string, unknown>, diagnosis: Record<string, unknown> = {}) {
  m.chatJson.mockImplementation(async (o: { schemaName: string; user: string; schema: { parse: (x: unknown) => unknown } }) => {
    const raw = reply(o);
    return o.schema.parse(raw);
  });
  function reply(o: { schemaName: string; user: string }): Record<string, unknown> {
    if (o.schemaName === "student_paper")
      return {
        readable: true,
        title: "第三单元测验",
        questions: [
          { number: 1, question: "$2+3=$", steps: ["$2+3=5$"], final_answer: "5" },
          { number: "2", question: "解方程 $x+1=4$", steps: [{ text: "$x=5$" }, { text: "划掉", crossed_out: true }], final_answer: "x=5" },
          { number: "3", question: "", steps: [], final_answer: "" },
        ],
      };
    if (o.schemaName === "reference_solution") return { answer: "3", solution: "x=4-1" };
    if (o.schemaName === "marking") return judge(o.user);
    if (o.schemaName === "diagnosis") return { approach: "习惯直接计算", strengths: ["加法熟练"], weaknesses: ["移项变号"], next: [{ question_type: "一元一次方程", knowledge_points: ["一元一次方程"], difficulty: 9, count: 1, reason: "第 2 题移项出错", grade_level: "bogus", domain: "algebra" }], summary: "计算好，方程需加强", ...diagnosis };
    throw new Error(`unexpected ${o.schemaName}`);
  }
}
const judgeByAnswer = (user: string) =>
  user.includes("x=5")
    ? { answer_correct: false, approach: "移项", approach_valid: true, steps: [{ index: 1, verdict: "wrong", comment: "移项没变号" }], error_types: ["sign_error"], feedback: "看符号", knowledge_points: ["一元一次方程"], score: 30 }
    : { answer_correct: true, approach: "直接计算", approach_valid: true, steps: [{ index: 1, verdict: "correct" }], error_types: [], feedback: "对", knowledge_points: ["整数加法"], score: 100 };

describe("answer keys and worksheets", () => {
  it("parses common answer-key forms", () => {
    const k = parseAnswerKey("1. 12\n2) C\n3：x=2\n第4题 A,D\n5(a) 7\n6、 $\\frac12$");
    expect(k.get("1")).toBe("12");
    expect(k.get("2")).toBe("C");
    expect(k.get("3")).toBe("x=2");
    expect(k.get("4")).toBe("A,D");
    expect(k.get("5a")).toBe("7");
    expect(k.get("6")).toBe("$\\frac12$");
    // answers that start with a letter are not sub-questions
    const k2 = parseAnswerKey("7 x = 3\n8 A B\n9 b 5\n10b 4\n11 (c) 6");
    expect([...k2]).toEqual([
      ["7", "x = 3"],
      ["8", "A B"],
      ["9", "b 5"],
      ["10b", "4"],
      ["11c", "6"],
    ]);
    expect(parseAnswerKey("").size).toBe(0);
    expect(parseAnswerKey(undefined).size).toBe(0);
  });

  it("matches a read question to the worksheet by text, then by number, then position", () => {
    const sheet = [
      { text: "计算 $12 \\times 15$ 的值", answer: "180", knowledge_points: [] },
      { text: "一辆车每小时行 60 千米，3 小时行多少千米？", answer: "180", knowledge_points: [] },
    ];
    expect(matchWorksheet({ number: "9", question: "一辆车每小时行 60 千米，3 小时行多少千米?" }, 0, sheet)).toBe(sheet[1]);
    expect(matchWorksheet({ number: "1", question: "" }, 1, sheet)).toBe(sheet[0]);
    expect(matchWorksheet({ number: "(b)", question: "" }, 1, sheet)).toBe(sheet[1]);
    expect(matchWorksheet({ number: "7", question: "" }, 5, sheet)).toBeUndefined();
  });
});

describe("reading and marking a whole paper", () => {
  it("reads every question, keeping blanks and crossed-out lines", async () => {
    modelReplies(judgeByAnswer);
    const r = await readPaper(["data:image/png;base64,AA"]);
    expect(r.title).toBe("第三单元测验");
    expect(r.questions.map((q) => q.number)).toEqual(["1", "2", "3"]);
    expect(r.questions[1].reading.steps[1]).toEqual({ text: "划掉", crossed_out: true });
    expect(r.questions[2].reading).toEqual({ readable: true, steps: [] });
  });

  it("uses the answer key first, solves the rest, and keeps a failure to its question", async () => {
    modelReplies(judgeByAnswer);
    const { questions } = await readPaper(["x"]);
    const progress: number[] = [];
    const out = await markPaperQuestions(questions, { answerKey: parseAnswerKey("1. 5"), onProgress: (d) => progress.push(d) });
    expect(out[0].reference).toMatchObject({ source: "teacher", answer: "5" });
    expect(out[0].marking?.verdict).toBe("correct");
    expect(out[1].reference).toMatchObject({ source: "model", answer: "3" });
    expect(out[1].marking?.verdict).not.toBe("correct");
    expect(out[1].marking?.needs_review).toBe(true);
    expect(out[2].marking).toBeUndefined();
    expect(out[2].error).toMatch(/could not be read/);
    expect(progress.sort()).toEqual([1, 2, 3]);
  });

  it("attaches a worksheet's solution to a keyed answer only when it is the same question", async () => {
    modelReplies(judgeByAnswer);
    const { questions } = await readPaper(["x"]);
    const sheet = [
      { text: "完全不同的题目甲", answer: "99", solution: "别的题的解答", knowledge_points: [] },
      { text: "完全不同的题目乙", answer: "3", solution: "x=4-1", knowledge_points: [] },
    ];
    const out = await markPaperQuestions(questions.slice(0, 2), { answerKey: parseAnswerKey("1. 5\n2. 3"), sheet });
    expect(out[0].reference).toEqual({ answer: "5", source: "teacher" });
    expect(out[1].reference).toEqual({ answer: "3", source: "teacher", solution: "x=4-1" });
  });
});

describe("mastery and recommendations", () => {
  it("levels skills by fixed rules", () => {
    expect(masteryLevel(2, 2)).toBe("mastered");
    expect(masteryLevel(1, 1)).toBe("developing"); // one question is not enough to call it mastered
    expect(masteryLevel(1, 2)).toBe("developing");
    expect(masteryLevel(0.5, 2)).toBe("weak");
    expect(masteryLevel(0, 3)).toBe("not_yet");
    expect(masteryLevel(0, 0)).toBe("not_yet");
  });

  it("counts each skill once per question, gives partial credit, and uses the teacher's verdict", () => {
    const subs = [
      sub("a", { knowledge_points: ["方程", "方程 "] }),
      sub("b", { verdict: "partially_correct", knowledge_points: ["方程"] }),
      sub("c", { verdict: "incorrect", knowledge_points: ["分数"] }, { teacher: { verdict: "correct", at: 1 } }),
      sub("d", { verdict: "unreadable", knowledge_points: ["分数"] }),
      sub("e", { verdict: "incorrect", knowledge_points: ["几何"] }),
    ];
    const ms = masteryOf(subs);
    expect(ms).toEqual([
      { knowledge_point: "几何", attempts: 1, correct: 0, level: "not_yet" },
      { knowledge_point: "方程", attempts: 2, correct: 1, level: "developing" },
      { knowledge_point: "分数", attempts: 1, correct: 1, level: "developing" },
    ]);
  });

  it("matches a recommendation to the bank knowledge point with most questions", () => {
    const banks = [
      { id: "b1", name: "七上", items: [{ knowledge_points: ["一元一次方程"] }, { knowledge_points: ["一元一次方程", "移项"] }, { knowledge_points: ["有理数"] }] },
      { id: "b2", name: "八上", items: [{ knowledge_points: ["一元一次方程的应用"] }] },
    ];
    expect(matchBank(banks, ["一元一次方程"])).toEqual({ bank_id: "b1", bank_name: "七上", knowledge_point: "一元一次方程", matched: 2 });
    expect(matchBank(banks, ["三角形"])).toBeUndefined();
    expect(matchBank(banks, ["x"])).toBeUndefined();
  });

  it("diagnoses: program mastery, model narrative, clamped recommendations", async () => {
    modelReplies(judgeByAnswer);
    const d = await diagnose({ submissions: [sub("a", { knowledge_points: ["整数加法"] }), sub("b", { verdict: "incorrect", knowledge_points: ["一元一次方程"] })] });
    expect(d.based_on).toBe(2);
    expect(d.mastery.map((x) => x.level)).toEqual(["not_yet", "developing"]);
    expect(d.next[0]).toMatchObject({ difficulty: 5, count: 2, builtin: { grade_level: "middle", difficulty: "standard", domain: "algebra" } });
    expect(d.next[0].bank).toBeUndefined();
    expect(d.summary).toBe("计算好，方程需加强");
  });

  it("does not call the model without marked work", async () => {
    const d = await diagnose({ submissions: [sub("x", {}, { status: "failed", marking: undefined })] });
    expect(d.based_on).toBe(0);
    expect(m.chatJson).not.toHaveBeenCalled();
  });
});

describe("papers in the store", () => {
  beforeEach(async () => {
    process.env.GRADING_STORE_PATH = await fs.mkdtemp(path.join(os.tmpdir(), "grading-paper-"));
    store._resetGradingStore();
  });

  const newPaper = (cls: { id: string }, memberId: string, by: string): Paper => {
    const id = store.newPaperId();
    return { id, class_id: cls.id, member_id: memberId, submitted_by: by, title: "", images: store.savePaperImages(id, [{ data: Buffer.from([9]), ext: "jpg" }]), source: { answer_key: "1. 5", bank_id: "bk", generation_id: "g" }, status: "failed", submission_ids: [], created_at: 5 };
  };

  it("marks a paper into one submission per question, diagnoses it, and guards access", async () => {
    const cls = store.ensureTeacherGroup("teacher", "T");
    const ming = store.joinClass("u-ming", cls.join_code, { name: "小明" }).member;
    const hong = store.joinClass("u-hong", cls.join_code, { name: "小红" }).member;
    modelReplies(judgeByAnswer);
    const stages: string[] = [];
    const saved = (await runPaper({ paper: newPaper(cls, ming.id, "teacher"), member: ming, imageUrls: ["x"], onProgress: (p) => stages.push(p.stage) }))!;
    expect(new Set(stages)).toEqual(new Set(["reading", "marking", "diagnosing"]));
    expect(saved.status).toBe("partial"); // question 3 could not be read
    expect(store.getSubmission(saved.submission_ids[2]).question_unread).toBe(true);
    expect(store.getSubmission(saved.submission_ids[0]).question_unread).toBeUndefined();
    expect(saved.title).toBe("第三单元测验");
    expect(saved.submission_ids).toHaveLength(3);
    const q2 = store.getSubmission(saved.submission_ids[1]);
    expect(q2).toMatchObject({ paper_id: saved.id, question_no: "2", images: [] });
    expect(saved.diagnosis?.based_on).toBe(2);
    expect(paperSummary(saved)).toMatchObject({ questions: 3, summary: "计算好，方程需加强" });

    // the student sees it without the teacher's sources; another student does not
    expect(store.visiblePaper("u-ming", saved.id).role).toBe("student");
    expect(() => store.visiblePaper("u-hong", saved.id)).toThrow();
    expect([...store.readPaperImage("u-ming", saved.id, "1.jpg")]).toEqual([9]);
    expect(() => store.readPaperImage("u-ming", saved.id, "../x")).toThrow();
    const pub = publicPaper(saved, "student");
    expect(pub).not.toHaveProperty("submitted_by");
    expect(pub.source).toEqual({});
    expect(publicPaper(saved, "teacher").source).toMatchObject({ answer_key: "1. 5" });
    expect(store.papersOf(ming.id).map((p) => p.id)).toEqual([saved.id]);
    expect(store.papersOf(hong.id)).toEqual([]);

    // marking a failed question again updates the paper's status; deleting a question drops it
    const q3 = store.getSubmission(saved.submission_ids[2]);
    store.saveMarkingResult(q3, { status: "marked", marking: marking(), error: undefined });
    expect(store.getPaper(saved.id).status).toBe("marked");
    store.deleteSubmission("teacher", saved.submission_ids[2]);
    expect(store.getPaper(saved.id).submission_ids).toHaveLength(2);
    expect(paperSummary(store.getPaper(saved.id)).questions).toBe(2);

    // students cannot delete a teacher's upload; the teacher deletes the paper and its questions
    expect(() => store.deletePaper("u-ming", saved.id)).toThrow(/老师|teacher/);
    store.deletePaper("teacher", saved.id);
    expect(() => store.getPaper(saved.id)).toThrow();
    expect(() => store.getSubmission(saved.submission_ids[0])).toThrow();
  });

  it("keeps a paper whose reading failed, and writes nothing for a student removed meanwhile", async () => {
    const cls = store.ensureTeacherGroup("teacher", "T");
    const ming = store.addMember("teacher", cls.id, "小明");
    m.chatJson.mockRejectedValue(new Error("vision down"));
    const failed = (await runPaper({ paper: newPaper(cls, ming.id, "teacher"), member: ming, imageUrls: ["x"] }))!;
    expect(failed).toMatchObject({ status: "failed", title: expect.any(String) });
    expect(failed.error).toMatch(/vision down/);

    modelReplies(judgeByAnswer);
    const p = newPaper(cls, ming.id, "teacher");
    store.removeMember("teacher", ming.id);
    expect(await runPaper({ paper: p, member: ming, imageUrls: ["x"] })).toBeUndefined();
    expect(() => store.getPaper(p.id)).toThrow();
    expect(() => store.getSubmission(`${p.id}q1`)).toThrow();
    expect(() => store.getPaper(failed.id)).toThrow(); // removed with the student
  });

  it("a paper whose questions were all deleted goes; a deleted class takes its papers along", async () => {
    const cls = store.ensureTeacherGroup("teacher", "T");
    const ming = store.addMember("teacher", cls.id, "小明");
    modelReplies(judgeByAnswer);
    const p = (await runPaper({ paper: newPaper(cls, ming.id, "teacher"), member: ming, imageUrls: ["x"] }))!;
    for (const id of p.submission_ids) store.deleteSubmission("teacher", id);
    expect(() => store.getPaper(p.id)).toThrow();

    const p2 = (await runPaper({ paper: newPaper(cls, ming.id, "teacher"), member: ming, imageUrls: ["x"] }))!;
    store.putMemberDiagnosis(ming.id, p2.diagnosis!);
    store.deleteClass("teacher", cls.id);
    expect(() => store.getPaper(p2.id)).toThrow();
    expect(store.getMemberDiagnosis(ming.id)).toBeUndefined();
    await expect(fs.stat(path.join(store.gradingRoot(), "papers", p2.id))).rejects.toThrow();

    // photos of a run that died before storing anything are discarded
    const draft = newPaper(cls, ming.id, "teacher");
    store.discardPaperDraft(draft.id);
    await expect(fs.stat(path.join(store.gradingRoot(), "papers", draft.id))).rejects.toThrow();
  });

  it("stores a student's overall diagnosis; students do not see the teacher's bank", () => {
    const cls = store.ensureTeacherGroup("teacher", "T");
    const ming = store.addMember("teacher", cls.id, "小明");
    const d: Diagnosis = {
      approach: "",
      strengths: [],
      weaknesses: [],
      mastery: [],
      next: [{ question_type: "x", knowledge_points: [], difficulty: 2, count: 3, reason: "", bank: { bank_id: "b", bank_name: "B", knowledge_point: "k", matched: 2 }, builtin: { grade_level: "middle", difficulty: "standard", domain: "algebra" } }],
      summary: "s",
      based_on: 3,
      created_at: 1,
    };
    expect(store.putMemberDiagnosis(ming.id, d)?.summary).toBe("s");
    expect(store.getMemberDiagnosis(ming.id)?.next[0].bank?.bank_id).toBe("b");
    expect(forStudent(d).next[0]).not.toHaveProperty("bank");
    store.removeMember("teacher", ming.id);
    expect(store.getMemberDiagnosis(ming.id)).toBeUndefined();
    expect(store.putMemberDiagnosis(ming.id, d)).toBeUndefined();
  });
});
