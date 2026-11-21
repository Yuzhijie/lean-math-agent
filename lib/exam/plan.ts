/**
 * Planning the next paper from marked work — the step that closes the loop between marking and
 * question writing. Decided by the program, from the teacher's verdicts (a teacher's correction
 * wins over the marker's), so the same marked work always gives the same plan:
 *
 *   1. per skill (knowledge point): attempts, credit (a fully correct piece 1, right answer with
 *      flawed working or a right approach with a slip ½ — the diagnosis's counting), level by the
 *      diagnosis's fixed rules, the questions got wrong (newest first) and the difficulty they were
 *      set at (questions of a generated exam carry it);
 *   2. the skills to aim at: up to MAX_FOCUS that are not mastered — not yet / weak first, then
 *      developing, more attempts first — and one mastered skill to stretch (two when nothing is
 *      weak);
 *   3. the paper's questions shared out by weight (not yet / weak 3, developing 2, mastered 1),
 *      at least one each;
 *   4. per skill: difficulty one below what it was set at for not yet / weak, the same for
 *      developing, one above for mastered (2 when nothing is known); variants of the questions got
 *      wrong first (same skill and kind, new numbers and setting) for the skills not mastered; the
 *      rest as worked problems and fill-in questions for weak skills (working shows where the
 *      reasoning breaks), fill-in and worked problems for developing ones, choice and fill-in to
 *      stretch a mastered one (one or two questions: the first kind only);
 *   5. the source: the teacher's bank when it has at least MIN_BANK_TEMPLATES questions on the
 *      skill (its questions are the template), else the built-in generator in the domain the skill
 *      belongs to (domainForSkill). Variants are written by the built-in generator from the wrong
 *      questions themselves.
 */
import { randomUUID } from "node:crypto";
import { CREDIT, masteryLevel, matchBank } from "../grading/diagnosis";
import { effectiveVerdict, type MasteryLevel, type Submission } from "../grading/types";
import { lt } from "../llm/output-locale";
import { domainAllowed, type CompetitionDomain, type GradeLevel } from "../types";
import { DEFAULT_POINTS } from "./preset";
import type { Blueprint, ExamKind, ExamPart, PlanBasis } from "./types";

export { DEFAULT_POINTS, presetBlueprint } from "./preset";

export const MAX_FOCUS = 4;
export const MIN_BANK_TEMPLATES = 3;
export const DEFAULT_QUESTIONS = 10;
const MAX_PARTS = 12;
const MAX_WRONG = 3;

export interface SkillRecord {
  knowledge_point: string;
  attempts: number;
  correct: number;
  credit: number;
  level: MasteryLevel;
  /** Problems got wrong (not fully correct), newest first. */
  wrong: string[];
  /** The difficulty (1–5) the skill's questions were set at, when known. */
  difficulty?: number;
  /** Class plans: how many students are not yet secure on it (not yet / weak). */
  students?: number;
}

const RANK: Record<MasteryLevel, number> = { not_yet: 0, weak: 1, developing: 2, mastered: 3 };
const WEIGHT: Record<MasteryLevel, number> = { not_yet: 3, weak: 3, developing: 2, mastered: 1 };

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : undefined;
};

/** Per skill, from marked work (newest first, as the store lists it). */
export function skillRecords(subs: Submission[]): SkillRecord[] {
  const by = new Map<string, { attempts: number; correct: number; credit: number; wrong: string[]; diffs: number[] }>();
  for (const s of subs) {
    const v = effectiveVerdict(s);
    if (s.status !== "marked" || !s.marking || !v || v === "unreadable") continue;
    for (const kp of new Set(s.marking.knowledge_points.map((k) => k.trim()).filter(Boolean))) {
      const cur = by.get(kp) ?? { attempts: 0, correct: 0, credit: 0, wrong: [], diffs: [] };
      cur.attempts++;
      cur.credit += CREDIT[v];
      if (v === "correct") cur.correct++;
      else if (!s.question_unread && cur.wrong.length < MAX_WRONG && !cur.wrong.includes(s.problem.text)) cur.wrong.push(s.problem.text);
      if (s.difficulty) cur.diffs.push(s.difficulty);
      by.set(kp, cur);
    }
  }
  return [...by.entries()]
    .map(([knowledge_point, x]) => ({
      knowledge_point,
      attempts: x.attempts,
      correct: x.correct,
      credit: x.credit,
      level: masteryLevel(x.credit, x.attempts),
      wrong: x.wrong,
      ...(x.diffs.length ? { difficulty: median(x.diffs) } : {}),
    }))
    .sort(byPriority);
}

function byPriority(a: SkillRecord, b: SkillRecord): number {
  return RANK[a.level] - RANK[b.level] || (b.students ?? 0) - (a.students ?? 0) || b.attempts - a.attempts || a.knowledge_point.localeCompare(b.knowledge_point);
}

