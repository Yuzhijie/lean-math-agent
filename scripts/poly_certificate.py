"""
Polynomial certificates for the Lean geometry prover (lib/lean/geometry).

Given hypotheses h_i = 0 and a goal g = 0 over QQ[x], find a multiplier m (1, or a product of up
to two candidates the caller can prove nonzero) and cofactors c_i with

    m * g = sum_i c_i * h_i

so the Lean proof is `linear_combination` (via `mul_eq_zero` when m ≠ 1). Polynomials travel as
sparse JSON — a list of [coefficient "p/q", {variable: exponent}] — so nothing is parsed or
evaluated from text.

The search: eliminate variables that a hypothesis gives linearly (v = expr), reduce by square
relations (s^2 = E, from square roots / |x| / sin^2 + cos^2), then solve for the remaining cofactors
by linear algebra over QQ with growing degree bounds (a Gröbner basis test first rules out a
multiplier quickly). Every step is tracked, so the cofactors are in terms of the caller's
hypotheses; the result is checked by expanding before it is returned.

Usage: python3 scripts/poly_certificate.py < request.json > response.json, or POST /certificate on
the compute server.
"""

from __future__ import annotations

import itertools
import json
import os
import re
import sys
from fractions import Fraction
from typing import Any

import sympy
from sympy import Poly, QQ, Rational, Symbol, groebner

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from safe_parse import ComputationTimeout, time_limit  # noqa: E402

NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
MAX_VARS = 40
MAX_TERMS = 4000


class CertError(ValueError):
    pass


def to_poly(sparse: Any, gens: list[Symbol], index: dict[str, int]) -> Poly:
    if not isinstance(sparse, list) or len(sparse) > MAX_TERMS:
        raise CertError("a polynomial must be a list of at most %d terms" % MAX_TERMS)
    terms: dict[tuple[int, ...], Any] = {}
    for term in sparse:
        if not (isinstance(term, list) and len(term) == 2 and isinstance(term[1], dict)):
            raise CertError("a term is [coefficient, {variable: exponent}]")
        coef, mono = term
        try:
            c = Fraction(str(coef))
        except (ValueError, ZeroDivisionError):
            raise CertError(f"bad coefficient {coef!r}")
        exps = [0] * len(gens)
        for v, e in mono.items():
            if v not in index or not isinstance(e, int) or e < 0 or e > 64:
                raise CertError(f"bad monomial {mono!r}")
            exps[index[v]] += e
        key = tuple(exps)
        terms[key] = terms.get(key, 0) + Rational(c.numerator, c.denominator)
    return Poly.from_dict({k: v for k, v in terms.items() if v != 0} or {tuple([0] * len(gens)): 0}, *gens, domain=QQ)


def from_poly(p: Poly, names: list[str]) -> list:
    out = []
    for mono, coef in sorted(p.terms(), reverse=True):
        if coef == 0:
            continue
        r = Rational(coef)
        out.append([f"{r.p}/{r.q}" if r.q != 1 else str(r.p), {names[i]: e for i, e in enumerate(mono) if e}])
    return out


class Item:
    """A polynomial known to equal comb(h) = sum_k comb[k] * h_k (as a polynomial identity)."""

    def __init__(self, poly: Poly, comb: dict[str, Poly]):
        self.poly = poly
        self.comb = comb


def add_comb(a: dict[str, Poly], b: dict[str, Poly], factor: Poly) -> dict[str, Poly]:
    out = dict(a)
    for k, v in b.items():
        out[k] = out.get(k, factor * 0) + factor * v
    return out


def divide_linear(q: Poly, p: Poly, v: int) -> tuple[Poly, Poly]:
    """q = quot * p + rem where p = a*x_v + r (a constant, r free of x_v); rem is free of x_v."""
    gens = q.gens
    x = gens[v]
    a = p.coeff_monomial(x)
    r = p - Poly(a * x, *gens, domain=QQ)
    sub = (-r.as_expr()) / a
    rem = Poly(q.as_expr().subs(x, sub), *gens, domain=QQ)
    quot, check = (q - rem).div(p)
    if not check.is_zero:
        raise CertError("internal: inexact linear division")
    return quot, rem


