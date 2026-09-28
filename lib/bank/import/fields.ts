/**
 * Lenient field mapping shared by every import format.
 *
 * Records from JSON files, spreadsheet rows and text segments are turned
 * into question fields here: header / key names in English and Chinese are
 * recognised, values are coerced (type words, difficulty words, option
 * lists, knowledge-point lists) and clamped to the limits of the data
 * model. What cannot be used is dropped with an issue for the reviewer
 * rather than failing the whole file.
 */
import { lt } from "@/lib/llm/output-locale";
import { QUESTION_TYPES, type ItemFields, type QuestionType } from "../types";

/** Field names a column / key can map to. */
export const FIELD_NAMES = ["stem", "type", "options", "answer", "solution", "grade", "difficulty", "knowledge_points", "tags", "label"] as const;
export type FieldName = (typeof FIELD_NAMES)[number];

/** Question fields while importing: like ItemFields, but the stem may be empty (→ error draft). */
export type DraftFields = ItemFields;

/** A question as cut from the file, before validation and duplicate checks. */
export interface ParsedQuestion {
  fields: DraftFields;
  /** Original text of the question in the file. */
  raw: string;
  /** Problems found while parsing (the reviewer should look at it). */
  issues: string[];
}

export const LETTERS = "ABCDEFGHIJ";

// ── Key / header recognition ─────────────────────────────────────────

/** Lower-case, drop spaces, underscores, dashes, dots, colons and brackets. */
export function normKey(k: string): string {
  return k
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s_\-.:：()（）[\]【】*]/g, "");
}

const ALIASES: Record<Exclude<FieldName, "options">, string[]> = {
  stem: ["stem", "question", "questiontext", "questionstem", "questionbody", "problem", "problemtext", "text", "content", "prompt", "body", "题目", "题干", "题目内容", "问题", "试题", "试题内容", "内容", "题面"],
  type: ["type", "questiontype", "qtype", "kind", "题型", "类型", "题目类型", "题类"],
  answer: ["answer", "answers", "correctanswer", "correct", "key", "answerkey", "ans", "correctoption", "答案", "正确答案", "参考答案", "标准答案"],
  solution: ["solution", "solutions", "explanation", "workedsolution", "working", "workings", "analysis", "rationale", "解析", "解答", "详解", "答案解析", "试题解析", "分析", "解题过程"],
  grade: ["grade", "year", "yearlevel", "gradelevel", "class", "年级", "学段", "适用年级"],
  difficulty: ["difficulty", "diff", "difficultylevel", "难度", "难易度", "难度系数", "难易程度"],
  knowledge_points: ["knowledgepoints", "knowledgepoint", "knowledge", "topic", "topics", "skill", "skills", "kp", "kps", "strand", "知识点", "考点", "知识点名称", "考查知识点"],
  tags: ["tags", "tag", "keywords", "标签", "关键词"],
  label: ["label", "number", "no", "num", "qno", "questionno", "questionnumber", "questionnum", "题号", "序号", "编号", "题目编号"],
};
const OPTION_ALIASES = ["options", "choices", "option", "choice", "选项", "备选项", "备选答案", "选项列表"];

const KEY_TO_FIELD = new Map<string, Exclude<FieldName, "options">>();
for (const [field, keys] of Object.entries(ALIASES) as Array<[Exclude<FieldName, "options">, string[]]>) for (const k of keys) KEY_TO_FIELD.set(k, field);

/** "Option A", "选项A", "A选项", "choice_b", "A" → the letter; otherwise undefined. */
export function optionLetterOf(header: string): string | undefined {
  const k = normKey(header);
  const m = /^(?:option|choice|opt|选项)?([a-j])(?:选项)?$/.exec(k);
  return m ? m[1].toUpperCase() : undefined;
}

