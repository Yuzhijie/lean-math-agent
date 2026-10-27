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
# linear algebra size (rows × columns of the cofactor system) and caller-settable bounds
MAX_CELLS = 100_000_000
MAX_ENTRIES = 2_000_000
MAX_UNKNOWNS = 5000
MAX_EXTRA_DEGREE = 3
MAX_TIMEOUT = 120.0


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


def linear_var(p: Poly, skip: set[int] | None = None) -> int | None:
    """A variable p is linear in with a constant coefficient and that appears nowhere else in p."""
    gens = p.gens
    best = None
    for v in range(len(gens)):
        if (skip and v in skip) or p.degree(gens[v]) != 1:
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


def rest_degree(p: Poly, v: int, skip: set[int]) -> int:
    """Total degree of p without its x_v term, counting only variables outside `skip`."""
    best = 0
    for m in p.monoms():
        if m[v]:
            continue
        best = max(best, sum(e for i, e in enumerate(m) if i not in skip))
    return best


def field_candidates_lower(work: list, field, deg: int) -> bool:
    """Some trig-coefficient substitution has a rest of lower degree than `deg`."""
    for it in work:
        if it in (field.r1, field.r2):
            continue
        found = field_linear_var(it.poly, field)
        if found is not None and rest_degree(it.poly, found[0], {field.ci, field.si}) < deg:
            return True
    return False


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
    if nrows * (ncols + 1) > MAX_CELLS or len(entries) > MAX_ENTRIES:
        return None
    # sparse: most entries are zero (a dense matrix of this size is hundreds of MB of Python objects)
    A: dict[int, dict[int, Any]] = {}
    for (r, c), v in entries.items():
        if v != 0:
            A.setdefault(r, {})[c] = QQ.convert(v)
    for tm, tc in target.terms():
        A.setdefault(rows[tm], {})[ncols] = QQ.convert(tc)
    M = DomainMatrix(A, (nrows, ncols + 1), QQ)
    R, pivots = M.rref()
    if ncols in pivots:
        return None  # inconsistent: no cofactors of this degree
    sol = [QQ(0)] * ncols
    Rd = R.to_sdm()
    for row, pc in enumerate(pivots):
        sol[pc] = Rd.get(row, {}).get(ncols, QQ(0))
    out = [Poly(0, *gens, domain=QQ) for _ in hyps]
    for col, (j, mono) in enumerate(columns):
        if sol[col] != 0:
            out[j] += Poly.from_dict({mono: sol[col]}, *gens, domain=QQ)
    return out


