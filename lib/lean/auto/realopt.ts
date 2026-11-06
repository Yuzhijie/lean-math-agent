/**
 * Extremum of a real polynomial under polynomial equations: `IsLeast {t | ∃ x y z, C₁ ∧ … ∧ t = E} M`
 * (or IsGreatest). scripts/real_extremum.py finds a rational point where the value is reached (the
 * witness) and, for some variable v, the target's normal form g(v) modulo the equations, the range
 * [lo, hi] of v on the real solutions (Lagrange critical points) and g − M = c · Π fᵢ^eᵢ with every
 * factor nonnegative on [lo, hi]. The proof:
 *
 *   refine ⟨⟨w…, by norm_num⟩, ?_⟩
 *   rintro t ⟨x, y, z, h…, rfl⟩
 *   have hroE : E = g(v) := by linear_combination …      (cofactors: poly_certificate.py)
 *   have hroL : lo ≤ v := by nlinarith [squares of differences of the other variables]
 *   have hroU : v ≤ hi := by nlinarith […]
 *   nlinarith [Π (nonneg factor), hroE, hroL, hroU]
 *
 * x + y + z = 3, x² + y² + z² = 9 ⇒ min xyz = −4 (xyz = z³ − 3z², z ∈ [−1, 3], z³ − 3z² + 4 =
 * (z + 1)(z − 2)²): the model's nlinarith had run out of heartbeats in the simplex.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import type { GoalState } from "../geometry/goal";
import { parseTerm, ParseError } from "../geometry/expr";
import { Frac, NotPolynomial, Poly, toPoly, VarTable } from "../geometry/poly";
import { findCertificate } from "../geometry/certificate";
import { topIndex } from "../combinatorics/lets";

export interface ExtremumGoal {
  kind: "min" | "max";
  setVar: string;
  vars: string[];
  conjuncts: string[];
  /** index of the conjunct `t = E` */
  valueAt: number;
  target: string;
  value: string;
}

/** `IsLeast {t | ∃ x y z, … ∧ t = E} M` as printed by Lean. */
export function readExtremumGoal(target: string): ExtremumGoal | undefined {
  const m = /^(IsLeast|IsGreatest) \{(\S+)(?: : [^|]+)? \| ∃ ([^,]+), ([\s\S]+)\} ([\s\S]+)$/.exec(target.replace(/\s+/g, " ").trim());
  if (!m) return undefined;
  const vars = m[3].replace(/[()]/g, " ").split(":")[0].trim().split(/\s+/).filter(Boolean);
  if (!vars.length || vars.length > 3) return undefined;
  const conjuncts: string[] = [];
  let rest = m[4].trim();
  for (let i = topIndex(rest, " ∧ "); i >= 0; i = topIndex(rest, " ∧ ")) {
    conjuncts.push(rest.slice(0, i).trim());
    rest = rest.slice(i + 3).trim();
  }
  conjuncts.push(rest);
  const t = m[2];
  const valueAt = conjuncts.findIndex((c) => c.startsWith(`${t} = `) || c.endsWith(` = ${t}`));
  if (valueAt < 0) return undefined;
  const c = conjuncts[valueAt];
  const expr = c.startsWith(`${t} = `) ? c.slice(t.length + 3) : c.slice(0, c.length - t.length - 3);
  const value = m[5].trim().replace(/^\((.*?)(?: : ℝ)?\)$/, "$1");
  return { kind: m[1] === "IsLeast" ? "min" : "max", setVar: t, vars, conjuncts, valueAt, target: expr.trim(), value };
}

interface Answer {
  witness: string[] | null;
  reductions: { var: number; g: [string, Record<string, number>][]; lo: string | null; hi: string | null; const: string; factors: { poly: [string, Record<string, number>][]; exp: number; kind: "lin" | "sq" | "pos" }[] }[];
}

function runHelper(body: string, timeoutMs: number): Promise<Answer | undefined> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (a: Answer | undefined) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(a);
      }
    };
    const child = spawn(process.env.GEOMETRY_PYTHON ?? "python3", [path.join(process.cwd(), "scripts", "real_extremum.py")], { stdio: ["pipe", "pipe", "ignore"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(undefined);
    }, timeoutMs);
    child.on("error", () => finish(undefined));
    child.stdin.on("error", () => undefined);
    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => {
      try {
        finish(JSON.parse(out) as Answer);
      } catch {
        finish(undefined);
      }
    });
    child.stdin.end(body);
  });
}

const num = (q: string) => {
  const [n, d] = q.split("/");
  const s = d ? `${n.replace(/^-/, "")} / ${d}` : n.replace(/^-/, "");
  return n.startsWith("-") ? `(-${d ? `(${s})` : s})` : d ? `(${s})` : s;
};

function poly(text: string, vars: VarTable): Poly | undefined {
  try {
    return toPoly(text, parseTerm(text), vars);
  } catch (e) {
    if (e instanceof NotPolynomial || e instanceof ParseError) return undefined;
    throw e;
  }
}

