/**
 * The solved answer in one format before it goes into the Lean statement.
 *
 * Solving writes its answer the way it suits a reader: `$$\boxed{\dfrac{3}{4}}$$`, "答：x = 2 或
 * x = 3。", "12 平方厘米", "C", "当 $x=3$ 时取最小值 $5$". The formalizer got that text as it was, and
 * what it made of it varied with the spelling. normalizeAnswer rewrites it — by rules, no model —
 * into plain mathematical text: the boxed part when there is one, no `$` or LaTeX layout, fractions
 * as `3/4`, roots as `√5`, `π`, `≤ ≥ ≠`, sets and intervals in plain brackets, "或 / or" between
 * equations as `∨` and "且 / and" as `∧`, list separators as ", ", a unit taken off a value and named
 * apart, and a choice letter replaced by the option it names in the problem.
 *
 * Nothing is computed: 0.75 stays 0.75 and 3/4 stays 3/4 (which of the two a statement should say is
 * the problem's business). What cannot be read is left as written. The text as written goes to the
 * formalizer too whenever the two differ, so a rule that reads something wrongly loses nothing.
 */

export interface NormalizedAnswer {
  /** the answer in the one format (the value without its unit) */
  text: string;
  /** the answer as solving wrote it, trimmed */
  raw: string;
  /** a unit taken off the value ("cm²", "元", "°") */
  unit?: string;
  /** a choice letter and the option it names in the problem */
  choice?: { letters: string[]; options: string[] };
  /** what was changed, in the order it was done (for the notes and the tests) */
  changes: string[];
}

/** `{…}` starting at `open` (the index of the brace): its body and the index after it. */
function braced(s: string, open: number): { body: string; end: number } | undefined {
  if (s[open] !== "{") return undefined;
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{" && s[i - 1] !== "\\") depth++;
    else if (s[i] === "}" && s[i - 1] !== "\\" && --depth === 0) return { body: s.slice(open + 1, i), end: i + 1 };
  }
  return undefined;
}

/** Every `\boxed{…}` of the text, outermost only. */
function boxedParts(s: string): string[] {
  const out: string[] = [];
  for (let i = s.indexOf("\\boxed"); i >= 0; i = s.indexOf("\\boxed", i)) {
    const open = s.indexOf("{", i);
    const b = open >= 0 && /^\\boxed\s*$/.test(s.slice(i, open)) ? braced(s, open) : undefined;
    if (!b) {
      i += 6;
      continue;
    }
    out.push(b.body);
    i = b.end;
  }
  return out;
}

/** A term that needs no brackets as a numerator, denominator or radicand. */
const atomic = (t: string) => /^(?:√?\d+(?:\.\d+)?|√?[A-Za-zα-ωπ]\w?|\([^()]*\))$/.test(t.trim());
const wrap = (t: string) => (atomic(t) ? t.trim() : `(${t.trim()})`);

/** `\cmd{a}{b}` (two braced arguments) rewritten by `f`, innermost first. */
function twoArgs(s: string, cmd: RegExp, f: (a: string, b: string) => string): string {
  let t = s;
  for (let guard = 0; guard < 50; guard++) {
    const m = cmd.exec(t);
    if (!m) return t;
    const a = braced(t, m.index + m[0].length);
    const b = a && braced(t, a.end);
    if (!a || !b) return t;
    t = t.slice(0, m.index) + f(latex(a.body), latex(b.body)) + t.slice(b.end);
  }
  return t;
}

function oneArg(s: string, cmd: RegExp, f: (a: string, m: RegExpExecArray) => string): string {
  let t = s;
  for (let guard = 0; guard < 50; guard++) {
    const m = cmd.exec(t);
    if (!m) return t;
    const a = braced(t, m.index + m[0].length);
    if (!a) return t;
    t = t.slice(0, m.index) + f(latex(a.body), m) + t.slice(a.end);
  }
  return t;
}