class Field:
    """The trigonometric field of the angle mode (lib/lean/geometry/angles.ts): variables c = cos θ,
    s = sin θ with the hypotheses R1 = s² + c² − 1 and R2 = T_k(c) − 1/2 (both Items, so their use
    is tracked). Normal forms have s-degree ≤ 1 and c-degree < k; a nonzero element is invertible
    (every point of R1 = R2 = 0 is a conjugate of the true cos θ, sin θ)."""

    def __init__(self, gens: list[Symbol], ci: int, si: int, r1: Item, r2: Item):
        self.gens = gens
        self.ci, self.si = ci, si
        self.c, self.s = gens[ci], gens[si]
        self.r1, self.r2 = r1, r2
        self.k = r2.poly.degree(self.c)
        if r1.poly.degree(self.s) != 2 or self.k < 1 or r2.poly.degree(self.s) > 0:
            raise CertError("field: R1 must be quadratic in s, R2 a polynomial in c")
        others = [g for i, g in enumerate(gens) if i not in (ci, si)]
        self.order = [self.s, self.c, *others]

    def only_field(self, p: Poly) -> bool:
        return all(all(e == 0 for i, e in enumerate(m) if i not in (self.ci, self.si)) for m in p.monoms())

    def reduce(self, p: Poly) -> tuple[Poly, Poly, Poly]:
        """p = rem + q1 * R1 + q2 * R2 (lex s > c > the rest: R1, R2 are a Gröbner basis)."""
        if p.is_zero:
            return p, p, p
        (q1, q2), rem = sympy.reduced(p.as_expr(), [self.r1.poly.as_expr(), self.r2.poly.as_expr()], *self.order, order="lex")
        P = lambda e: Poly(e, *self.gens, domain=QQ)
        return P(rem), P(q1), P(q2)

    def reduce_item(self, it: Item, sign: int) -> Item:
        """Reduce an item's polynomial. Hypotheses (sign −1) keep poly = Σ comb·h; the target (sign
        +1) keeps goal = poly + Σ comb·h."""
        rem, q1, q2 = self.reduce(it.poly)
        if q1.is_zero and q2.is_zero:
            return it
        comb = add_comb(it.comb, self.r1.comb, sign * q1)
        comb = add_comb(comb, self.r2.comb, sign * q2)
        return Item(rem, comb)

    def inverse(self, a: Poly) -> tuple[Poly, Poly, Poly] | None:
        """w, mu1, mu2 with a * w - 1 = mu1 * R1 + mu2 * R2, or None (a is zero in the field)."""
        a, _, _ = self.reduce(a)
        if a.is_zero:
            return None
        basis = [self.s**i * self.c**j for i in range(2) for j in range(self.k)]
        ys = sympy.symbols(f"y0:{len(basis)}")
        w_expr = sum(y * b for y, b in zip(ys, basis))
        prod = sympy.expand(a.as_expr() * w_expr)
        _, rem = sympy.reduced(prod, [self.r1.poly.as_expr(), self.r2.poly.as_expr()], self.s, self.c, *ys, order="lex")
        rp = Poly(rem, self.s, self.c)
        eqs = []
        for i in range(2):
            for j in range(self.k):
                coeff = rp.coeff_monomial(self.s**i * self.c**j)
                eqs.append(coeff - (1 if (i, j) == (0, 0) else 0))
        sol = sympy.linsolve(eqs, ys)
        if not sol:
            return None
        vals = list(sol)[0]
        if any(v.free_symbols for v in vals):
            return None
        w = Poly(sum(v * b for v, b in zip(vals, basis)), *self.gens, domain=QQ)
        rem2, mu1, mu2 = self.reduce(a * w - Poly(1, *self.gens, domain=QQ))
        if not rem2.is_zero:
            return None
        return w, mu1, mu2


def shrink_field(comb: dict[str, Poly], originals: dict[str, Poly], field: Field) -> dict[str, Poly]:
    """Each cofactor reduced modulo R1, R2: c_j = r_j + q1 R1 + q2 R2 gives c_j h_j = r_j h_j +
    (q1 h_j) R1 + (q2 h_j) R2, so the excess moves to the relations' cofactors (a much smaller
    `linear_combination` for Lean's `ring`)."""
    r1 = next(iter(field.r1.comb))
    r2 = next(iter(field.r2.comb))
    out = dict(comb)
    zero = Poly(0, *field.gens, domain=QQ)
    for k in list(out):
        if k in (r1, r2):
            continue
        rem, q1, q2 = field.reduce(out[k])
        if q1.is_zero and q2.is_zero:
            continue
        out[k] = rem
        out[r1] = out.get(r1, zero) + q1 * originals[k]
        out[r2] = out.get(r2, zero) + q2 * originals[k]
    # the relations' own cofactors: R1's modulo R2 (moved to R2's), then R2's modulo R1 by s only
    return out


def field_linear_var(p: Poly, field: Field) -> tuple[int, Poly, Poly] | None:
    """A variable (not c, s) p is linear in, with a coefficient a in the field (not constant) and
    the rest free of it: (v, a, rest)."""
    gens = p.gens
    best = None
    for v in range(len(gens)):
        if v in (field.ci, field.si) or p.degree(gens[v]) != 1:
            continue
        x = gens[v]
        a = Poly(sympy.expand(p.as_expr()).coeff(x, 1), *gens, domain=QQ)
        if a.is_zero or a.total_degree() == 0 or not field.only_field(a):
            continue
        rest = p - a * Poly(x, *gens, domain=QQ)
        if rest.degree(x) > 0:
            continue
        size = len(rest.terms())
        if best is None or size < best[3]:
            best = (v, a, rest, size)
    return None if best is None else best[:3]


