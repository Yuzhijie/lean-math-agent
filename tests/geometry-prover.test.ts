import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { parseTerm, slice, unwrap } from "@/lib/lean/geometry/expr";
import { parseGoal } from "@/lib/lean/geometry/goal";
import { Frac, Poly, toPoly, VarTable } from "@/lib/lean/geometry/poly";
import { findCertificate } from "@/lib/lean/geometry/certificate";
import { looksGeometric } from "@/lib/lean/geometry";
import { evalProp, evalTerm } from "@/lib/lean/geometry/refute";
import { findFieldRoot, findPoints } from "@/lib/lean/geometry/certificate";

function show(src: string, vars = new VarTable(new Set(["x", "t", "a", "b"]))) {
  const n = parseTerm(src);
  return { n, p: toPoly(src, n, vars), vars };
}

describe("Lean term parser", () => {
  it("follows Lean's precedences", () => {
    const neg = parseTerm("-3 * t");
    expect(neg.k).toBe("bin"); // (-3) * t
    const sq = parseTerm("√x ^ 2");
    expect(sq.k === "bin" && sq.op === "^" && sq.a.k === "sqrt").toBe(true);
    const negPow = parseTerm("-x ^ 2");
    expect(negPow.k === "neg" && negPow.a.k === "bin").toBe(true);
    const not = parseTerm("¬a = b ∧ c = d");
    expect(not.k === "bin" && not.op === "∧" && not.a.k === "not").toBe(true);
    const imp = parseTerm("a = b → c = d → e = f");
    expect(imp.k === "bin" && imp.op === "→" && imp.b.k === "bin" && imp.b.op === "→").toBe(true);
  });

  it("reads binders, pairs, projections, |…| and ascriptions", () => {
    const all = parseTerm("∀ (E F : ℝ × ℝ), E.1 = F.2 → (E.1, 0) = F");
    expect(all.k).toBe("quant");
    if (all.k === "quant") expect(all.binders).toEqual([{ names: ["E", "F"], type: "ℝ × ℝ" }]);
    const ex = parseTerm("∃ t, 0 ≤ t ∧ t ≤ 1");
    expect(ex.k === "quant" && ex.q === "∃").toBe(true);
    const abs = parseTerm("|x - 1| / 2 = (3 : ℝ)");
    expect(abs.k === "bin" && unwrap(abs.b).k === "num").toBe(true);
    const src = "Real.arccos (((x - 1) * t) / (√(x ^ 2) * √2)) = 40 * Real.pi / 180";
    const ac = parseTerm(src);
    expect(ac.k === "bin" && ac.a.k === "app" && ac.a.fn === "Real.arccos").toBe(true);
    if (ac.k === "bin") expect(slice(src, ac.b)).toBe("40 * Real.pi / 180");
  });

  it("rejects what it does not know", () => {
    expect(() => parseTerm("fun x => x")).toThrow();
  });
});

describe("goal states", () => {
  it("splits hypotheses (continued lines, let values) and the target", () => {
    const g = parseGoal("x y : ℝ\nh :\n  √(x ^ 2) =\n    y\nA : ℝ × ℝ := (0, 0)\n⊢ x = y");
    expect(g?.hyps.map((h) => h.names)).toEqual([["x", "y"], ["h"], ["A"]]);
    expect(g?.hyps[1].type.replace(/\s+/g, " ")).toBe("√(x ^ 2) = y");
    expect(g?.hyps[2]).toMatchObject({ type: "ℝ × ℝ", value: "(0, 0)" });
    expect(g?.target).toBe("x = y");
    expect(parseGoal("case refine_1\nx : ℝ\n⊢ x = 1")?.hyps).toEqual([{ names: ["x"], type: "ℝ" }]);
  });
});

describe("polynomials", () => {
  it("expands and keeps √, |…|, cos as atoms with their exact text", () => {
    const { p, vars } = show("(x - 1) ^ 2 + √((t * Real.cos (40 * Real.pi / 180) - 1) ^ 2) - |a| / 2");
    expect(vars.atoms.map((a) => [a.kind, a.text])).toEqual([
      ["sqrt", "√((t * Real.cos (40 * Real.pi / 180) - 1) ^ 2)"],
      ["abs", "|a|"],
    ]);
    expect(p.toLean(vars.names)).toBe("-(1 / 2) * (|a|) + (√((t * Real.cos (40 * Real.pi / 180) - 1) ^ 2)) + x ^ 2 - 2 * x + 1");
    expect(() => show("x / t")).toThrow();
    expect(show("x / (2 * 3)").p.toLean(["x"])).toBe("(1 / 6) * x");
  });

  it("refuses expansions past the limits", () => {
    expect(() => show("((x + t + a + b + 1) ^ 12) ^ 12")).toThrow();
  });

  it("round-trips through the sparse form", () => {
    const { p } = show("3 / 4 * x ^ 2 * t - 5");
    expect(Poly.fromSparse(p.toSparse()).toLean(["x", "t"])).toBe(p.toLean(["x", "t"]));
  });
});

