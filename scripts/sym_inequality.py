#!/usr/bin/env python3
"""
Symmetric inequalities in three positive reals with x·y·z = 1, for lib/lean/auto/symineq.ts
(JSON on stdin, JSON on stdout).

Input: {"parts": [{"lhs": expr, "rhs": expr}, ...]}        — each part asks for lhs − rhs ≥ 0
  expr = ["num", "p/q"] | ["var", 0 | 1 | 2] | ["neg", e] | ["+" | "-" | "*" | "/", e, e] | ["^", e, n]
       | ["base", id, e]      — e is the base of a denominator (the caller knows its text by id)

Output: {"rewrites": [{"id": id, "product": [[id, exp], ...], "cof": sparse3}], "parts": [part, ...]}
  rewrites: a denominator base that equals a product of smaller ones once x·y·z = 1 —
    base − Π base^exp = cof · (x·y·z − 1), as 2 + x + y + z + xy + yz + zx = (1 + x)(1 + y)(1 + z).
    The parts below are computed with the base replaced: the common denominator is smaller (of
    degree 6 instead of 10 for Σ 1/(1 + x)² against 8(x + y + z − 3)/(2 + … + zx)², which is the
    difference between a proof `ring` checks in seconds and one it needs minutes for).
  part = {"ok": false, "why": "...", "false_at_one"?: true}     — false_at_one: lhs − rhs < 0 at x = y = z = 1
       | {"ok": true,
          "den_const": "p/q", "den": [{"poly": sparse3, "exp": e}],   lhs − rhs = N / (den_const · Π den^exp)
          "N": sparse3,
          "cof": sparse3,                                             N − G(x, y, z) = cof · (x·y·z − 1)
          "g_const": "p/q", "g": [{"poly": sparse2, "exp": e, "kind": "even" | "coef" | "other"}],
          "expanded": sparse2, "rest": sparse2, "expanded_coef": true | false, "linear": "P" | "Q" | null}
  sparse3 = [[coef "p/q", {"v0": exp, ...}], ...] in x, y, z; sparse2 the same in P = v0, Q = v1
  (the format of lib/lean/geometry/poly.ts)

How: lhs − rhs as one fraction N / Den (every factor of Den has no negative coefficient, so it is
positive for positive x, y, z); N is symmetric, so it is a polynomial in p = x + y + z,
q = xy + yz + zx and r = xyz = 1; with P = p − 3 ≥ 0 and Q = q − 3 ≥ 0 (AM–GM) it becomes
G(P, Q) = g_const · Π g^exp. A factor's kind says why it is not negative: an even power, no
negative coefficient, or "other" (left to nlinarith with P, Q ≥ 0, p² ≥ 3q and q² ≥ 3p).
"expanded": G multiplied out; "rest": G − λ(P² + 6P − 3Q) − μ(Q² + 6Q − 3P) with the least λ, μ ≥ 0
that take a negative c·Q and c·P away; "expanded_coef": the rest has no negative coefficient;
"linear": it then has a term c·P (or c·Q) with c > 0 — so G = 0 forces P = 0 (or Q = 0), the
equality case.
Nothing here is trusted: the proof built from it is checked by Lean.
"""
import json
import signal
import sys

import sympy as sp
from sympy.polys.polyfuncs import symmetrize

X = sp.symbols("v0 v1 v2", positive=True)
P, Q = sp.symbols("P Q")
MAX_TERMS = 1500


def build(e, bases, replaced=None):
    """The expression; `bases` collects id → polynomial, `replaced` gives a base another value."""
    tag = e[0]
    if tag == "base":
        inner = build(e[2], bases, replaced)
        bases[int(e[1])] = sp.expand(inner)
        return replaced[int(e[1])] if replaced and int(e[1]) in replaced else inner
    if tag == "num":
        return sp.Rational(e[1])
    if tag == "var":
        return X[int(e[1])]
    if tag == "neg":
        return -build(e[1], bases, replaced)
    if tag == "^":
        n = int(e[2])
        if n < 0 or n > 12:
            raise ValueError("exponent")
        return build(e[1], bases, replaced) ** n
    a, b = build(e[1], bases, replaced), build(e[2], bases, replaced)
    if tag == "+":
        return a + b
    if tag == "-":
        return a - b
    if tag == "*":
        return a * b
    if tag == "/":
        return a / b
    raise ValueError(f"unknown node {tag}")


def sparse(expr, syms):
    p = sp.Poly(sp.expand(expr), *syms)
    return [[str(sp.Rational(c)), {f"v{i}": int(k) for i, k in enumerate(m) if k}] for m, c in p.terms()]


def no_negative_coefficient(expr, syms):
    return all(c >= 0 for c in sp.Poly(sp.expand(expr), *syms).coeffs())


def find_rewrites(bases):
    """Bases that are a product of bases of smaller degree modulo x·y·z = 1."""
    constraint = sp.Poly(X[0] * X[1] * X[2] - 1, *X)
    # one id per distinct polynomial
    seen = {}
    for i in sorted(bases):
        if bases[i].free_symbols and bases[i] not in seen.values():
            seen[i] = bases[i]
    degree = {i: sp.Poly(f, *X).total_degree() for i, f in seen.items()}
    out = []
    for i, f in seen.items():
        smaller = [j for j in seen if degree[j] < degree[i]][:4]
        if not smaller:
            continue
        found = None
        for exps in sp.utilities.iterables.cartes(*[range(3)] * len(smaller)):
            if not any(exps) or sum(e * degree[j] for e, j in zip(exps, smaller)) < degree[i]:
                continue
            g = sp.Integer(1)
            for e, j in zip(exps, smaller):
                g *= seen[j] ** e
            q, r = sp.div(sp.Poly(sp.expand(f - g), *X), constraint)
            if r.is_zero:
                found = ([[j, int(e)] for e, j in zip(exps, smaller) if e], g, q)
                break
        if found:
            # every id with this polynomial gets the product
            for k in sorted(bases):
                if bases[k] == f:
                    out.append({"id": k, "product": found[0], "cof": sparse(found[2].as_expr(), X), "_value": found[1]})
    return out