def attempt(goal: Poly, items: list[Item], max_extra: int, max_unknowns: int, member_only: bool = False, field: Field | None = None):
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

    def field_reduce_all():
        nonlocal work, target
        if field is None:
            return
        work = [field.reduce_item(it, -1) if it not in (field.r1, field.r2) else it for it in work]
        work = [it for it in work if not it.poly.is_zero or it in (field.r1, field.r2)]
        t = field.reduce_item(target, 1)
        target.poly, target.comb = t.poly, t.comb

    if field is not None:
        # the field relations stay as they are (they are the Items the reductions refer to)
        work = [it for it in work if not (it.comb.keys() == field.r1.comb.keys() or it.comb.keys() == field.r2.comb.keys())]
        work += [field.r1, field.r2]
        field_reduce_all()

    for _ in range(200):
        changed = False
        # the substitution of lowest degree first (in the variables other than the field's): a
        # coordinate from an angle equation, not from a length relation d² = …, which would make
        # everything quartic
        best = None
        for it in work:
            if field is not None and (it in (field.r1, field.r2) or field.only_field(it.poly)):
                continue
            skip = set() if field is None else {field.ci, field.si}
            v = linear_var(it.poly, skip)
            if v is None:
                continue
            key = (rest_degree(it.poly, v, skip), len(it.poly.terms()))
            if best is None or key < best[0]:
                best = (key, it, v)
        if best is not None and (field is None or best[0][0] <= 1 or not field_candidates_lower(work, field, best[0][0])):
            reduce_all(best[1], divide_linear, best[2], keep_rule=False)
            field_reduce_all()
            continue
        for it in work:
            if field is not None and (it in (field.r1, field.r2) or field.only_field(it.poly)):
                continue  # the field's own reduction handles c and s
            v = square_var(it.poly)
            if v is not None and (any(o is not it and o.poly.degree(gens[v]) >= 2 for o in work) or target.poly.degree(gens[v]) >= 2):
                reduce_all(it, divide_square, v, keep_rule=True)
                changed = True
                break
        if changed:
            field_reduce_all()
            continue
        if field is not None:
            cands = []
            for it in work:
                if it in (field.r1, field.r2):
                    continue
                found = field_linear_var(it.poly, field)
                if found is not None:
                    cands.append(((rest_degree(it.poly, found[0], {field.ci, field.si}), len(it.poly.terms())), it, found))
            cands.sort(key=lambda x: x[0])
            for _key, it, found in cands:
                v, a, rest = found
                inv = field.inverse(a)
                if inv is None:
                    continue
                w, mu1, mu2 = inv
                x = Poly(gens[v], *gens, domain=QQ)
                sub = (-(w * rest)).as_expr()
                divisor = x + w * rest

                def substitute(q: Poly) -> tuple[Poly, Poly] | None:
                    # q = rem + Q * (x + w rest), and x + w rest = w * p - x * (mu1 R1 + mu2 R2)
                    if q.degree(gens[v]) <= 0:
                        return None
                    rem = Poly(sympy.expand(q.as_expr().subs(gens[v], sub)), *gens, domain=QQ)
                    Q = (q - rem).exquo(divisor)
                    return rem, Q

                nxt = []
                for o in work:
                    if o is it:
                        continue
                    r = substitute(o.poly)
                    if r is None:
                        nxt.append(o)
                        continue
                    rem, Q = r
                    comb = add_comb(o.comb, it.comb, -(Q * w))
                    comb = add_comb(comb, field.r1.comb, Q * x * mu1)
                    comb = add_comb(comb, field.r2.comb, Q * x * mu2)
                    if not rem.is_zero or o in (field.r1, field.r2):
                        nxt.append(Item(rem, comb))
                work = nxt
                r = substitute(target.poly)
                if r is not None:
                    rem, Q = r
                    comb = add_comb(target.comb, it.comb, Q * w)
                    comb = add_comb(comb, field.r1.comb, -(Q * x * mu1))
                    comb = add_comb(comb, field.r2.comb, -(Q * x * mu2))
                    target.poly, target.comb = rem, comb
                field_reduce_all()
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


