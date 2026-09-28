/**
 * Plain text / Markdown (and extracted PDF text) → questions.
 *
 *  - Questions start at a number at the beginning of a line: "1." "1、"
 *    "1)" "(1)" "（1）" "Q1" "Question 1" "第1题" "例1". The most frequent
 *    style is the question numbering; the others (e.g. "(1)" sub-parts
 *    inside a question) stay part of the text. Numbers must go up (a
 *    restart at a lower number is allowed after a section heading).
 *  - Choices A–E ("A." "A)" "(A)" "A、" or "A " at a line start) become
 *    options[] and the type multiple_choice.
 *  - "答案：…" / "Answer: …" and "解析：…" / "Solution: …" lines belong to
 *    their question; an answer-key section ("Answers", "参考答案" …) at the
 *    end is matched to the questions by number.
 */
import { lt } from "@/lib/llm/output-locale";
import type { QuestionType } from "../types";
import { recordToFields, type ParsedQuestion } from "./fields";

export interface SourceLine {
  text: string;
  page?: number;
}

export interface SplitOptions {
  /** PDF text: line breaks are layout, not meaning — join stem lines. */
  joinLines?: boolean;
  /** Flag questions that mention a figure the import cannot carry over. */
  figureCheck?: boolean;
}

// ── Question starts ──────────────────────────────────────────────────

type Style = "num" | "rparen" | "paren" | "q" | "di" | "li";
const MAIN_STYLES: Style[] = ["num", "rparen", "paren", "q"];

const PREFIX = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*/;
const CLOSE = String.raw`\s*(?:\*\*|__)?\s*`;
const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function cnNumber(s: string): number {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === "十") return 10;
  const m = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/.exec(s);
  if (m) return (m[1] ? CN_NUM[m[1]] : 1) * 10 + (m[2] ? CN_NUM[m[2]] : 0);
  return CN_NUM[s] ?? NaN;
}

const START_PATTERNS: Array<[Style, RegExp]> = [
  ["di", new RegExp(String.raw`^第\s*(\d{1,3}|[一二三四五六七八九十]{1,3})\s*题${CLOSE}[.:：、．]?${CLOSE}`)],
  ["li", new RegExp(String.raw`^例\s*(\d{1,3})${CLOSE}[.:：、．]?${CLOSE}`)],
  ["q", new RegExp(String.raw`^(?:Q\s*|[Qq]uestion\s+)(\d{1,3})(?!\d)${CLOSE}[.:：)]?${CLOSE}`)],
  ["paren", /^[(（]\s*(\d{1,3})\s*[)）]\s*/],
  ["num", new RegExp(String.raw`^(\d{1,3})${CLOSE}(?:[.．](?!\d)|、)${CLOSE}`)],
  ["rparen", /^(\d{1,3})\s*[)）]\s*/],
];

interface Start {
  style: Style;
  num: number;
  label: string;
  rest: string;
}

function matchStart(line: string): Start | undefined {
  const pre = PREFIX.exec(line)?.[0] ?? "";
  const s = line.slice(pre.length);
  for (const [style, re] of START_PATTERNS) {
    const m = re.exec(s);
    if (!m) continue;
    const num = cnNumber(m[1]);
    if (!Number.isFinite(num)) continue;
    const label = style === "li" ? `例${num}` : style === "q" ? `Q${num}` : String(num);
    return { style, num, label, rest: s.slice(m[0].length) };
  }
  return undefined;
}

/** Section heading between questions ("## Part A", "一、选择题", "Section 2", "练习一"); short lines only. */
function isHeading(line: string): boolean {
  const t = line.trim();
  if (/^#{1,6}\s+\S/.test(t)) return t.length <= 80;
  if (t.length > 40) return false;
  return /^(?:[一二三四五六七八九十]{1,3}\s*[、.．]\s*\S|(?:Part|Section)\s+[A-Z0-9IVX]+\b|(?:练习|习题|Exercises?)\s*[\d一二三四五六七八九十]*\s*[:：]?\s*$)/i.test(t);
}

function sectionHint(heading: string): QuestionType | undefined {
  if (/选择|multiple[\s-]*choice/i.test(heading)) return "multiple_choice";
  if (/证明|proof/i.test(heading)) return "proof";
  if (/填空|解答|计算|应用|short[\s-]*answer|extended|free[\s-]*response/i.test(heading)) return "short_answer";
  return undefined;
}

// ── Answers and solutions ────────────────────────────────────────────

const ANSWER_KEY_HEADING = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:answers?|answer\s*key|answer\s*sheet|answers?\s*and\s*solutions?|参考答案|答案|答案与解析|答案及解析|参考答案与解析|参考答案及解析)\s*(?:\*\*|__)?\s*[:：]?\s*(?:\*\*|__)?\s*$/i;

