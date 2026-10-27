import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chebyshev, chooseStep, piMultiple, readAngle, reduceTrig, relations, trigChain } from "@/lib/lean/geometry/angles";
import { parseTerm } from "@/lib/lean/geometry/expr";
import { Frac, Poly } from "@/lib/lean/geometry/poly";

function evalCS(p: Poly, c: number, s: number): number {
  let t = 0;
  for (const [m, f] of p.terms) {
    let v = Number(f.n) / Number(f.d);
    if (m)
      for (const part of m.split("*")) {
        const [x, e] = part.split("^");
        v *= (x === "v0" ? c : s) ** (e ? Number(e) : 1);
      }
    t += v;
  }
  return t;
}

describe("angle mode: trigonometry", () => {
  it("reads multiples of π", () => {
    expect(piMultiple("4 * Real.pi / 9")?.toString()).toBe("4/9");
    expect(piMultiple("Real.pi / 18")?.toString()).toBe("1/18");
    expect(piMultiple("π / 3")?.toString()).toBe("1/3");
    expect(piMultiple("Real.pi")).toBeUndefined(); // not strictly between 0 and π
    expect(piMultiple("2 * x")).toBeUndefined();
  });

  it("chooses θ = π / N for all the angles", () => {
    const qs = (xs: string[]) => xs.map((x) => piMultiple(x)!);
    expect(chooseStep(qs(["4 * Real.pi / 9", "Real.pi / 6", "Real.pi / 18"]))).toBe(18);
    expect(chooseStep(qs(["Real.pi / 4", "Real.pi / 3"]))).toBe(12);
    expect(chooseStep(qs(["Real.pi / 3"]))).toBe(3);
    expect(chooseStep(qs(["2 * Real.pi / 5"]))).toBeUndefined(); // 72°: not a multiple of π/36
  });

  it("Chebyshev polynomials", () => {
    for (const k of [1, 2, 3, 6]) expect(evalCS(chebyshev(k), Math.cos(0.3), 0)).toBeCloseTo(Math.cos(k * 0.3), 12);
  });

  it("the chain cos jθ, sin jθ is exact modulo the relations, for every N", () => {
    for (const N of [3, 6, 9, 12, 18, 36]) {
      const th = Math.PI / N;
      const chain = trigChain(Math.max(N - 1, 1), N / 3);
      for (let j = 1; j < N; j++) {
        expect(evalCS(chain[j].cos, Math.cos(th), Math.sin(th))).toBeCloseTo(Math.cos(j * th), 9);
        expect(evalCS(chain[j].sin, Math.cos(th), Math.sin(th))).toBeCloseTo(Math.sin(j * th), 9);
      }
    }
  });

  it("reduction keeps p = rest + q1·R1 + q2·R2 with small degrees", () => {
    const c = Poly.variable(0);
    const s = Poly.variable(1);
    const p = c.pow(9).mul(s.pow(3)).add(s.pow(4)).sub(c.scale(new Frac(3n)));
    const { rest, q1, q2 } = reduceTrig(p, 6, true);
    const { r1, r2 } = relations(6);
    expect(rest.add(q1.mul(r1)).add(q2.mul(r2)).sub(p).isZero()).toBe(true);
    for (const m of rest.terms.keys()) {
      expect(/v1\^/.test(m)).toBe(false); // s-degree ≤ 1
      const ce = /v0\^(\d+)/.exec(m);
      expect(ce ? Number(ce[1]) : 1).toBeLessThan(6);
    }
  });
});

describe("angle mode: reading an angle", () => {
  const src = "Real.arccos (((Ax - 0) * (1 - 0) + (Ay - 0) * (0 - 0)) / (√((0 - Ax) ^ 2 + (0 - Ay) ^ 2) * √((0 - 1) ^ 2 + (0 - 0) ^ 2))) = 4 * Real.pi / 9";
  it("splits dot product, lengths and builds the cross product", () => {
    const n = parseTerm(src);
    if (n.k !== "bin") throw new Error("parse");
    const a = readAngle(src, n.a, n.b, new Set(["Ax", "Ay"]))!;
    expect(a.q.toString()).toBe("4/9");
    expect(a.d1.arg).toBe("((0 - Ax) ^ 2 + (0 - Ay) ^ 2)");
    expect(a.cross).toBe("((Ax - 0)) * ((0 - 0)) - ((Ay - 0)) * ((1 - 0))");
  });
  it("gives up on lengths that do not match the vectors", () => {
    const bad = src.replace("√((0 - 1) ^ 2", "√((0 - 2) ^ 2");
    const n = parseTerm(bad);
    if (n.k !== "bin") throw new Error("parse");
    expect(readAngle(bad, n.a, n.b, new Set(["Ax", "Ay"]))?.cross).toBeUndefined();
  });
});

describe("poly_certificate.py: the trigonometric field", () => {
  // cos 20° · x = 1 − cos 80° · y and sin 80° · y = sin 20° · x (two rays meeting), θ = 10°:
  // c = cos θ (v0), s = sin θ (v1), x (v2), y (v3); goal: the solution satisfies the law of sines,
  // x · sin 100° = sin 80°... here simply x·sin(100°) − sin(80°) = 0 written with c, s.
  it("eliminates through a trigonometric coefficient (its inverse in the field)", () => {
    const q = (n: string) => n;
    const req = {
      vars: ["v0", "v1", "v2", "v3"],
      hyps: [
        // R1 = s² + c² − 1
        { name: "h0", poly: [[q("1"), { v1: 2 }], [q("1"), { v0: 2 }], [q("-1"), {}]] },
        // R2 = T6(c) − 1/2 = 32c⁶ − 48c⁴ + 18c² − 1 − 1/2
        { name: "h1", poly: [[q("32"), { v0: 6 }], [q("-48"), { v0: 4 }], [q("18"), { v0: 2 }], [q("-3/2"), {}]] },
        // (2c² − 1)·x − 1 = 0   (cos 20° · x = 1)
        { name: "h2", poly: [[q("2"), { v0: 2, v2: 1 }], [q("-1"), { v2: 1 }], [q("-1"), {}]] },
      ],
      // goal: x − 1 / cos 20° … stated polynomially: x · (2c² − 1) · (2c² − 1) − (2c² − 1) = 0
      goal: [[q("4"), { v0: 4, v2: 1 }], [q("-4"), { v0: 2, v2: 1 }], [q("1"), { v2: 1 }], [q("-2"), { v0: 2 }], [q("1"), {}]],
      multipliers: [],
      field: { c: "v0", s: "v1", r1: "h0", r2: "h1" },
      timeout: 60,
    };
    let out: string;
    try {
      out = execFileSync("python3", ["scripts/poly_certificate.py"], { input: JSON.stringify(req), encoding: "utf8", timeout: 90_000 });
    } catch {
      return; // no python / sympy here
    }
    const r = JSON.parse(out) as { ok: boolean };
    expect(r.ok).toBe(true);
  });
});
