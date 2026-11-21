import { describe, expect, it } from "vitest";
import {
  classRecords,
  DEFAULT_POINTS,
  difficultyFor,
  domainForSkill,
  kindOfText,
  planExam,
  PlanError,
  presetBlueprint,
  shares,
  skillRecords,
  type SkillRecord,
} from "@/lib/exam/plan";
import { blueprintSchema, examTotal, missingByPart, numberQuestions, orderQuestions, plannedTotal, type ExamQuestion } from "@/lib/exam/types";
import { examWorksheet } from "@/lib/exam/worksheet";
import { sectionTitle } from "@/lib/exam/labels";
import { focusPrompt } from "@/lib/llm/generate-problem";
import type { Marking, Submission, Verdict } from "@/lib/grading/types";

const zh = (a: string) => a;

const marking = (verdict: Verdict, kps: string[]): Marking => ({
  verdict,
  answer_correct: verdict === "correct",
  answer_check: "program",
  approach: "",
  approach_valid: true,
  steps: [],
  first_error_step: null,
  error_types: [],
  feedback: "",
  knowledge_points: kps,
  score: verdict === "correct" ? 100 : 30,
});
let n = 0;
const sub = (verdict: Verdict, kps: string[], extra: Partial<Submission> = {}): Submission => ({
  id: `s${++n}`,
  class_id: "c",
  member_id: "m1",
  submitted_by: "t",
  problem: { text: `题目 ${n}` },
  reference: { source: "exam", answer: "1" },
  images: [],
  status: "marked",
  marking: marking(verdict, kps),
  created_at: 1000 - n,
  ...extra,
});

describe("skills from marked work", () => {
  it("counts credit as the diagnosis does; the teacher's verdict wins; wrong questions newest first; the difficulty they were set at", () => {
    const subs = [
      sub("incorrect", ["分数加减"], { problem: { text: "计算 1/2 + 1/3" }, difficulty: 3 }),
      sub("partially_correct", ["分数加减"], { problem: { text: "计算 2/5 + 1/4" }, difficulty: 3 }),
      // the marker said correct, the teacher said incorrect
      sub("correct", ["分数加减"], { teacher: { verdict: "incorrect", at: 1 }, problem: { text: "计算 3/4 − 1/6" }, difficulty: 2 }),
      sub("correct", ["一元一次方程"]),
      sub("correct", ["一元一次方程"]),
      sub("unreadable", ["一元一次方程"]),
      sub("incorrect", ["面积"], { status: "failed", marking: undefined }),
    ];
    const r = skillRecords(subs);
    expect(r.map((x) => x.knowledge_point)).toEqual(["分数加减", "一元一次方程"]);
    expect(r[0]).toMatchObject({ attempts: 3, correct: 0, credit: 0.5, level: "weak", difficulty: 3 });
    expect(r[0].wrong).toEqual(["计算 1/2 + 1/3", "计算 2/5 + 1/4", "计算 3/4 − 1/6"]);
    expect(r[1]).toMatchObject({ attempts: 2, correct: 2, level: "mastered", wrong: [] });
    expect(r[1].difficulty).toBeUndefined();
  });

  it("a question that could not be read is counted but not written as a variant", () => {
    const r = skillRecords([sub("no_answer", ["比例"], { question_unread: true }), sub("incorrect", ["比例"], { problem: { text: "比例题" } })]);
    expect(r[0].wrong).toEqual(["比例题"]);
  });

  it("a class: the skill most students are weak on first", () => {
    const a = [sub("incorrect", ["方程"], { member_id: "a" }), sub("correct", ["几何"], { member_id: "a" }), sub("correct", ["几何"], { member_id: "a" })];
    const b = [sub("incorrect", ["方程"], { member_id: "b" }), sub("incorrect", ["几何"], { member_id: "b" })];
    const c = [sub("incorrect", ["方程"], { member_id: "c" })];
    const r = classRecords([a, b, c]);
    expect(r[0]).toMatchObject({ knowledge_point: "方程", students: 3, level: "not_yet" });
    expect(r.find((x) => x.knowledge_point === "几何")).toMatchObject({ students: 1 });
  });
});