def divide_square(q: Poly, p: Poly, v: int) -> tuple[Poly, Poly]:
    """q = quot * p + rem where p = a*x_v^2 + r (a constant, r free of x_v); rem has x_v-degree ≤ 1."""
    gens = q.gens
    x = gens[v]
    a = p.coeff_monomial(x**2)
    r = p - Poly(a * x**2, *gens, domain=QQ)
    # replace x^2 by -r/a repeatedly: x^(2k+e) -> (-r/a)^k x^e
    rep = Poly((-r.as_expr()) / a, *gens, domain=QQ)
    rem = Poly(0, *gens, domain=QQ)
    for mono, coef in q.terms():
        e = mono[v]
        rest = list(mono)
        rest[v] = e % 2
        term = Poly.from_dict({tuple(rest): coef}, *gens, domain=QQ)
        rem += term * rep ** (e // 2)
    quot, check = (q - rem).div(p)
    if not check.is_zero:
        raise CertError("internal: inexact square division")
    return quot, rem


def linear_var(p: Poly) -> int | None:
    """A variable p is linear in with a constant coefficient and that appears nowhere else in p."""
    gens = p.gens
    best = None
    for v in range(len(gens)):
        if p.degree(gens[v]) != 1:
            continue
        a = p.coeff_monomial(gens[v])
        if a == 0:
            continue
        rest = p - Poly(a * gens[v], *gens, domain=QQ)
        if rest.degree(gens[v]) <= 0:
            # prefer the variable whose elimination leaves the fewest terms
            size = len(rest.terms())
            if best is None or size < best[1]:
                best = (v, size)
    return None if best is None else best[0]


def square_var(p: Poly) -> int | None:
    gens = p.gens
    for v in range(len(gens)):
        if p.degree(gens[v]) != 2:
            continue
        a = p.coeff_monomial(gens[v] ** 2)
        if a == 0:
            continue
        rest = p - Poly(a * gens[v] ** 2, *gens, domain=QQ)
        if rest.degree(gens[v]) <= 0:
            return v
    return None


def monomials_upto(nvars: int, deg: int):
    for d in range(deg + 1):
        for combo in itertools.combinations_with_replacement(range(nvars), d):
            exps = [0] * nvars
            for i in combo:
                exps[i] += 1
            yield tuple(exps)


def solve_cofactors(target: Poly, hyps: list[Poly], extra: int, max_unknowns: int) -> list[Poly] | None:
    """Cofactors c with target = sum c_j hyps_j, each deg c_j ≤ D - deg hyps_j, by linear algebra."""
    gens = target.gens
    n = len(gens)
    used = sorted({i for p in [target, *hyps] for mono in p.monoms() for i, e in enumerate(mono) if e})
    D = max([target.total_degree()] + [h.total_degree() for h in hyps]) + extra
    columns: list[tuple[int, tuple[int, ...]]] = []
    for j, h in enumerate(hyps):
        dj = D - h.total_degree()
        if dj < 0:
            continue
        for small in monomials_upto(len(used), dj):
            mono = [0] * n
            for k, i in enumerate(used):
                mono[i] = small[k]
            columns.append((j, tuple(mono)))
            if len(columns) > max_unknowns:
                return None
    if not columns:
        return None
    rows: dict[tuple[int, ...], int] = {}
    entries: dict[tuple[int, int], Any] = {}
    for col, (j, mono) in enumerate(columns):
        for hm, hc in hyps[j].terms():
            m = tuple(a + b for a, b in zip(mono, hm))
            r = rows.setdefault(m, len(rows))
            entries[(r, col)] = entries.get((r, col), 0) + hc
    for tm, _ in target.terms():
        rows.setdefault(tm, len(rows))
    from sympy.polys.matrices import DomainMatrix

    nrows, ncols = len(rows), len(columns)
    A = [[QQ(0)] * (ncols + 1) for _ in range(nrows)]
    for (r, c), v in entries.items():
        A[r][c] = QQ.convert(v)
    for tm, tc in target.terms():
        A[rows[tm]][ncols] = QQ.convert(tc)
    M = DomainMatrix(A, (nrows, ncols + 1), QQ)
    R, pivots = M.rref()
    if ncols in pivots:
        return None  # inconsistent: no cofactors of this degree
    sol = [QQ(0)] * ncols
    Rl = R.to_list()
    for row, pc in enumerate(pivots):
        sol[pc] = Rl[row][ncols]
    out = [Poly(0, *gens, domain=QQ) for _ in hyps]
    for col, (j, mono) in enumerate(columns):
        if sol[col] != 0:
            out[j] += Poly.from_dict({mono: sol[col]}, *gens, domain=QQ)
    return out


def attempt(goal: Poly, items: list[Item], max_extra: int, max_unknowns: int, member_only: bool = False):
    """Coefficients (by hypothesis name) with goal = sum coef * h, or None. With member_only: True
    when the goal is in the ideal (Gröbner basis test), else False — no cofactors."""
    gens = goal.gens
    zero = Poly(0, *gens, domain=QQ)
    target = Item(goal, {})  # invariant: original goal = target.poly + sum target.comb[k] * h_k
    work = [Item(it.poly, dict(it.comb)) for it in items if not it.poly.is_zero]

    def reduce_all(rule: Item, divide, v: int, keep_rule: bool):
        nonlocal work
        nxt = []
        for it in work:
            if it is rule:
                if keep_rule:
                    nxt.append(it)
                continue
            q, r = divide(it.poly, rule.poly, v)
            if not q.is_zero:
                it = Item(r, add_comb(it.comb, rule.comb, -q))
            if not it.poly.is_zero:
                nxt.append(it)
        work = nxt
        q, r = divide(target.poly, rule.poly, v)
        if not q.is_zero:
            target.poly, target.comb = r, add_comb(target.comb, rule.comb, q)

    for _ in range(60):
        changed = False
        for it in work:
            v = linear_var(it.poly)
            if v is not None:
                reduce_all(it, divide_linear, v, keep_rule=False)
                changed = True
                break
        if changed:
            continue
        for it in work:
            v = square_var(it.poly)
            if v is not None and (any(o is not it and o.poly.degree(gens[v]) >= 2 for o in work) or target.poly.degree(gens[v]) >= 2):
                reduce_all(it, divide_square, v, keep_rule=True)
                changed = True
                break
        if not changed:
            break

    if target.poly.is_zero:
        return True if member_only else target.comb
    hyps = [it.poly for it in work]
    if not hyps:
        return False if member_only else None
    try:
        G = groebner([h.as_expr() for h in hyps], *gens, order="grevlex", domain=QQ)
        member = G.contains(target.poly.as_expr())
    except ComputationTimeout:
        raise
    except Exception:
        member = True  # unknown: let the linear algebra decide
    if member_only:
        return member
    if not member:
        return None
    for extra in range(max_extra + 1):
        cof = solve_cofactors(target.poly, hyps, extra, max_unknowns)
        if cof is not None:
            comb = dict(target.comb)
            for c, it in zip(cof, work):
                if not c.is_zero:
                    comb = add_comb(comb, it.comb, c)
            return comb
    return None


def certificate(req: dict) -> dict:
    names = req.get("vars")
    if not isinstance(names, list) or not names or len(names) > MAX_VARS or not all(isinstance(n, str) and NAME.match(n) for n in names):
        raise CertError("vars: a list of plain identifiers")
    gens = [Symbol(n) for n in names]
    index = {n: i for i, n in enumerate(names)}
    hyps_in = req.get("hyps") or []
    mults_in = req.get("multipliers") or []
    if not isinstance(hyps_in, list) or not isinstance(mults_in, list):
        raise CertError("hyps and multipliers are lists")
    items = []
    originals: dict[str, Poly] = {}
    for h in hyps_in:
        name = h.get("name") if isinstance(h, dict) else None
        if not (isinstance(name, str) and NAME.match(name)) or name in originals:
            raise CertError("each hypothesis needs a unique plain name")
        p = to_poly(h.get("poly"), gens, index)
        originals[name] = p
        items.append(Item(p, {name: Poly(1, *gens, domain=QQ)}))
    goal = to_poly(req.get("goal"), gens, index)
    mults = []
    for m in mults_in:
        name = m.get("name") if isinstance(m, dict) else None
        if not (isinstance(name, str) and NAME.match(name)):
            raise CertError("each multiplier needs a plain name")
        mults.append((name, to_poly(m.get("poly"), gens, index)))
    max_extra = int(req.get("max_extra_degree", 2))
    max_unknowns = int(req.get("max_unknowns", 3000))

    # Irreducible factors of the candidates: lower degree than the candidates (a point D ≠ C with
    # D = (1 - t) A + t C gives (1 - t)^2 |A - C|^2, of which t - 1 is what is needed), and each is
    # still nonzero (the caller proves it from the candidate: factor = 0 makes the candidate 0).
    factors: list[tuple[str, Poly, Poly]] = []
    seen: set = set()
    for name, p in mults:
        if p.is_zero:
            continue
        for f, _e in p.factor_list()[1]:
            if f.total_degree() == 0:
                continue
            key = f.monic().as_expr()
            if key in seen:
                continue
            seen.add(key)
            cof, r = p.div(f)
            if not r.is_zero:
                continue
            factors.append((name, f, cof))
    factors.sort(key=lambda x: (x[1].total_degree(), len(x[1].terms())))

    def product(choice) -> Poly:
        m = Poly(1, *gens, domain=QQ)
        for _, f, _c in choice:
            m = m * f
        return m

    def member(choice) -> bool:
        return bool(attempt(product(choice) * goal, items, max_extra, max_unknowns, member_only=True))

    choice = None
    if member([]):
        choice = []
    else:
        for size in (1, 2, 3):
            for combo in itertools.combinations(factors, size):
                if member(list(combo)):
                    choice = list(combo)
                    break
            if choice is not None:
                break
    if choice is None:
        return {"ok": False, "reason": "the goal does not follow from the equations (with up to three nondegeneracy factors)"}
    m = product(choice)
    comb = attempt(m * goal, items, max_extra, max_unknowns)
    if comb is not None:
        rest = m * goal
        for k, c in comb.items():
            rest -= c * originals[k]
        if rest.is_zero:
            return {
                "ok": True,
                "multiplier": [{"source": n, "factor": from_poly(f, names), "cofactor": from_poly(c, names)} for n, f, c in choice],
                "coefficients": {k: from_poly(c, names) for k, c in comb.items() if not c.is_zero},
            }
    return {"ok": False, "reason": "the goal follows, but no cofactors were found within the degree bounds"}


def certificate_or_reason(req: Any) -> dict:
    """For a caller that already runs under a time limit (the compute server)."""
    if not isinstance(req, dict):
        return {"ok": False, "reason": "request must be a JSON object"}
    try:
        return certificate(req)
    except CertError as e:
        return {"ok": False, "reason": str(e)}


def handle(req: Any, timeout: float = 30.0) -> dict:
    if not isinstance(req, dict):
        return {"ok": False, "reason": "request must be a JSON object"}
    try:
        with time_limit(float(req.get("timeout", timeout))):
            return certificate(req)
    except CertError as e:
        return {"ok": False, "reason": str(e)}
    except ComputationTimeout:
        return {"ok": False, "reason": "timed out"}


if __name__ == "__main__":
    try:
        request = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        print(json.dumps({"ok": False, "reason": "invalid JSON"}))
        sys.exit(0)
    print(json.dumps(handle(request)))
