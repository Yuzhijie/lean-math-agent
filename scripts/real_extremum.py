#!/usr/bin/env python3
"""
Real polynomial extremum helper for lib/lean/auto/realopt.ts (JSON on stdin, JSON on stdout).

Input: {"vars": ["v0", ...], "eqs": [sparse], "ineqs": [sparse, each >= 0], "target": sparse,
        "value": "p/q", "kind": "min" | "max"}
  sparse = [[coef "p/q", {"v0": exp, ...}], ...]  (the format of lib/lean/geometry/poly.ts)

Output: {"witness": ["p/q", ...] | null,
         "reductions": [{"var": i, "g": sparse, "lo": "p/q" | null, "hi": "p/q" | null,
                         "factors": [{"poly": sparse, "exp": e, "kind": "lin" | "sq"}], "const": "p/q"}]}

- witness: a rational point (grid of small numbers) where every equation holds, every inequality
  holds and the target equals the value.
- reductions: for a variable v, the target's normal form modulo the equations (lex Gröbner basis,
  v last) when it is a polynomial g(v) of v alone; the range [lo, hi] of v on the real solutions
  (Lagrange: critical points of v on the variety, rational ones only); and g − value (min) or
  value − g (max) = const · Π factor^exp with every factor nonnegative on [lo, hi] (a linear factor
  signed so, or an even power) — what nlinarith is then given.
Nothing here is trusted: the proof built from it is checked by Lean.
"""
import json
import signal
import sys
from fractions import Fraction
from itertools import product

import sympy as sp


def frac(s):
    return Fraction(s)


def to_expr(sparse, syms):
    e = sp.Integer(0)
    for coef, mono in sparse:
        c = sp.Rational(coef)
        t = c
        for v, k in mono.items():
            t *= syms[int(v[1:])] ** k
        e += t
    return sp.expand(e)


def to_sparse(expr, syms):
    p = sp.Poly(sp.expand(expr), *syms)
    out = []
    for monom, coef in p.terms():
        out.append([str(sp.Rational(coef)), {f"v{i}": int(k) for i, k in enumerate(monom) if k}])
    return out


def evaluator(sparse):
    terms = [(Fraction(c), [(int(v[1:]), k) for v, k in m.items()]) for c, m in sparse]

    def f(pt):
        s = Fraction(0)
        for c, ms in terms:
            t = c
            for i, k in ms:
                t *= pt[i] ** k
            s += t
        return s

    return f


def find_witness(n, eqs, ineqs, target, value):
    fe = [evaluator(e) for e in eqs]
    fi = [evaluator(e) for e in ineqs]
    ft = evaluator(target)
    for den, lim in ((1, 12), (2, 12), (3, 6)):
        if n >= 4 and den > 1:
            break
        if n >= 5:
            break
        vals = sorted({Fraction(k, den) for k in range(-lim * den, lim * den + 1)}, key=lambda q: (abs(q), q < 0))
        for pt in product(vals, repeat=n):
            if all(f(pt) == 0 for f in fe) and all(f(pt) >= 0 for f in fi) and ft(pt) == value:
                return [str(q) for q in pt]
    return None


def var_range(v, syms, eqs):
    """Critical values of v on the real variety {eqs = 0}: min and max when all are rational."""
    lams = sp.symbols(f"lam0:{len(eqs)}")
    grads = [[sp.diff(e, s) for s in syms] for e in eqs]
    system = list(eqs)
    for j, s in enumerate(syms):
        system.append((1 if s == v else 0) - sum(lams[i] * grads[i][j] for i in range(len(eqs))))
    try:
        sols = sp.solve(system, list(syms) + list(lams), dict=True)
    except Exception:
        return None, None
    vals = []
    for sol in sols:
        if v not in sol:
            continue
        val = sp.nsimplify(sol[v])
        if not val.is_real:
            continue
        # every coordinate real
        if any(not sp.sympify(sol.get(s, 0)).is_real for s in syms):
            continue
        vals.append(val)
    if not vals:
        return None, None
    lo, hi = min(vals), max(vals)
    rat = lambda x: str(sp.Rational(x)) if x.is_rational else None
    return rat(lo), rat(hi)


def factor_hint(g_minus, v, lo, hi):
    """g_minus = const · Π f^e with each f ≥ 0 on [lo, hi]; None when that is not seen."""
    c, facs = sp.factor_list(sp.Poly(g_minus, v))
    const = sp.Rational(c)
    out = []
    lo_q = sp.Rational(lo) if lo is not None else None
    hi_q = sp.Rational(hi) if hi is not None else None
    for f, e in facs:
        f = f.as_expr()
        deg = sp.degree(f, v)
        if e % 2 == 0:
            out.append({"expr": f, "exp": int(e), "kind": "sq"})
            continue
        if deg != 1:
            # positive everywhere (no real root, positive leading coefficient)
            if not sp.real_roots(sp.Poly(f, v)) and sp.Poly(f, v).LC() > 0:
                out.append({"expr": f, "exp": int(e), "kind": "pos"})
                continue
            return None
        a = sp.Poly(f, v).LC()
        r = sp.solve(f, v)[0]
        if lo_q is not None and r <= lo_q:
            sign = 1 if a > 0 else -1
        elif hi_q is not None and r >= hi_q:
            sign = -1 if a > 0 else 1
        else:
            return None
        if sign < 0:
            f = -f
            const = const * (-1) ** e
        out.append({"expr": sp.expand(f), "exp": int(e), "kind": "lin"})
    if const <= 0:
        return None
    return const, out


def main():
    req = json.load(sys.stdin)
    n = len(req["vars"])
    syms = sp.symbols(f"v0:{n}") if n > 1 else (sp.Symbol("v0"),)
    eqs = [to_expr(e, syms) for e in req["eqs"]]
    target = to_expr(req["target"], syms)
    value = frac(req["value"])
    kind = req.get("kind", "min")
    witness = find_witness(n, req["eqs"], req.get("ineqs", []), req["target"], value)
    reductions = []
    for i, v in enumerate(syms):
        others = [s for s in syms if s != v]
        try:
            G = sp.groebner(eqs, *others, v, order="lex") if eqs else None
            g = G.reduce(target)[1] if G is not None else target
        except Exception:
            continue
        g = sp.expand(g)
        if not g.free_symbols or not g.free_symbols <= {v}:
            continue
        lo, hi = var_range(v, syms, eqs) if eqs else (None, None)
        diff = g - sp.Rational(value.numerator, value.denominator) if kind == "min" else sp.Rational(value.numerator, value.denominator) - g
        hint = factor_hint(sp.expand(diff), v, lo, hi)
        if hint is None:
            continue
        const, facs = hint
        reductions.append({
            "var": i,
            "g": to_sparse(g, syms),
            "lo": lo,
            "hi": hi,
            "const": str(const),
            "factors": [{"poly": to_sparse(f["expr"], syms), "exp": f["exp"], "kind": f["kind"]} for f in facs],
        })
    json.dump({"witness": witness, "reductions": reductions}, sys.stdout)


if __name__ == "__main__":
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError()))
    signal.alarm(40)
    try:
        main()
    except TimeoutError:
        json.dump({"witness": None, "reductions": [], "error": "timeout"}, sys.stdout)