/** A class: the skills over everyone's work, and per skill how many students are not yet secure on it. */
export function classRecords(byMember: Submission[][]): SkillRecord[] {
  const all = skillRecords(byMember.flat().sort((a, b) => b.created_at - a.created_at));
  const weakCount = new Map<string, number>();
  for (const subs of byMember) for (const r of skillRecords(subs)) if (r.level === "weak" || r.level === "not_yet") weakCount.set(r.knowledge_point, (weakCount.get(r.knowledge_point) ?? 0) + 1);
  return all.map((r) => ({ ...r, students: weakCount.get(r.knowledge_point) ?? 0 })).sort(byPriority);
}

// ── The domain of the built-in generator a skill belongs to ─────────

const DOMAIN_WORDS: [RegExp, CompetitionDomain][] = [
  [/数列|找规律|规律|第\s*n\s*项|通项|等差|等比|sequence|pattern|n-?th term/i, "sequence"],
  [/应用题|应用|行程|工程|鸡兔|植树|和差|和倍|差倍|归一|归总|浓度|利润|折扣|盈亏|word problem/i, "word_problem"],
  [/不等式|inequalit/i, "inequality"],
  [/几何|三角形|四边形|多边形|圆|角|面积|周长|体积|表面积|相似|全等|勾股|坐标|图形|平行|垂直|对称|geometr|triangle|circle|angle|area|perimeter|volume|polygon|coordinate|symmetr/i, "geometry"],
  [/整除|因数|倍数|质数|素数|合数|余数|公约|公倍|同余|数论|奇偶|divisib|prime|factor|multiple|remainder|gcd|lcm|parity/i, "number_theory"],
  [/排列|组合|计数|概率|抽屉|枚举|count|permutation|combination|probabilit|pigeonhole/i, "combinatorics"],
  [/集合|venn|\bsets?\b/i, "set_theory"],
  [/逻辑|推理|logic|reasoning/i, "logic"],
  [/方程|函数|代数|因式|多项式|整式|分式|根式|二次|一次|指数|对数|equation|function|algebra|polynomial|quadratic|linear|expression/i, "algebra"],
  [/计算|运算|分数|小数|百分|乘法|除法|加法|减法|四则|估算|简便|arithmetic|fraction|decimal|percent|multiplication|division|addition|subtraction/i, "computation"],
];

export function domainForSkill(skill: string, grade: GradeLevel): CompetitionDomain {
  const hit = DOMAIN_WORDS.find(([re]) => re.test(skill))?.[1];
  const d = hit ?? (grade === "elementary" ? "computation" : "algebra");
  return domainAllowed(d, grade) ? d : "algebra";
}

/** The kind of question a written problem is: choice when it lists options A., B., …; proof when it asks for one; else a worked problem. */
export function kindOfText(text: string): ExamKind {
  if ((text.match(/^\s*[A-H]\s*[.．、)）]/gm) ?? []).length >= 2) return "choice";
  if (/求证|证明|prove|show that/i.test(text)) return "proof";
  return "solve";
}

// ── The plan ─────────────────────────────────────────────────────────

export interface BankIndex {
  id: string;
  name: string;
  items: { knowledge_points: string[] }[];
}

export interface PlanInput {
  records: SkillRecord[];
  grade_level: GradeLevel;
  title: string;
  /** Questions on the paper (default DEFAULT_QUESTIONS; 4–20). */
  questions?: number;
  /** The teacher's banks (bank sources where they have the skill). */
  banks?: BankIndex[];
}

export class PlanError extends Error {}

const newId = () => randomUUID().replace(/-/g, "").slice(0, 10);

/** Largest-remainder shares of `total`, at least `min` each. */
export function shares(weights: number[], total: number, min = 1): number[] {
  const n = weights.length;
  if (!n) return [];
  const base = Array(n).fill(min) as number[];
  let left = total - min * n;
  if (left <= 0) return base;
  const sum = weights.reduce((a, b) => a + b, 0) || n;
  const exact = weights.map((w) => (w / sum) * left);
  const out = base.map((b, i) => b + Math.floor(exact[i]));
  left -= exact.reduce((a, x) => a + Math.floor(x), 0);
  const order = exact.map((x, i) => ({ r: x - Math.floor(x), i })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; k < left; k++) out[order[k % n].i]++;
  return out;
}

const KINDS_FOR: Record<MasteryLevel, ExamKind[]> = {
  not_yet: ["solve", "blank"],
  weak: ["solve", "blank"],
  developing: ["blank", "solve"],
  mastered: ["choice", "blank"],
};

export function difficultyFor(level: MasteryLevel, setAt: number | undefined): number {
  const base = setAt ?? 2;
  if (level === "mastered") return Math.min(5, base + 1);
  if (level === "developing") return base;
  return Math.max(1, base - 1);
}

