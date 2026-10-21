/**
 * Learning record (学情) from marked submissions: how often a student (or a class) is right,
 * which kinds of mistakes recur and which skills are weak. Pure; runs on the server and in tests.
 */
import { effectiveScore, effectiveVerdict, ERROR_TYPES, VERDICTS, type ErrorType, type Submission, type Verdict } from "./types";

export interface KnowledgeStat {
  name: string;
  attempts: number;
  correct: number;
  /** correct / attempts */
  rate: number;
}

export interface LearningStats {
  submissions: number;
  marked: number;
  /** Fully correct work (verdict "correct"). */
  correct: number;
  /** Right final answer, whatever the working. */
  answer_correct: number;
  correct_rate: number;
  answer_rate: number;
  mean_score: number | null;
  verdicts: Record<Verdict, number>;
  error_types: Record<ErrorType, number>;
  /** Skills with at least one attempt, weakest first. */
  knowledge: KnowledgeStat[];
  /** The most recent marked verdicts, newest first (for a trend strip). */
  recent: { id: string; verdict: Verdict; score: number | null; at: number }[];
}

export function learningStats(subs: Submission[], opts: { recent?: number } = {}): LearningStats {
  const marked = subs.filter((s) => s.status === "marked" && s.marking);
  const verdicts = Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<Verdict, number>;
  const errorTypes = Object.fromEntries(ERROR_TYPES.map((e) => [e, 0])) as Record<ErrorType, number>;
  const know = new Map<string, { attempts: number; correct: number }>();
  let correct = 0;
  let answerCorrect = 0;
  let scoreSum = 0;
  let scored = 0;
  for (const s of marked) {
    const v = effectiveVerdict(s)!;
    verdicts[v]++;
    const ok = v === "correct";
    if (ok) correct++;
    const answerOk = s.teacher?.verdict ? v === "correct" || v === "correct_answer_flawed" : s.marking!.answer_correct === true;
    if (answerOk) answerCorrect++;
    if (v !== "unreadable") {
      scoreSum += effectiveScore(s) ?? 0;
      scored++;
    }
    if (!ok) for (const e of s.marking!.error_types) errorTypes[e]++;
    for (const k of s.marking!.knowledge_points) {
      const key = k.trim();
      if (!key) continue;
      const cur = know.get(key) ?? { attempts: 0, correct: 0 };
      cur.attempts++;
      if (ok) cur.correct++;
      know.set(key, cur);
    }
  }
  const knowledge = [...know.entries()]
    .map(([name, x]) => ({ name, ...x, rate: x.correct / x.attempts }))
    .sort((a, b) => a.rate - b.rate || b.attempts - a.attempts || a.name.localeCompare(b.name));
  const n = marked.length;
  return {
    submissions: subs.length,
    marked: n,
    correct,
    answer_correct: answerCorrect,
    correct_rate: n ? correct / n : 0,
    answer_rate: n ? answerCorrect / n : 0,
    mean_score: scored ? Math.round(scoreSum / scored) : null,
    verdicts,
    error_types: errorTypes,
    knowledge,
    recent: [...marked]
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, opts.recent ?? 20)
      .map((s) => ({ id: s.id, verdict: effectiveVerdict(s)!, score: effectiveScore(s), at: s.created_at })),
  };
}
