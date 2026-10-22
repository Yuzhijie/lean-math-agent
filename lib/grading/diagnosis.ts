/**
 * Diagnosis (学习诊断) from marked work — one paper, or everything a student has done:
 *
 *   - mastery: per skill, counted by the program from the verdicts (a fully correct piece earns 1,
 *     right answer with flawed working or a right approach with a slip 0.5) and levelled by fixed
 *     rules (masteryLevels), so the levels do not depend on a model's mood;
 *   - approach, strengths, weaknesses, summary: the model reads the per-question approaches,
 *     verdicts and mistake types and describes how the student works;
 *   - next: what to test next (question type, skills, difficulty, how many, why), each matched to
 *     the teacher's question bank where possible (bank + knowledge point to generate from), else
 *     to the built-in generator's grade / difficulty / domain.
 */
import { z } from "zod";
import { chatJson } from "../llm/client";
import { listBanks, listItems } from "../bank/store";
import { COMPETITION_DOMAINS, DIFFICULTY_LEVELS, GRADE_LEVELS } from "../types";
import { effectiveVerdict, type Diagnosis, type MasteryLevel, type Submission, type Verdict } from "./types";

const CREDIT: Record<Verdict, number> = { correct: 1, correct_answer_flawed: 0.5, partially_correct: 0.5, incorrect: 0, no_answer: 0, unreadable: 0 };

/** Fixed rules: ≥ 80 % credit over ≥ 2 attempts = mastered; ≥ 50 % = developing; > 0 = weak; else not yet. */
export function masteryLevel(credit: number, attempts: number): MasteryLevel {
  const rate = attempts ? credit / attempts : 0;
  if (rate >= 0.8 && attempts >= 2) return "mastered";
  if (rate >= 0.5) return "developing";
  if (rate > 0) return "weak";
  return "not_yet";
}

const LEVEL_ORDER: Record<MasteryLevel, number> = { not_yet: 0, weak: 1, developing: 2, mastered: 3 };

export function masteryOf(subs: Submission[]): Diagnosis["mastery"] {
  const by = new Map<string, { attempts: number; correct: number; credit: number }>();
  for (const s of subs) {
    const v = effectiveVerdict(s);
    if (!v || v === "unreadable" || !s.marking) continue;
    for (const kp of new Set(s.marking.knowledge_points.map((k) => k.trim()).filter(Boolean))) {
      const cur = by.get(kp) ?? { attempts: 0, correct: 0, credit: 0 };
      cur.attempts++;
      if (v === "correct") cur.correct++;
      cur.credit += CREDIT[v];
      by.set(kp, cur);
    }
  }
  return [...by.entries()]
    .map(([knowledge_point, x]) => ({ knowledge_point, attempts: x.attempts, correct: x.correct, level: masteryLevel(x.credit, x.attempts) }))
    .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || b.attempts - a.attempts || a.knowledge_point.localeCompare(b.knowledge_point));
}

// ── Matching a recommendation to the teacher's banks ────────────────

const kpKey = (s: string) => s.toLowerCase().replace(/[\s·、,，()（）-]/g, "");

/** The bank and knowledge point with the most questions matching any of the skills (name equal or contained). */
export function matchBank(
  banks: { id: string; name: string; items: { knowledge_points: string[] }[] }[],
  skills: string[],
): { bank_id: string; bank_name: string; knowledge_point: string; matched: number } | undefined {
  let best: { bank_id: string; bank_name: string; knowledge_point: string; matched: number } | undefined;
  const wanted = skills.map(kpKey).filter((k) => k.length >= 2);
  if (!wanted.length) return undefined;
  for (const b of banks) {
    const counts = new Map<string, number>();
    for (const it of b.items) for (const kp of new Set(it.knowledge_points)) counts.set(kp, (counts.get(kp) ?? 0) + 1);
    for (const [kp, n] of counts) {
      const k = kpKey(kp);
      if (k.length < 2 || !wanted.some((w) => w === k || w.includes(k) || k.includes(w))) continue;
      if (!best || n > best.matched) best = { bank_id: b.id, bank_name: b.name, knowledge_point: kp, matched: n };
    }
  }
  return best;
}

function ownerBanks(owner: string) {
  try {
    return listBanks(owner).map((b) => ({ id: b.id, name: b.name, items: listItems(owner, b.id).map((i) => ({ knowledge_points: i.knowledge_points })) }));
  } catch {
    return [];
  }
}

// ── The model's part ─────────────────────────────────────────────────

const diagOut = z.object({
  approach: z.string().default(""),
  strengths: z.array(z.string()).default([]),
  weaknesses: z.array(z.string()).default([]),
  mastery_notes: z.array(z.object({ knowledge_point: z.string(), note: z.string() })).default([]),
  next: z
    .array(
      z.object({
        question_type: z.string(),
        knowledge_points: z.array(z.string()).default([]),
        difficulty: z.coerce.number().default(2),
        count: z.coerce.number().default(3),
        reason: z.string().default(""),
        grade_level: z.string().nullish(),
        builtin_difficulty: z.string().nullish(),
        domain: z.string().nullish(),
      }),
    )
    .default([]),
  summary: z.string().default(""),
});