/** Field a header / key most likely holds, or undefined. */
export function fieldForHeader(header: string): FieldName | undefined {
  if (header.trim() === "#") return "label";
  const k = normKey(header);
  if (!k) return undefined;
  if (OPTION_ALIASES.includes(k) || optionLetterOf(header)) return "options";
  // "Options (A|B|C|D)", "选项（用|分隔）" …
  if (/^(options|choices|选项)/.test(k)) return "options";
  return KEY_TO_FIELD.get(k);
}

/** Suggested header → field mapping (unrecognised headers are left out). */
export function suggestMapping(headers: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const taken = new Set<string>();
  for (const h of headers) {
    const f = fieldForHeader(h);
    if (!f) continue;
    // Only options may come from several columns; otherwise the first column wins.
    if (f !== "options" && taken.has(f)) continue;
    taken.add(f);
    out[h] = f;
  }
  return out;
}

// ── Value coercion ───────────────────────────────────────────────────

export function clampStr(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

export function asText(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return undefined;
}

export function mapType(v: unknown): QuestionType | undefined {
  const s = asText(v);
  if (!s) return undefined;
  const k = normKey(s);
  if ((QUESTION_TYPES as readonly string[]).includes(s.trim().toLowerCase())) return s.trim().toLowerCase() as QuestionType;
  if (/^(mc|mcq|multiplechoice|choice|singlechoice|multichoice|multipleselect|单选|多选|选择|单选题|多选题|选择题|单项选择题|多项选择题|不定项选择题)$/.test(k)) return "multiple_choice";
  if (/^(numeric|number|numerical|calculation|计算|计算题|数值|数值题)$/.test(k)) return "numeric";
  if (/^(shortanswer|short|fillin|fillintheblank|fillblank|blank|freeresponse|openended|written|填空|填空题|简答|简答题|解答|解答题|应用题)$/.test(k)) return "short_answer";
  if (/^(proof|prove|证明|证明题)$/.test(k)) return "proof";
  return undefined;
}

const DIFFICULTY_WORDS: Array<[RegExp, number]> = [
  [/^(veryeasy|基础|很简单|非常简单|容易题)$/, 1],
  [/^(easy|simple|易|容易|简单|较易)$/, 2],
  [/^(medium|moderate|average|normal|intermediate|中|中等|适中|一般|中档)$/, 3],
  [/^(hard|difficult|难|较难|偏难)$/, 4],
  [/^(veryhard|challenging|expert|很难|困难|压轴|难题)$/, 5],
];

/** Difficulty 1–5 from a number, "3/5", stars or a word; undefined when not recognised. */
export function mapDifficulty(v: unknown): number | undefined {
  const s = asText(v);
  if (!s) return undefined;
  const stars = /^[★☆*]+$/.test(s) ? [...s].filter((c) => c === "★" || c === "*").length : 0;
  if (stars) return Math.min(5, Math.max(1, stars));
  const frac = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+)$/.exec(s);
  if (frac) {
    const [a, b] = [Number(frac[1]), Number(frac[2])];
    if (b > 0 && a <= b) return Math.min(5, Math.max(1, Math.round((a / b) * 5)));
  }
  const n = Number(s);
  if (Number.isFinite(n)) {
    if (Number.isInteger(n) && n >= 1 && n <= 5) return n;
    // 难度系数 (share of students answering correctly): 0.85 is easy, 0.3 is hard.
    if (n > 0 && n < 1) return Math.min(5, Math.max(1, 5 - Math.floor(n * 5)));
    return undefined;
  }
  const k = normKey(s);
  for (const [re, d] of DIFFICULTY_WORDS) if (re.test(k)) return d;
  return undefined;
}

