// ── Safe integer arithmetic evaluator ───────────────────────────────────
//
// Evaluates formulas such as `m * (a1 + a2) - a3` with exact BigInt
// arithmetic WITHOUT handing the string to `new Function` / `eval`.
//
// Why: the formula comes from LLM output that is ultimately derived from
// user-supplied problem text. Feeding it to `new Function` let a crafted
// problem statement execute arbitrary JavaScript inside the Next.js server
// process. This module only understands integer literals, a fixed set of
// variable names, `+ - * /`, unary minus and parentheses — nothing else can
// be expressed, so nothing else can run.

export type ArithVars = Readonly<Record<string, bigint>>;

export interface ArithEvaluation {
  value: bigint;
  /** False when some `/` had a non-zero remainder (result was truncated). */
  exact: boolean;
}

export interface ArithEvaluator {
  (vars: ArithVars): ArithEvaluation;
  /** Variable names referenced by the formula (subset of the allowed set). */
  readonly variables: readonly string[];
}

const MAX_FORMULA_LENGTH = 500;
const MAX_LITERAL_DIGITS = 40;

type Token =
  | { kind: "num"; value: bigint }
  | { kind: "id"; name: string }
  | { kind: "op"; op: "+" | "-" | "*" | "/" }
  | { kind: "lparen" }
  | { kind: "rparen" };

type Node =
  | { kind: "num"; value: bigint }
  | { kind: "var"; name: string }
  | { kind: "neg"; operand: Node }
  | { kind: "bin"; op: "+" | "-" | "*" | "/"; left: Node; right: Node };

export class ArithSyntaxError extends Error {}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    if (ch >= "0" && ch <= "9") {
      let j = i;
      while (j < src.length && src[j] >= "0" && src[j] <= "9") j++;
      if (j - i > MAX_LITERAL_DIGITS) {
        throw new ArithSyntaxError(`integer literal too long at position ${i}`);
      }
      tokens.push({ kind: "num", value: BigInt(src.slice(i, j)) });
      i = j;
      continue;
    }
    if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_") {
      let j = i;
      while (
        j < src.length &&
        ((src[j] >= "a" && src[j] <= "z") ||
          (src[j] >= "A" && src[j] <= "Z") ||
          (src[j] >= "0" && src[j] <= "9") ||
          src[j] === "_")
      ) {
        j++;
      }
      tokens.push({ kind: "id", name: src.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/") {
      tokens.push({ kind: "op", op: ch });
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "lparen" });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen" });
      i++;
      continue;
    }
    throw new ArithSyntaxError(`unexpected character '${ch}' at position ${i}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly allowed: ReadonlySet<string>,
    readonly used = new Set<string>(),
  ) {}

  parse(): Node {
    if (this.tokens.length === 0) throw new ArithSyntaxError("empty formula");
    const node = this.expr();
    if (this.pos !== this.tokens.length) {
      throw new ArithSyntaxError(`unexpected token at position ${this.pos}`);
    }
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private expr(): Node {
    let left = this.term();
    for (;;) {
      const t = this.peek();
      if (t?.kind === "op" && (t.op === "+" || t.op === "-")) {
        this.pos++;
        left = { kind: "bin", op: t.op, left, right: this.term() };
      } else {
        return left;
      }
    }
  }

  private term(): Node {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (t?.kind === "op" && (t.op === "*" || t.op === "/")) {
        this.pos++;
        left = { kind: "bin", op: t.op, left, right: this.unary() };
      } else {
        return left;
      }
    }
  }

  private unary(): Node {
    const t = this.peek();
    if (t?.kind === "op" && t.op === "-") {
      this.pos++;
      return { kind: "neg", operand: this.unary() };
    }
    if (t?.kind === "op" && t.op === "+") {
      this.pos++;
      return this.unary();
    }
    return this.primary();
  }

  private primary(): Node {
    const t = this.peek();
    if (!t) throw new ArithSyntaxError("unexpected end of formula");
    this.pos++;
    if (t.kind === "num") return { kind: "num", value: t.value };
    if (t.kind === "id") {
      if (!this.allowed.has(t.name)) {
        throw new ArithSyntaxError(`unknown variable '${t.name}'`);
      }
      this.used.add(t.name);
      return { kind: "var", name: t.name };
    }
    if (t.kind === "lparen") {
      const inner = this.expr();
      const close = this.peek();
      if (close?.kind !== "rparen") throw new ArithSyntaxError("missing ')'");
      this.pos++;
      return inner;
    }
    throw new ArithSyntaxError(`unexpected token at position ${this.pos - 1}`);
  }
}

function evaluate(node: Node, vars: ArithVars, state: { exact: boolean }): bigint {
  switch (node.kind) {
    case "num":
      return node.value;
    case "var": {
      const v = vars[node.name];
      if (v === undefined) throw new Error(`variable '${node.name}' is not bound`);
      return v;
    }
    case "neg":
      return -evaluate(node.operand, vars, state);
    case "bin": {
      const l = evaluate(node.left, vars, state);
      const r = evaluate(node.right, vars, state);
      switch (node.op) {
        case "+":
          return l + r;
        case "-":
          return l - r;
        case "*":
          return l * r;
        case "/":
          if (r === 0n) throw new RangeError("division by zero");
          if (l % r !== 0n) state.exact = false;
          return l / r;
      }
    }
  }
}

/**
 * Compile an integer formula into an evaluator. Throws `ArithSyntaxError`
 * when the formula uses anything outside the supported grammar or names a
 * variable that is not in `allowedVars`.
 */
export function compileArith(
  formula: string,
  allowedVars: readonly string[],
): ArithEvaluator {
  if (typeof formula !== "string" || formula.trim().length === 0) {
    throw new ArithSyntaxError("empty formula");
  }
  if (formula.length > MAX_FORMULA_LENGTH) {
    throw new ArithSyntaxError(`formula longer than ${MAX_FORMULA_LENGTH} characters`);
  }
  const parser = new Parser(tokenize(formula), new Set(allowedVars));
  const ast = parser.parse();
  const variables = [...parser.used];
  const evaluator = ((vars: ArithVars) => {
    const state = { exact: true };
    const value = evaluate(ast, vars, state);
    return { value, exact: state.exact };
  }) as ArithEvaluator;
  Object.defineProperty(evaluator, "variables", { value: variables, enumerable: true });
  return evaluator;
}
