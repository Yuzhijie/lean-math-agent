#!/usr/bin/env python3
"""
Polynomial and rational inequalities that are sums of AM–GM steps between two monomials, for
lib/lean/inequality/squares.ts (JSON on stdin, JSON on stdout).

Input: {"vars": n, "signs": ["pos" | "nonneg" | "free", ...], "timeout": seconds,
        "parts": [{"lhs": expr, "rhs": expr, "targets"?: [[u, v], ...]}, ...]}
  each part asks for lhs − rhs ≥ 0; with "targets" also for: lhs = rhs exactly when x_u = x_v for
  every pair (an equality case, all variables positive)
  expr = ["num", "p/q"] | ["var", i] | ["neg", e] | ["+" | "-" | "*" | "/", e, e] | ["^", e, n]
       | ["base", id, e]      — e itself (the tag of scripts/sym_inequality.py's caller)

Output: {"parts": [part, ...]}
  part = {"ok": false, "why": "...", "false_at"?: ["p/q", ...]}   — false_at: lhs − rhs < 0 there
       | {"ok": true,
          "den_const": "p/q", "den": [{"poly": sparse, "exp": e}],      lhs − rhs = N / (den_const · Π den^exp)
          "N": sparse, "mult": k,
          "terms": [{"c": "p/q", "mu": exps, "a": exps, "b": exps}],    (Σ x_i)^k · N = Σ c · x^mu · (x^a − x^b)² + Σ rest
          "rest": [["p/q", exps], ...],                                 monomials with a positive coefficient
          "equal"?: {"ok": false, "why": "..."}
                  | {"ok": true,
                     "uses": [k, ...],                                  the terms whose x^a = x^b are needed
                     "targets": [{"u": i, "v": j, "n": n, "w": exps,    x^w · x_u^n − x^w · x_v^n = Σ cof · (x^a − x^b)
                                  "cof": [[k, sparse], ...]}],
                     "back": [sparse, ...]}}                            N = Σ back_i · (x_u − x_v) over the targets
  sparse = [[coef "p/q", {"v0": exp, ...}], ...]; exps = {"v0": exp, ...}   (lib/lean/geometry/poly.ts)

How: lhs − rhs as one fraction N / Den, every factor of Den without a negative coefficient (so the
variables in it must be positive). N ≥ 0 is looked for as a combination, with coefficients ≥ 0, of
    x^P + x^Q − 2·x^((P+Q)/2) = x^mu · (x^a − x^b)²      (P ≡ Q mod 2; mu = min(P, Q), a = (P − mu)/2)
and of monomials — a linear program over ℚ, solved exactly (a simplex of its own: no solver is
assumed on the machine; for an N that a permutation of the variables leaves unchanged the
unknowns are orbits, which is what makes degree 12 in three variables a matter of seconds). x^mu and the monomials must be ≥ 0: even exponents for a variable without
a sign. Squares alone are tried first: an equality case needs a form without monomials left over.
When N is no such combination, (x_1 + … + x_n)^k · N is tried for k = 1, 2 (all variables positive).
The equality case: N = 0 makes every term 0, so x^a = x^b for each; the exponent differences a − b
generate n·(e_u − e_v) for some n ≥ 1 exactly when these equalities force x_u = x_v on positive
numbers, and the same combination, written as a product, gives x^w·x_u^n = x^w·x_v^n with
polynomial cofactors (a telescoping sum).
Nothing here is trusted: the proof built from it is checked by Lean.
"""
import itertools
import json
import signal
import sys
import time
from fractions import Fraction

import sympy as sp

MAX_MONOMIALS = 140
MAX_PAIRS = 2600
MAX_POWER = 6
MAX_MULTIPLIER = 2


class Refused(Exception):
    pass