const MARKER = /^\s*(?:(?:\*\*|__)?\s*【\s*(答案|解析|详解|分析|解答|点评|考点)\s*】\s*(?:\*\*|__)?\s*[:：]?|(?:\*\*|__)?\s*(答案|参考答案|正确答案|解析|详解|分析|点评|考点|Answer|Ans\.?|Correct answer|Solution|Worked solution|Explanation|Working)\s*(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?)\s*/i;

type Part = "body" | "answer" | "solution" | "kp";
function markerKind(word: string): Part {
  const w = word.toLowerCase();
  if (/^(答案|参考答案|正确答案|answer|ans\.?|correct answer)$/.test(w)) return "answer";
  if (w === "考点") return "kp";
  return "solution";
}

/** Put inline "【答案】" / " 答案：" / " Answer:" markers on a line of their own. */
function splitInlineMarkers(text: string): string[] {
  return text
    .replace(/(\S)\s*(【\s*(?:答案|解析|详解|分析|点评|考点)\s*】)/g, "$1\n$2")
    .replace(/([\s)）])\s*((?:答案|解析|Answer|Solution)\s*[:：])/g, "$1\n$2")
    .split("\n");
}

export interface KeyEntry {
  answer: string;
  solution?: string;
}

/** Parse an answer-key section: "1. B", "1 B", "1) 12", "1-B", "1 B 2 C 3 A", "1-5 BCADA", number/answer table rows. */
export function parseAnswerKey(lines: string[]): Map<number, KeyEntry> {
  const key = new Map<number, KeyEntry>();
  let last: KeyEntry | undefined;
  const set = (n: number, e: KeyEntry) => {
    if (!key.has(n)) key.set(n, e);
    last = key.get(n);
  };
  const clean = lines.map((l) => l.replace(/\|/g, " ").replace(/^[\s:-]+$/, "").trim());
  for (let i = 0; i < clean.length; i++) {
    let line = clean[i];
    if (!line) continue;
    // Table: a row of numbers followed by a row of answers.
    const nums = line.split(/\s+/);
    if (nums.length >= 2 && nums.every((t) => /^\d{1,3}$/.test(t)) && i + 1 < clean.length) {
      const next = clean[i + 1].split(/\s+/);
      if (next.length === nums.length) {
        nums.forEach((n, k) => set(Number(n), { answer: next[k] }));
        i++;
        continue;
      }
    }
    // Ranges: "1-5 BCADA".
    let ranged = false;
    line = line.replace(/(\d{1,3})\s*[-–~～]\s*(\d{1,3})\s*[.:：、]?\s*([A-E]{2,})(?![A-Za-z])/g, (all, a: string, b: string, letters: string) => {
      const from = Number(a);
      const to = Number(b);
      if (to - from + 1 !== letters.length) return all;
      for (let k = 0; k < letters.length; k++) set(from + k, { answer: letters[k] });
      ranged = true;
      return " ";
    });
    if (ranged && !line.trim()) continue;
    line = line.trim();
    // Several "N X" pairs on one line: "1 B 2 C 3 A", "1.B 2.C".
    const pairs = [...line.matchAll(/(?:^|\s)(\d{1,3})\s*[.、)．:：\-–]?\s*[(（]?([A-E])[)）]?(?=$|[\s,，;；])/g)];
    if (pairs.length >= 2) {
      for (const p of pairs) set(Number(p[1]), { answer: p[2] });
      continue;
    }
    const single = /^(\d{1,3})\s*[.、)．:：\-–]\s*(.+)$/.exec(line) ?? /^(\d{1,3})\s+(.+)$/.exec(line);
    if (single) {
      const rest = single[2].trim();
      const letter = /^[(（]?([A-E])[)）]?(?:[\s.、。:：]+(.+))?$/.exec(rest);
      if (letter) set(Number(single[1]), { answer: letter[1], solution: letter[2]?.replace(MARKER, "").trim() || undefined });
      else {
        const m = MARKER.exec(rest);
        set(Number(single[1]), { answer: m ? rest.slice(m[0].length) : rest });
      }
      continue;
    }
    // Anything else continues the previous entry's explanation.
    if (last) {
      const text = line.replace(MARKER, "").trim();
      if (text) last.solution = last.solution ? `${last.solution}\n${text}` : text;
    }
  }
  return key;
}

