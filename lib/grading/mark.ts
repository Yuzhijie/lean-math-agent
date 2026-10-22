/**
 * Marking a student's handwritten work:
 *
 *   1. read    — the vision model transcribes the photos line by line, mistakes and crossings-out
 *                kept, and picks out the final answer (it never corrects anything);
 *   2. answer  — the final answer is compared with the reference by the program first (same value,
 *                same choice letter, same set); only forms the program cannot compare go to the model;
 *   3. working — a careful model judges every step against the problem and the reference: which
 *                steps are right, the first wrong one, the kind of mistake, what the student's
 *                approach was, encouraging feedback and a hint that does not give the solution away.
 *
 * The program's answer comparison wins over the model's; the overall verdict is derived from the
 * answer and the step judgements by fixed rules (deriveVerdict), not left to the model.
 */
import { z } from "zod";
import { chatJson } from "../llm/client";
import { lt } from "../llm/output-locale";
import { plainAnswer } from "../pipeline/lean-attempt";
import { detectImage, preparePhoto } from "../bank/import/images";
import { clampScore, ERROR_TYPES, STEP_VERDICTS, type Marking, type Reading, type Reference, type Verdict } from "./types";

export const MAX_WORK_IMAGES = 6;
export const MAX_WORK_IMAGE_BYTES = 10 * 1024 * 1024;

export class MarkingError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message);
  }
}

// ── 1. Reading the photos ────────────────────────────────────────────

const readOut = z.object({
  readable: z.boolean().nullish(),
  steps: z
    .array(z.union([z.string(), z.object({ text: z.string(), crossed_out: z.boolean().nullish(), unclear: z.boolean().nullish() })]))
    .default([]),
  final_answer: z.string().nullish(),
  note: z.string().nullish(),
});

export const READ_WORK_SYSTEM = `You transcribe a student's handwritten maths working from photos for a teacher who will mark it.
Rules:
- Transcribe EXACTLY what the student wrote, line by line in reading order, as "steps" (one entry per line or per equation). Keep every mistake, wrong sign, wrong number and wrong method as written — never correct, complete or improve anything, and never add steps the student did not write.
- Write maths in LaTeX between $ … $. Keep the student's words.
- Crossed-out work: include it with "crossed_out": true. Anything you cannot read with confidence: write your best reading and set "unclear": true. Do not guess whole lines.
- Ignore the printed question itself, the teacher's marks and doodles; transcribe only the student's own working.
- "final_answer": the answer the student gives (boxed, underlined, after "答" / "Answer" / "∴", or the last result) exactly as written; empty if there is none.
- "readable": false if the photos show no readable working. "note": anything the teacher should know (e.g. "the right half of the page is cut off").
Return JSON: {"readable":true,"steps":[{"text":"…","crossed_out":false,"unclear":false}],"final_answer":"…","note":""}`;

export interface WorkImage {
  data: Buffer;
}

/** Checks and prepares the photos (format, size, orientation); returns data URLs for the model. */
export async function prepareWorkImages(images: WorkImage[], max = MAX_WORK_IMAGES): Promise<{ urls: string[]; files: { data: Buffer; ext: string }[] }> {
  if (!images.length) throw new MarkingError(lt("请至少上传一张作答照片", "Upload at least one photo of the work"), 400);
  if (images.length > max) throw new MarkingError(lt(`最多 ${max} 张照片`, `At most ${max} photos`), 400);
  const urls: string[] = [];
  const files: { data: Buffer; ext: string }[] = [];
  for (const [i, img] of images.entries()) {
    if (img.data.length > MAX_WORK_IMAGE_BYTES) throw new MarkingError(lt("照片太大（每张最大 10 MB）", "A photo is too large (10 MB each at most)"), 413);
    if (!detectImage(img.data)) throw new MarkingError(lt("不是可识别的图片（支持 PNG、JPEG、GIF、WebP）", "Not a recognised image (PNG, JPEG, GIF or WebP)"), 415);
    const p = await preparePhoto(img.data, i + 1); // HEIC is refused with a message
    urls.push(`data:${p.mime};base64,${p.data.toString("base64")}`);
    files.push({ data: p.data, ext: p.mime === "image/png" ? "png" : p.mime === "image/webp" ? "webp" : p.mime === "image/gif" ? "gif" : "jpg" });
  }
  return { urls, files };
}

