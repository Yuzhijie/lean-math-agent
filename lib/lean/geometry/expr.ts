/**
 * Lean terms as the goal printer writes them (real arithmetic, propositions), parsed into a small
 * AST that keeps every node's source span. The geometry prover reads hypotheses and goals from
 * the REPL with it and writes back slices of the original text, so an atom such as
 * `√((t * Real.cos θ - 1) ^ 2 + …)` is pasted exactly as Lean printed it (a re-printed variant
 * like `(-3) * t` for `-3 * t` would be a different atom for `ring`).
 *
 * Precedences follow Lean 4: → 25 (right), ↔ 20, ∨ 30 (right), ∧ 35 (right), ¬ 40, relations 50,
 * + - 65, * / % 70, unary - 75, ^ 75 (right), √ 100, application and projections max.
 * Anything else (`fun`, `if`, set-builder, …) is a parse error: the caller then leaves that
 * hypothesis out (or gives up on the goal).
 */

export type Node =
  | { k: "num"; text: string; s: number; e: number }
  | { k: "ident"; name: string; s: number; e: number }
  | { k: "app"; fn: string; args: Node[]; s: number; e: number }
  | { k: "neg"; a: Node; s: number; e: number }
  | { k: "bin"; op: BinOp; a: Node; b: Node; s: number; e: number }
  | { k: "not"; a: Node; s: number; e: number }
  | { k: "sqrt"; a: Node; s: number; e: number }
  | { k: "abs"; a: Node; s: number; e: number }
  | { k: "cast"; a: Node; s: number; e: number }
  | { k: "pair"; a: Node; b: Node; s: number; e: number }
  | { k: "proj"; a: Node; index: 1 | 2; s: number; e: number }
  | { k: "quant"; q: "∃" | "∀"; binders: { names: string[]; type?: string }[]; body: Node; s: number; e: number }
  | { k: "asc"; a: Node; type: string; s: number; e: number }
  | { k: "paren"; a: Node; s: number; e: number };

export type BinOp = "+" | "-" | "*" | "/" | "^" | "=" | "≠" | "<" | "≤" | ">" | "≥" | "∧" | "∨" | "→" | "↔";

export class ParseError extends Error {}

interface Tok {
  t: string;
  v: string;
  s: number;
  e: number;
}

const IDENT_START = /[A-Za-z_Ͱ-Ͽἀ-῿℀-⅏'π]/;
const IDENT_CHAR = /[A-Za-z0-9_Ͱ-Ͽἀ-῿℀-⅏'!?✝¹²³⁴⁵⁶⁷⁸⁹⁰₀₁₂₃₄₅₆₇₈₉]/;
const SYMBOLS = ["≠", "≤", "≥", "→", "↔", "∧", "∨", "¬", "∃", "∀", "√", "↑", "×", "⊢", "(", ")", ",", "+", "-", "*", "/", "^", "=", "<", ">", "|", ":", "%"];

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
      if (src[j] === "." && /[0-9]/.test(src[j + 1] ?? "")) {
        j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      out.push({ t: "num", v: src.slice(i, j), s: i, e: j });
      i = j;
      continue;
    }
    // projection `.1` / `.2` right after a term
    if (c === "." && /[12]/.test(src[i + 1] ?? "") && !/[0-9]/.test(src[i + 2] ?? "") && out.length && /^(ident|\)|num)$/.test(out[out.length - 1].t === "sym" ? out[out.length - 1].v : out[out.length - 1].t)) {
      out.push({ t: "proj", v: src[i + 1], s: i, e: i + 2 });
      i += 2;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < src.length && (IDENT_CHAR.test(src[j]) || (src[j] === "." && IDENT_START.test(src[j + 1] ?? "")))) j++;
      out.push({ t: "ident", v: src.slice(i, j), s: i, e: j });
      i = j;
      continue;
    }
    const sym = SYMBOLS.find((x) => src.startsWith(x, i));
    if (!sym) throw new ParseError(`unexpected character ${JSON.stringify(c)} at ${i}`);
    out.push({ t: "sym", v: sym, s: i, e: i + sym.length });
    i += sym.length;
  }
  return out;
}