// ── Options ──────────────────────────────────────────────────────────

const OPTION_MARK = /(^|\n|[ \t　]+)(?:\(\s*([A-E])\s*\)|（\s*([A-E])\s*）|([A-E])\s*[.．、:：)）]|([A-E])[ \t]+(?=\S))/g;

/** Split "stem … A. x B. y …" into stem and options (letters dropped). Undefined when there are no options. */
export function detectOptions(body: string): { stem: string; options: string[] } | undefined {
  const marks: Array<{ index: number; textStart: number; letter: string; style: "paren" | "punct" | "space" }> = [];
  for (const m of body.matchAll(OPTION_MARK)) {
    const lineStart = m[1] === "" || m[1] === "\n";
    const style = m[2] || m[3] ? "paren" : m[4] ? "punct" : "space";
    if (style === "space" && !lineStart) continue;
    marks.push({ index: m.index!, textStart: m.index! + m[0].length, letter: m[2] || m[3] || m[4] || m[5], style });
  }
  let best: number[] | undefined;
  for (let i = 0; i < marks.length; i++) {
    if (marks[i].letter !== "A") continue;
    const run = [i];
    for (let j = i + 1; j < marks.length; j++) {
      if (marks[j].style !== marks[i].style) continue;
      const expected = String.fromCharCode(65 + run.length);
      if (marks[j].letter === expected) run.push(j);
      else break;
    }
    const min = marks[i].style === "space" ? 3 : 2;
    if (run.length >= min && (!best || run.length >= best.length)) best = run;
  }
  if (!best) return undefined;
  const stem = body.slice(0, marks[best[0]].index).trim();
  if (!stem) return undefined;
  const options = best.map((mi, k) => {
    const end = k + 1 < best!.length ? marks[best![k + 1]].index : body.length;
    return body.slice(marks[mi].textStart, end).replace(/\s*\n\s*/g, " ").trim();
  });
  return { stem, options };
}

// ── Splitting ────────────────────────────────────────────────────────

const FIGURE_WORDS = /\b(?:shown|diagram|graph|picture|figure|below|chart|image)\b|如图|下图|图中|右图|左图|见图|图示/i;

/** Join PDF layout lines: no space between CJK characters. */
function joinLayout(lines: string[]): string {
  let out = "";
  for (const l of lines.map((x) => x.trim()).filter(Boolean)) {
    if (!out) out = l;
    else if (/[　-〿一-鿿＀-￯]$/.test(out) || /^[　-〿一-鿿＀-￯]/.test(l)) out += l;
    else out += " " + l;
  }
  return out;
}

interface Segment {
  label: string;
  num: number;
  group: "main" | "di" | "li";
  lines: SourceLine[];
  hint?: QuestionType;
}

function findAnswerKey(lines: SourceLine[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (!ANSWER_KEY_HEADING.test(lines[i].text)) continue;
    // A real key lists short answers; a bare "答案" line inside a question followed by more questions does not.
    const entries = [...parseAnswerKey(lines.slice(i + 1).map((l) => l.text)).values()];
    const short = entries.filter((e) => e.answer.trim().length <= 25).length;
    const questiony = entries.some((e) => /[?？]\s*$|[(（]\s*[)）]|_{3,}/.test(e.answer));
    if (entries.length && !questiony && short >= entries.length * 0.6) return i;
  }
  return -1;
}

