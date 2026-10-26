import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { parseTerm, slice, unwrap } from "@/lib/lean/geometry/expr";
import { parseGoal } from "@/lib/lean/geometry/goal";
import { Frac, Poly, toPoly, VarTable } from "@/lib/lean/geometry/poly";
import { findCertificate } from "@/lib/lean/geometry/certificate";
import { looksGeometric } from "@/lib/lean/geometry";
import { evalProp, evalTerm } from "@/lib/lean/geometry/refute";
import { findPoints } from "@/lib/lean/geometry/certificate";

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