/** Left binding power and the minimum binding power of the right operand. */
const INFIX: Record<string, { lbp: number; rbp: number }> = {
  "↔": { lbp: 20, rbp: 20 },
  "→": { lbp: 25, rbp: 24 },
  "∨": { lbp: 30, rbp: 29 },
  "∧": { lbp: 35, rbp: 34 },
  "=": { lbp: 50, rbp: 50 },
  "≠": { lbp: 50, rbp: 50 },
  "<": { lbp: 50, rbp: 50 },
  "≤": { lbp: 50, rbp: 50 },
  ">": { lbp: 50, rbp: 50 },
  "≥": { lbp: 50, rbp: 50 },
  "+": { lbp: 65, rbp: 65 },
  "-": { lbp: 65, rbp: 65 },
  "*": { lbp: 70, rbp: 70 },
  "/": { lbp: 70, rbp: 70 },
  "^": { lbp: 75, rbp: 74 },
};

const KEYWORDS = new Set(["fun", "let", "if", "then", "else", "match", "with", "have", "show", "by", "λ"]);

class Parser {
  i = 0;
  constructor(
    private toks: Tok[],
    private src: string,
  ) {}

  peek(): Tok | undefined {
    return this.toks[this.i];
  }
  isSym(v: string): boolean {
    const t = this.peek();
    return !!t && t.t === "sym" && t.v === v;
  }
  expectSym(v: string): Tok {
    const t = this.peek();
    if (!t || t.t !== "sym" || t.v !== v) throw new ParseError(`expected ${v} at ${t?.s ?? this.src.length}`);
    this.i++;
    return t;
  }

  /** Can the current token start an argument of an application? */
  startsAtom(): boolean {
    const t = this.peek();
    if (!t) return false;
    if (t.t === "num") return true;
    if (t.t === "ident") return !KEYWORDS.has(t.v);
    return t.t === "sym" && (t.v === "(" || t.v === "↑" || t.v === "√");
  }

  /** Pratt loop: operators binding tighter than `minBp`. */
  expr(minBp: number, inAbs = false): Node {
    let left = this.prefix(inAbs);
    for (;;) {
      const t = this.peek();
      if (!t || t.t !== "sym" || !INFIX[t.v]) break;
      const { lbp, rbp } = INFIX[t.v];
      if (lbp <= minBp) break;
      this.i++;
      const right = this.expr(rbp, inAbs);
      left = { k: "bin", op: t.v as BinOp, a: left, b: right, s: left.s, e: right.e };
    }
    return left;
  }

  prefix(inAbs: boolean): Node {
    const t = this.peek();
    if (!t) throw new ParseError("unexpected end of input");
    if (t.t === "sym") {
      switch (t.v) {
        case "-": {
          this.i++;
          const a = this.expr(74, inAbs);
          return { k: "neg", a, s: t.s, e: a.e };
        }
        case "¬": {
          this.i++;
          const a = this.expr(39, inAbs);
          return { k: "not", a, s: t.s, e: a.e };
        }
        case "√": {
          this.i++;
          const a = this.expr(99, inAbs);
          return { k: "sqrt", a, s: t.s, e: a.e };
        }
        case "↑": {
          this.i++;
          const a = this.atom();
          return { k: "cast", a, s: t.s, e: a.e };
        }
        case "|": {
          if (inAbs) throw new ParseError("nested |…|");
          this.i++;
          const a = this.expr(0, true);
          const close = this.expectSym("|");
          return this.postfix({ k: "abs", a, s: t.s, e: close.e });
        }
        case "∃":
        case "∀":
          return this.quant(t.v);
      }
    }
    return this.application();
  }