def build(e, X):
    tag = e[0]
    if tag == "base":
        return build(e[2], X)
    if tag == "num":
        return sp.Rational(e[1])
    if tag == "var":
        return X[int(e[1])]
    if tag == "neg":
        return -build(e[1], X)
    if tag == "^":
        n = int(e[2])
        if n < 0 or n > 12:
            raise Refused("exponent")
        return build(e[1], X) ** n
    a, b = build(e[1], X), build(e[2], X)
    if tag == "+":
        return a + b
    if tag == "-":
        return a - b
    if tag == "*":
        return a * b
    if tag == "/":
        return a / b
    raise Refused(f"unknown node {tag}")


def exps(m):
    return {f"v{i}": int(k) for i, k in enumerate(m) if k}


def sparse(expr, X):
    p = sp.Poly(sp.expand(expr), *X)
    return [[str(sp.Rational(c)), exps(m)] for m, c in p.terms()]


def no_negative_coefficient(expr, X):
    return all(c >= 0 for c in sp.Poly(sp.expand(expr), *X).coeffs())


def monomial(m, X):
    out = sp.Integer(1)
    for x, k in zip(X, m):
        out *= x**k
    return out


# ── a linear program over ℚ ───────────────────────────────────────────


def simplex(columns, rhs, cost, deadline):
    """
    min cost·x with Σ_j x_j·columns[j] = rhs, x ≥ 0 — columns as {row: Fraction}. Returns x (a list
    of Fractions) or None when there is no solution. Two phases on a dense tableau; the entering
    column by the most negative reduced cost, by the lowest index (Bland) once the objective stalls.
    """
    m, n = len(rhs), len(columns)
    zero, one = Fraction(0), Fraction(1)
    rows = [[zero] * (n + m + 1) for _ in range(m)]
    for j, col in enumerate(columns):
        for i, v in col.items():
            rows[i][j] = v
    for i in range(m):
        rows[i][-1] = rhs[i]
        if rhs[i] < 0:
            rows[i] = [-v for v in rows[i]]
        rows[i][n + i] = one
    basis = [n + i for i in range(m)]

    def run(objective, allowed):
        # reduced costs for the current basis
        z = list(objective) + [zero]
        for i, b in enumerate(basis):
            if z[b] != 0:
                f = z[b]
                z = [zv - f * rv for zv, rv in zip(z, rows[i])]
        stalled = 0
        while True:
            if time.time() > deadline:
                raise Refused("the search for the squares ran out of time")
            if stalled > 40:
                enter = next((j for j in range(allowed) if z[j] < 0), None)
            else:
                enter, best = None, zero
                for j in range(allowed):
                    if z[j] < best:
                        enter, best = j, z[j]
            if enter is None:
                return -z[-1]
            leave, ratio = None, None
            for i in range(m):
                a = rows[i][enter]
                if a > 0:
                    r = rows[i][-1] / a
                    if ratio is None or r < ratio or (r == ratio and basis[i] < basis[leave]):
                        leave, ratio = i, r
            if leave is None:
                raise Refused("unbounded")  # cannot happen: the costs are ≥ 0
            stalled = stalled + 1 if ratio == 0 else 0
            pivot(leave, enter)
            f = z[enter]
            if f != 0:
                z = [zv - f * rv for zv, rv in zip(z, rows[leave])]

    def pivot(i, j):
        p = rows[i][j]
        if p != 1:
            rows[i] = [v / p for v in rows[i]]
        ri = rows[i]
        for k in range(m):
            if k != i:
                f = rows[k][j]
                if f != 0:
                    rows[k] = [v - f * w if w != 0 else v for v, w in zip(rows[k], ri)]
        basis[i] = j

    # phase 1: the artificial columns out of the solution
    if run([zero] * n + [one] * m, n + m) != 0:
        return None
    for i in range(m):
        if basis[i] >= n:
            j = next((j for j in range(n) if rows[i][j] != 0), None)
            if j is not None:
                pivot(i, j)  # the row's value is 0: the solution does not change
    # phase 2
    run(list(cost) + [zero] * m, n)
    x = [zero] * n
    for i, b in enumerate(basis):
        if b < n:
            x[b] = rows[i][-1]
    return x


# ── N as squares ──────────────────────────────────────────────────────


