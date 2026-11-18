/**
 * What the inequality routes share: the two sides of a part as a tree for the Python helpers,
 * the lets written out as `simp only [lets]` leaves them, and the helpers' runner.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { parseTerm, slice, unwrap, type Node } from "../geometry/expr";
import { Frac } from "../geometry/poly";

export const ID = "[A-Za-z_][\\w'₀-₉]*";

/** An expression for the helpers: numbers, the variables by index, + − * / ^, a denominator's base numbered. */
export type Ast = ["num", string] | ["var", number] | ["neg", Ast] | ["+" | "-" | "*" | "/", Ast, Ast] | ["^", Ast, number] | ["base", number, Ast];

/** An expression a route does not read (another function, a name it does not know, a variable exponent). */
export class Unsupported extends Error {}

/** A polynomial as the helpers write it: [[coefficient "p/q", {"v0": exponent, …}], …] (lib/lean/geometry/poly.ts). */
export type Sparse = [string, Record<string, number>][];

/** The text with every let replaced by its value (as `simp only [lets]` leaves the goal). */
export function inlineLets(text: string, lets: ReadonlyMap<string, string>, depth = 0): string {
  if (depth > 8) throw new Unsupported("lets too deep");
  return text.replace(new RegExp(`(?<![\\w.'₀-₉])${ID}`, "g"), (name) => (lets.has(name) ? `(${inlineLets(lets.get(name)!, lets, depth + 1)})` : name));
}

/** The lets a text uses, the lets those use included, in the context's order. */
export function letsUsed(text: string, lets: ReadonlyMap<string, string>): string[] {
  const seen = new Set<string>();
  const visit = (t: string) => {
    for (const m of t.matchAll(new RegExp(`(?<![\\w.'₀-₉])${ID}`, "g"))) {
      if (lets.has(m[0]) && !seen.has(m[0])) {
        seen.add(m[0]);
        visit(lets.get(m[0])!);
      }
    }
  };
  visit(text);
  return [...lets.keys()].filter((n) => seen.has(n));
}

export interface AstContext {
  /** the variables, by the index the helper knows them under */
  vars: readonly string[];
  /** let-bound names with their values as Lean prints them */
  lets: ReadonlyMap<string, string>;
  /** id → a denominator base's text with the lets written out (filled while reading) */
  bases: string[];
}

export function toAst(src: string, node: Node, ctx: AstContext, depth = 0): Ast {
  const n = unwrap(node);
  switch (n.k) {
    case "num":
      return ["num", Frac.parse(n.text).toString()];
    case "ident": {
      const i = ctx.vars.indexOf(n.name);
      if (i >= 0) return ["var", i];
      const value = ctx.lets.get(n.name);
      if (value === undefined || depth > 8) throw new Unsupported(`name ${n.name}`);
      return toAst(value, parseTerm(value), ctx, depth + 1);
    }
    case "neg":
      return ["neg", toAst(src, n.a, ctx, depth)];
    case "bin": {
      if (n.op === "+" || n.op === "-" || n.op === "*") return [n.op, toAst(src, n.a, ctx, depth), toAst(src, n.b, ctx, depth)];
      if (n.op === "/") return ["/", toAst(src, n.a, ctx, depth), denominator(src, n.b, ctx, depth)];
      if (n.op === "^") return ["^", toAst(src, n.a, ctx, depth), exponent(n.b)];
      throw new Unsupported(`operator ${n.op}`);
    }
    default:
      throw new Unsupported(n.k);
  }
}

function exponent(node: Node): number {
  const e = unwrap(node);
  if (e.k !== "num" || !/^\d+$/.test(e.text) || Number(e.text) > 12) throw new Unsupported("exponent");
  return Number(e.text);
}

/** A denominator: its bases (what stands under a power, or a factor) are numbered for the helper. */
function denominator(src: string, node: Node, ctx: AstContext, depth: number): Ast {
  const n = unwrap(node);
  if (n.k === "num") return toAst(src, n, ctx, depth);
  if (n.k === "bin" && n.op === "*") return ["*", denominator(src, n.a, ctx, depth), denominator(src, n.b, ctx, depth)];
  if (n.k === "bin" && n.op === "^") return ["^", denominator(src, n.a, ctx, depth), exponent(n.b)];
  const id = ctx.bases.length;
  ctx.bases.push(inlineLets(slice(src, n), ctx.lets));
  return ["base", id, toAst(src, n, ctx, depth)];
}

/** The conjuncts of a goal, brackets taken off. */
export function conjuncts(root: Node): Node[] {
  const out: Node[] = [];
  const flatten = (n: Node) => {
    const u = unwrap(n);
    if (u.k === "bin" && u.op === "∧") {
      flatten(u.a);
      flatten(u.b);
    } else out.push(u);
  };
  flatten(root);
  return out;
}

/**
 * One of the helpers (scripts/<name>, JSON on stdin and stdout) run with GEOMETRY_PYTHON (default
 * python3, as the other algebra helpers); undefined when it does not answer in time or at all
 * (no python3, no SymPy).
 */
export function runHelper<T>(script: string, body: string, timeoutMs: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (a: T | undefined) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(a);
      }
    };
    const child = spawn(process.env.GEOMETRY_PYTHON ?? "python3", [path.join(process.cwd(), "scripts", script)], { stdio: ["pipe", "pipe", "ignore"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(undefined);
    }, timeoutMs);
    child.on("error", () => finish(undefined));
    child.stdin.on("error", () => undefined);
    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => {
      try {
        finish(JSON.parse(out) as T);
      } catch {
        finish(undefined);
      }
    });
    child.stdin.end(body);
  });
}

/** A rational as Lean reads it: `3`, `(1 / 2)`. */
export const num = (q: string) => (q.includes("/") ? `(${q.replace("/", " / ")})` : q);

export const power = (base: string, exp: number) => (exp === 1 ? `(${base})` : `(${base}) ^ ${exp}`);
