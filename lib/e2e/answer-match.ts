/**
 * Whether the answer the product gave is the reference answer of a held-out problem — decided by
 * the program, so a run needs no judge model: the product's answer ("$\dfrac{24\sqrt{3}}{7}$",
 * "n = 4 或 n = 10", "AP : PD = 1 : 2", "最小值为 12") is evaluated to numbers and compared with the
 * reference value(s). undefined = the forms could not be compared (reported as "not compared",
 * never counted as right). No imports: the evaluation script loads this without the app.
 */

// ── a number from an expression ──────────────────────────────────────────────────────────────

/** The text between the brace at `open` and its match; undefined when unbalanced. */
function braced(s: string, open: number): { body: string; end: number } | undefined {
  if (s[open] !== "{") return undefined;
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return { body: s.slice(open + 1, i), end: i + 1 };
  }
  return undefined;
}

/** LaTeX / typed maths → a plain expression of numbers, + - * / ^, sqrt( ), pi, parentheses. */
function normalise(raw: string): string | undefined {
  let s = raw
    .replace(/\$|\\[()[\]]/g, " ")
    .replace(/\{,\}/g, "")
    .replace(/\\[,;!]/g, " ")
    .replace(/\\(?:left|right|displaystyle|quad|qquad)(?![a-zA-Z])/g, " ")
    .replace(/\\ /g, " ")
    .replace(/\\[dt]frac/g, "\\frac")
    .replace(/\\(?:cdot|times)(?![a-zA-Z])|[×·]/g, "*")
    .replace(/\\div(?![a-zA-Z])|÷/g, "/")
    .replace(/[−–—]/g, "-")
    .replace(/\\pi(?![a-zA-Z])|π/g, " pi ")
    .replace(/\^\s*\{\s*\\circ\s*\}|\^\s*\\circ|°|\\degree/g, " ")
    .replace(/\\(?:text|mathrm|mathbf|operatorname)\s*\{[^{}]*\}/g, " ");
  // \boxed{X}, \fbox{X}
  s = s.replace(/\\fbox(?![a-zA-Z])/g, "\\boxed");
  for (let i = s.indexOf("\\boxed"); i >= 0; i = s.indexOf("\\boxed")) {
    const b = braced(s, s.indexOf("{", i));
    if (!b) return undefined;
    s = s.slice(0, i) + b.body + s.slice(b.end);
  }
  // mixed numbers: 3\frac{1}{4} = 13/4
  s = s.replace(/(\d+)\s*\\frac\s*\{\s*(\d+)\s*\}\s*\{\s*(\d+)\s*\}/g, (_m, w: string, a: string, b: string) => `((${w}*${b}+${a})/${b})`);
  // \frac{A}{B}, \frac12
  for (let guard = 0; s.includes("\\frac") && guard < 50; guard++) {
    const i = s.indexOf("\\frac");
    let j = i + 5;
    while (s[j] === " ") j++;
    const a = braced(s, j);
    if (a) {
      let k = a.end;
      while (s[k] === " ") k++;
      const b = braced(s, k);
      if (!b) return undefined;
      s = `${s.slice(0, i)}((${a.body})/(${b.body}))${s.slice(b.end)}`;
    } else {
      const m = /^(\d)\s*(\d)/.exec(s.slice(j));
      if (!m) return undefined;
      s = `${s.slice(0, i)}((${m[1]})/(${m[2]}))${s.slice(j + m[0].length)}`;
    }
  }
  // \sqrt[n]{A}, \sqrt{A}, \sqrt3, √3, √(…)
  for (let guard = 0; s.includes("\\sqrt") && guard < 50; guard++) {
    const i = s.indexOf("\\sqrt");
    let j = i + 5;
    while (s[j] === " ") j++;
    let index: string | undefined;
    if (s[j] === "[") {
      const close = s.indexOf("]", j);
      if (close < 0) return undefined;
      index = s.slice(j + 1, close);
      j = close + 1;
      while (s[j] === " ") j++;
    }
    const a = braced(s, j);
    const body = a ? a.body : /^(\d+(?:\.\d+)?)/.exec(s.slice(j))?.[1];
    if (body === undefined) return undefined;
    const end = a ? a.end : j + body.length;
    s = `${s.slice(0, i)}${index ? `((${body})^(1/(${index})))` : `sqrt(${body})`}${s.slice(end)}`;
  }
  s = s.replace(/√\s*(\d+(?:\.\d+)?)/g, "sqrt($1)").replace(/√\s*\(/g, "sqrt(").replace(/√\s*\{/g, "sqrt{");
  // ^{A}
  for (let guard = 0; /\^\s*\{/.test(s) && guard < 50; guard++) {
    const m = /\^\s*\{/.exec(s)!;
    const b = braced(s, m.index + m[0].length - 1);
    if (!b) return undefined;
    s = `${s.slice(0, m.index)}^(${b.body})${s.slice(b.end)}`;
  }
  s = s.replace(/[{}]/g, (c) => (c === "{" ? "(" : ")"));
  return s;
}

type Tok = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

function tokens(s: string): Tok[] | undefined {
  const out: Tok[] = [];
  const re = /\s*(?:(\d+(?:\.\d+)?|\.\d+)|(sqrt|pi)|([-+*/^()]))/y;
  let i = 0;
  while (i < s.length) {
    if (/^\s*$/.test(s.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) return undefined;
    if (m[1] !== undefined) out.push({ t: "num", v: Number(m[1]) });
    else if (m[2] !== undefined) out.push({ t: "id", v: m[2] });
    else out.push({ t: "op", v: m[3] });
    i = re.lastIndex;
  }
  return out;
}

/** The value of a closed expression (numbers, fractions, roots, π, powers); undefined when it is anything else. */
export function evalNumber(raw: string): number | undefined {
  const text = normalise(raw);
  if (text === undefined) return undefined;
  // a ratio a : b
  const ratio = /^([^:：]+)[:：]([^:：]+)$/.exec(text);
  if (ratio) {
    const a = evalNumber(ratio[1]);
    const b = evalNumber(ratio[2]);
    return a !== undefined && b !== undefined && b !== 0 ? a / b : undefined;
  }
  const toks = tokens(text);
  if (!toks?.length) return undefined;
  let pos = 0;
  const peek = () => toks[pos];
  const isOp = (v: string) => peek()?.t === "op" && peek()!.v === v;
  const startsPrimary = () => {
    const k = peek();
    return !!k && (k.t === "id" || (k.t === "op" && k.v === "("));
  };
  const fail = Symbol("fail");
  const primary = (): number => {
    const k = toks[pos++];
    if (!k) throw fail;
    if (k.t === "num") return k.v;
    if (k.t === "id" && k.v === "pi") return Math.PI;
    if (k.t === "id" && k.v === "sqrt") {
      if (!isOp("(")) throw fail;
      pos++;
      const v = expr();
      if (!isOp(")")) throw fail;
      pos++;
      return Math.sqrt(v);
    }
    if (k.t === "op" && k.v === "(") {
      const v = expr();
      if (!isOp(")")) throw fail;
      pos++;
      return v;
    }
    throw fail;
  };
  const power = (): number => {
    const base = primary();
    if (isOp("^")) {
      pos++;
      return Math.pow(base, unary());
    }
    return base;
  };
  const unary = (): number => {
    if (isOp("-")) {
      pos++;
      return -unary();
    }
    if (isOp("+")) {
      pos++;
      return unary();
    }
    return power();
  };
  const term = (): number => {
    let v = unary();
    for (;;) {
      if (isOp("*")) {
        pos++;
        v *= unary();
      } else if (isOp("/")) {
        pos++;
        v /= unary();
      } else if (startsPrimary()) {
        // 2√6, 3(1+√5), 2π — but never two numbers side by side
        v *= power();
      } else return v;
    }
  };
  const expr = (): number => {
    let v = term();
    for (;;) {
      if (isOp("+")) {
        pos++;
        v += term();
      } else if (isOp("-")) {
        pos++;
        v -= term();
      } else return v;
    }
  };
  try {
    const v = expr();
    return pos === toks.length && Number.isFinite(v) ? v : undefined;
  } catch (e) {
    if (e === fail) return undefined;
    throw e;
  }
}

// ── the values of an answer ──────────────────────────────────────────────────────────────────

/** The separate values an answer lists ("4, 10", "n = 4 或 n = 10", "(4, 10)", "\{4, 10\}"). */
export function answerItems(answer: string): string[] {
  let s = answer.replace(/\$|\\[()[\]]/g, " ").replace(/\\\{|\\\}/g, " ").replace(/\\(?:left|right)(?![a-zA-Z])/g, "").trim();
  s = s.replace(/[。．.]\s*$/, "");
  const wrapped = /^[([{](.*)[)\]}]$/.exec(s);
  if (wrapped && /[,，、;；]/.test(wrapped[1]) && depthZeroSplit(wrapped[1]).length > 1) s = wrapped[1];
  return depthZeroSplit(s)
    .map((x) => x.trim())
    .filter(Boolean);
}

function depthZeroSplit(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ("({[".includes(c)) depth++;
    else if (")}]".includes(c)) depth = Math.max(0, depth - 1);
    if (depth === 0) {
      const word = /^(?:或者|或|和|及|以及|\\text\{\s*(?:or|and|或|和)\s*\}|\bor\b|\band\b)/.exec(s.slice(i));
      if (",，、;；".includes(c) || word) {
        out.push(cur);
        cur = "";
        i += word ? word[0].length - 1 : 0;
        continue;
      }
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

interface Item {
  /** the item names what it gives ("a = 6", "∠BCD = 10°") */
  named: boolean;
  /** the name before the "=", for telling "n = 4 或 n = 10" (two solutions) from "12，此时 a = 6" (a remark) */
  name: string;
  value: number | undefined;
  /** it holds a number or a symbol the program could not read as a value ("x + 1", "y 取最小值 5"); plain words do not count */
  unread: boolean;
}

/** What one item states: the value after its last "=" / "∈" / "≈", words and remarks in brackets removed. */
function readItem(item: string): Item {
  const bare = item
    .replace(/[（(][^（()）]*[\u4e00-\u9fff=＝][^（()）]*[）)]/g, " ")
    .replace(/＝/g, "=")
    .replace(/：/g, ":")
    .replace(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g, " ");
  const cut = Math.max(bare.lastIndexOf("="), bare.lastIndexOf("≈"), bare.lastIndexOf("\\in") >= 0 ? bare.lastIndexOf("\\in") + 2 : -1, bare.lastIndexOf("\\approx") >= 0 ? bare.lastIndexOf("\\approx") + 6 : -1);
  const tail = (cut >= 0 ? bare.slice(cut + 1) : bare).replace(/^\s*:/, "");
  const first = bare.indexOf("=");
  const value = evalNumber(tail);
  return { named: cut >= 0, name: first >= 0 ? bare.slice(0, first).replace(/\s+/g, "") : "", value, unread: value === undefined && /[0-9A-Za-z\\√π]/.test(bare) };
}

/** What the answer marks as the answer itself: the contents of every `\boxed{…}` / `\fbox{…}`. */
function boxedParts(answer: string): string[] {
  const out: string[] = [];
  const re = /\\(?:boxed|fbox)\s*\{/g;
  for (let m = re.exec(answer); m; m = re.exec(answer)) {
    const b = braced(answer, m.index + m[0].length - 1);
    if (!b) break;
    out.push(b.body);
    re.lastIndex = b.end;
  }
  return out;
}

/**
 * A sentence with formulas in it ("当 $x=3$ 时，$y$ 取最小值 $5$") cut at the formulas' delimiters, so
 * that each formula and each stretch of words is read on its own; undefined when the answer has no
 * delimited formula, or nothing outside them.
 */
function sentencePieces(answer: string): string[] | undefined {
  const re = /\$\$([\s\S]+?)\$\$|\$([^$]+)\$|\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]/g;
  const out: string[] = [];
  let last = 0;
  let outside = "";
  for (let m = re.exec(answer); m; m = re.exec(answer)) {
    out.push(answer.slice(last, m.index), m[1] ?? m[2] ?? m[3] ?? m[4]);
    outside += answer.slice(last, m.index);
    last = m.index + m[0].length;
  }
  if (!out.length) return undefined;
  out.push(answer.slice(last));
  outside += answer.slice(last);
  return outside.trim() ? out.filter((x) => x.trim()) : undefined;
}

function same(got: number, want: number): boolean {
  if (Number.isInteger(want)) return Math.abs(got - want) <= 1e-6;
  return Math.abs(got - want) <= 5e-4 * Math.max(1, Math.abs(want));
}

function sameSet(got: number[], want: number[]): boolean {
  if (got.length !== want.length) return false;
  const left = [...want];
  for (const g of got) {
    const k = left.findIndex((w) => same(g, w));
    if (k < 0) return false;
    left.splice(k, 1);
  }
  return true;
}

export interface Reference {
  answer?: string;
  value?: number;
  values?: number[];
}

/**
 * true / false when the program can tell, undefined when it cannot (or the problem has no
 * answer). `decimal` is the product's own decimal value of the answer, when it gave one.
 *
 * What is read: the boxed part when the answer has one (`$$\boxed{n=1470}$$`, "共有 \(\boxed{19}\) 种")
 * — it is the model's own "this is the answer"; otherwise the answer as a list of values, and when
 * that decides nothing, the sentence cut at its formulas. "Wrong" is only said when every number
 * in the answer was read: an answer with a part the program cannot evaluate is "not compared".
 */
export function matchAnswer(ref: Reference, answer: string | undefined, decimal?: string | number): boolean | undefined {
  const want = ref.values ?? (ref.value !== undefined ? [ref.value] : undefined);
  if (!want) return undefined;
  const dec = typeof decimal === "number" ? decimal : decimal !== undefined && /^\s*-?\d+(?:\.\d+)?(?:e-?\d+)?\s*$/i.test(decimal) ? Number(decimal) : undefined;
  const byDecimal = () => (dec !== undefined && want.length === 1 ? same(dec, want[0]) : undefined);
  if (!answer?.trim()) return byDecimal();
  const boxed = boxedParts(answer);
  const readings: string[][] = boxed.length ? [boxed.flatMap(answerItems)] : [answerItems(answer)];
  const pieces = boxed.length ? undefined : sentencePieces(answer);
  if (pieces) readings.push(pieces.flatMap(answerItems));
  for (const texts of readings) {
    const verdict = decide(texts.map(readItem), want);
    if (verdict !== undefined) return verdict;
  }
  return byDecimal();
}

function decide(all: Item[], want: number[]): boolean | undefined {
  // plain words between the values ("此时", "共有") say nothing
  const items = all.filter((x) => x.value !== undefined || x.unread);
  const complete = items.every((x) => x.value !== undefined);
  if (want.length > 1) {
    // a set of values: every item must be one of them
    return complete && items.length ? sameSet(items.map((x) => x.value!), want) : undefined;
  }
  /** "wrong" needs every part of the answer read: the part that was not may be the answer */
  const verdict = (ok: boolean) => (ok ? true : complete ? false : undefined);
  // one value: the item that states it bare ("12" in "12，此时 a = 6"), else the one that names it ("x = 4")
  const bare = items.filter((x) => !x.named && x.value !== undefined);
  if (bare.length === 1) return verdict(same(bare[0].value!, want[0]));
  if (bare.length > 1) return verdict(bare.every((x) => same(x.value!, want[0])));
  const named = items.filter((x) => x.named && x.value !== undefined);
  if (named.length === 1) return verdict(same(named[0].value!, want[0]));
  if (named.length > 1) {
    if (named.every((x) => same(x.value!, want[0]))) return true;
    // several values under one name are several solutions (wrong); under different names, one of them may be a remark
    if (new Set(named.map((x) => x.name)).size === 1) return verdict(false);
  }
  return undefined;
}