describe("the plan", () => {
  const rec = (knowledge_point: string, level: SkillRecord["level"], extra: Partial<SkillRecord> = {}): SkillRecord => ({
    knowledge_point,
    attempts: 3,
    correct: level === "mastered" ? 3 : 0,
    credit: level === "mastered" ? 3 : 0.5,
    level,
    wrong: [],
    ...extra,
  });

  it("shares questions by weight, at least one each", () => {
    expect(shares([3, 3, 2, 1], 10)).toEqual([3, 3, 2, 2]);
    expect(shares([3, 1], 4)).toEqual([3, 1]);
    expect(shares([1, 1, 1], 2)).toEqual([1, 1, 1]);
    expect(shares([], 5)).toEqual([]);
    expect(shares([2, 2], 9).reduce((a, b) => a + b)).toBe(9);
  });

  it("difficulty: one step easier for weak skills, the same for developing, one step harder for mastered", () => {
    expect(difficultyFor("weak", 3)).toBe(2);
    expect(difficultyFor("not_yet", 1)).toBe(1);
    expect(difficultyFor("developing", 3)).toBe(3);
    expect(difficultyFor("mastered", 5)).toBe(5);
    expect(difficultyFor("mastered", undefined)).toBe(3);
    expect(difficultyFor("weak", undefined)).toBe(1);
  });

  it("aims at the weak skills, writes variants of what was got wrong, and stretches one mastered skill", () => {
    const bp = planExam({
      records: [
        rec("分数加减", "weak", { difficulty: 3, wrong: ["计算 1/2 + 1/3", "计算 2/5 + 1/4"] }),
        rec("行程问题", "developing", { difficulty: 2 }),
        rec("一元一次方程", "mastered", { difficulty: 2 }),
      ],
      grade_level: "elementary",
      title: "小明 · 针对性练习卷",
      questions: 10,
    });
    expect(blueprintSchema.safeParse(bp).success).toBe(true);
    expect(bp.parts.reduce((a, p) => a + p.count, 0)).toBe(10);
    const frac = bp.parts.filter((p) => p.knowledge_points[0] === "分数加减");
    // variants first, at the difficulty the questions were set at; then easier worked problems and fill-ins
    expect(frac[0]).toMatchObject({ kind: "solve", count: 2, difficulty: 3, like: ["计算 1/2 + 1/3", "计算 2/5 + 1/4"] });
    expect(frac.slice(1).map((p) => [p.kind, p.count, p.difficulty])).toEqual([
      ["solve", 2, 2],
      ["blank", 1, 2],
    ]);
    expect(frac.reduce((a, p) => a + p.count, 0)).toBe(5);
    expect(frac[0].reason).toContain("变式");
    expect(frac[0].target).toMatchObject({ knowledge_point: "分数加减", level: "weak" });
    // the domain each skill belongs to, allowed at the level
    expect(frac[0].source).toEqual({ kind: "builtin", domain: "computation" });
    const trip = bp.parts.filter((p) => p.knowledge_points[0] === "行程问题");
    expect(trip.map((p) => [p.kind, p.count, p.difficulty])).toEqual([
      ["blank", 2, 2],
      ["solve", 1, 2],
    ]);
    // one or two questions of a skill: its first kind only
    expect(trip[0].source).toEqual({ kind: "builtin", domain: "word_problem" });
    const eq = bp.parts.filter((p) => p.knowledge_points[0] === "一元一次方程");
    expect(eq.map((p) => [p.kind, p.count, p.difficulty])).toEqual([["choice", 2, 3]]);
    expect(eq[0].like).toEqual([]);
    expect(eq[0].reason).toContain("拓展");
    for (const p of bp.parts) expect(p.points).toBe(DEFAULT_POINTS[p.kind]);
  });

  it("takes the teacher's bank where it has enough questions on the skill (not for variants)", () => {
    const banks = [{ id: "b1", name: "四年级题库", items: [{ knowledge_points: ["分数加减法"] }, { knowledge_points: ["分数加减法"] }, { knowledge_points: ["分数加减法", "通分"] }] }];
    const bp = planExam({ records: [rec("分数加减法", "weak", { wrong: ["错题"] })], grade_level: "elementary", title: "t", questions: 4, banks });
    expect(bp.parts[0]).toMatchObject({ like: ["错题"], source: { kind: "builtin" } });
    expect(bp.parts[1].source).toEqual({ kind: "bank", bank_id: "b1", bank_name: "四年级题库", knowledge_point: "分数加减法" });
    // too few bank questions: the built-in generator
    const few = planExam({ records: [rec("通分", "weak")], grade_level: "elementary", title: "t", questions: 4, banks });
    expect(few.parts.every((p) => p.source.kind === "builtin")).toBe(true);
  });

  it("at most four weak skills and one to stretch; two to stretch when nothing is weak; no marked work → an error", () => {
    const many = ["a1", "a2", "a3", "a4", "a5"].map((k) => rec(k, "weak"));
    const bp = planExam({ records: [...many, rec("m1", "mastered"), rec("m2", "mastered")], grade_level: "middle", title: "t", questions: 12 });
    expect([...new Set(bp.parts.map((p) => p.knowledge_points[0]))]).toEqual(["a1", "a2", "a3", "a4", "m1"]);
    const allGood = planExam({ records: [rec("m1", "mastered"), rec("m2", "mastered"), rec("m3", "mastered")], grade_level: "middle", title: "t", questions: 6 });
    expect([...new Set(allGood.parts.map((p) => p.knowledge_points[0]))]).toEqual(["m1", "m2"]);
    expect(() => planExam({ records: [], grade_level: "middle", title: "t" })).toThrow(PlanError);
    // the question count is kept in 4–20
    expect(planExam({ records: [rec("a", "weak")], grade_level: "middle", title: "t", questions: 99 }).parts.reduce((a, p) => a + p.count, 0)).toBe(20);
  });

  it("kinds of question read off a written problem", () => {
    expect(kindOfText("下列哪个数最大？\nA. 1\nB. 2\nC. 3\nD. 4")).toBe("choice");
    expect(kindOfText("求证：三角形内角和为 180°")).toBe("proof");
    expect(kindOfText("小明走了 3 千米，用了多少时间？")).toBe("solve");
  });

  it("the domain a skill belongs to, allowed at the level", () => {
    expect(domainForSkill("等差数列求和", "middle")).toBe("sequence");
    expect(domainForSkill("找规律", "high")).toBe("algebra"); // 数列 is a primary / middle domain
    expect(domainForSkill("分数应用题", "elementary")).toBe("word_problem");
    expect(domainForSkill("三角形面积", "elementary")).toBe("geometry");
    expect(domainForSkill("分式方程", "middle")).toBe("algebra");
    expect(domainForSkill("质因数分解", "middle")).toBe("number_theory");
    expect(domainForSkill("概率", "high")).toBe("combinatorics");
    expect(domainForSkill("小数乘法", "elementary")).toBe("computation");
    expect(domainForSkill("something else", "elementary")).toBe("computation");
    expect(domainForSkill("something else", "high")).toBe("algebra");
  });

  it("the presets are 100-point papers the generator can write", () => {
    for (const g of ["elementary", "middle", "high", "university"] as const) {
      const bp = presetBlueprint(g, "期中测验");
      expect(blueprintSchema.safeParse(bp).success).toBe(true);
      expect(plannedTotal(bp.parts)).toBe(100);
    }
    expect(presetBlueprint("high", "x").parts.map((p) => p.kind)).toEqual(["choice", "blank", "solve", "proof"]);
  });
});

