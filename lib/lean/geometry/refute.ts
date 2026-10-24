/**
 * Numeric refutation of coordinate / real statements. After the same normalization as the prover
 * (coordinates, named hypotheses), the hypotheses' polynomial equations — with √E as s (s² = E,
 * s ≥ 0), |E| as a (a² = E², a ≥ 0) and numeric atoms such as cos(π/9) fixed to their values — go
 * to scripts/poly_certificate.py (mode "points") for points that satisfy them. Each point is then
 * checked against the statement itself, evaluated numerically as Lean printed it (divisions,
 * square roots, trigonometry included): every hypothesis must hold and the conclusion must fail by
 * a clear margin. Only then is it a counterexample — the search proposes, this check decides.
 *
 * It catches statements that are false as formalized (or as posed: "AB = AC, ∠A = 20°, BD = BC,
 * prove AD = (√3/2)·AB" — AD is (2 cos 20° − 1)·AB ≈ 0.879·AB), which no prover can close; the
 * decide / plausible probes cannot evaluate real numbers.
 */
import { slice, unwrap, type Node } from "./expr";
import { findPoints } from "./certificate";
import { NotPolynomial, Poly, toPoly, VarTable } from "./poly";
import { Fail, normalize, state, tryParse, type TacticRunner } from "./prove";

type Env = Map<string, number>;

/** A real term's value, or undefined when it cannot be evaluated (unknown name, cast, …). */
export function evalTerm(n: Node, env: Env): number | undefined {
  const u = unwrap(n);
  const ev = (x: Node) => evalTerm(x, env);
  switch (u.k) {
    case "num":
      return Number(u.text);
    case "ident":
      if (u.name === "π" || u.name === "Real.pi") return Math.PI;
      return env.get(u.name);
    case "neg": {
      const a = ev(u.a);
      return a === undefined ? undefined : -a;
    }
    case "sqrt": {
      const a = ev(u.a);
      return a === undefined ? undefined : Math.sqrt(Math.max(0, a)); // Real.sqrt of a negative is 0
    }
    case "abs": {
      const a = ev(u.a);
      return a === undefined ? undefined : Math.abs(a);
    }
    case "app": {
      if (u.args.length !== 1) return undefined;
      const a = ev(u.args[0]);
      if (a === undefined) return undefined;
      const fns: Record<string, (x: number) => number> = {
        "Real.sqrt": (x) => Math.sqrt(Math.max(0, x)),
        "Real.cos": Math.cos,
        "Real.sin": Math.sin,
        "Real.tan": Math.tan,
        "Real.arccos": (x) => Math.acos(Math.min(1, Math.max(-1, x))),
        "Real.arcsin": (x) => Math.asin(Math.min(1, Math.max(-1, x))),
        "Real.arctan": Math.atan,
        "Real.exp": Math.exp,
      };
      const f = fns[u.fn];
      return f ? f(a) : undefined;
    }
    case "bin": {
      const a = ev(u.a);
      const b = ev(u.b);
      if (a === undefined || b === undefined) return undefined;
      switch (u.op) {
        case "+":
          return a + b;
        case "-":
          return a - b;
        case "*":
          return a * b;
        case "/":
          return b === 0 ? 0 : a / b; // Lean: x / 0 = 0
        case "^":
          return Number.isInteger(b) && b >= 0 ? a ** b : undefined;
        default:
          return undefined;
      }
    }
    default:
      return undefined;
  }
}

const close = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol * (1 + Math.abs(a) + Math.abs(b));

/** true / false with a margin, undefined when it cannot be told (or too close to call). */
export function evalProp(n: Node, env: Env, strict = 1e-6): boolean | undefined {
  const u = unwrap(n);
  if (u.k === "not") {
    const a = evalProp(u.a, env, strict);
    return a === undefined ? undefined : !a;
  }
  if (u.k !== "bin") return undefined;
  if (u.op === "∧" || u.op === "∨" || u.op === "→" || u.op === "↔") {
    const a = evalProp(u.a, env, strict);
    const b = evalProp(u.b, env, strict);
    if (u.op === "∧") return a === false || b === false ? false : a && b ? true : undefined;
    if (u.op === "∨") return a === true || b === true ? true : a === false && b === false ? false : undefined;
    if (u.op === "→") return a === false || b === true ? true : a === true && b === false ? false : undefined;
    return a === undefined || b === undefined ? undefined : a === b;
  }
  const a = evalTerm(u.a, env);
  const b = evalTerm(u.b, env);
  if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  // equalities: true when equal to 1e-9, false only when apart by `strict`; in between, unknown
  const eqTrue = close(a, b, 1e-9);
  const eqFalse = !close(a, b, strict);
  const scale = strict * (1 + Math.abs(a) + Math.abs(b));
  switch (u.op) {
    case "=":
      return eqTrue ? true : eqFalse ? false : undefined;
    case "≠":
      return eqTrue ? false : eqFalse ? true : undefined;
    case "<":
      return a < b - scale ? true : a > b - 1e-9 * (1 + Math.abs(a) + Math.abs(b)) ? false : undefined;
    case ">":
      return a > b + scale ? true : a < b + 1e-9 * (1 + Math.abs(a) + Math.abs(b)) ? false : undefined;
    case "≤":
      return a <= b + 1e-9 * (1 + Math.abs(a) + Math.abs(b)) ? true : a > b + scale ? false : undefined;
    case "≥":
      return a >= b - 1e-9 * (1 + Math.abs(a) + Math.abs(b)) ? true : a < b - scale ? false : undefined;
    default:
      return undefined;
  }
}