/** Split lines into questions. */
export function splitQuestions(input: SourceLine[], opts: SplitOptions = {}): ParsedQuestion[] {
  const lines: SourceLine[] = input.flatMap((l) => splitInlineMarkers(l.text.replace(/\r/g, "")).map((text) => ({ text, page: l.page })));

  const keyAt = findAnswerKey(lines);
  const key = keyAt >= 0 ? parseAnswerKey(lines.slice(keyAt + 1).map((l) => l.text)) : new Map<number, KeyEntry>();
  const body = keyAt >= 0 ? lines.slice(0, keyAt) : lines;

  // Most frequent numbering style is the question numbering.
  const counts = new Map<Style, number>();
  const firstSeen = new Map<Style, number>();
  body.forEach((l, i) => {
    const s = matchStart(l.text);
    if (s && MAIN_STYLES.includes(s.style)) {
      counts.set(s.style, (counts.get(s.style) ?? 0) + 1);
      if (!firstSeen.has(s.style)) firstSeen.set(s.style, i);
    }
  });
  const primary = [...counts.entries()].sort((a, b) => b[1] - a[1] || firstSeen.get(a[0])! - firstSeen.get(b[0])!)[0]?.[0];

  const segs: Segment[] = [];
  const lastNum: Partial<Record<Segment["group"], number>> = {};
  let sectionSince = false;
  let hint: QuestionType | undefined;
  let cur: Segment | undefined;
  for (const l of body) {
    const s = matchStart(l.text);
    const group: Segment["group"] | undefined = !s ? undefined : s.style === "di" ? "di" : s.style === "li" ? "li" : s.style === primary ? "main" : undefined;
    if (s && group) {
      const last = lastNum[group];
      const ok = last === undefined || (s.num > last && s.num <= last + 5) || (s.num <= last && sectionSince);
      if (ok) {
        cur = { label: s.label, num: s.num, group, lines: [{ text: s.rest, page: l.page }], hint };
        segs.push(cur);
        lastNum[group] = s.num;
        sectionSince = false;
        continue;
      }
    }
    if (isHeading(l.text) && !MARKER.test(l.text)) {
      sectionSince = true;
      hint = sectionHint(l.text) ?? hint;
      continue;
    }
    if (cur) cur.lines.push(l);
  }

  // No numbering at all: one question per blank-line separated block.
  let fallbackIssue: string | undefined;
  if (!segs.length) {
    fallbackIssue = lt("没有找到题号，按空行拆分，请核对", "No question numbers found; split at blank lines — please check");
    let block: SourceLine[] = [];
    const flush = () => {
      if (block.some((b) => b.text.trim())) segs.push({ label: "", num: segs.length + 1, group: "main", lines: block });
      block = [];
    };
    for (const l of body) {
      if (!l.text.trim()) flush();
      else block.push(l);
    }
    flush();
  }

  const used = new Set<number>();
  return segs.map((seg) => {
    const parts: Record<Part, string[]> = { body: [], answer: [], solution: [], kp: [] };
    let part: Part = "body";
    for (const l of seg.lines) {
      const m = MARKER.exec(l.text);
      if (m) {
        part = markerKind(m[1] ?? m[2]);
        const rest = l.text.slice(m[0].length).trim();
        if (rest) parts[part].push(rest);
        continue;
      }
      parts[part].push(l.text);
    }
    const trimBlank = (xs: string[]) => xs.join("\n").replace(/^\s*\n|\n\s*$/g, "").trim();
    const bodyText = trimBlank(parts.body);
    const detected = detectOptions(bodyText);
    let stem = detected ? detected.stem : bodyText;
    if (opts.joinLines) stem = joinLayout(stem.split("\n"));
    else stem = stem.replace(/\n{3,}/g, "\n\n");

    let answer = opts.joinLines ? joinLayout(parts.answer) : trimBlank(parts.answer);
    let solution = opts.joinLines ? joinLayout(parts.solution) : trimBlank(parts.solution);
    if (!answer && seg.group === "main" && key.has(seg.num) && !used.has(seg.num)) {
      const k = key.get(seg.num)!;
      used.add(seg.num);
      answer = k.answer;
      if (!solution && k.solution) solution = k.solution;
    }

    const issues: string[] = [];
    if (fallbackIssue) issues.push(fallbackIssue);
    const { fields, issues: fieldIssues } = recordToFields(
      {
        stem,
        options: detected?.options,
        answer: answer || undefined,
        solution: solution || undefined,
        knowledge_points: parts.kp.length ? parts.kp.join("，") : undefined,
        label: seg.label || undefined,
        page: seg.lines.find((l) => l.text.trim())?.page ?? seg.lines[0]?.page,
      },
      { typeHint: seg.hint },
    );
    issues.push(...fieldIssues);

    const raw = [seg.label ? `${seg.label}. ${seg.lines[0]?.text ?? ""}` : (seg.lines[0]?.text ?? ""), ...seg.lines.slice(1).map((l) => l.text)].join("\n").trim();
    const hasImage = /!\[[^\]]*\]\([^)]*\)|<img\b/i.test(raw);
    if (hasImage) issues.push(lt("题目中的图片未导入，请对照原文件", "Images in the question were not imported; check the original"));
    else if (opts.figureCheck && FIGURE_WORDS.test(fields.stem)) issues.push(lt("题目引用了图形，请对照原文件的页面核对", "Refers to a figure; check the original page"));
    return { fields, raw, issues };
  });
}

/** Text → lines → questions. */
export function splitText(text: string, opts: SplitOptions = {}): ParsedQuestion[] {
  return splitQuestions(
    text.split(/\r?\n/).map((t) => ({ text: t })),
    opts,
  );
}
