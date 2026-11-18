/**
 * Inequalities between polynomials or fractions in real variables that are sums of AM–GM steps
 * between two monomials — "a, b, c positive: a²/(a² + ab + b²) + b²/(b² + bc + c²) +
 * c²/(c² + ca + a²) ≥ 1, and when equality holds" (a session's statement: the single tactics and
 * the search have no hold on it, the model's proof ran out of heartbeats).
 *
 * The method, every step checked by Lean:
 *   – each part `B ≤ A` as one fraction: A − B = N / Den, Den a product of factors without a
 *     negative coefficient in positive variables (positivity);
 *   – N = Σ c · μ · (m − m')² + Σ d · ν with c, d > 0 and μ, m, m', ν monomials — each square is one
 *     AM–GM step μm² + μm'² ≥ 2μmm' — or the same for (x₁ + … + xₙ)^k · N, k = 1, 2, when N itself
 *     is no such sum (a²c + ab² + bc² ≥ 3abc); `ring` checks the identity, positivity the sign;
 *   – an equality case `A = B ↔ a = b ∧ b = c`: N = 0 makes every square 0, so m = m' for each;
 *     a product of these equalities is w · aⁿ = w · bⁿ (`linear_combination` with the cofactors of a
 *     telescoping sum), so aⁿ = bⁿ and a = b; back, N is a combination of a − b and b − c.
 * scripts/squares_inequality.py finds the squares (a linear program over ℚ, solved exactly) and
 * the cofactors; nothing it says is trusted.
 */
import { isInaccessible, type GoalState } from "../geometry/goal";
import { parseTerm, ParseError, slice, unwrap, type Node } from "../geometry/expr";
import { Poly } from "../geometry/poly";
import { Unsupported, conjuncts, inlineLets, letsUsed, num, power, runHelper, toAst, type Ast, type AstContext, type Sparse } from "./shared";

/** How many real variables a statement may have. */
export const MAX_VARIABLES = 4;

/** The names the proof introduces itself; a statement that uses one is left to the other routes. */
const OWN = ["hden_", "hfrac_", "hsq_", "hN_", "hm_", "hdiff_", "heq_", "hzero_", "e_", "t_", "hpow_", "hN0_", "hd0_"];
const OWN_NUMBERED = /^(hn|hr|e|ht|hb)\d+_$/;

export type Sign = "pos" | "nonneg" | "free";