def field_chain(goal: Poly, items: list[Item], field: Field, originals: dict[str, Poly], deadline_steps: int = 80):
    """The angle mode's certificate as a chain: each unknown fixed linearly by a hypothesis (a
    constant coefficient, or a trig value inverted in the field) becomes a fact `v = e` proved from
    the hypotheses and the earlier facts; the goal is then a combination of those facts and the
    field relations. Every combination stays small (a direct certificate was 270 000 characters).
    Returns (steps, coefficients) or None; steps are (name, var, expr, comb)."""
    gens = goal.gens
    one = Poly(1, *gens, domain=QQ)
    r1n, r2n = next(iter(field.r1.comb)), next(iter(field.r2.comb))
    work = [Item(it.poly, dict(it.comb)) for it in items if not it.poly.is_zero and next(iter(it.comb)) not in (r1n, r2n)]
    target = Item(goal, {})

    def red(it: Item, sign: int) -> Item:
        return field.reduce_item(it, sign)

    work = [red(it, -1) for it in work]
    work = [it for it in work if not it.poly.is_zero]
    target = red(target, 1)
    steps: list[tuple[str, int, Poly, dict[str, Poly]]] = []
    basis = dict(originals)
    for n in range(deadline_steps):
        if target.poly.is_zero:
            return steps, target.comb
        skip = {field.ci, field.si}
        cands = []
        for it in work:
            if field.only_field(it.poly):
                continue
            v = linear_var(it.poly, skip)
            if v is not None:
                a = it.poly.coeff_monomial(gens[v])
                rest = it.poly - Poly(a * gens[v], *gens, domain=QQ)
                cands.append(((rest_degree(it.poly, v, skip), 0, len(it.poly.terms())), it, v, Poly(a, *gens, domain=QQ), rest))
            f = field_linear_var(it.poly, field)
            if f is not None:
                cands.append(((rest_degree(it.poly, f[0], skip), 1, len(it.poly.terms())), it, f[0], f[1], f[2]))
        if not cands:
            return None
        cands.sort(key=lambda c: c[0])
        made = None
        for _key, it, v, a, rest in cands:
            x = Poly(gens[v], *gens, domain=QQ)
            if a.total_degree() == 0:
                c = a.coeff_monomial(1)
                e = rest * (Rational(-1) / c)
                comb = {k: q * (Rational(1) / c) for k, q in it.comb.items()}  # v − e = p / a
            else:
                inv = field.inverse(a)
                if inv is None:
                    continue
                w, mu1, mu2 = inv
                e = -(w * rest)
                # v − e = w·p − v·(a·w − 1) = w·p − v·(mu1 R1 + mu2 R2)
                comb = add_comb({}, it.comb, w)
                comb = add_comb(comb, field.r1.comb, -(x * mu1))
                comb = add_comb(comb, field.r2.comb, -(x * mu2))
            e_red, q1, q2 = field.reduce(e)
            # v − e_red = (v − e) + q1 R1 + q2 R2
            comb = add_comb(comb, field.r1.comb, q1)
            comb = add_comb(comb, field.r2.comb, q2)
            made = (it, v, e_red, comb)
            break
        if made is None:
            return None
        it, v, e, comb = made
        name = f"s{len(steps)}"
        steps.append((name, v, e, comb))
        sfact = Poly(gens[v], *gens, domain=QQ) - e
        basis[name] = sfact
        sitem = {name: one}
        divisor = sfact

        def substitute(q: Poly):
            if q.degree(gens[v]) <= 0:
                return None
            rem = Poly(sympy.expand(q.as_expr().subs(gens[v], e.as_expr())), *gens, domain=QQ)
            return rem, (q - rem).exquo(divisor)

        nxt = []
        for o in work:
            if o is it:
                continue
            r = substitute(o.poly)
            if r is None:
                nxt.append(o)
                continue
            rem, Q = r
            o2 = red(Item(rem, add_comb(o.comb, sitem, -Q)), -1)
            if not o2.poly.is_zero:
                nxt.append(o2)
        work = nxt
        r = substitute(target.poly)
        if r is not None:
            rem, Q = r
            target = red(Item(rem, add_comb(target.comb, sitem, Q)), 1)
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
    try:
        max_extra = max(0, min(MAX_EXTRA_DEGREE, int(req.get("max_extra_degree", 2))))
        max_unknowns = max(1, min(MAX_UNKNOWNS, int(req.get("max_unknowns", 3000))))
    except (TypeError, ValueError):
        raise CertError("max_extra_degree / max_unknowns must be integers")

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

    field = None
    fspec = req.get("field")
    if fspec is not None:
        if not isinstance(fspec, dict) or fspec.get("c") not in index or fspec.get("s") not in index:
            raise CertError("field: c and s must be variables")
        byname = {next(iter(it.comb)): it for it in items}
        r1, r2 = byname.get(fspec.get("r1")), byname.get(fspec.get("r2"))
        if r1 is None or r2 is None:
            raise CertError("field: r1 and r2 must be hypotheses")
        field = Field(gens, index[fspec["c"]], index[fspec["s"]], r1, r2)

    if field is not None:
        chained = field_chain(goal, items, field, originals)
        if chained is not None:
            steps, comb = chained
            basis = dict(originals)
            ok = True
            for name, v, e, c in steps:
                rest = Poly(gens[v], *gens, domain=QQ) - e
                for k, q in c.items():
                    rest -= q * basis[k]
                if not rest.is_zero:
                    ok = False
                    break
                basis[name] = Poly(gens[v], *gens, domain=QQ) - e
            if ok:
                rest = goal
                for k, q in comb.items():
                    rest -= q * basis[k]
                ok = rest.is_zero
            if ok:
                return {
                    "ok": True,
                    "multiplier": [],
                    "steps": [{"name": n, "var": names[v], "expr": from_poly(e, names), "coefficients": {k: from_poly(q, names) for k, q in c.items() if not q.is_zero}} for n, v, e, c in steps],
                    "coefficients": {k: from_poly(q, names) for k, q in comb.items() if not q.is_zero},
                }

    def member(choice) -> bool:
        return bool(attempt(product(choice) * goal, items, max_extra, max_unknowns, member_only=True, field=field))

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
    comb = attempt(m * goal, items, max_extra, max_unknowns, field=field)
    if comb is not None and field is not None:
        comb = shrink_field(comb, originals, field)
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


