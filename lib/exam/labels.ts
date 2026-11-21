/** Words for exams (browser-safe): kinds of question, section titles, statuses. */
import type { ExamKind, ExamStatus } from "./types";

export type Tr = (zh: string, en: string) => string;

export function kindLabel(kind: ExamKind | string, tr: Tr): string {
  switch (kind) {
    case "choice":
      return tr("选择题", "Multiple choice");
    case "blank":
      return tr("填空题", "Fill in the blank");
    case "solve":
      return tr("解答题", "Worked problems");
    case "proof":
      return tr("证明题", "Proofs");
    default:
      return kind;
  }
}

const NUMERALS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

/** "一、选择题（共 5 题，每题 4 分，共 20 分）" — points per question only when they are all the same. */
export function sectionTitle(index: number, kind: ExamKind, points: number[], tr: Tr): string {
  const n = points.length;
  const total = points.reduce((a, b) => a + b, 0);
  const same = points.every((p) => p === points[0]);
  const zh = `${NUMERALS[index] ?? index + 1}、${kindLabel(kind, tr)}（共 ${n} 题，${same ? `每题 ${points[0]} 分，` : ""}共 ${total} 分）`;
  const en = `${["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"][index] ?? index + 1}. ${kindLabel(kind, tr)} (${n} question${n === 1 ? "" : "s"}, ${same ? `${points[0]} points each, ` : ""}${total} points)`;
  return tr(zh, en);
}

export function statusLabel(s: ExamStatus, tr: Tr): string {
  switch (s) {
    case "generating":
      return tr("生成中", "Generating");
    case "ready":
      return tr("已生成", "Ready");
    case "partial":
      return tr("部分缺题", "Some questions missing");
    case "failed":
      return tr("生成失败", "Failed");
    case "cancelled":
      return tr("已停止", "Stopped");
  }
}

export function statusVariant(s: ExamStatus): "success" | "warning" | "destructive" | "secondary" | "info" {
  if (s === "ready") return "success";
  if (s === "partial" || s === "cancelled") return "warning";
  if (s === "failed") return "destructive";
  return "info";
}

export function masteryLabel(level: string, tr: Tr): string {
  switch (level) {
    case "mastered":
      return tr("已掌握", "Mastered");
    case "developing":
      return tr("基本掌握", "Developing");
    case "weak":
      return tr("薄弱", "Weak");
    case "not_yet":
      return tr("未掌握", "Not yet");
    default:
      return level;
  }
}

export function masteryVariant(level: string): "success" | "warning" | "destructive" | "secondary" | "info" {
  return level === "mastered" ? "success" : level === "developing" ? "info" : level === "weak" ? "warning" : "destructive";
}

export function gradeLabel(g: string, tr: Tr): string {
  switch (g) {
    case "elementary":
      return tr("小学", "Primary school");
    case "middle":
      return tr("初中", "Middle school");
    case "high":
      return tr("高中", "High school");
    case "university":
      return tr("大学", "University");
    default:
      return g;
  }
}

const DOMAIN_WORDS: Record<string, [string, string]> = {
  competition_elementary: ["竞赛初等", "Competition elementary math"],
  competition_inequality: ["竞赛不等式", "Competition inequalities"],
  competition_number_theory: ["竞赛数论", "Competition number theory"],
  competition_combinatorics: ["竞赛组合", "Competition combinatorics"],
  competition_set_theory: ["竞赛集合", "Competition set theory"],
  number_theory: ["数论", "Number theory"],
  combinatorics: ["组合", "Combinatorics"],
  set_theory: ["集合", "Set theory"],
  algebra: ["代数", "Algebra"],
  geometry: ["几何", "Geometry"],
  inequality: ["不等式", "Inequalities"],
  logic: ["逻辑", "Logic"],
  computation: ["计算", "Computation"],
  word_problem: ["应用题", "Word problems"],
  sequence: ["数列", "Sequences"],
};

export function domainLabel(d: string, tr: Tr): string {
  const w = DOMAIN_WORDS[d];
  return w ? tr(w[0], w[1]) : d;
}

/** Difficulty 1–5 of a part. */
export function difficultyLabel(d: number, tr: Tr): string {
  return [tr("1 · 基础", "1 · Basic"), tr("2 · 较易", "2 · Easy"), tr("3 · 中等", "3 · Medium"), tr("4 · 较难", "4 · Hard"), tr("5 · 挑战", "5 · Challenge")][d - 1] ?? String(d);
}