export async function readStudentWork(imageUrls: string[], problemText: string): Promise<Reading> {
  const r = await chatJson({
    role: "vision",
    system: READ_WORK_SYSTEM,
    user: `The problem the student was answering (for context only — do not transcribe it):\n${problemText.slice(0, 4000)}\n\nTranscribe the student's working in the ${imageUrls.length} attached photo(s), in order, and return the JSON.`,
    images: imageUrls,
    schema: readOut,
    schemaName: "student_work",
    temperature: 0,
    maxTokens: 6000,
    maxRetries: 1,
    keepLanguage: true,
  });
  const steps = r.steps
    .map((s) => (typeof s === "string" ? { text: s } : { text: s.text, ...(s.crossed_out ? { crossed_out: true } : {}), ...(s.unclear ? { unclear: true } : {}) }))
    .filter((s) => s.text.trim());
  const final = r.final_answer?.trim();
  return {
    readable: r.readable !== false && (steps.length > 0 || !!final),
    steps,
    ...(final ? { final_answer: final } : {}),
    ...(r.note?.trim() ? { note: r.note.trim() } : {}),
  };
}

// ── 2. Comparing answers ─────────────────────────────────────────────

/** A choice answer as a sorted letter set ("C", "选 C", "(C)", "A、D", "A and D" → letters), else null. */
export function choiceLetters(a: string): string[] | null {
  const t = plainAnswer(a).replace(/^(答|答案|选|answer|选项)\s*[:：]?\s*/i, "").trim();
  const one = "[(（]?[A-H][)）]?";
  if (!new RegExp(`^${one}(?:\\s*(?:[,，、&]|和|与|\\band\\b)\\s*${one})*$`, "i").test(t)) return null;
  // Lower-case words ("bad") are not choices: every letter must stand alone.
  if (/[a-z]{2,}/i.test(t.replace(/\band\b/gi, ""))) return null;
  return [...new Set(t.toUpperCase().match(/[A-H]/g) ?? [])].sort();
}

/** An answer without "答：", "共", "$", "\\boxed{}". */
function stripAnswer(a: string): string {
  return plainAnswer(a)
    .replace(/^(答|答案|解|answer)\s*[:：]?\s*/i, "")
    .replace(/^(共|一共|是|为)\s*/, "")
    .trim();
}

const UNITS = new Set([
  "cm", "mm", "m", "km", "dm", "kg", "g", "mg", "t", "s", "min", "h", "ml", "l", "L",
  "cm²", "cm^2", "cm^{2}", "m²", "m^2", "m^{2}", "cm³", "cm^3", "cm^{3}", "m³", "m^3", "m^{3}", "km^2", "km²",
  "°", "^\\circ", "^{\\circ}", "度", "个", "只", "人", "元", "角", "次", "种", "条", "天", "本", "块", "张", "岁", "分", "秒", "米", "厘米", "毫米", "千米", "分米", "克", "千克", "吨", "升", "毫升", "小时", "分钟", "平方厘米", "平方米", "立方厘米", "%",
]);

/** A plain number with an optional known unit ("18 个", "-3/4", "\\frac{1}{2}", "60°"), else null. */
export function parseQuantity(t: string): { value: number; unit: string } | null {
  const x = stripAnswer(t)
    .replace(/\\(?:text|mathrm)\{([^{}]*)\}/g, "$1")
    .replace(/(-?)\\[dt]?frac\{(-?\d+(?:\.\d+)?)\}\{(-?\d+(?:\.\d+)?)\}/g, "$1$2/$3")
    .replace(/\\,|\;|\\!|\s+/g, " ")
    .trim();
  const m = /^([-−]?\d+(?:\.\d+)?)(?:\s*\/\s*([-−]?\d+(?:\.\d+)?))?\s*(.*)$/.exec(x);
  if (!m) return null;
  const unit = m[3].replace(/\s+/g, "");
  if (unit && !UNITS.has(unit)) return null;
  const num = (v: string) => Number(v.replace("−", "-"));
  const value = num(m[1]) / (m[2] ? num(m[2]) : 1);
  return Number.isFinite(value) ? { value, unit: unit === "^\\circ" || unit === "^{\\circ}" || unit === "度" ? "°" : unit } : null;
}