  quant(q: "∃" | "∀"): Node {
    const start = this.expectSym(q).s;
    const binders: { names: string[]; type?: string }[] = [];
    while (!this.isSym(",")) {
      const t = this.peek();
      if (!t) throw new ParseError("unterminated binder");
      if (t.t === "ident") {
        binders.push({ names: [t.v] });
        this.i++;
      } else if (this.isSym("(")) {
        this.i++;
        const names: string[] = [];
        while (this.peek()?.t === "ident") names.push(this.toks[this.i++].v);
        if (!names.length) throw new ParseError("binder without names");
        let type: string | undefined;
        if (this.isSym(":")) {
          const colon = this.toks[this.i++];
          let depth = 0;
          let j = this.i;
          for (; j < this.toks.length; j++) {
            const x = this.toks[j];
            if (x.t === "sym" && x.v === "(") depth++;
            if (x.t === "sym" && x.v === ")") {
              if (depth === 0) break;
              depth--;
            }
          }
          if (j >= this.toks.length) throw new ParseError("unterminated binder type");
          type = this.src.slice(colon.e, this.toks[j].s).trim();
          this.i = j;
        }
        this.expectSym(")");
        binders.push({ names, type });
      } else if (this.isSym(":")) {
        // `∃ t : ℝ, …` — type up to the comma
        const colon = this.toks[this.i++];
        let j = this.i;
        while (j < this.toks.length && !(this.toks[j].t === "sym" && this.toks[j].v === ",")) j++;
        if (j >= this.toks.length) throw new ParseError("unterminated binder type");
        const type = this.src.slice(colon.e, this.toks[j].s).trim();
        for (const b of binders) if (!b.type) b.type = type;
        this.i = j;
      } else throw new ParseError(`unexpected token in binder at ${t.s}`);
    }
    this.expectSym(",");
    const body = this.expr(0);
    return { k: "quant", q, binders, body, s: start, e: body.e };
  }

  application(): Node {
    const head = this.atom();
    if (head.k !== "ident" || !this.startsAtom()) return head;
    const args: Node[] = [];
    while (this.startsAtom()) args.push(this.atom());
    return this.postfix({ k: "app", fn: head.name, args, s: head.s, e: args[args.length - 1].e });
  }

  atom(): Node {
    const t = this.peek();
    if (!t) throw new ParseError("unexpected end of input");
    if (t.t === "num") {
      this.i++;
      return this.postfix({ k: "num", text: t.v, s: t.s, e: t.e });
    }
    if (t.t === "ident") {
      if (KEYWORDS.has(t.v)) throw new ParseError(`unsupported construct ${t.v}`);
      this.i++;
      return this.postfix({ k: "ident", name: t.v, s: t.s, e: t.e });
    }
    if (t.t === "sym" && t.v === "(") {
      this.i++;
      const a = this.expr(0);
      if (this.isSym(",")) {
        this.i++;
        const b = this.expr(0);
        const close = this.expectSym(")");
        return this.postfix({ k: "pair", a, b, s: t.s, e: close.e });
      }
      if (this.isSym(":")) {
        const colon = this.toks[this.i++];
        let depth = 0;
        let j = this.i;
        for (; j < this.toks.length; j++) {
          const x = this.toks[j];
          if (x.t === "sym" && x.v === "(") depth++;
          if (x.t === "sym" && x.v === ")") {
            if (depth === 0) break;
            depth--;
          }
        }
        if (j >= this.toks.length) throw new ParseError("unterminated ascription");
        const type = this.src.slice(colon.e, this.toks[j].s).trim();
        this.i = j;
        const close = this.expectSym(")");
        return this.postfix({ k: "asc", a, type, s: t.s, e: close.e });
      }
      const close = this.expectSym(")");
      return this.postfix({ k: "paren", a, s: t.s, e: close.e });
    }
    if (t.t === "sym" && (t.v === "√" || t.v === "↑")) return this.prefix(false);
    throw new ParseError(`unexpected token ${t.v} at ${t.s}`);
  }

  postfix(n: Node): Node {
    let node = n;
    while (this.peek()?.t === "proj") {
      const p = this.toks[this.i++];
      node = { k: "proj", a: node, index: p.v === "1" ? 1 : 2, s: node.s, e: p.e };
    }
    return node;
  }
}

/** Parse a whole term / proposition; throws ParseError. */
export function parseTerm(src: string): Node {
  const toks = lex(src);
  if (!toks.length) throw new ParseError("empty");
  const p = new Parser(toks, src);
  const n = p.expr(0);
  if (p.i !== toks.length) throw new ParseError(`trailing input at ${toks[p.i].s}`);
  return n;
}

/** The node's source text, whitespace collapsed (the printer wraps long terms over lines). */
export function slice(src: string, n: Node): string {
  return src.slice(n.s, n.e).replace(/\s+/g, " ").trim();
}

/** Strip parentheses and type ascriptions. */
export function unwrap(n: Node): Node {
  let x = n;
  while (x.k === "paren" || x.k === "asc") x = x.a;
  return x;
}