describe("numeric evaluation (refutation checks)", () => {
  const env = new Map([["d", 2 * Math.cos(Math.PI / 9) - 1]]);
  it("evaluates terms as Lean means them", () => {
    expect(evalTerm(parseTerm("√((0 - d) ^ 2 + (0 - 0) ^ 2)"), env)).toBeCloseTo(0.8794, 4);
    expect(evalTerm(parseTerm("√3 / 2 * Real.cos (Real.pi / 9)"), env)).toBeCloseTo(0.8138, 4);
    expect(evalTerm(parseTerm("1 / 0"), env)).toBe(0); // x / 0 = 0
    expect(evalTerm(parseTerm("√(-4)"), env)).toBe(0); // Real.sqrt of a negative is 0
    expect(evalTerm(parseTerm("↑n + 1"), env)).toBeUndefined();
  });
  it("tells true, false and too close to call apart", () => {
    expect(evalProp(parseTerm("d = 2 * Real.cos (Real.pi / 9) - 1"), env)).toBe(true);
    expect(evalProp(parseTerm("d = √3 / 2"), env, 1e-4)).toBe(false);
    expect(evalProp(parseTerm("d = 0.8793853"), env)).toBeUndefined();
    expect(evalProp(parseTerm("0 ≤ d ∧ d ≤ 1"), env)).toBe(true);
    expect(evalProp(parseTerm("d < 0 ∨ d > 2"), env)).toBe(false);
  });
});

describe("statements it takes on", () => {
  it("coordinates yes, synthetic geometry no", () => {
    expect(looksGeometric("(E F : ℝ × ℝ) : E ≠ F → √((E.1 - F.1) ^ 2) = 1")).toBe(true);
    expect(looksGeometric("(A B C : EuclideanSpace ℝ (Fin 2)) : ∠ A B C = π / 2")).toBe(false);
    expect(looksGeometric(": ∀ n : ℕ, n + 0 = n")).toBe(false);
  });
});

let sympy = false;
try {
  execFileSync(process.env.GEOMETRY_PYTHON ?? "python3", ["-c", "import sympy"], { stdio: "ignore" });
  sympy = true;
} catch {
  sympy = false;
}