def symmetries(support, signs):
    """The permutations of the variables that leave N and the variables' signs as they are (a group)."""
    nv = len(signs)
    found = []
    for perm in itertools.permutations(range(nv)):
        if any(signs[perm[i]] != signs[i] for i in range(nv)):
            continue
        if all(support.get(tuple(m[perm[i]] for i in range(nv))) == c for m, c in support.items()):
            found.append(perm)
    return found


def squares(N, X, signs, deadline):
    """N = Σ c·x^mu·(x^a − x^b)² + Σ d·x^R with c, d > 0 — (terms, rest) or None."""
    poly = sp.Poly(N, *X)
    support = {m: Fraction(int(c.p), int(c.q)) for m, c in ((m, sp.Rational(c)) for m, c in poly.terms())}
    nv = len(X)
    lo = [min(m[i] for m in support) for i in range(nv)]
    hi = [max(m[i] for m in support) for i in range(nv)]
    dmin, dmax = min(sum(m) for m in support), max(sum(m) for m in support)
    points = [m for m in itertools.product(*[range(lo[i], hi[i] + 1) for i in range(nv)]) if dmin <= sum(m) <= dmax]
    if len(points) > MAX_MONOMIALS:
        raise Refused("too many monomials")
    free = [i for i in range(nv) if signs[i] == "free"]
    usable = [m for m in points if all(m[i] % 2 == 0 for i in free)]  # ≥ 0 as a monomial
    by_parity = {}
    for m in usable:
        by_parity.setdefault(tuple(k % 2 for k in m), []).append(m)
    pairs = [(p, q) for group in by_parity.values() for p, q in itertools.combinations(group, 2)]
    if len(pairs) > MAX_PAIRS:
        raise Refused("too many pairs of monomials")
    # N symmetric (or cyclic): a form with the same symmetry exists whenever one does, so the
    # unknowns are the orbits of the pairs and the equations the orbits of the monomials —
    # a sixth of both for a symmetric N in three variables
    group = symmetries(support, signs)
    act = lambda perm, m: tuple(m[perm[i]] for i in range(nv))
    point_rep = {m: min(act(g, m) for g in group) for m in points}
    reps = sorted(set(point_rep.values()))
    row = {m: i for i, m in enumerate(reps)}
    pair_orbits = {}
    for p, q in pairs:
        key = min(tuple(sorted((act(g, p), act(g, q)))) for g in group)
        pair_orbits.setdefault(key, []).append((p, q))
    rest_orbits = {}
    for m in usable:
        rest_orbits.setdefault(point_rep[m], []).append(m)
    one, two, zero = Fraction(1), Fraction(2), Fraction(0)
    orbit_list = list(pair_orbits.values())
    columns = []
    for orbit in orbit_list:
        col = {}
        for p, q in orbit:
            mid = tuple((a + b) // 2 for a, b in zip(p, q))
            for m, v in ((p, one), (q, one), (mid, -two)):
                if m in row:
                    col[row[m]] = col.get(row[m], zero) + v
        columns.append({i: v for i, v in col.items() if v != 0})
    rest_list = list(rest_orbits.values())
    rest_columns = [{row[point_rep[orbit[0]]]: one} for orbit in rest_list]
    rhs = [support.get(m, zero) for m in reps]
    # squares alone first (an equality case needs that), with the least total weight;
    # else with monomials left over, as little of them as possible
    x = simplex(columns, rhs, [Fraction(len(o)) for o in orbit_list], deadline)
    if x is not None:
        x = x + [zero] * len(rest_list)
    else:
        x = simplex(columns + rest_columns, rhs, [zero] * len(orbit_list) + [Fraction(len(o)) for o in rest_list], deadline)
    if x is None:
        return None
    terms = []
    for orbit, c in zip(orbit_list, x):
        if c > 0:
            for p, q in orbit:
                mu = tuple(min(a, b) for a, b in zip(p, q))
                terms.append({"c": c, "mu": mu, "a": tuple((k - l) // 2 for k, l in zip(p, mu)), "b": tuple((k - l) // 2 for k, l in zip(q, mu))})
    rest = [(c, m) for orbit, c in zip(rest_list, x[len(orbit_list):]) if c > 0 for m in orbit]
    return terms, rest


# ── the equality case ─────────────────────────────────────────────────


def combination(deltas, target):
    """Integers t (by term index) and n ≥ 1 with Σ t_k·δ_k = n·target, small ones; or None."""
    nv = len(target)
    best = None
    ids = list(range(len(deltas)))[:14]
    for size in range(1, min(nv, len(ids)) + 1):
        for subset in itertools.combinations(ids, size):
            A = sp.Matrix([[deltas[k][i] for k in subset] for i in range(nv)])
            if A.rank() < size:
                continue
            try:
                sol = A.gauss_jordan_solve(sp.Matrix(target))[0]
            except ValueError:
                continue
            ts = [sp.Rational(v) for v in sol]
            if any(t == 0 for t in ts):
                continue
            n = sp.ilcm(1, *[t.q for t in ts])
            ints = [int(t * n) for t in ts]
            weight = (int(n), sum(abs(t) for t in ints))
            if n <= MAX_POWER and all(abs(t) <= MAX_POWER for t in ints) and (best is None or weight < best[0]):
                best = (weight, dict(zip(subset, ints)), int(n))
        if best:
            break
    return (best[1], best[2]) if best else None


def equal_case(N, terms, rest, targets, X, signs):
    if rest:
        return {"ok": False, "why": "the difference is positive for all positive values: the two sides are never equal"}
    if any(s != "pos" for s in signs):
        return {"ok": False, "why": "an equality case needs every variable positive"}
    nv = len(X)
    deltas = [tuple(a - b for a, b in zip(t["a"], t["b"])) for t in terms]
    uses, out = set(), []
    for u, v in targets:
        want = [0] * nv
        want[u], want[v] = 1, -1
        found = combination(deltas, want)
        if not found:
            return {"ok": False, "why": f"the squares being 0 does not give x{u} = x{v}"}
        ts, n = found
        order = sorted(ts)
        # A_k = B_k for each used term, oriented so that Π A^|t| / Π B^|t| = (x_u / x_v)^n
        A = {k: monomial(terms[k]["a"] if ts[k] > 0 else terms[k]["b"], X) for k in order}
        B = {k: monomial(terms[k]["b"] if ts[k] > 0 else terms[k]["a"], X) for k in order}
        cof = {}
        for pos, k in enumerate(order):
            t = abs(ts[k])
            before = sp.prod([B[l] ** abs(ts[l]) for l in order[:pos]])
            after = sp.prod([A[l] ** abs(ts[l]) for l in order[pos + 1 :]])
            geometric = sum(A[k] ** s * B[k] ** (t - 1 - s) for s in range(t))
            cof[k] = sp.expand((1 if ts[k] > 0 else -1) * before * after * geometric)
        whole = sp.Poly(sp.prod([A[k] ** abs(ts[k]) for k in order]), *X).monoms()[0]
        w = tuple(e - (n if i == u else 0) for i, e in enumerate(whole))
        if any(e < 0 for e in w):
            return {"ok": False, "why": "no common factor"}
        W = monomial(w, X)
        check = W * X[u] ** n - W * X[v] ** n - sum(cof[k] * (monomial(terms[k]["a"], X) - monomial(terms[k]["b"], X)) for k in order)
        if sp.expand(check) != 0:
            return {"ok": False, "why": "the cofactors do not add up"}
        uses.update(order)
        out.append({"u": u, "v": v, "n": n, "w": exps(w), "cof": [[k, sparse(cof[k], X)] for k in order]})
    # back: N = Σ g_i·(x_u − x_v), one target after the other
    back, left = [], sp.expand(N)
    for u, v in targets:
        after = sp.expand(left.subs(X[u], X[v]))
        q, r = sp.div(sp.Poly(left - after, *X), sp.Poly(X[u] - X[v], *X))
        if not r.is_zero:
            return {"ok": False, "why": "no cofactor for the converse"}
        back.append(sparse(q.as_expr(), X))
        left = after
    if left != 0:
        return {"ok": False, "why": "the two sides differ when the variables are equal"}
    return {"ok": True, "uses": sorted(uses), "targets": out, "back": back}


# ── one part ──────────────────────────────────────────────────────────

GRID = [sp.Integer(1), sp.Integer(2), sp.Rational(1, 2), sp.Integer(3)]


def negative_point(num, X, signs):
    """A point with positive coordinates where the numerator is negative (the denominator is positive there)."""
    for values in itertools.product(GRID, repeat=len(X)):
        if num.subs(dict(zip(X, values))) < 0:
            return [str(v) for v in values]
    return None


def part(spec, X, signs, deadline):
    f = sp.together(build(spec["lhs"], X) - build(spec["rhs"], X))
    num, den = sp.fraction(sp.cancel(f))
    num, den = sp.expand(num), sp.expand(den)
    dc, dfs = sp.factor_list(den, *X)
    if dc < 0:
        dc, num = -dc, -num
    den_factors = []
    for fac, e in dfs:
        if not no_negative_coefficient(fac, X):
            fac = -fac
            if e % 2:
                num = -num
            if not no_negative_coefficient(fac, X):
                return {"ok": False, "why": "a denominator factor that may vanish for positive values"}
        if any(signs[i] != "pos" for i in range(len(X)) if sp.Poly(fac, *X).degree(X[i]) > 0):
            return {"ok": False, "why": "a denominator in a variable that is not known to be positive"}
        den_factors.append((fac, e))
    if num == 0:
        return {"ok": False, "why": "the two sides are equal"}
    if len(sp.Poly(num, *X).terms()) > MAX_MONOMIALS:
        return {"ok": False, "why": "too many terms"}
    bad = negative_point(num, X, signs)
    if bad:
        return {"ok": False, "why": "false at " + ", ".join(f"x{i} = {v}" for i, v in enumerate(bad)), "false_at": bad}
    # N itself, else N times a power of the sum of the variables (positive when all of them are):
    # a²c + ab² + bc² − 3abc is no combination of such squares, (a + b + c) times it is
    total = sum(X)
    found, mult = None, 0
    for mult in range(0, MAX_MULTIPLIER + 1 if all(s == "pos" for s in signs) else 1):
        found = squares(sp.expand(num * total**mult), X, signs, deadline)
        if found:
            break
    if not found:
        return {"ok": False, "why": "not a sum of AM–GM steps between two monomials"}
    terms, rest = found
    out = {
        "ok": True,
        "den_const": str(sp.Rational(dc)),
        "den": [{"poly": sparse(fac, X), "exp": int(e)} for fac, e in den_factors],
        "N": sparse(num, X),
        "mult": mult,
        "terms": [{"c": str(t["c"]), "mu": exps(t["mu"]), "a": exps(t["a"]), "b": exps(t["b"])} for t in terms],
        "rest": [[str(c), exps(m)] for c, m in rest],
    }
    if spec.get("targets") is not None:
        out["equal"] = equal_case(num, terms, rest, [tuple(t) for t in spec["targets"]], X, signs)
    return out


def main():
    signal.signal(signal.SIGALRM, lambda *_: sys.exit(3))
    data = json.load(sys.stdin)
    timeout = int(data.get("timeout", 40))
    signal.alarm(timeout + 5)
    n = int(data["vars"])
    signs = list(data.get("signs") or ["pos"] * n)
    X = sp.symbols(f"v0:{n}")
    started = time.time()
    out = []
    for k, spec in enumerate(data["parts"]):
        # what is left of the time, shared by the parts still to do
        deadline = time.time() + max(2.0, (started + timeout - time.time()) / (len(data["parts"]) - k))
        try:
            out.append(part(spec, X, signs, deadline))
        except Refused as e:
            out.append({"ok": False, "why": str(e)})
        except Exception as e:  # noqa: BLE001 — a part the helper cannot read is just not proved this way
            out.append({"ok": False, "why": f"{type(e).__name__}: {e}"})
    json.dump({"parts": out}, sys.stdout)


if __name__ == "__main__":
    main()