function levelWords(r: SkillRecord): string {
  const lv = { not_yet: lt("未掌握", "not yet"), weak: lt("薄弱", "weak"), developing: lt("基本掌握", "developing"), mastered: lt("已掌握", "mastered") }[r.level];
  const many = r.students ? lt(`，${r.students} 名学生不熟`, `, ${r.students} student(s) not secure`) : "";
  return lt(`${lv}：${r.attempts} 次作答 ${r.correct} 次全对${many}`, `${lv}: ${r.correct} of ${r.attempts} fully correct${many}`);
}

/** The paper's parts, aimed at the skills the marked work shows are not yet secure. */
export function planExam(input: PlanInput): Blueprint {
  const records = [...input.records].filter((r) => r.attempts > 0).sort(byPriority);
  if (!records.length) throw new PlanError(lt("还没有批改过的作答，无法按掌握情况出卷", "No marked work yet: there is nothing to plan the paper from"));
  const focus = records.filter((r) => r.level !== "mastered").slice(0, MAX_FOCUS);
  const stretch = records.filter((r) => r.level === "mastered").slice(0, focus.length ? 1 : 2);
  const total = Math.max(4, Math.min(20, Math.round(input.questions ?? DEFAULT_QUESTIONS)));
  let chosen = [...focus, ...stretch];
  if (chosen.length > total) chosen = chosen.slice(0, total);
  const counts = shares(
    chosen.map((r) => WEIGHT[r.level]),
    total,
  );
  const parts: ExamPart[] = [];
  chosen.forEach((r, i) => {
    let n = counts[i];
    const difficulty = difficultyFor(r.level, r.difficulty);
    const target = { knowledge_point: r.knowledge_point, level: r.level, attempts: r.attempts, correct: r.correct, ...(r.students !== undefined ? { students: r.students } : {}) };
    const why = levelWords(r);
    const step = difficulty < (r.difficulty ?? 2) ? lt("降一级难度", "one step easier") : difficulty > (r.difficulty ?? 2) ? lt("升一级难度", "one step harder") : lt("难度不变", "same difficulty");
    // variants of the questions got wrong, first
    if (r.level !== "mastered" && r.wrong.length && n > 0) {
      const v = Math.min(n, r.wrong.length, 2);
      const like = r.wrong.slice(0, v);
      parts.push({
        id: newId(),
        kind: kindOfText(like[0]),
        count: v,
        points: DEFAULT_POINTS[kindOfText(like[0])],
        difficulty: Math.max(1, Math.min(5, r.difficulty ?? difficulty)),
        knowledge_points: [r.knowledge_point],
        source: { kind: "builtin", domain: domainForSkill(r.knowledge_point, input.grade_level) },
        like,
        reason: lt(`${r.knowledge_point}（${why}）— 做错的 ${v} 道题的变式`, `${r.knowledge_point} (${why}) — variants of ${v} question(s) got wrong`),
        target,
      });
      n -= v;
    }
    if (n <= 0) return;
    const bank = input.banks ? matchBank(input.banks, [r.knowledge_point]) : undefined;
    const source: ExamPart["source"] =
      bank && bank.matched >= MIN_BANK_TEMPLATES
        ? { kind: "bank", bank_id: bank.bank_id, bank_name: bank.bank_name, knowledge_point: bank.knowledge_point }
        : { kind: "builtin", domain: domainForSkill(r.knowledge_point, input.grade_level) };
    const kinds = KINDS_FOR[r.level];
    // n questions over the skill's kinds — one or two in its first kind only (a paper of many one-question parts is hard to read), more: the first kind gets the larger half
    const split = n <= 2 ? [n] : [Math.ceil(n / 2), Math.floor(n / 2)];
    split.forEach((c, k) => {
      if (!c) return;
      const kind = kinds[k];
      parts.push({
        id: newId(),
        kind,
        count: c,
        points: DEFAULT_POINTS[kind],
        difficulty,
        knowledge_points: [r.knowledge_point],
        source,
        like: [],
        reason:
          r.level === "mastered"
            ? lt(`${r.knowledge_point}（${why}）— 拓展，${step}`, `${r.knowledge_point} (${why}) — to stretch, ${step}`)
            : lt(`${r.knowledge_point}（${why}）— ${step}`, `${r.knowledge_point} (${why}) — ${step}`),
        target,
      });
    });
  });
  return { title: input.title.slice(0, 100), grade_level: input.grade_level, parts: parts.slice(0, MAX_PARTS) };
}

/** What the plan is based on, kept with the exam. */
export function planBasis(args: { scope: "member" | "class"; member_id?: string; name: string; records: SkillRecord[]; submissions: number; exam_ids: string[] }): PlanBasis {
  return {
    scope: args.scope,
    ...(args.member_id ? { member_id: args.member_id } : {}),
    name: args.name.slice(0, 100),
    submissions: args.submissions,
    exam_ids: [...new Set(args.exam_ids)].slice(0, 50),
    mastery: args.records.slice(0, 40).map((r) => ({ knowledge_point: r.knowledge_point, level: r.level, attempts: r.attempts, correct: r.correct })),
    at: Date.now(),
  };
}