/** "a, b；c、d" / arrays → list of non-empty strings. */
export function splitList(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap((x) => splitList(x));
  const s = asText(v);
  if (!s) return [];
  return s
    .split(/[,;|，；、\n]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Strip a leading "A." / "(A)" / "A、" / "A)" marker from an option. */
export function stripOptionLetter(s: string): string {
  return s.replace(/^\s*(?:\(\s*[A-Ja-j]\s*\)|（\s*[A-Ja-j]\s*）|[A-J]\s*[.．、:：)）])\s*/, "").trim();
}

/** Options from an array, an {A: …, B: …} object or one string separated by newlines, "|" or ";". */
export function splitOptions(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => (typeof x === "object" && x ? asText((x as Record<string, unknown>).text ?? (x as Record<string, unknown>).value) ?? "" : asText(x) ?? "")).map(stripOptionLetter);
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return entries.map(([, x]) => stripOptionLetter(asText(x) ?? ""));
  }
  const s = asText(v);
  if (!s) return [];
  let parts = s.split(/\s*(?:\r?\n|\|)\s*/).filter((x) => x.trim());
  if (parts.length < 2) parts = s.split(/\s*[;；]\s*/).filter((x) => x.trim());
  if (parts.length < 2) {
    // "A. 3  B. 4  C. 5" in one cell.
    const inline = s.split(/\s+(?=(?:\([B-J]\)|（[B-J]）|[B-J][.．、)）])\s*)/);
    if (inline.length >= 2 && /^\s*(?:\(A\)|（A）|A[.．、)）])/.test(s)) parts = inline;
  }
  return parts.map(stripOptionLetter);
}

/** "(B)", "b.", " B " → "B" for multiple choice answers; other answers unchanged. */
export function normaliseChoiceAnswer(answer: string): string {
  const m = /^\s*[(（]?\s*([A-Ja-j](?:\s*[,，、]?\s*[A-Ja-j])*)\s*[)）]?\s*[.．。]?\s*$/.exec(answer);
  if (!m) return answer;
  return m[1].replace(/[\s,，、]/g, "").toUpperCase();
}

export function detectLanguage(text: string): "zh" | "en" | undefined {
  const cjk = (text.match(/[一-鿿]/g) ?? []).length;
  if (cjk >= 2) return "zh";
  if (/[A-Za-z]{2,}/.test(text)) return "en";
  return undefined;
}

export function looksNumeric(answer: string): boolean {
  return /^\s*[-+−]?\s*[$€£¥]?\s*\d[\d,\s]*(?:[.．]\d+)?(?:\s*\/\s*\d+)?\s*(?:%|°|[a-zA-Z²³]{1,6}|元|厘米|米|千克|克|分|秒|个|人|度)?\s*$/.test(answer);
}

/** Type to use when the file does not say: options → multiple choice, a number answer → numeric. */
export function inferType(f: { options?: string[]; answer?: string }, hint?: QuestionType): QuestionType {
  if (f.options && f.options.length >= 1) return "multiple_choice";
  if (hint && hint !== "multiple_choice") return hint;
  if (f.answer && looksNumeric(f.answer)) return "numeric";
  if (f.answer) return "short_answer";
  return hint === "multiple_choice" ? "multiple_choice" : "other";
}

// ── Record → fields ──────────────────────────────────────────────────

/** Canonical field name for a JSON key (aliases, both languages), or the key itself. */
function canonicalKey(k: string): string {
  const f = fieldForHeader(k);
  if (f) return f;
  const n = normKey(k);
  if (n === "page" || n === "页码" || n === "sourcepage") return "page";
  if (n === "source" || n === "来源" || n === "出处") return "source";
  if (n === "images" || n === "image" || n === "图片") return "images";
  if (n === "language" || n === "lang" || n === "语言") return "language";
  return k;
}

/**
 * Turn a loosely shaped record (JSON object, spreadsheet row) into question
 * fields. Unknown keys are ignored; bad values are dropped with an issue.
 * A record without question text gets an empty stem (→ error draft).
 */