def part(spec, replaced):
    f = sp.together(build(spec["lhs"], {}, replaced) - build(spec["rhs"], {}, replaced))
    num, den = sp.fraction(sp.cancel(f))
    num, den = sp.expand(num), sp.expand(den)
    if den.free_symbols - set(X) or num.free_symbols - set(X):
        return {"ok": False, "why": "other symbols"}
    # the denominator as a positive number times factors without negative coefficients
    dc, dfs = sp.factor_list(den, *X)
    if dc < 0:
        dc, num = -dc, -num
    den_factors = []
    for fac, e in dfs:
        if not no_negative_coefficient(fac, X):
            fac = -fac
            if e % 2:
                dc, num = -dc, -num
            if dc < 0:
                dc, num = -dc, -num
            if not no_negative_coefficient(fac, X):
                return {"ok": False, "why": "a denominator factor that may vanish for positive values"}
        den_factors.append((fac, e))
    if len(sp.Poly(num, *X).terms()) > MAX_TERMS:
        return {"ok": False, "why": "too many terms"}
    # symmetric → a polynomial in the elementary symmetric functions
    sym, rest, defs = symmetrize(num, list(X), formal=True)
    if rest != 0:
        return {"ok": False, "why": "not symmetric"}
    s1, s2, s3 = (d[0] for d in defs)
    G = sp.expand(sym.subs({s3: 1}).subs({s1: P + 3, s2: Q + 3}))
    if G == 0:
        return {"ok": False, "why": "the two sides are equal"}
    px, qx = X[0] + X[1] + X[2] - 3, X[0] * X[1] + X[1] * X[2] + X[2] * X[0] - 3
    cof, rem = sp.div(sp.Poly(sp.expand(num - G.subs({P: px, Q: qx})), *X), sp.Poly(X[0] * X[1] * X[2] - 1, *X))
    if not rem.is_zero:
        return {"ok": False, "why": "no cofactor"}
    # P = Q = 0 is x = y = z = 1: a negative value there is a counterexample
    if G.subs({P: 0, Q: 0}) < 0:
        return {"ok": False, "why": "false at x = y = z = 1", "false_at_one": True}
    gc, gfs = sp.factor_list(G, P, Q)
    gfs = [[fac, int(e)] for fac, e in gfs]
    if gc < 0:
        # the sign belongs to a factor of odd power (factor_list fixes signs by the leading term)
        odd = next((f for f in gfs if f[1] % 2), None)
        if odd is None:
            return {"ok": False, "why": "never positive"}
        odd[0], gc = -odd[0], -gc
    factors = []
    for fac, e in gfs:
        if e % 2 and not no_negative_coefficient(fac, (P, Q)) and no_negative_coefficient(-fac, (P, Q)):
            return {"ok": False, "why": "a factor that is never positive"}
        kind = "even" if e % 2 == 0 else "coef" if no_negative_coefficient(fac, (P, Q)) else "other"
        factors.append({"poly": sparse(fac, (P, Q)), "exp": int(e), "kind": kind})
    # the equality case: G = λ·T1 + μ·T2 + R with T1 = P² + 6P − 3Q ≥ 0, T2 = Q² + 6Q − 3P ≥ 0 and
    # R without a negative coefficient; a term c·P (or c·Q), c > 0, in R then makes G = 0 force P = 0
    whole = sp.Poly(G, P, Q)
    lam = max(sp.Integer(0), -whole.coeff_monomial(Q) / 3)
    mu = max(sp.Integer(0), -whole.coeff_monomial(P) / 3)
    rest = sp.Poly(sp.expand(G - lam * (P**2 + 6 * P - 3 * Q) - mu * (Q**2 + 6 * Q - 3 * P)), P, Q)
    expanded = all(c >= 0 for c in rest.coeffs())
    linear = None
    if expanded:
        if rest.coeff_monomial(P) > 0:
            linear = "P"
        elif rest.coeff_monomial(Q) > 0:
            linear = "Q"
    return {
        "ok": True,
        "den_const": str(sp.Rational(dc)),
        "den": [{"poly": sparse(fac, X), "exp": int(e)} for fac, e in den_factors],
        "N": sparse(num, X),
        "cof": sparse(cof.as_expr(), X),
        "g_const": str(sp.Rational(gc)),
        "g": factors,
        "expanded": sparse(G, (P, Q)),
        "rest": sparse(rest.as_expr(), (P, Q)),
        "expanded_coef": bool(expanded),
        "linear": linear,
    }


def main():
    signal.signal(signal.SIGALRM, lambda *_: sys.exit(3))
    data = json.load(sys.stdin)
    signal.alarm(int(data.get("timeout", 40)))
    bases = {}
    try:
        for spec in data["parts"]:
            build(spec["lhs"], bases)
            build(spec["rhs"], bases)
        rewrites = find_rewrites(bases)
    except Exception:  # noqa: BLE001
        rewrites = []
    replaced = {r["id"]: r.pop("_value") for r in rewrites}
    out = []
    for spec in data["parts"]:
        try:
            out.append(part(spec, replaced))
        except Exception as e:  # noqa: BLE001 — a part the helper cannot read is just not proved this way
            out.append({"ok": False, "why": f"{type(e).__name__}: {e}"})
    json.dump({"rewrites": rewrites, "parts": out}, sys.stdout)


if __name__ == "__main__":
    main()