const SYMBOLS: [RegExp, string][] = [
  [/\\(?:le|leq|leqslant)(?![A-Za-z])/g, "≤"],
  [/\\(?:ge|geq|geqslant)(?![A-Za-z])/g, "≥"],
  [/\\(?:ne|neq)(?![A-Za-z])/g, "≠"],
  [/\\(?:cdot|times)(?![A-Za-z])/g, "*"],
  [/\\div(?![A-Za-z])/g, "/"],
  [/\\pm(?![A-Za-z])/g, "±"],
  [/\\mp(?![A-Za-z])/g, "∓"],
  [/\\pi(?![A-Za-z])/g, "π"],
  [/\\infty(?![A-Za-z])/g, "∞"],
  [/\\cup(?![A-Za-z])/g, "∪"],
  [/\\cap(?![A-Za-z])/g, "∩"],
  [/\\in(?![A-Za-z])/g, "∈"],
  [/\\notin(?![A-Za-z])/g, "∉"],
  [/\\(?:varnothing|emptyset)(?![A-Za-z])/g, "∅"],
  [/\\(?:land|wedge)(?![A-Za-z])/g, "∧"],
  [/\\(?:lor|vee)(?![A-Za-z])/g, "∨"],
  [/\\(?:to|rightarrow)(?![A-Za-z])/g, "→"],
  [/\\(?:ldots|cdots|dots)(?![A-Za-z])/g, "…"],
  [/\\angle(?![A-Za-z])/g, "∠"],
  [/\\triangle(?![A-Za-z])/g, "△"],
  [/\\alpha(?![A-Za-z])/g, "α"],
  [/\\beta(?![A-Za-z])/g, "β"],
  [/\\theta(?![A-Za-z])/g, "θ"],
  [/\\mathbb\s*\{?R\}?/g, "ℝ"],
  [/\\mathbb\s*\{?Z\}?/g, "ℤ"],
  [/\\mathbb\s*\{?N\}?/g, "ℕ"],
  [/\\mathbb\s*\{?Q\}?/g, "ℚ"],
  [/\\%/g, "%"],
  [/\\\{/g, "{"],
  [/\\\}/g, "}"],
  [/\\[lr]?vert(?![A-Za-z])|\\\|/g, "|"],
];