export interface SquaresSetting {
  /** the real variables of the goal, in the context's order */
  vars: string[];
  signs: Sign[];
  /** per variable: its hypothesis `0 < v` or `0 ≤ v` */
  signHyps: (string | undefined)[];
  /** let-bound names of the context with their values as Lean prints them */
  lets: Map<string, string>;
  /** the context says more than the variables' signs (an equation, a bound): a point where a part is false is then no counterexample */
  constrained: boolean;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The real variables with what the context says of their signs. */
export function readSetting(st: GoalState): SquaresSetting | undefined {
  const lets = new Map<string, string>();
  for (const h of st.hyps) if (h.value !== undefined) for (const n of h.names) lets.set(n, h.value);
  let body: string;
  try {
    body = inlineLets(st.target, lets);
  } catch (e) {
    if (e instanceof Unsupported) return undefined;
    throw e;
  }
  const occurs = (v: string) => new RegExp(`(?<![\\w.'₀-₉])${escape(v)}(?![\\w'₀-₉])`).test(body);
  const vars = st.hyps.filter((h) => h.type.trim() === "ℝ" && h.value === undefined).flatMap((h) => h.names).filter(occurs);
  if (vars.length < 1 || vars.length > MAX_VARIABLES) return undefined;
  const signs: Sign[] = [];
  const signHyps: (string | undefined)[] = [];
  const used = new Set<string>();
  for (const v of vars) {
    const find = (re: RegExp) => st.hyps.find((h) => h.value === undefined && re.test(h.type.trim()))?.names[0];
    const pos = find(new RegExp(`^(0 < ${escape(v)}|${escape(v)} > 0)$`));
    const nonneg = pos ? undefined : find(new RegExp(`^(0 ≤ ${escape(v)}|${escape(v)} ≥ 0)$`));
    signs.push(pos ? "pos" : nonneg ? "nonneg" : "free");
    signHyps.push(pos ?? nonneg);
    if (pos ?? nonneg) used.add((pos ?? nonneg)!);
  }
  // anything else the context states: a hypothesis that is no variable, no let and no sign
  const constrained = st.hyps.some((h) => h.value === undefined && !/^(ℝ|ℕ|ℤ|ℚ|Type.*|Sort.*)$/.test(h.type.trim()) && !h.names.every((n) => used.has(n)));
  const names = [...vars, ...lets.keys(), ...signHyps.filter((n): n is string => !!n)];
  if (names.some((n) => isInaccessible(n) || OWN.includes(n) || OWN_NUMBERED.test(n))) return undefined;
  return { vars, signs, signHyps, lets, constrained };
}

export type Part =
  | { kind: "ineq"; /** `large - (small)` is shown ≥ 0 */ small: string; large: string }
  | { kind: "eqcase"; a: string; b: string; /** pairs of variables (by index) that are equal exactly when a = b */ targets: [number, number][]; /** written `a = b ∧ … ↔ A = B` */ reversed: boolean };

/** `v = w ∧ …` between variables, as pairs of indices; undefined when it is anything else. */
function variableEqualities(text: string, node: Node, vars: readonly string[]): [number, number][] | undefined {
  const out: [number, number][] = [];
  for (const q of conjuncts(node)) {
    if (q.k !== "bin" || q.op !== "=") return undefined;
    const [u, v] = [vars.indexOf(slice(text, q.a).trim()), vars.indexOf(slice(text, q.b).trim())];
    if (u < 0 || v < 0 || u === v) return undefined;
    out.push([u, v]);
  }
  return out.length ? out : undefined;
}

/** The parts of the goal: `A ≤ B` / `A ≥ B`, and `A = B ↔ a = b ∧ b = c` (either way round); undefined when any part is something else. */
export function readParts(target: string, vars: readonly string[]): Part[] | undefined {
  let root: Node;
  try {
    root = parseTerm(target);
  } catch (e) {
    if (e instanceof ParseError) return undefined;
    throw e;
  }
  const text = (n: Node) => slice(target, n);
  const parts: Part[] = [];
  for (const n of conjuncts(root)) {
    if (n.k !== "bin") return undefined;
    if (n.op === "≤") parts.push({ kind: "ineq", small: text(n.a), large: text(n.b) });
    else if (n.op === "≥") parts.push({ kind: "ineq", small: text(n.b), large: text(n.a) });
    else if (n.op === "↔") {
      const right = variableEqualities(target, n.b, vars);
      const left = variableEqualities(target, n.a, vars);
      if (!!right === !!left) return undefined;
      const equation = unwrap(right ? n.a : n.b);
      if (equation.k !== "bin" || equation.op !== "=") return undefined;
      parts.push({ kind: "eqcase", a: text(equation.a), b: text(equation.b), targets: (right ?? left)!, reversed: !right });
    } else return undefined;
  }
  return parts.length ? parts : undefined;
}

// ── the helper ────────────────────────────────────────────────────────

type Exps = Record<string, number>;

interface HelperTerm {
  c: string;
  mu: Exps;
  a: Exps;
  b: Exps;
}

interface HelperEqual {
  ok: boolean;
  why?: string;
  uses: number[];
  targets: { u: number; v: number; n: number; w: Exps; cof: [number, Sparse][] }[];
  back: Sparse[];
}

export interface HelperPart {
  ok: boolean;
  why?: string;
  /** the part is false at this point (one value per variable) */
  false_at?: string[];
  den_const: string;
  den: { poly: Sparse; exp: number }[];
  N: Sparse;
  /** the squares are those of (x₁ + … + xₙ)^mult · N */
  mult: number;
  terms: HelperTerm[];
  rest: [string, Exps][];
  equal?: HelperEqual;
}

interface HelperAnswer {
  parts: HelperPart[];
}

interface Spec {
  lhs: Ast;
  rhs: Ast;
  targets?: [number, number][];
}

/** What the helper needs to know of one statement, and what came back: the script is written from these. */
export interface Plan {
  setting: SquaresSetting;
  parts: Part[];
  /** per part: the helper's part (for an equality case: the orientation that is ≥ 0) and whether its two sides were swapped */
  chosen: { part: HelperPart; swapped: boolean }[];
}

/** The helper's request for a goal, or why the goal is not of this kind. */
export function request(st: GoalState): { setting: SquaresSetting; parts: Part[]; specs: Spec[]; specOf: number[][] } | string {
  const setting = readSetting(st);
  if (!setting) return `not an inequality in 1–${MAX_VARIABLES} real variables`;
  const parts = readParts(st.target, setting.vars);
  if (!parts) return "a part of the goal is neither an inequality (≤, ≥) nor an equality case between variables";
  if (parts.some((p) => p.kind === "eqcase") && setting.signs.some((s) => s !== "pos")) return "an equality case needs every variable positive";
  const ctx: AstContext = { vars: setting.vars, lets: setting.lets, bases: [] };
  const specs: Spec[] = [];
  const specOf: number[][] = [];
  try {
    for (const p of parts) {
      const [a, b] = p.kind === "ineq" ? [p.large, p.small] : [p.a, p.b];
      const lhs = toAst(a, parseTerm(a), ctx);
      const rhs = toAst(b, parseTerm(b), ctx);
      if (p.kind === "ineq") {
        specOf.push([specs.length]);
        specs.push({ lhs, rhs });
      } else {
        // an equality case: whichever of A − B, B − A is never negative
        specOf.push([specs.length, specs.length + 1]);
        specs.push({ lhs, rhs, targets: p.targets }, { lhs: rhs, rhs: lhs, targets: p.targets });
      }
    }
  } catch (e) {
    if (e instanceof Unsupported || e instanceof ParseError) return `an expression the route does not read (${e.message})`;
    throw e;
  }
  return { setting, parts, specs, specOf };
}

/** Why there is no plan; `counterexample` when an inequality of the goal is false at a point the context allows. */
export interface NoPlan {
  reason: string;
  counterexample?: string;
}

/** Ask the helper; a plan, or why there is none. */
export async function plan(st: GoalState, timeoutMs = 45_000): Promise<Plan | NoPlan> {
  const req = request(st);
  if (typeof req === "string") return { reason: req };
  const body = JSON.stringify({ vars: req.setting.vars.length, signs: req.setting.signs, parts: req.specs, timeout: Math.ceil(timeoutMs / 1000) });
  const answer = await runHelper<HelperAnswer>("squares_inequality.py", body, timeoutMs + 8_000);
  if (!answer) return { reason: "the algebra helper did not answer (python3 with SymPy, scripts/squares_inequality.py)" };
  const chosen: Plan["chosen"] = [];
  for (const [i, p] of req.parts.entries()) {
    const options = req.specOf[i].map((k, j) => ({ part: answer.parts[k], swapped: j === 1 }));
    const good = options.find((o) => o.part?.ok && (p.kind === "ineq" || o.part.equal?.ok));
    if (!good) {
      const where = req.parts.length > 1 ? `part ${i + 1}: ` : "";
      const at = options[0].part?.false_at;
      if (p.kind === "ineq" && at) {
        const point = req.setting.vars.map((v, k) => `${v} = ${at[k]}`).join(", ");
        // with more in the context than the signs the point may not be allowed: only a reason then
        return { reason: `${where}${p.small} ≤ ${p.large} is false at ${point}`, ...(req.setting.constrained ? {} : { counterexample: point }) };
      }
      const why = p.kind === "ineq" ? options[0].part?.why : (options.map((o) => (o.part?.ok ? o.part.equal?.why : undefined)).find(Boolean) ?? options.map((o) => o.part?.why).find((w) => w && !w.startsWith("false at")));
      return { reason: `${where}${why ?? (p.kind === "ineq" ? "no squares" : "the equality case does not follow from the squares")}` };
    }
    chosen.push(good);
  }
  return { setting: req.setting, parts: req.parts, chosen };
}

// ── the proof ─────────────────────────────────────────────────────────

/** A monomial as Lean reads it: `a ^ 2 * b`, `1` for the empty one. */
function monomial(e: Exps, names: readonly string[]): string {
  const factors = Object.entries(e)
    .map(([v, k]) => [Number(v.slice(1)), k] as const)
    .filter(([, k]) => k > 0)
    .sort((x, y) => x[0] - y[0])
    .map(([i, k]) => (k === 1 ? names[i] : `${names[i]} ^ ${k}`));
  return factors.length ? factors.join(" * ") : "1";
}

/** The proof script for the goal after the intros (the statement's own names in the context). */
export function script(pl: Plan): string {
  const { setting, parts } = pl;
  const names = setting.vars;
  const lean = (s: Sparse) => Poly.fromSparse(s).toLean([...names]);
  const out: string[] = [];
  const push = (indent: number, ...lines: string[]) => out.push(...lines.map((l) => "  ".repeat(indent) + l));
  const total = names.length === 1 ? names[0] : `(${names.join(" + ")})`;

  /** The facts of one part — the fraction and its numerator as squares — as lines, and what they are about. */
  const facts = (i: number) => {
    const { part, swapped } = pl.chosen[i];
    const p = parts[i];
    const [a, b] = p.kind === "ineq" ? [p.large, p.small] : swapped ? [p.b, p.a] : [p.a, p.b];
    const diff = `${a} - (${b})`;
    const N = lean(part.N);
    const den = [num(part.den_const), ...part.den.map((d) => power(lean(d.poly), d.exp))].join(" * ");
    // the squares, each without its coefficient: μ · (m − m')²
    const squares = part.terms.map((t) => {
      const sq = `(${monomial(t.a, names)} - ${monomial(t.b, names)}) ^ 2`;
      const mu = monomial(t.mu, names);
      return { text: mu === "1" ? sq : `${mu} * ${sq}`, mu, c: t.c, diff: `${monomial(t.a, names)} - ${monomial(t.b, names)}` };
    });
    const sum = [...squares.map((s) => `${num(s.c)} * (${s.text})`), ...part.rest.map(([c, m]) => `${num(c)} * (${monomial(m, names)})`)].join(" + ");
    const scaled = part.mult === 0 ? N : `${part.mult === 1 ? total : `${total} ^ ${part.mult}`} * (${N})`;
    const used = letsUsed(diff, setting.lets);
    const lines = [
      `have hden_ : (0:ℝ) < ${den} := by positivity`,
      `have hfrac_ : ${diff} = (${N}) / (${den}) := by`,
      ...(used.length ? [`  simp only [${used.join(", ")}]`] : []),
      ...(part.den.length ? ["  field_simp"] : []),
      "  ring",
      `have hsq_ : ${scaled} = ${sum} := by ring`,
    ];
    return { diff, N, den, squares, sum, scaled, part, lines };
  };
  const all = parts.map((_, i) => facts(i));

  const many = parts.length > 1;
  // an inequality and its equality case are about the same fraction: stated once, before the parts
  // (`field_simp; ring` on it is most of the proof's time)
  const shared = many && all.every((f) => f.lines.join("\n") === all[0].lines.join("\n"));
  if (shared) push(0, ...all[0].lines);
  if (many) push(0, `refine ⟨${parts.map(() => "?_").join(", ")}⟩`);
  for (const [i, p] of parts.entries()) {
    const from = out.length;
    const ind = many ? 1 : 0;
    const f = all[i];
    if (!shared) push(ind, ...f.lines);
    if (p.kind === "ineq") {
      push(
        ind,
        `have hN_ : (0:ℝ) ≤ ${f.N} := by`,
        ...(f.part.mult === 0 ? ["  rw [hsq_]", "  positivity"] : [`  have hm_ : (0:ℝ) ≤ ${f.scaled} := by`, "    rw [hsq_]", "    positivity", "  exact nonneg_of_mul_nonneg_right hm_ (by positivity)"]),
        `have hdiff_ : 0 ≤ ${f.diff} := by`,
        "  rw [hfrac_]",
        "  exact div_nonneg hN_ hden_.le",
        "exact sub_nonneg.mp hdiff_",
      );
    } else {
      const eq = f.part.equal!;
      const nonneg = f.squares.map((_, k) => `hn${k}_`);
      push(ind, ...f.squares.map((s, k) => `have hn${k}_ : (0:ℝ) ≤ ${s.text} := by positivity`));
      // A = B → the variables are equal: the squares add up to 0, so each is 0
      const forward: string[] = [
        `have hzero_ : ${f.sum} = 0 := by`,
        `  have e_ : (${f.N}) / (${f.den}) = 0 := by`,
        "    rw [← hfrac_]",
        "    linarith only [heq_]",
        "  rw [div_eq_zero_iff] at e_",
        "  rcases e_ with e_ | e_",
        ...(f.part.mult === 0 ? ["  · rw [← hsq_]", "    exact e_"] : ["  · rw [← hsq_, e_, mul_zero]"]),
        "  · exact absurd e_ hden_.ne'",
      ];
      for (const k of eq.uses) {
        const s = f.squares[k];
        const zero = `le_antisymm (by linarith only [${["hzero_", ...nonneg].join(", ")}]) hn${k}_`;
        if (s.mu === "1") forward.push(`have e${k}_ : ${s.diff} = 0 := (pow_eq_zero_iff (by norm_num : (2:ℕ) ≠ 0)).mp (${zero})`);
        else forward.push(`have e${k}_ : ${s.diff} = 0 := by`, `  have t_ : ${s.text} = 0 := ${zero}`, `  exact (pow_eq_zero_iff (by norm_num : (2:ℕ) ≠ 0)).mp ((mul_eq_zero.mp t_).resolve_left (by positivity : (${s.mu} : ℝ) ≠ 0))`);
      }
      for (const [j, t] of eq.targets.entries()) {
        const [u, v] = [names[t.u], names[t.v]];
        const w = monomial(t.w, names);
        const combination = t.cof.map(([k, g]) => `(${lean(g)}) * e${k}_`).join(" + ");
        forward.push(
          `have ht${j}_ : ${u} = ${v} := by`,
          `  have hpow_ : (${w} : ℝ) * ${u} ^ ${t.n} = ${w} * ${v} ^ ${t.n} := by linear_combination ${combination}`,
          `  exact (pow_left_inj₀ ${setting.signHyps[t.u]}.le ${setting.signHyps[t.v]}.le (by norm_num : (${t.n}:ℕ) ≠ 0)).mp (mul_left_cancel₀ (by positivity : (${w} : ℝ) ≠ 0) hpow_)`,
        );
      }
      forward.push(eq.targets.length === 1 ? "exact ht0_" : `exact ⟨${eq.targets.map((_, j) => `ht${j}_`).join(", ")}⟩`);
      // the variables are equal → A = B: the numerator is a combination of their differences
      const given = eq.targets.map((_, j) => `hb${j}_`);
      const backward: string[] = [
        `have hN0_ : ${f.N} = 0 := by linear_combination ${eq.back.map((g, j) => `(${lean(g)}) * hb${j}_`).join(" + ")}`,
        `have hd0_ : ${f.diff} = 0 := by rw [hfrac_, hN0_, zero_div]`,
        "linarith only [hd0_]",
      ];
      const intro = { forward: "intro heq_", backward: given.length === 1 ? `intro ${given[0]}` : `rintro ⟨${given.join(", ")}⟩` };
      const order: ("forward" | "backward")[] = p.reversed ? ["backward", "forward"] : ["forward", "backward"];
      push(ind, "constructor");
      for (const dir of order) {
        push(ind, `· ${intro[dir]}`);
        push(ind + 1, ...(dir === "forward" ? forward : backward));
      }
    }
    if (many) out[from] = `· ${out[from].slice(2)}`;
  }
  return out.join("\n");
}