export function recordToFields(record: Record<string, unknown>, opts: { typeHint?: QuestionType } = {}): { fields: DraftFields; issues: string[] } {
  const issues: string[] = [];
  const r: Record<string, unknown> = {};
  const optionCols: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(record)) {
    const letter = optionLetterOf(k);
    if (letter && normKey(k) !== "options") {
      optionCols.push([letter, v]);
      continue;
    }
    const c = canonicalKey(k);
    if (r[c] === undefined || r[c] === null || r[c] === "") r[c] = v;
  }

  const rawStem = r.stem;
  let stem = typeof rawStem === "string" ? rawStem.trim() : (asText(rawStem) ?? "");
  if (stem.length > 20_000) {
    stem = stem.slice(0, 20_000);
    issues.push(lt("题干过长，已截断", "The question text was too long and was cut"));
  }

  let options = r.options !== undefined ? splitOptions(r.options) : [];
  if (!options.length && optionCols.length) {
    options = optionCols
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, v]) => stripOptionLetter(asText(v) ?? ""))
      .filter((x, i, all) => x || all.slice(i + 1).some(Boolean)); // drop trailing empty option columns
  }
  if (options.length > 10) {
    issues.push(lt(`选项超过 10 个，只保留前 10 个`, `More than 10 options; kept the first 10`));
    options = options.slice(0, 10);
  }
  options = options.map((o) => clampStr(o, 2000));

  let type = mapType(r.type);
  if (r.type !== undefined && r.type !== null && r.type !== "" && !type) issues.push(lt(`无法识别的题型"${clampStr(String(asText(r.type) ?? ""), 40)}"`, `Unrecognised question type "${clampStr(String(asText(r.type) ?? ""), 40)}"`));

  let answer = asText(r.answer);
  if (Array.isArray(r.answer)) answer = r.answer.map((x) => asText(x) ?? "").filter(Boolean).join(", ") || undefined;
  if (answer) answer = clampStr(answer, 5000);
  const solution = asText(r.solution) ? clampStr(asText(r.solution)!, 20_000) : undefined;

  type = type ?? inferType({ options, answer }, opts.typeHint);
  if (type === "multiple_choice" && answer) answer = normaliseChoiceAnswer(answer);

  let difficulty: number | undefined;
  if (r.difficulty !== undefined && r.difficulty !== null && r.difficulty !== "") {
    difficulty = mapDifficulty(r.difficulty);
    if (difficulty === undefined) issues.push(lt(`难度"${clampStr(String(asText(r.difficulty) ?? ""), 20)}"无法识别（应为 1–5），已忽略`, `Difficulty "${clampStr(String(asText(r.difficulty) ?? ""), 20)}" not recognised (expected 1–5); ignored`));
  }

  const kps = splitList(r.knowledge_points).map((x) => clampStr(x, 80));
  const tags = splitList(r.tags).map((x) => clampStr(x, 60));
  if (kps.length > 20) issues.push(lt("知识点超过 20 个，只保留前 20 个", "More than 20 knowledge points; kept the first 20"));
  if (tags.length > 30) issues.push(lt("标签超过 30 个，只保留前 30 个", "More than 30 tags; kept the first 30"));

  const src = r.source && typeof r.source === "object" ? (r.source as Record<string, unknown>) : {};
  const label = asText(r.label) ?? asText(src.label);
  const pageN = Number(asText(r.page) ?? asText(src.page));
  const file = asText(src.file);
  const source: DraftFields["source"] = {};
  if (label) source.label = clampStr(label, 40);
  if (Number.isInteger(pageN) && pageN > 0) source.page = pageN;
  if (file) source.file = clampStr(file, 300);

  if (Array.isArray(r.images) && r.images.length) issues.push(lt("记录中的图片未导入，请在原文件中查看", "Images in the record were not imported; check the original"));

  const lang = asText(r.language);
  const language = lang === "zh" || lang === "en" ? lang : detectLanguage(stem);
  const grade = asText(r.grade);

  const fields: DraftFields = {
    stem,
    type,
    options: options.length ? options : undefined,
    answer,
    solution,
    grade: grade ? clampStr(grade, 40) : undefined,
    difficulty,
    knowledge_points: kps.slice(0, 20),
    tags: tags.slice(0, 30),
    images: [],
    source: Object.keys(source).length ? source : undefined,
    language,
  };
  return { fields, issues };
}