/** LaTeX mathematics as plain text. */
function latex(s: string): string {
  let t = s
    .replace(/\\(?:displaystyle|textstyle|limits|nolimits)(?![A-Za-z])/g, "")
    .replace(/\\(?:left|right|big|Big|bigg|Bigg)(?![A-Za-z])\.?/g, "")
    .replace(/\\(?:,|;|:|!|quad|qquad| )|~/g, " ");
  t = oneArg(t, /\\(?:text|mathrm|mbox|textbf|mathbf|operatorname)\s*(?=\{)/, (a) => a);
  // a mixed number: an integer straight before a fraction
  t = t.replace(/(\d)\s*(?=\\[dt]?frac\s*\{\d+\}\s*\{\d+\})/g, "$1 + ");
  t = twoArgs(t, /\\[dt]?frac\s*(?=\{)/, (a, b) => `${wrap(a)}/${wrap(b)}`);
  t = t.replace(/\\sqrt\s*\[\s*([^\]]+)\s*\]\s*(?=\{)/g, "\\nroot{$1}");
  t = twoArgs(t, /\\nroot\s*(?=\{)/, (n, a) => (n.trim() === "2" ? `√${wrap(a)}` : `${wrap(a)}^(1/${n.trim()})`));
  t = oneArg(t, /\\sqrt\s*(?=\{)/, (a) => `√${wrap(a)}`);
  t = t.replace(/\\sqrt\s*(\d|[A-Za-z])/g, "√$1");
  t = t.replace(/\^\s*\{?\s*\\circ\s*\}?|\^\s*∘|°/g, "°");
  t = oneArg(t, /\^\s*(?=\{)/, (a) => (/^[\w.]+$/.test(a.trim()) ? `^${a.trim()}` : `^(${a.trim()})`));
  t = oneArg(t, /_\s*(?=\{)/, (a) => `_${a.trim()}`);
  for (const [re, to] of SYMBOLS) t = t.replace(re, to);
  // the functions keep their names, without the backslash
  t = t.replace(/\\(sin|cos|tan|cot|log|ln|lg|max|min|gcd|lcm|arcsin|arccos|arctan)(?![A-Za-z])/g, "$1");
  return t;
}

const UNITS = [
  "平方厘米", "平方米", "平方千米", "平方分米", "立方厘米", "立方米", "立方分米", "千米/时", "米/秒", "千米", "厘米", "毫米", "分米", "千克", "毫升", "小时", "分钟",
  "km/h", "m/s", "cm²", "cm³", "m²", "m³", "km²", "cm^2", "cm^3", "m^2", "m^3", "km^2", "km", "cm", "mm", "dm", "kg", "mg", "ml", "mL", "min",
  "米", "克", "吨", "升", "秒", "度", "个", "只", "人", "元", "角", "分", "次", "种", "条", "天", "本", "块", "张", "岁", "棵", "辆", "件", "页", "名", "根", "支", "把", "台", "间", "层", "步", "题", "道",
  "m", "g", "t", "s", "h", "L", "l", "°",
];

/** A value followed by a known unit → the value and the unit; else undefined. */
function splitUnit(t: string): { value: string; unit: string } | undefined {
  for (const u of UNITS) {
    if (!t.endsWith(u)) continue;
    const value = t.slice(0, -u.length).trim();
    // the value must be a number or a numeric expression: "x = 3 米" keeps its name; a bare word does not lose its last letter
    if (!value || !/[\d)πe]$/.test(value) || !/^[-−+]?[\d.(√π]/.test(value.replace(/^[A-Za-z]\w*\s*=\s*/, ""))) continue;
    // one-letter units only after a space or a digit that is not part of a name ("3 m", "45°")
    if (/^[a-zA-Z]$/.test(u) && !/\s$/.test(t.slice(0, -u.length))) continue;
    return { value, unit: u.replace(/\^(\d)/, (_, d: string) => (d === "2" ? "²" : d === "3" ? "³" : `^${d}`)) };
  }
  return undefined;
}

/** The options of a multiple-choice problem: letter → text ("A. 12", "(B) 15", "C、18", "D：21"). */
export function problemOptions(problemText: string): Map<string, string> {
  const out = new Map<string, string>();
  const text = problemText.replace(/\r/g, "");
  const re = /(?:^|[\n\s（(])[(（]?([A-H])[)）]?\s*[.．、:：)）]\s*([^\n]*?)(?=(?:\s+[(（]?[A-H][)）]?\s*[.．、:：)）]\s)|\n|$)/g;
  for (const m of text.matchAll(re)) {
    const body = m[2].trim();
    if (body && !out.has(m[1])) out.set(m[1], body);
  }
  // options are a run from A: a lone "A." in a sentence is not a list
  const letters = [...out.keys()].sort();
  return letters.length >= 2 && letters.every((l, i) => l === String.fromCharCode(65 + i)) ? out : new Map();
}

/** "C", "选 C", "(C)", "A、D", "B and D" → the letters; else undefined. */
function choiceLetters(t: string): string[] | undefined {
  const one = "[(（]?[A-H][)）]?";
  const s = t.replace(/^(?:选项?|故选|应选)\s*[:：]?\s*/, "").trim();
  if (!new RegExp(`^${one}(?:\\s*(?:[,，、&]|和|与|\\band\\b)\\s*${one})*$`).test(s)) return undefined;
  return [...new Set(s.match(/[A-H]/g) ?? [])].sort();
}

const LEAD = /^(?:答案?\s*(?:是|为)?|解\s*[:：]|故|所以|因此|即|综上(?:所述)?|answer\s*(?:is)?|the\s+answer\s+is|final\s+answer(?:\s+is)?|therefore|thus|so)\s*[:：,，]?\s*/i;

/** The answer in the one format. */
export function normalizeAnswer(answer: string | undefined, problemText?: string): NormalizedAnswer {
  const raw = (answer ?? "").trim();
  const changes: string[] = [];
  const step = (name: string, before: string, after: string) => {
    if (after !== before) changes.push(name);
    return after;
  };
  let t = raw;
  // 1. the boxed part is the answer
  const boxed = boxedParts(t);
  if (boxed.length) {
    // a unit written after the box belongs to the answer ("$\\boxed{12}$ 平方厘米")
    const after = latex(t.slice(t.lastIndexOf("}") + 1).replace(/\$\$?|\\\)|\\\]/g, " ")).replace(/[。.．\s]+$/u, "").trim();
    t = step("boxed", t, boxed.join(", ") + (boxed.length === 1 && UNITS.includes(after) ? ` ${after}` : ""));
  }
  // 2. mathematics delimiters and LaTeX
  t = step("delimiters", t, t.replace(/\$\$?|\\\(|\\\)|\\\[|\\\]/g, " "));
  t = step("latex", t, latex(t));
  // 3. the words around it
  let before = t;
  t = t.replace(/\s+/g, " ").trim();
  for (let k = 0; k < 3; k++) t = t.replace(LEAD, "").trim();
  t = t.replace(/[。.．;；,，]+$/u, "").trim();
  t = step("words", before.replace(/\s+/g, " ").trim(), t);
  // 4. a choice letter is the option it names
  let choice: NormalizedAnswer["choice"];
  const letters = choiceLetters(t);
  if (letters && problemText) {
    const options = problemOptions(problemText);
    const named = letters.map((l) => options.get(l));
    if (named.every((x): x is string => !!x)) {
      choice = { letters, options: named.map((x) => normalizeAnswer(x).text) };
      t = step("choice", t, choice.options.join(", "));
    }
  }
  // 5. separators and connectives
  before = t;
  t = t
    .replace(/[，、；;]\s*/g, ", ")
    .replace(/\s*[:：]\s*(?=\d)/g, " : ")
    .replace(/−|－/g, "-")
    .replace(/＝/g, "=")
    .replace(/（/g, "(")
    .replace(/）/g, ")");
  // between equations or inequalities: 或 / or → ∨, 且 / and → ∧
  const REL = /[=<>≤≥≠∈]/;
  const join = (text: string, word: RegExp, sym: string) => {
    const parts = text.split(word);
    return parts.length > 1 && parts.every((p) => REL.test(p)) ? parts.map((p) => p.trim()).join(` ${sym} `) : text;
  };
  t = join(t, /\s*(?:或者?|\bor\b)\s*/i, "∨");
  t = join(t, /\s*(?:且|并且|\band\b)\s*/i, "∧");
  // x₁ = 2, x₂ = 3 stays a list; "x = 2, 3" too
  t = t.replace(/\s*,\s*/g, ", ").replace(/\s+/g, " ").trim();
  t = step("separators", before, t);
  // 6. spacing of relations and of the fraction bar between numbers
  before = t;
  t = t
    .replace(/\s*(≤|≥|≠|=|<|>)\s*/g, " $1 ")
    .replace(/(\d)\s*\/\s*(\d)/g, "$1/$2")
    .replace(/\s+/g, " ")
    .trim();
  t = step("spacing", before, t);
  // 7. a unit after the value
  let unit: string | undefined;
  const u = choice ? undefined : splitUnit(t);
  if (u) {
    unit = u.unit;
    t = step("unit", t, u.value);
  }
  return { text: t || raw, raw, ...(unit ? { unit } : {}), ...(choice ? { choice } : {}), changes };
}

/** Two answers that are the same once normalized (`\frac{1}{2}` and `1/2`). */
export const sameAnswer = (a: string, b: string, problemText?: string): boolean => {
  const key = (x: string) => normalizeAnswer(x, problemText).text.replace(/\s+/g, "");
  return key(a) === key(b);
};

/** The lines about the answer for the formalizer. */
export function answerForFormalizer(answer: string, problemText?: string): string {
  const n = normalizeAnswer(answer, problemText);
  const lines = [`The answer found by solving is: ${n.text}`];
  if (n.choice) lines.push(`(the solution chose option ${n.choice.letters.join(", ")} of the problem; the statement is about the value, not the letter)`);
  if (n.unit) lines.push(`(its unit is ${n.unit}; the statement is about the number)`);
  if (n.text.replace(/\s+/g, "") !== n.raw.replace(/\s+/g, "")) lines.push(`(as the solution wrote it: ${n.raw})`);
  return lines.join("\n");
}