function hasVar(n: Node, vars: Set<string>): boolean {
  const u = unwrap(n);
  switch (u.k) {
    case "ident":
      return vars.has(u.name);
    case "num":
      return false;
    case "neg":
    case "sqrt":
    case "abs":
    case "cast":
      return hasVar(u.a, vars);
    case "app":
      return u.args.some((a) => hasVar(a, vars));
    case "bin":
      return hasVar(u.a, vars) || hasVar(u.b, vars);
    default:
      return true;
  }
}

/** Register every √ / |…| / function atom of a term (also inside ones that are not polynomial). */
function collectAtoms(src: string, n: Node, vars: VarTable): void {
  const u = unwrap(n);
  if (u.k === "sqrt" || u.k === "abs" || (u.k === "app" && u.args.length === 1 && u.fn.startsWith("Real."))) {
    vars.atom(src, u);
    collectAtoms(src, u.k === "app" ? u.args[0] : u.a, vars);
    return;
  }
  if (u.k === "bin") {
    collectAtoms(src, u.a, vars);
    collectAtoms(src, u.b, vars);
  } else if (u.k === "neg" || u.k === "not") collectAtoms(src, u.a, vars);
}

export interface Counterexample {
  /** The real variables' values. */
  values: [string, number][];
  /** The conclusion's two sides there, when it is an equation. */
  sides?: [string, number, string, number];
}

/** Normalize, then look for a point where every hypothesis holds and the conclusion fails. */
export async function numericCounterexample(run: TacticRunner): Promise<Counterexample | undefined> {
  try {
    await normalize(run);
  } catch (e) {
    if (e instanceof Fail) return undefined;
    throw e;
  }
  if (!run.goals().length) return undefined;
  const st = state(run);
  const goal = tryParse(st.target);
  if (!goal) return undefined;
  const realVars = new Set(st.hyps.filter((h) => /^ℝ$/.test(h.type.trim()) && h.value === undefined).flatMap((h) => h.names).filter((n) => !n.includes("✝")));
  if (!realVars.size) return undefined;
  const hyps: { text: string; node: Node }[] = [];
  for (const h of st.hyps) {
    if (h.value !== undefined || /^(ℝ|ℕ|ℤ|ℚ|Prop|Type|ℝ\s*×\s*ℝ)$/.test(h.type.trim())) continue;
    const n = tryParse(h.type);
    if (!n) return undefined; // a hypothesis we cannot read could be what rules a point out
    hyps.push({ text: h.type, node: n });
  }

  const vars = new VarTable(realVars);
  for (const v of realVars) vars.variable(v);
  for (const h of hyps) collectAtoms(h.text, h.node, vars);
  collectAtoms(st.target, goal, vars);

  const P = (src: string, n: Node): Poly | undefined => {
    try {
      return toPoly(src, n, vars);
    } catch (e) {
      if (e instanceof NotPolynomial) return undefined;
      throw e;
    }
  };
  const fixed = new Map<number, number>();
  const equations: Poly[] = [];
  const inequalities: { poly: Poly; rel: ">" | ">=" | "!=" }[] = [];
  for (const a of [...vars.atoms]) {
    const node = tryParse(a.text);
    if (!node) continue;
    if (!hasVar(node, realVars)) {
      const v = evalTerm(node, new Map());
      if (v !== undefined && Number.isFinite(v)) fixed.set(a.index, v);
      continue;
    }
    const u = unwrap(node);
    if ((a.kind === "sqrt" || a.kind === "abs") && (u.k === "sqrt" || u.k === "abs" || u.k === "app")) {
      // parsed again from the atom's own text, so the spans point into it
      const arg = u.k === "app" ? u.args[0] : u.a;
      const E = arg ? P(a.text, arg) : undefined;
      if (!E) continue;
      const s = Poly.variable(a.index);
      equations.push(a.kind === "sqrt" ? s.mul(s).sub(E) : s.mul(s).sub(E.mul(E)));
      inequalities.push({ poly: s, rel: ">=" });
    }
  }
  for (const h of hyps) {
    const u = unwrap(h.node);
    if (u.k !== "bin") continue;
    const a = P(h.text, u.a);
    const b = P(h.text, u.b);
    if (!a || !b) continue;
    if (u.op === "=") equations.push(a.sub(b));
    else if (u.op === "<") inequalities.push({ poly: b.sub(a), rel: ">" });
    else if (u.op === ">") inequalities.push({ poly: a.sub(b), rel: ">" });
    else if (u.op === "≤") inequalities.push({ poly: b.sub(a), rel: ">=" });
    else if (u.op === "≥") inequalities.push({ poly: a.sub(b), rel: ">=" });
    else if (u.op === "≠") inequalities.push({ poly: a.sub(b), rel: "!=" });
  }
  if (!equations.length) return undefined;

  const points = await findPoints({ vars: vars.names.length, fixed, equations, inequalities });
  for (const pt of points) {
    const env: Env = new Map();
    for (const v of realVars) {
      const x = pt.get(vars.variable(v));
      if (x !== undefined) env.set(v, x);
    }
    if (env.size !== realVars.size) continue;
    if (!hyps.every((h) => evalProp(h.node, env) === true)) continue;
    if (evalProp(goal, env, 1e-4) !== false) continue;
    const g = unwrap(goal);
    const sides: Counterexample["sides"] =
      g.k === "bin" && g.op === "="
        ? [slice(st.target, g.a), evalTerm(g.a, env) ?? NaN, slice(st.target, g.b), evalTerm(g.b, env) ?? NaN]
        : undefined;
    return { values: [...env].sort(), ...(sides ? { sides } : {}) };
  }
  return undefined;
}