# ── Numeric points (for refuting a statement) ────────────────────────────────


def _sparse_terms(sparse: Any, index: dict[str, int]) -> list[tuple[Any, list[tuple[int, int]]]]:
    import mpmath

    if not isinstance(sparse, list) or len(sparse) > MAX_TERMS:
        raise CertError("a polynomial must be a list of at most %d terms" % MAX_TERMS)
    out = []
    for term in sparse:
        if not (isinstance(term, list) and len(term) == 2 and isinstance(term[1], dict)):
            raise CertError("a term is [coefficient, {variable: exponent}]")
        try:
            c = Fraction(str(term[0]))
        except (ValueError, ZeroDivisionError):
            raise CertError(f"bad coefficient {term[0]!r}")
        mono = []
        for v, e in term[1].items():
            if v not in index or not isinstance(e, int) or e < 0 or e > 64:
                raise CertError(f"bad monomial {term[1]!r}")
            mono.append((index[v], e))
        out.append((mpmath.mpf(c.numerator) / c.denominator, mono))
    return out


def _eval(terms, x):
    total = 0
    for c, mono in terms:
        t = c
        for i, e in mono:
            t *= x[i] ** e
        total += t
    return total


def _grad(terms, x, n):
    g = [0] * n
    for c, mono in terms:
        for k, (i, e) in enumerate(mono):
            t = c * e * x[i] ** (e - 1)
            for j, (i2, e2) in enumerate(mono):
                if j != k:
                    t *= x[i2] ** e2
            g[i] += t
    return g


