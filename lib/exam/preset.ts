/**
 * Papers to start from and the usual points per question (browser-safe: the exam page builds a
 * paper from these; the server gives the parts new ids when it stores the exam).
 */
import { domainAllowed, type CompetitionDomain, type GradeLevel } from "../types";
import type { Blueprint, ExamKind, ExamPart } from "./types";

/** Points for one question of each kind on a planned paper (the teacher can change them). */
export const DEFAULT_POINTS: Record<ExamKind, number> = { choice: 4, blank: 4, solve: 10, proof: 12 };

let seq = 0;
/** An id for a part being edited (replaced by the server). */
export const draftPartId = () => `d${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A new part of the given kind, in a domain the level offers. */
export function newPart(kind: ExamKind, grade: GradeLevel, domain: CompetitionDomain = grade === "elementary" ? "computation" : "algebra"): ExamPart {
  return {
    id: draftPartId(),
    kind,
    count: kind === "proof" ? 1 : kind === "solve" ? 3 : 4,
    points: DEFAULT_POINTS[kind],
    difficulty: 2,
    knowledge_points: [],
    source: { kind: "builtin", domain: domainAllowed(domain, grade) ? domain : "algebra" },
    like: [],
  };
}

/** A usual 100-point paper for the level, to edit: choice, fill-in and worked problems (and a proof in high school). */
export function presetBlueprint(grade: GradeLevel, title: string): Blueprint {
  const part = (kind: ExamKind, domain: CompetitionDomain, count: number, points: number, difficulty = 2): ExamPart => ({
    ...newPart(kind, grade, domain),
    count,
    points,
    difficulty,
  });
  const parts =
    grade === "elementary"
      ? [part("choice", "computation", 4, 5), part("blank", "computation", 4, 5), part("solve", "word_problem", 3, 20)]
      : grade === "middle"
        ? [part("choice", "algebra", 5, 4), part("blank", "geometry", 5, 4), part("solve", "algebra", 3, 12), part("solve", "geometry", 2, 12, 3)]
        : [part("choice", "algebra", 6, 5), part("blank", "algebra", 4, 5), part("solve", "geometry", 3, 12), part("proof", "inequality", 1, 14, 3)];
  return { title: title.slice(0, 100), grade_level: grade, parts };
}