/** The proof scripts (one per variable the target reduces to), or none. */
export async function extremumScripts(st: GoalState, timeoutMs = 45_000): Promise<string[]> {
  const goal = readExtremumGoal(st.target);
  if (!goal) return [];
  const vars = new VarTable(new Set(goal.vars));
  for (const v of goal.vars) vars.variable(v);
  const eqs: { name: string; poly: Poly }[] = [];
  const ineqs: Poly[] = [];
  const names = goal.conjuncts.map((_, i) => (i === goal.valueAt ? "rfl" : `hro${i + 1}`));
  for (const [i, c] of goal.conjuncts.entries()) {
    if (i === goal.valueAt) continue;
    const rel = [" = ", " ≤ ", " ≥ ", " < ", " > "].map((r) => [r, topIndex(c, r)] as const).find(([, k]) => k >= 0);
    if (!rel) return [];
    const [op, k] = rel;
    const a = poly(c.slice(0, k), vars);
    const b = poly(c.slice(k + op.length), vars);
    if (!a || !b) return [];
    if (op === " = ") eqs.push({ name: names[i], poly: a.sub(b) });
    else ineqs.push(op === " ≤ " || op === " < " ? b.sub(a) : a.sub(b));
  }
  const E = poly(goal.target, vars);
  const M = poly(goal.value, new VarTable(new Set()));
  const mv = M?.constValue();
  if (!E || !mv || vars.names.length !== goal.vars.length) return [];
  const body = JSON.stringify({ vars: vars.names.map((_, i) => `v${i}`), eqs: eqs.map((e) => e.poly.toSparse()), ineqs: ineqs.map((p) => p.toSparse()), target: E.toSparse(), value: mv.toString(), kind: goal.kind });
  const ans = await runHelper(body, timeoutMs);
  if (!ans?.witness) return [];
  const names0 = vars.names;
  const open = [
    `refine ⟨⟨${ans.witness.map(num).join(", ")}, by norm_num⟩, ?_⟩`,
    `rintro ${goal.setVar} ⟨${goal.vars.join(", ")}, ${names.join(", ")}⟩`,
  ];
  const out: string[] = [];
  for (const r of ans.reductions) {
    const v = names0[r.var];
    const g = Poly.fromSparse(r.g);
    const cert = await findCertificate({ vars: names0.map((_, i) => `v${i}`), hyps: eqs, goal: E.sub(g), multipliers: [], timeoutSec: 20 });
    if (!cert.ok || cert.multiplier.length) continue;
    const combo = [...cert.coefficients].map(([h, c]) => `(${c.toLean(names0)}) * ${h}`).join(" + ");
    const others = names0.filter((n) => n !== v);
    const sq: string[] = [];
    for (let i = 0; i < others.length; i++) for (let j = i + 1; j < others.length; j++) sq.push(`sq_nonneg (${others[i]} - ${others[j]})`, `sq_nonneg (${others[i]} + ${others[j]})`);
    for (const o of others) sq.push(`sq_nonneg (${o} - ${v})`, `sq_nonneg ${o}`);
    const lines = [...open, `have hroE : ${E.toLean(names0)} = ${g.toLean(names0)} := by linear_combination ${combo || "0"}`];
    const facts = ["hroE"];
    if (r.lo !== null) {
      lines.push(`have hroL : ${num(r.lo)} ≤ ${v} := by nlinarith [${sq.join(", ")}]`);
      facts.push("hroL");
    }
    if (r.hi !== null) {
      lines.push(`have hroU : ${v} ≤ ${num(r.hi)} := by nlinarith [${sq.join(", ")}]`);
      facts.push("hroU");
    }
    const terms = r.factors.map((f) => {
      const F = Poly.fromSparse(f.poly).toLean(names0);
      if (f.kind === "sq") return `sq_nonneg (${f.exp === 2 ? F : `(${F}) ^ ${f.exp / 2}`})`;
      let base: string;
      if (f.kind === "lin") base = `(by linarith : (0:ℝ) ≤ ${F})`;
      else {
        // a positive quadratic: (v + b/2a)² ≥ 0 shows it
        const p = Poly.fromSparse(f.poly);
        const a2 = p.terms.get(`v${r.var}^2`) ?? new Frac(1n);
        const b1 = p.terms.get(`v${r.var}`) ?? new Frac(0n);
        const shift = b1.mul(new Frac(1n, 2n)).mul(new Frac(a2.d, a2.n));
        base = `(by nlinarith [sq_nonneg (${v} + ${num(shift.toString())})] : (0:ℝ) ≤ ${F})`;
      }
      return f.exp === 1 ? base : `pow_nonneg ${base} ${f.exp}`;
    });
    const product = terms.length ? terms.reduce((acc, t) => `mul_nonneg (${acc}) (${t})`) : "";
    lines.push(`nlinarith [${[product, ...facts].filter(Boolean).join(", ")}]`);
    out.push(lines.join("\n"));
  }
  return out;
}