describe("numbering, totals and printing", () => {
  const q = (id: string, part_id: string, kind: ExamQuestion["kind"], points: number): ExamQuestion => ({
    id,
    no: "",
    part_id,
    kind,
    stem: `stem ${id}`,
    answer: "1",
    hints: [],
    knowledge_points: [],
    difficulty: 2,
    points,
    source: { kind: "builtin" },
  });
  const parts = [{ id: "p1" }, { id: "p2" }, { id: "p3" }];
  const qs = [q("a", "p2", "solve", 10), q("b", "p1", "choice", 4), q("c", "p3", "choice", 4), q("d", "p1", "choice", 4), q("e", "p2", "blank", 5)];

  it("sections in the order choice, fill-in, worked, proof; parts in their order; numbers across sections", () => {
    expect(orderQuestions(qs, parts).map((x) => x.id)).toEqual(["b", "d", "c", "e", "a"]);
    expect(numberQuestions(qs, parts).map((x) => `${x.no}${x.id}`)).toEqual(["1b", "2d", "3c", "4e", "5a"]);
    expect(examTotal(qs)).toBe(27);
    expect(missingByPart({ parts: [{ id: "p1", count: 3 }, { id: "p2", count: 2 }, { id: "p3", count: 1 }] as never, questions: qs })).toEqual(new Map([["p1", 1]]));
  });

  it("prints with a heading per section and the paper's total", () => {
    const ws = examWorksheet({ title: "单元测验", parts: parts as never, questions: numberQuestions(qs, parts) }, zh);
    expect(ws.total).toBe(27);
    expect(ws.questions.map((x) => x.no)).toEqual(["1", "2", "3", "4", "5"]);
    expect([...new Set(ws.questions.map((x) => x.section))]).toEqual(["一、选择题（共 3 题，每题 4 分，共 12 分）", "二、填空题（共 1 题，每题 5 分，共 5 分）", "三、解答题（共 1 题，每题 10 分，共 10 分）"]);
    expect(sectionTitle(0, "solve", [10, 12], zh)).toBe("一、解答题（共 2 题，共 22 分）");
    expect(sectionTitle(1, "choice", [4, 4], (_z, en) => en)).toBe("II. Multiple choice (2 questions, 4 points each, 8 points)");
  });
});

describe("what the writer is told for a part", () => {
  it("the kind, the skills, the difficulty and the questions to vary", () => {
    expect(focusPrompt(undefined)).toBe("");
    const p = focusPrompt({ kind: "choice", knowledge_points: ["分数加减", " "], difficulty: 7, like: ["计算  1/2\n+ 1/3"] });
    expect(p).toContain("单项选择题");
    expect(p).toContain("“A. …”");
    expect(p).toContain("answer 只写正确选项的字母");
    expect(p).toContain("每道题都必须考查这些知识点：分数加减。");
    expect(p).toContain("难度：5/5");
    expect(p).toContain("1. 计算 1/2 + 1/3");
    expect(focusPrompt({ kind: "blank" })).toContain("____");
    expect(focusPrompt({ kind: "proof" })).toContain("证明题");
  });
});