/** "x = 3" → {name: "x", value: "3"}; else {value}. */
function named(t: string): { name?: string; value: string } {
  const m = /^([a-zA-Zα-ω][\w']*)\s*=\s*(.+)$/.exec(stripAnswer(t));
  return m ? { name: m[1], value: m[2].trim() } : { value: stripAnswer(t) };
}

/** Elements of a list/set/tuple answer, or null for a single value. Tuples "(1, 2)" keep their order. */
function listOf(a: string): { items: string[]; ordered: boolean } | null {
  let t = stripAnswer(a);
  let ordered = false;
  const tuple = /^[(（](.*)[)）]$/.exec(t);
  if (tuple && /[,，]/.test(tuple[1])) {
    t = tuple[1];
    ordered = true;
  }
  t = t.replace(/^\\?\{|\\?\}$/g, "");
  const items = t.split(/\s*(?:,|，|、|;|；|或|和|\bor\b|\band\b|\\text\{或\})\s*/).map((p) => p.trim()).filter(Boolean);
  return items.length > 1 ? { items, ordered } : null;
}

const textKey = (t: string) =>
  stripAnswer(t)
    .replace(/\\left|\\right|\\displaystyle|\s|\\,|\;|\\!/g, "")
    .replace(/×|\\times|\\cdot/g, "*")
    .replace(/÷/g, "/")
    .replace(/−/g, "-");

/** One value against another: true / false when the program can tell, else undefined. */
function compareSingle(student: string, reference: string): boolean | undefined {
  const s = named(student);
  const r = named(reference);
  if (s.name && r.name && s.name !== r.name) return undefined; // another letter: let the model judge
  const a = parseQuantity(s.value);
  const b = parseQuantity(r.value);
  if (a && b) {
    if ((a.unit === "%") !== (b.unit === "%")) return undefined; // 10% vs 0.1
    if (a.unit && b.unit && a.unit !== b.unit) return false;
    return Math.abs(a.value - b.value) <= 1e-9 * Math.max(1, Math.abs(b.value));
  }
  if (textKey(s.value) === textKey(r.value)) return true;
  return undefined;
}

/**
 * Program comparison of a student's answer with the reference: true / false when it can tell
 * (same number with the same or no unit, same choice letters, same set / tuple / named values),
 * undefined when the forms need judgement (expressions, words, unknown units, 10% vs 0.1).
 */
export function compareAnswers(student: string | undefined, reference: string | undefined): boolean | undefined {
  if (!student?.trim() || !reference?.trim()) return undefined;
  const sl = choiceLetters(student);
  const rl = choiceLetters(reference);
  if (sl && rl) return sl.join(",") === rl.join(",");
  if (sl || rl) return undefined;
  const sList = listOf(student);
  const rList = listOf(reference);
  if (!sList && !rList) return compareSingle(student, reference);
  if (!sList || !rList) {
    // One value against several: different when the single one is a plain number.
    const single = sList ? reference : student;
    return parseQuantity(named(single).value) ? false : undefined;
  }
  if (sList.items.length !== rList.items.length) return false;
  const sN = sList.items.map(named);
  const rN = rList.items.map(named);
  // Named values (x = 1, y = 2): compare by name.
  if (sN.every((x) => x.name) && rN.every((x) => x.name)) {
    let result: boolean | undefined = true;
    for (const x of sN) {
      const y = rN.find((z) => z.name === x.name);
      if (!y) return undefined;
      const c = compareSingle(x.value, y.value);
      if (c === false) return false;
      if (c === undefined) result = undefined;
    }
    return result;
  }
  // Tuples / coordinates: in order.
  if (sList.ordered || rList.ordered) {
    let result: boolean | undefined = true;
    for (let i = 0; i < sN.length; i++) {
      const c = compareSingle(sN[i].value, rN[i].value);
      if (c === false) return false;
      if (c === undefined) result = undefined;
    }
    return result;
  }
  // Sets: every student element must match a different reference element.
  const left = rN.map((x) => x.value);
  let undecided = false;
  for (const x of sN) {
    const k = left.findIndex((y) => compareSingle(x.value, y) === true);
    if (k >= 0) {
      left.splice(k, 1);
      continue;
    }
    if (left.some((y) => compareSingle(x.value, y) === undefined)) undecided = true;
    else return false;
  }
  return undecided ? undefined : true;
}

// ── Reference answer when none is known ──────────────────────────────

const refOut = z.object({ answer: z.string().min(1), solution: z.string().default("") });

/** Solves the problem independently (careful, high effort) when there is no known answer. */
export async function solveReference(problemText: string): Promise<Pick<Reference, "answer" | "solution">> {
  const r = await chatJson({
    system:
      "You are a careful mathematics teacher. Solve the problem completely and check your answer against every condition. Return JSON {\"answer\": the final answer only, \"solution\": a concise worked solution (numbered steps, LaTeX between $ … $)}.",
    user: problemText.slice(0, 6000),
    schema: refOut,
    schemaName: "reference_solution",
    reasoningEffort: "high",
    maxRetries: 1,
  });
  return { answer: r.answer.trim(), solution: r.solution.trim().slice(0, 6000) || undefined };
}

// ── 3. Judging the working ───────────────────────────────────────────

const judgeOut = z.object({
  answer_correct: z.boolean().nullish(),
  approach: z.string().default(""),
  approach_valid: z.boolean().nullish(),
  steps: z
    .array(z.object({ index: z.number(), verdict: z.string(), comment: z.string().nullish() }))
    .default([]),
  first_error_step: z.number().nullish(),
  error_types: z.array(z.string()).default([]),
  feedback: z.string().default(""),
  hint: z.string().nullish(),
  knowledge_points: z.array(z.string()).default([]),
  score: z.number().nullish(),
});

export const JUDGE_SYSTEM = `You are an experienced, kind mathematics teacher marking a student's working. Write everything the student will read in Chinese.
You get the problem, a reference answer (and possibly a reference solution), and the student's working transcribed line by line (crossed-out lines marked; unclear readings marked).
Judge the STUDENT'S OWN approach — a different valid method is fully correct; do not require the reference method.
- "steps": one entry per transcribed step, same 1-based index: "correct", "error" (mathematically wrong: wrong calculation, wrong rule, wrong reading of the problem), "unjustified" (a claim that needs a reason the student did not give), or "unclear" (cannot be judged from the transcription). Crossed-out steps are "correct" unless they matter. Add a short "comment" for every step that is not "correct".
- "first_error_step": index of the first "error" step, or null.
- "answer_correct": is the student's final answer mathematically equal to the reference answer (any equivalent form counts; missing answer → false)? null only if you cannot decide.
- "approach": one or two sentences on the student's approach (思路), e.g. "设两数为 x、y，列方程组后消元求解".
- "approach_valid": would this approach, carried out without mistakes, solve the problem?
- "error_types": from ${ERROR_TYPES.join(", ")} (calculation = arithmetic/algebra slip; concept = wrong rule, formula or definition; method = an approach that cannot work; misread = misreading the question or data; incomplete = missing cases, missing justification or no conclusion; notation = wrong or careless notation). Empty when there is no mistake.
- "feedback": 2–4 sentences to the student: start with what is good, then name the first mistake precisely (which step, what is wrong) — do not lecture.
- "hint": the next thing to check or try, as a question or nudge; never give the corrected working or the answer.
- "knowledge_points": 1–4 short names of the skills the problem tests (e.g. "一元二次方程", "相似三角形").
- "score": 0–100 for the whole piece of work (answer and reasoning).
Return JSON with exactly these fields.`;

function judgeUser(problem: string, figure: string | undefined, reference: Reference, reading: Reading): string {
  const steps = reading.steps
    .map((s, i) => `${i + 1}. ${s.text}${s.crossed_out ? "  [crossed out]" : ""}${s.unclear ? "  [unclear reading]" : ""}`)
    .join("\n");
  return [
    `PROBLEM:\n${problem.slice(0, 6000)}`,
    figure ? `FIGURE (described):\n${figure.slice(0, 3000)}` : "",
    reference.answer ? `REFERENCE ANSWER: ${reference.answer}${reference.source === "model" ? " (solved by a model; double-check it yourself)" : ""}` : "REFERENCE ANSWER: (none — solve the problem yourself first)",
    reference.solution ? `REFERENCE SOLUTION:\n${reference.solution.slice(0, 5000)}` : "",
    `STUDENT'S WORKING:\n${steps || "(no working written)"}`,
    `STUDENT'S FINAL ANSWER: ${reading.final_answer ?? "(none given)"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The overall verdict from the answer and the step judgements (fixed rules, not the model's say). */
export function deriveVerdict(m: { readable: boolean; hasAnswer: boolean; answerCorrect: boolean | null; approachValid: boolean | null; hasError: boolean }): Verdict {
  if (!m.readable) return "unreadable";
  if (m.answerCorrect === true) return m.hasError ? "correct_answer_flawed" : "correct";
  if (!m.hasAnswer) return m.approachValid ? "partially_correct" : "no_answer";
  // Undecided answer (neither the program nor the model could tell): only a broken approach is
  // "incorrect"; otherwise partial, and the marking asks the teacher to check (needs_review).
  if (m.answerCorrect === null) return m.approachValid === false ? "incorrect" : "partially_correct";
  return m.approachValid ? "partially_correct" : "incorrect";
}

export async function judgeWork(args: { problem: string; figure?: string; reference: Reference; reading: Reading }): Promise<Marking> {
  const { reading, reference } = args;
  if (!reading.readable) {
    return {
      verdict: "unreadable",
      answer_correct: null,
      answer_check: "none",
      approach: "",
      approach_valid: null,
      steps: [],
      first_error_step: null,
      error_types: [],
      feedback: lt("照片里没有读到作答内容，请拍清楚整页后重新提交。", "No working could be read from the photos; please photograph the whole page clearly and submit again."),
      knowledge_points: [],
      score: 0,
    };
  }
  const programAnswer = compareAnswers(reading.final_answer, reference.answer);
  const j = await chatJson({
    system: JUDGE_SYSTEM,
    user: judgeUser(args.problem, args.figure, reference, reading),
    schema: judgeOut,
    schemaName: "marking",
    reasoningEffort: "high",
    maxRetries: 1,
  });
  const steps = reading.steps.map((_, i) => {
    const s = j.steps.find((x) => x.index === i + 1);
    const verdict = (STEP_VERDICTS as readonly string[]).includes(s?.verdict ?? "") ? (s!.verdict as (typeof STEP_VERDICTS)[number]) : "unclear";
    return { index: i + 1, verdict, ...(s?.comment?.trim() ? { comment: s.comment.trim() } : {}) };
  });
  const errorIdx = steps.find((s) => s.verdict === "error")?.index ?? null;
  const hasAnswer = !!reading.final_answer?.trim();
  // The program's comparison wins; the model decides only forms the program cannot compare.
  const answerCorrect = !hasAnswer ? false : programAnswer !== undefined ? programAnswer : (j.answer_correct ?? null);
  const answerCheck: Marking["answer_check"] = !hasAnswer ? "none" : programAnswer !== undefined ? "program" : j.answer_correct != null ? "model" : "none";
  const errorTypes = [...new Set(j.error_types.filter((e): e is (typeof ERROR_TYPES)[number] => (ERROR_TYPES as readonly string[]).includes(e)))];
  const hasError = errorIdx !== null || steps.some((s) => s.verdict === "unjustified");
  const verdict = deriveVerdict({ readable: true, hasAnswer, answerCorrect, approachValid: j.approach_valid ?? null, hasError });
  if (!hasAnswer && !errorTypes.includes("incomplete")) errorTypes.push("incomplete");
  return {
    verdict,
    answer_correct: answerCorrect,
    answer_check: answerCheck,
    approach: j.approach.trim(),
    approach_valid: j.approach_valid ?? null,
    steps,
    first_error_step: errorIdx,
    error_types: verdict === "correct" ? [] : errorTypes,
    feedback: j.feedback.trim(),
    ...(j.hint?.trim() && verdict !== "correct" ? { hint: j.hint.trim() } : {}),
    knowledge_points: [...new Set(j.knowledge_points.map((k) => k.trim()).filter(Boolean))].slice(0, 4),
    score: clampScore(j.score, verdict),
    ...(answerCorrect === null || reference.source === "model" ? { needs_review: true } : {}),
  };
}

/** Read + reference (when missing) + judge. */
export async function markWork(args: { problem: string; figure?: string; imageUrls: string[]; reference: Reference }): Promise<{ reading: Reading; marking: Marking; reference: Reference }> {
  const problem = args.figure ? `${args.problem}\n\n[Figure: ${args.figure}]` : args.problem;
  const [reading, solved] = await Promise.all([
    readStudentWork(args.imageUrls, problem),
    args.reference.answer ? Promise.resolve(undefined) : solveReference(problem).catch(() => undefined),
  ]);
  const reference: Reference = solved?.answer ? { ...solved, source: "model" } : args.reference;
  const marking = await judgeWork({ problem: args.problem, figure: args.figure, reference, reading });
  return { reading, marking, reference };
}