def numeric_points(req: dict) -> dict:
    """
    Points where every equation is zero and every inequality holds, found by damped Gauss–Newton
    (minimum-norm steps, so an underdetermined system lands somewhere on its solution set) from
    random starts, refined at 40 digits. `fixed` gives known values (numeric atoms such as
    cos(π/9)). The caller checks each point against the original statement; this only proposes.
    """
    import random

    import mpmath

    names = req.get("vars")
    if not isinstance(names, list) or not names or len(names) > MAX_VARS or not all(isinstance(n, str) and NAME.match(n) for n in names):
        raise CertError("vars: a list of plain identifiers")
    index = {n: i for i, n in enumerate(names)}
    mpmath.mp.dps = 40
    fixed: dict[int, Any] = {}
    for k, v in (req.get("fixed") or {}).items():
        if k not in index:
            raise CertError(f"unknown fixed variable {k}")
        try:
            fixed[index[k]] = mpmath.mpf(str(v))
        except (ValueError, TypeError):
            raise CertError(f"bad value for {k}")
    eqs = [_sparse_terms(e, index) for e in (req.get("equations") or [])][:200]
    ineqs = []
    for q in (req.get("inequalities") or [])[:200]:
        if not isinstance(q, dict) or q.get("rel") not in (">", ">=", "!="):
            raise CertError("an inequality is {poly, rel: '>' | '>=' | '!='}")
        ineqs.append((_sparse_terms(q.get("poly"), index), q["rel"]))
    if not eqs:
        return {"ok": True, "points": []}
    n = len(names)
    free = [i for i in range(n) if i not in fixed]
    trials = max(1, min(200, int(req.get("trials", 30))))
    rng = random.Random(int(req.get("seed", 1)))
    points: list[list[Any]] = []

    def residual(x):
        return [_eval(e, x) for e in eqs]

    for _ in range(trials):
        x = [fixed[i] if i in fixed else mpmath.mpf(rng.uniform(-3, 3)) for i in range(n)]
        lam = mpmath.mpf("1e-3")
        r = residual(x)
        norm = sum(v * v for v in r)
        for _it in range(200):
            if norm < mpmath.mpf("1e-60"):
                break
            J = [[g[i] for i in free] for g in (_grad(e, x, n) for e in eqs)]
            m = len(eqs)
            k = len(free)
            if k == 0:
                break
            # minimum-norm damped step: δ = -Jᵀ (J Jᵀ + λI)⁻¹ r
            A = mpmath.matrix(m, m)
            for a in range(m):
                for b in range(m):
                    A[a, b] = sum(J[a][t] * J[b][t] for t in range(k)) + (lam if a == b else 0)
            try:
                y = mpmath.lu_solve(A, mpmath.matrix([-v for v in r]))
            except ZeroDivisionError:
                lam *= 10
                continue
            step = [sum(J[a][t] * y[a] for a in range(m)) for t in range(k)]
            trial = list(x)
            for t, i in enumerate(free):
                trial[i] = x[i] + step[t]
            r2 = residual(trial)
            n2 = sum(v * v for v in r2)
            if n2 < norm:
                x, r, norm = trial, r2, n2
                lam = max(lam / 10, mpmath.mpf("1e-30"))
            else:
                lam *= 10
                if lam > 1e12:
                    break
        if norm > mpmath.mpf("1e-50"):
            continue
        ok = True
        for terms, rel in ineqs:
            v = _eval(terms, x)
            if (rel == ">" and not v > mpmath.mpf("1e-20")) or (rel == ">=" and not v > mpmath.mpf("-1e-20")) or (rel == "!=" and not abs(v) > mpmath.mpf("1e-12")):
                ok = False
                break
        if not ok:
            continue
        if any(max(abs(a - b) for a, b in zip(p, x)) < mpmath.mpf("1e-12") for p in points):
            continue
        points.append(x)
        if len(points) >= 8:
            break
    return {"ok": True, "points": [{names[i]: mpmath.nstr(v, 25) for i, v in enumerate(p)} for p in points]}


def dispatch(req: dict) -> dict:
    return numeric_points(req) if req.get("mode") == "points" else certificate(req)


def request_timeout(req: Any, default: float = 30.0) -> float:
    try:
        t = float(req.get("timeout", default)) if isinstance(req, dict) else default
    except (TypeError, ValueError):
        t = default
    return max(1.0, min(MAX_TIMEOUT, t))


def certificate_or_reason(req: Any) -> dict:
    """For a caller that already runs under a time limit (the compute server)."""
    if not isinstance(req, dict):
        return {"ok": False, "reason": "request must be a JSON object"}
    try:
        return dispatch(req)
    except CertError as e:
        return {"ok": False, "reason": str(e)}


def handle(req: Any, timeout: float = 30.0) -> dict:
    if not isinstance(req, dict):
        return {"ok": False, "reason": "request must be a JSON object"}
    try:
        with time_limit(request_timeout(req, timeout)):
            return dispatch(req)
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