describe.skipIf(!sympy)("polynomial certificates (SymPy)", () => {
  it("finds the cofactors and the nondegeneracy factors that are needed", async () => {
    // t (25 t - 16) = 0, t ≠ 0, w = √(25 t²) ≥ 0  ⇒  w = 16 / 5
    const vars = new VarTable(new Set(["t"]));
    const P = (s: string) => toPoly(s, parseTerm(s), vars);
    const h = P("25 * t ^ 2 - 16 * t");
    const hsq = P("√(25 * t ^ 2) ^ 2 - 25 * t ^ 2");
    const goal = P("√(25 * t ^ 2) - 16 / 5");
    const r = await findCertificate({
      vars: vars.names.map((_, i) => `v${i}`),
      hyps: [
        { name: "h", poly: h },
        { name: "hsq", poly: hsq },
      ],
      goal,
      multipliers: [
        { name: "ht", poly: P("25 * t ^ 2") },
        { name: "hsign", poly: P("√(25 * t ^ 2) + 16 / 5") },
        { name: "hjunk", poly: P("t + 7") },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.multiplier.map((m) => m.source).sort()).toEqual(["hsign", "ht"]);
    // m * goal = Σ c_k h_k, m the product of the factors; each factor divides its candidate
    let m = Poly.const(new Frac(1n));
    for (const f of r.multiplier) m = m.mul(f.factor);
    let rest = m.mul(goal);
    rest = rest.sub(r.coefficients.get("h")!.mul(h));
    if (r.coefficients.has("hsq")) rest = rest.sub(r.coefficients.get("hsq")!.mul(hsq));
    expect(rest.isZero()).toBe(true);
    // 25 t² was split: the factor t (cofactor 25 t)
    const t = r.multiplier.find((f) => f.source === "ht")!;
    expect(t.factor.mul(t.cofactor).sub(P("25 * t ^ 2")).isZero()).toBe(true);
    expect(t.factor.degree()).toBe(1);
  });

  it("takes Lean names (h₁, hAB') and sends only the variables used", async () => {
    const vars = new VarTable(new Set(["a", "t", "z"]));
    const P = (s: string) => toPoly(s, parseTerm(s), vars);
    P("z"); // a variable nothing below uses
    const r = await findCertificate({
      vars: [],
      hyps: [{ name: "h₁", poly: P("t ^ 2 - 1") }],
      goal: P("t - 1"),
      multipliers: [{ name: "hAB'", poly: P("t + 1") }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.coefficients.keys()]).toEqual(["h₁"]);
    expect(r.multiplier.map((m) => m.source)).toEqual(["hAB'"]);
    expect(r.coefficients.get("h₁")!.toLean(vars.names)).toBe("1");
  });

  it("finds the points of a system (the two D with BD = BC on AC)", async () => {
    // d² − 2d·c + 2c − 1 = 0 with c = cos 20°: d = 1 or d = 2c − 1
    const vars = new VarTable(new Set(["d", "c"]));
    const P = (s: string) => toPoly(s, parseTerm(s), vars);
    const eq = P("d ^ 2 - 2 * d * c + 2 * c - 1");
    const pts = await findPoints({ vars: 2, fixed: new Map([[1, Math.cos(Math.PI / 9)]]), equations: [eq], inequalities: [{ poly: P("d"), rel: ">=" }] });
    const ds = pts.map((p) => p.get(0)!).sort();
    expect(ds.length).toBe(2);
    expect(ds[0]).toBeCloseTo(2 * Math.cos(Math.PI / 9) - 1, 9);
    expect(ds[1]).toBeCloseTo(1, 9);
  });

  it("cancels a factor whose inverse is known (b · w = 1): b · (p − c · r) = 0 gives p = c · r", async () => {
    const vars = new VarTable(new Set(["b", "p", "c", "r", "w"]));
    const P = (s: string) => toPoly(s, parseTerm(s), vars);
    const hyps = [
      { name: "h", poly: P("b * p - b * c * r") },
      { name: "hw", poly: P("b * w - 1") },
    ];
    const goal = P("p ^ 2 - c ^ 2 * r ^ 2");
    const r = await findCertificate({ vars: [], hyps, goal, multipliers: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // an exact combination, no multiplier: w is what divides by b
    expect(r.multiplier).toEqual([]);
    let rest = goal;
    for (const hh of hyps) if (r.coefficients.has(hh.name)) rest = rest.sub(r.coefficients.get(hh.name)!.mul(hh.poly));
    expect(rest.isZero()).toBe(true);
  });

  it("finds a root with a length scale: q² = b² − p², p = cos 20° · b ⇒ q = sin 20° · b", async () => {
    const vars = new VarTable(new Set(["b", "p", "q"]));
    const P = (s: string) => toPoly(s, parseTerm(s), vars);
    const c = "Real.cos (Real.pi / 9)", sn = "Real.sin (Real.pi / 9)";
    const hyps = [
      { name: "hp", poly: P(`p - ${c} * b`) },
      { name: "hq", poly: P("q ^ 2 - b ^ 2 + p ^ 2") },
      { name: "r1", poly: P(`${sn} ^ 2 + ${c} ^ 2 - 1`) },
      { name: "r2", poly: P(`4 * ${c} ^ 3 - 3 * ${c} - 1 / 2`) },
    ];
    const idx = (s: string) => [...P(s).vars()][0];
    const base = { vars: [], hyps, field: { c: idx(c), s: idx(sn) }, root: idx("q"), n: 9 };
    // without the scale the square b² sin² θ is no number of the field
    expect(await findFieldRoot(base)).toBeUndefined();
    const r = await findFieldRoot({ ...base, scale: [idx("b")] });
    expect(r?.root.sub(P(`${sn} * b`)).isZero()).toBe(true);
    expect(r?.factor?.sub(P(sn)).isZero()).toBe(true);
    expect([...(r?.scaleExps ?? new Map())]).toEqual([[idx("b"), 1]]);
  });

  it("finds the value of an expression: (1 − s)² · |AB|² = 1 with |AB| = 2c + 1 ⇒ 1 − s = 2 + 2c − 4c²", async () => {
    const vars = new VarTable(new Set(["s", "r"]));
    const P = (t: string) => toPoly(t, parseTerm(t), vars);
    const c = "Real.cos (Real.pi / 9)", sn = "Real.sin (Real.pi / 9)";
    const hyps = [
      { name: "hr", poly: P(`r - 2 * ${c} - 1`) },
      { name: "he", poly: P("(1 - s) ^ 2 * r ^ 2 - 1") },
      { name: "r1", poly: P(`${sn} ^ 2 + ${c} ^ 2 - 1`) },
      { name: "r2", poly: P(`4 * ${c} ^ 3 - 3 * ${c} - 1 / 2`) },
    ];
    const idx = (t: string) => [...P(t).vars()][0];
    const r = await findFieldRoot({ vars: [], hyps, field: { c: idx(c), s: idx(sn) }, root: P("1 - s"), n: 9 });
    expect(r?.root.sub(P(`2 + 2 * ${c} - 4 * ${c} ^ 2`)).isZero()).toBe(true);
  });

  it("names the factor a multiplier needs when no candidate works (u² = v² ⇒ u = v needs u + v ≠ 0)", async () => {
    const vars = new VarTable(new Set(["u", "v"]));
    const P = (s: string) => toPoly(s, parseTerm(s), vars);
    const r = await findCertificate({ vars: [], hyps: [{ name: "h", poly: P("u ^ 2 - v ^ 2") }], goal: P("u - v"), multipliers: [], needed: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.needed?.map((p) => p.sub(P("u + v")).isZero())).toEqual([true]);
  });

  it("equal angles in a right triangle: the conjugate removes the roots (BD · AC² = DC · AB²)", async () => {
    // A = (0,0), B = (b,0), C = (0,c), D = (b(1-t), c t); ∠BAD = ∠ACB as |AC|·|CB|·dot₁ = |AB|·|AD|·dot₂
    const vars = new VarTable(new Set(["b", "c", "t"]));
    const P = (s: string) => toPoly(s, parseTerm(s), vars);
    const AB = "√(b ^ 2)", AC = "√(c ^ 2)", BC = "√(b ^ 2 + c ^ 2)", AD = "√((b * (1 - t)) ^ 2 + (c * t) ^ 2)";
    const BD = "√((b * t) ^ 2 + (c * t) ^ 2)", DC = "√((b * (1 - t)) ^ 2 + (c * (1 - t)) ^ 2)";
    const hyps = [
      { name: "hang", poly: P(`b ^ 2 * (1 - t) * ${AC} * ${BC} - c ^ 2 * ${AB} * ${AD}`) },
      ...[AB, AC, BC, AD, BD, DC].map((r, i) => {
        const arg = r.slice(2, -1);
        return { name: `hsq${i}`, poly: P(`${r} ^ 2 - (${arg})`) };
      }),
      { name: "hsrb", poly: P(`${AB} - b`) },
      { name: "hsrc", poly: P(`${AC} - c`) },
    ];
    const goal = P(`${BD} * ${AC} ^ 2 - ${DC} * ${AB} ^ 2`).mul(P(`${BD} * ${AC} ^ 2 + ${DC} * ${AB} ^ 2`));
    const multipliers = ["b", "c", "t", "1 - t"].map((m, i) => ({ name: `hm${i}`, poly: P(m) }));
    const sqrtVars = vars.atoms.filter((a) => a.kind === "sqrt").map((a) => a.index);
    const r = await findCertificate({ vars: [], hyps, goal, multipliers, sqrtVars, timeoutSec: 60 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    let m = Poly.const(new Frac(1n));
    for (const f of r.multiplier) m = m.mul(f.factor);
    let rest = m.mul(goal);
    for (const h of hyps) if (r.coefficients.has(h.name)) rest = rest.sub(r.coefficients.get(h.name)!.mul(h.poly));
    expect(rest.isZero()).toBe(true);
  }, 120_000);

  it("says so when the goal does not follow", async () => {
    const vars = new VarTable(new Set(["t"]));
    const P = (s: string) => toPoly(s, parseTerm(s), vars);
    const r = await findCertificate({ vars: ["v0"], hyps: [{ name: "h", poly: P("t ^ 2 - 1") }], goal: P("t - 2"), multipliers: [] });
    expect(r.ok).toBe(false);
  });
});

describe("reduceSquares (nested roots)", () => {
  it("(10 + 2√5)(10 − 2√5) reduces to 80 with cofactor −4 on √5² = 5", async () => {
    const { reduceSquares } = await import("@/lib/lean/geometry/prove");
    const { Poly, Frac } = await import("@/lib/lean/geometry/poly");
    const s = Poly.variable(0);
    const c = (n: number) => Poly.const(new Frac(BigInt(n)));
    const args = new Map([[0, c(5)]]);
    const r = reduceSquares(c(10).add(s.scale(new Frac(2n))).mul(c(10).sub(s.scale(new Frac(2n)))), args)!;
    expect(r.r.constValue()?.toString()).toBe("80");
    expect(r.cof.get(0)?.constValue()?.toString()).toBe("-4");
  });
});
