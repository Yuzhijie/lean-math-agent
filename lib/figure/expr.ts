/**
 * Safe math-expression compiler for function plots: `x^2 - 2x + 1`,
 * `sin(2x) + sqrt(x)`, `1/(x-1)`, `2^x`, `|x - 1|`, `ln(x)`.
 *
 * A small Pratt parser → closure tree. Never uses `eval`/`Function`; only
 * the variable `x`, numbers, `pi`/`π`/`e`, + - * / ^ (and `**`), unary
 * minus, parentheses, absolute bars and a fixed set of functions are
 * accepted. Implicit multiplication is supported where it is unambiguous
 * (`2x`, `3(x+1)`, `(x+1)(x-1)`, `2sin(x)`, `x sqrt(x)`).
 */

export class ExprError extends Error {}

type Fn = (x: number) => number;

const FUNCS: Record<string, (v: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  arcsin: Math.asin,
  arccos: Math.acos,
  arctan: Math.atan,
  sqrt: Math.sqrt,
  abs: Math.abs,
  ln: Math.log,
  log: Math.log10,
  lg: Math.log10,
  log2: Math.log2,
  exp: Math.exp,
  floor: Math.floor,
  ceil: Math.ceil,
  sign: Math.sign,
};

const CONSTS: Record<string, number> = { pi: Math.PI, "π": Math.PI, e: Math.E };

type Tok =
  | { t: "num"; v: number }
  | { t: "id"; v: string }
  | { t: "op"; v: string }
  | { t: "(" }
  | { t: ")" }
  | { t: "|" };

function tokenize(src: string): Tok[] {
  const s = src
    .replace(/\*\*/g, "^")
    .replace(/[×·]/g, "*")
    .replace(/÷/g, "/")
    .replace(/[−–]/g, "-")
    .replace(/²/g, "^2")
    .replace(/³/g, "^3")
    .replace(/√/g, "sqrt");
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = s.slice(i).match(/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i)!;
      out.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-zπ]/.test(c)) {
      const m = s.slice(i).match(/^(π|[A-Za-z][A-Za-z0-9]*)/)!;
      let word = m[0];
      // Split run-together words like `xsin` / `sinx` / `2pix` into known parts.
      const parts: string[] = [];
      while (word.length) {
        const known = [...Object.keys(FUNCS), ...Object.keys(CONSTS), "x"]
          .sort((a, b) => b.length - a.length)
          .find((k) => word.startsWith(k));
        if (!known) throw new ExprError(`未知标识符: ${word}`);
        parts.push(known);
        word = word.slice(known.length);
      }
      for (const p of parts) out.push({ t: "id", v: p });
      i += m[0].length;
      continue;
    }
    if ("+-*/^".includes(c)) {
      out.push({ t: "op", v: c });
      i++;
      continue;
    }
    if (c === "(" || c === "[") {
      out.push({ t: "(" });
      i++;
      continue;
    }
    if (c === ")" || c === "]") {
      out.push({ t: ")" });
      i++;
      continue;
    }
    if (c === "|") {
      out.push({ t: "|" });
      i++;
      continue;
    }
    throw new ExprError(`无法识别的字符: ${c}`);
  }
  return out;
}

/** Compile an expression in `x` into a function. Throws ExprError on bad input. */
export function compileExpr(src: string): Fn {
  if (src.length > 300) throw new ExprError("表达式过长");
  const toks = tokenize(src);
  let pos = 0;
  let absDepth = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];

  // Tokens that can start an operand (for implicit multiplication).
  const startsOperand = (t: Tok | undefined) =>
    !!t && (t.t === "num" || t.t === "id" || t.t === "(" || (t.t === "|" && absDepth === 0));

  const BP: Record<string, number> = { "+": 10, "-": 10, "*": 20, "/": 20, "^": 40 };

  function parse(minBp: number): Fn {
    let lhs = prefix();
    for (;;) {
      const t = peek();
      if (t && t.t === "op") {
        const bp = BP[t.v];
        if (bp < minBp) break;
        next();
        // `^` is right-associative.
        const rhs = parse(t.v === "^" ? bp : bp + 1);
        const l = lhs;
        switch (t.v) {
          case "+": lhs = (x) => l(x) + rhs(x); break;
          case "-": lhs = (x) => l(x) - rhs(x); break;
          case "*": lhs = (x) => l(x) * rhs(x); break;
          case "/": lhs = (x) => l(x) / rhs(x); break;
          case "^": lhs = (x) => Math.pow(l(x), rhs(x)); break;
        }
        continue;
      }
      // Implicit multiplication binds like `*`.
      if (startsOperand(t) && BP["*"] >= minBp) {
        const rhs = parse(BP["*"] + 1);
        const l = lhs;
        lhs = (x) => l(x) * rhs(x);
        continue;
      }
      break;
    }
    return lhs;
  }

  function prefix(): Fn {
    const t = next();
    if (!t) throw new ExprError("表达式不完整");
    if (t.t === "num") {
      const v = t.v;
      return () => v;
    }
    if (t.t === "op" && (t.v === "-" || t.v === "+")) {
      // Unary minus binds looser than ^ (-x^2 = -(x^2)) but tighter than * /.
      const operand = parse(30);
      return t.v === "-" ? (x) => -operand(x) : operand;
    }
    if (t.t === "(") {
      const inner = parse(0);
      if (next()?.t !== ")") throw new ExprError("括号不匹配");
      return inner;
    }
    if (t.t === "|") {
      absDepth++;
      const inner = parse(0);
      absDepth--;
      if (next()?.t !== "|") throw new ExprError("绝对值符号不匹配");
      return (x) => Math.abs(inner(x));
    }
    if (t.t === "id") {
      if (t.v === "x") return (x) => x;
      if (t.v in CONSTS) {
        const v = CONSTS[t.v];
        return () => v;
      }
      const f = FUNCS[t.v];
      if (f) {
        // `sin x` / `sin(x)` / `sin 2x`: the argument binds tighter than + - but
        // takes an implicit product (`sin 2x` = sin(2x)).
        const arg = peek()?.t === "(" ? prefix() : parse(20);
        return (x) => f(arg(x));
      }
    }
    throw new ExprError("表达式语法错误");
  }

  const fn = parse(0);
  if (pos !== toks.length) throw new ExprError("表达式语法错误（多余的符号）");
  return fn;
}