export const DIAGNOSIS_SYSTEM = `You are an experienced mathematics teacher writing a learning diagnosis for one student from their marked work. Write everything in Chinese, concretely and kindly, for the teacher (and the student).
You get each marked question: the problem, the verdict, the student's approach as the marker summarised it, mistake types, the first wrong step's comment, and skills; plus a mastery table the program computed (do not change its levels).
Return JSON:
- "approach": 2–4 sentences on HOW the student works — typical strategies, whether they set up equations / draw figures / check answers, where their reasoning tends to break (cite the questions by their labels, e.g. "第 2 题" or the paper and question given).
- "strengths", "weaknesses": short concrete bullet phrases (max 4 each), each tied to evidence.
- "mastery_notes": for skills in the table that need a remark, one short note each (what exactly is not yet secure).
- "next": 2–4 recommendations for the NEXT test, most important first. Each: "question_type" (e.g. "一元一次方程应用题（行程问题）", "含括号的分数四则运算"), "knowledge_points" (1–3, use the table's skill names where possible), "difficulty" 1–5 (one step above the student's secure level for weak skills; harder for mastered ones, to stretch), "count" 2–6, "reason" (which evidence it addresses). Also pick for the built-in generator "grade_level" from ${GRADE_LEVELS.join("/")}, "builtin_difficulty" from ${DIFFICULTY_LEVELS.join("/")}, "domain" from ${COMPETITION_DOMAINS.join("/")}.
- "summary": one sentence the teacher can read first.`;

export interface DiagnosisInput {
  submissions: Submission[];
  /** How each question is cited: its number on one paper, or paper + number / date across work. */
  numbers?: Map<string, string>;
  owner?: string;
}

function questionLine(s: Submission, n: string): string {
  const m = s.marking!;
  const wrong = m.first_error_step ? m.steps.find((x) => x.index === m.first_error_step)?.comment : undefined;
  return [
    `[${/^\d/.test(n) ? `第 ${n} 题` : n}] ${s.problem.text.replace(/\s+/g, " ").slice(0, 300)}`,
    `  verdict: ${effectiveVerdict(s)}; score ${m.score}; approach: ${m.approach || "-"}${m.approach_valid === false ? " (does not work)" : ""}`,
    m.error_types.length ? `  mistakes: ${m.error_types.join(", ")}${wrong ? ` — first wrong step: ${wrong}` : ""}` : "",
    m.knowledge_points.length ? `  skills: ${m.knowledge_points.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function diagnose(input: DiagnosisInput): Promise<Diagnosis> {
  const marked = input.submissions.filter((s) => s.status === "marked" && s.marking && effectiveVerdict(s) !== "unreadable");
  const mastery = masteryOf(marked);
  if (!marked.length) {
    return { approach: "", strengths: [], weaknesses: [], mastery, next: [], summary: "", based_on: 0, created_at: Date.now() };
  }
  const lines = marked.slice(0, 40).map((s, i) => questionLine(s, input.numbers?.get(s.id) ?? String(i + 1)));
  const table = mastery.map((m) => `${m.knowledge_point}: ${m.correct}/${m.attempts} fully correct → ${m.level}`).join("\n");
  const r = await chatJson({
    system: DIAGNOSIS_SYSTEM,
    user: `MARKED WORK (${marked.length}):\n${lines.join("\n")}\n\nMASTERY (computed by the program):\n${table || "(no skills recorded)"}`,
    schema: diagOut,
    schemaName: "diagnosis",
    reasoningEffort: "high",
    maxRetries: 1,
  });
  const notes = new Map(r.mastery_notes.map((n) => [n.knowledge_point.trim(), n.note.trim()]));
  const banks = input.owner ? ownerBanks(input.owner) : [];
  const pick = <T extends string>(v: string | null | undefined, allowed: readonly T[], dflt: T): T => (allowed.includes(v as T) ? (v as T) : dflt);
  return {
    approach: r.approach.trim(),
    strengths: r.strengths.map((x) => x.trim()).filter(Boolean).slice(0, 4),
    weaknesses: r.weaknesses.map((x) => x.trim()).filter(Boolean).slice(0, 4),
    mastery: mastery.map((m) => (notes.get(m.knowledge_point) ? { ...m, note: notes.get(m.knowledge_point) } : m)),
    next: r.next.slice(0, 4).map((n) => {
      const kps = n.knowledge_points.map((k) => k.trim()).filter(Boolean).slice(0, 3);
      const bank = matchBank(banks, kps.length ? kps : [n.question_type]);
      return {
        question_type: n.question_type.trim(),
        knowledge_points: kps,
        difficulty: Math.min(5, Math.max(1, Math.round(n.difficulty))),
        count: Math.min(6, Math.max(2, Math.round(n.count))),
        reason: n.reason.trim(),
        ...(bank ? { bank } : {}),
        builtin: {
          grade_level: pick(n.grade_level, GRADE_LEVELS, "middle"),
          difficulty: pick(n.builtin_difficulty, DIFFICULTY_LEVELS, "standard"),
          domain: pick(n.domain, COMPETITION_DOMAINS, "algebra"),
        },
      };
    }),
    summary: r.summary.trim(),
    based_on: marked.length,
    created_at: Date.now(),
  };
}
