#!/usr/bin/env python3
"""
Recomputes the answers of the held-out problem set (bench/heldout.json) independently of the
text: brute force, exact arithmetic, or numeric geometry — so that a wrong reference answer does
not get measured as a failure of the solver.

    python3 scripts/heldout_check.py [bench/heldout.json] [--values]

Every problem id has a function here. It returns
  - a number or Fraction (compared with the problem's `value`),
  - a list of numbers (compared with `values`, as a set),
  - True for a claim to prove (checked on small cases / random points; `value` absent),
  - ("theorem", n) for a value that rests on a named theorem this script does not re-derive.
Exits 1 when an answer disagrees or a problem has no check. `--values` prints what it computed.
"""
import itertools
import json
import math
import random
import sys
from fractions import Fraction
from math import comb, cos, factorial, gcd, pi, radians, sin, sqrt, tan


# ── helpers ──────────────────────────────────────────────────────────────────────────────────

def lcm(*xs):
    out = 1
    for x in xs:
        out = out * x // gcd(out, x)
    return out


def order(a, m):
    k, x = 1, a % m
    while x != 1:
        x = x * a % m
        k += 1
    return k


def is_prime(n):
    if n < 2:
        return False
    i = 2
    while i * i <= n:
        if n % i == 0:
            return False
        i += 1
    return True


def tau(n):
    return sum(1 for d in range(1, n + 1) if n % d == 0)


def phi(n):
    return sum(1 for k in range(1, n + 1) if gcd(k, n) == 1)


def is_square(n):
    r = math.isqrt(n)
    return r * r == n


def angle_deg(p, q, r):
    """Angle pqr at q, in degrees."""
    ux, uy = p[0] - q[0], p[1] - q[1]
    vx, vy = r[0] - q[0], r[1] - q[1]
    return math.degrees(math.acos((ux * vx + uy * vy) / (math.hypot(ux, uy) * math.hypot(vx, vy))))


def dist(p, q):
    return math.hypot(p[0] - q[0], p[1] - q[1])


def meet(p1, p2, p3, p4):
    """Intersection of lines p1p2 and p3p4."""
    x1, y1, x2, y2 = *p1, *p2
    x3, y3, x4, y4 = *p3, *p4
    d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    a, b = x1 * y2 - y1 * x2, x3 * y4 - y3 * x4
    return ((a * (x3 - x4) - (x1 - x2) * b) / d, (a * (y3 - y4) - (y1 - y2) * b) / d)


def triangle(c, a, b):
    """A = (0,0), B = (c,0), C with |BC| = a, |CA| = b (above the axis)."""
    x = (b * b + c * c - a * a) / (2 * c)
    return (0.0, 0.0), (float(c), 0.0), (x, sqrt(b * b - x * x))


def area(p, q, r):
    return abs((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])) / 2


def rnd_points(k, seed):
    g = random.Random(seed)
    return [(g.uniform(-5, 5), g.uniform(-5, 5)) for _ in range(k)]


CHECKS = {}


def check(pid):
    def deco(fn):
        CHECKS[pid] = fn
        return fn
    return deco


# ── number theory ────────────────────────────────────────────────────────────────────────────

@check("nt-01")
def _():
    return lcm(order(3, 7 ** 3), order(3, 11 ** 2))


@check("nt-02")
def _():
    return lcm(order(2, 5 ** 3 * 7 ** 2), order(5, 3 ** 5))


@check("nt-03")
def _():
    return gcd(2 ** 90 + 1, 2 ** 126 + 1)


@check("nt-04")
def _():
    n, e = 50 ** 343 - 1, 0
    while n % 7 == 0:
        n //= 7
        e += 1
    return e


@check("nt-05")
def _():
    return sum(n for n in range(1, 200001) if (n * n + 5 * n + 10) % (3 * n + 1) == 0)


@check("nt-06")
def _():
    return next(n for n in range(60, 100000, 60) if tau(n) == 30)


@check("nt-07")
def _():
    return (pow(7, 2026, 1000) + pow(11, 2026, 1000)) % 1000


@check("nt-08")
def _():
    hits = [n for n in range(1001, 1300) if n % 5 == 3 and n % 7 == 2 and n % 11 == 6]
    assert len(hits) == 1, hits
    return hits[0]


@check("nt-09")
def _():
    return next(n for n in range(4, 10000) if not is_prime(n) and pow(3, n - 1, n) == 1)


@check("nt-10")
def _():
    n = 2 ** 4 * 3 ** 2 * 7
    return sum(1 for x in range(n) if pow(x, 6, n) == 1)


@check("nt-11")
def _():
    return next(m for m in range(2, 2000) if (m * m - 1) % 1001 == 0)


@check("nt-12")
def _():
    g = 0
    for n in range(2, 80):
        g = gcd(g, n ** 13 - n)
    return g


@check("nt-13")
def _():
    return sum(1 for x in range(13, 12 + 144 + 1) if (12 * x) % (x - 12) == 0)


@check("nt-14")
def _():
    return sum(1 for x in range(-45, 46) for y in range(-45, 46) if x * x + y * y == 2025)


@check("nt-15")
def _():
    n, e = factorial(2026), 0
    while n % 10 == 0:
        n //= 10
        e += 1
    return e


@check("nt-16")
def _():
    return sum(n for n in range(1, 1000) if phi(n) == 12)


@check("nt-17")
def _():
    a = next(a for a in range(200) if (a + 1) % 2 == 0 and a % 3 == 0 and a % 5 == 0)
    b = next(b for b in range(200) if b % 2 == 0 and (b + 1) % 3 == 0 and b % 5 == 0)
    c = next(c for c in range(200) if c % 2 == 0 and c % 3 == 0 and (c + 1) % 5 == 0)
    return (a + 1) * (b + 1) * (c + 1)


@check("nt-18")
def _():
    return sum(n for n in range(100, 1000) if sum(int(d) ** 3 for d in str(n)) == n)


@check("nt-19")
def _():
    return sum(1 for n in range(1, 1001) if sum(map(int, str(n))) % 7 == 0)


@check("nt-20")
def _():
    return sum(1 for x in range(1, 101) if (x * x - 4) % 105 == 0)


@check("nt-21")
def _():
    return sum(1 for x in range(1, 300) if (2026 - 7 * x) > 0 and (2026 - 7 * x) % 11 == 0)


@check("nt-22")
def _():
    ok = {6 * a + 10 * b + 15 * c for a in range(40) for b in range(30) for c in range(20)}
    return max(n for n in range(1, 200) if n not in ok)


@check("nt-23")
def _():
    return all((n ** 5 - n) % 30 == 0 for n in range(1, 500))


@check("nt-24")
def _():
    return all((3 ** (2 * n + 1) + 2 ** (n + 2)) % 7 == 0 for n in range(1, 300))


@check("nt-25")
def _():
    return not any(is_square(3 * y * y + 2) for y in range(1, 200000))


@check("nt-26")
def _():
    return all((p * p - 1) % 24 == 0 for p in range(5, 20000) if is_prime(p))


@check("nt-27")
def _():
    return [p for p in range(2, 20000) if is_prime(p) and is_prime(p * p + 2)]


@check("nt-28")
def _():
    return [n for n in range(1, 400) if is_square(2 ** n + 65)]


@check("nt-29")
def _():
    return max(gcd(n * n + 1, (n + 1) ** 2 + 1) for n in range(1, 20000))


@check("nt-30")
def _():
    return next(n for n in range(1, 100) if factorial(n) % (2 ** 20 * 3 ** 10) == 0)


# ── combinatorics ────────────────────────────────────────────────────────────────────────────

@check("co-01")
def _():
    return sum(1 for s in itertools.combinations(range(1, 14), 4) if all(b - a >= 3 for a, b in zip(s, s[1:])) and sum(s) % 2 == 0)


@check("co-02")
def _():
    n, seen = 10, set()
    for s in itertools.combinations(range(n), 3):
        if any((b - a) % n in (1, n - 1) for a in s for b in s if a != b):
            continue
        images = []
        for k in range(n):
            images.append(tuple(sorted((x + k) % n for x in s)))
            images.append(tuple(sorted((k - x) % n for x in s)))
        seen.add(min(images))
    return len(seen)


@check("co-03")
def _():
    # A sits at seat 0 (rotations are the same arrangement); people 1..6 = B, C, D, E, F, G
    count = 0
    for p in itertools.permutations(range(1, 7)):
        seat = {0: 0}
        for s, who in enumerate(p, start=1):
            seat[who] = s
        adj = lambda x, y: (seat[x] - seat[y]) % 7 in (1, 6)
        if not adj(0, 1) and adj(2, 3):
            count += 1
    return count


@check("co-04")
def _():
    abc = 4
    ab, bc, ca = 12 - abc, 9 - abc, 10 - abc
    a, b, c = 28 - ab - ca - abc, 25 - ab - bc - abc, 20 - bc - ca - abc
    assert min(a, b, c, ab, bc, ca) >= 0 and a + b + c + ab + bc + ca + abc <= 50
    return ab + bc + ca


@check("co-05")
def _():
    best = None
    for abc in range(0, 21):
        for ab in range(0, 23):
            for ac in range(0, 23):
                for bc in range(0, 22):
                    a, b, c = 22 - abc - ab - ac, 21 - abc - ab - bc, 20 - abc - ac - bc
                    if min(a, b, c) < 0 or a + b + c + ab + ac + bc + abc > 30:
                        continue
                    best = abc if best is None else min(best, abc)
        if best is not None:
            return best
    return best


@check("co-06")
def _():
    return ("theorem", comb(8, 2))  # Erdős–Ko–Rado, n = 9 ≥ 2k = 6


@check("co-07")
def _():
    return ("theorem", comb(6, 3))  # Sperner


@check("co-08")
def _():
    # 1..5 = 甲乙丙丁戊; True = tells the truth
    sols = []
    for t in itertools.product([True, False], repeat=5):
        a, b, c, d, e = t
        says = [not b, a != d, (not b) or (not e), not e, a != c]
        if all(says[i] == t[i] for i in range(5)):
            sols.append(t)
    assert len(sols) == 1, sols
    return sum(i + 1 for i, x in enumerate(sols[0]) if x)


@check("co-09")
def _():
    cells = [(r, c) for r in range(3) for c in range(5)]
    return sum(1 for s in itertools.combinations(cells, 4) if all(abs(p[0] - q[0]) + abs(p[1] - q[1]) != 1 for p, q in itertools.combinations(s, 2)))


@check("co-10")
def _():
    return comb(7, 2)  # a student is exactly a pair of groups, and every pair has exactly one


@check("co-11")
def _():
    edges = list(itertools.combinations(range(5), 2))
    tri = list(itertools.combinations(range(5), 3))
    count = 0
    for col in itertools.product([0, 1], repeat=10):
        c = dict(zip(edges, col))
        if not any(c[(x, y)] == c[(x, z)] == c[(y, z)] for x, y, z in tri):
            count += 1
    return count


@check("co-12")
def _():
    sets = [m for m in range(1, 32) if bin(m).count("1") % 2 == 0]
    best = 1
    for mask in range(1, 1 << len(sets)):
        fam = [sets[i] for i in range(len(sets)) if mask >> i & 1]
        if len(fam) <= best:
            continue
        if all(bin(x & y).count("1") % 2 == 1 for x, y in itertools.combinations(fam, 2)):
            best = len(fam)
    return best


@check("co-13")
def _():
    return sum(1 for p in itertools.permutations(range(1, 7)) if abs(p.index(1) - p.index(2)) != 1 and p.index(3) < p.index(4))


@check("co-14")
def _():
    return sum(1 for p in itertools.permutations(range(6)) if sum(1 for i in range(6) if p[i] == i) == 2)


@check("co-15")
def _():
    return sum(1 for x in itertools.product(range(1, 9), repeat=4) if sum(x) == 20)


@check("co-16")
def _():
    ways = {(0, 0): 1}
    for x in range(6):
        for y in range(6):
            if (x, y) == (0, 0):
                continue
            if y > x or (x, y) == (3, 3):
                ways[(x, y)] = 0
                continue
            ways[(x, y)] = ways.get((x - 1, y), 0) + ways.get((x, y - 1), 0)
    return ways[(5, 5)]


@check("co-17")
def _():
    return sum(1 for c in itertools.product(range(4), repeat=5) if all(c[i] != c[(i + 1) % 5] for i in range(5)))


@check("co-18")
def _():
    seen = set()
    for c in itertools.product(range(3), repeat=6):
        seen.add(min(c[k:] + c[:k] for k in range(6)))
    return len(seen)


@check("co-19")
def _():
    return sum(1 for n in range(1, 1001) if n % 3 and n % 5 and n % 7)


@check("co-20")
def _():
    return sum(1 for f in itertools.product(range(3), repeat=7) if len(set(f)) == 3)


@check("co-21")
def _():
    def parts(n, largest):
        if n == 0:
            return 1
        return sum(parts(n - k, k) for k in range(1, min(n, largest) + 1, 2))
    return parts(10, 10)


@check("co-22")
def _():
    return all(any(b % a == 0 for a, b in itertools.combinations(s, 2)) for s in itertools.combinations(range(1, 21), 11))


@check("co-23")
def _():
    # largest subset of 1..30 without two numbers differing by 7: chains k, k+7, k+14, …
    total = 0
    for r in range(1, 8):
        length = len(range(r, 31, 7))
        total += (length + 1) // 2
    return total + 1


@check("co-24")
def _():
    # domino tilings of 3 × 8, column by column with a profile of cells already filled
    from functools import lru_cache
    rows, cols = 3, 8

    def fills(mask):
        # ways to complete a column whose `mask` cells are filled: (next column's mask)
        out = []

        def go(r, cur, nxt):
            if r == rows:
                out.append(nxt)
                return
            if cur >> r & 1:
                go(r + 1, cur, nxt)
                return
            go(r + 1, cur | 1 << r, nxt | 1 << r)  # horizontal
            if r + 1 < rows and not cur >> (r + 1) & 1:
                go(r + 2, cur | 3 << r, nxt)  # vertical
        go(0, mask, 0)
        return out

    @lru_cache(None)
    def count(col, mask):
        if col == cols:
            return 1 if mask == 0 else 0
        return sum(count(col + 1, nxt) for nxt in fills(mask))
    return count(0, 0)


@check("co-25")
def _():
    return sum(1 for s in itertools.product("01", repeat=10) if "111" not in "".join(s))


@check("co-26")
def _():
    edges = list(itertools.combinations(range(6), 2))
    tri = list(itertools.combinations(range(6), 3))
    for col in itertools.product([0, 1], repeat=15):
        c = dict(zip(edges, col))
        if not any(c[(x, y)] == c[(x, z)] == c[(y, z)] for x, y, z in tri):
            return False
    return True


@check("co-27")
def _():
    return Fraction(sum(1 for a in range(1, 7) for b in range(1, 7) if is_prime(a + b)), 36)


@check("co-28")
def _():
    all3 = list(itertools.combinations(range(1, 11), 3))
    return Fraction(sum(1 for s in all3 if sum(s) % 3 == 0), len(all3))


@check("co-29")
def _():
    return sum(1 for p in itertools.permutations(range(5)) if all(p[i] != i for i in range(5)))


@check("co-30")
def _():
    best = 0
    for mask in range(1 << 20):
        k = bin(mask).count("1")
        if k <= best:
            continue
        xs = [i + 1 for i in range(20) if mask >> i & 1]
        r = [sum(1 for x in xs if x % 3 == j) for j in range(3)]
        # two different elements with sum ≡ 0 (mod 3): both ≡ 0, or one ≡ 1 and one ≡ 2
        if r[0] <= 1 and not (r[1] and r[2]):
            best = k
    return best


# ── geometry ─────────────────────────────────────────────────────────────────────────────────

@check("ge-01")
def _():
    a, b, c = 7, 8, 9
    s = (a + b + c) / 2
    return sqrt(s * (s - a) * (s - b) * (s - c)) / s


@check("ge-02")
def _():
    A, B, C = triangle(13, 15, 14)
    M = ((B[0] + C[0]) / 2, (B[1] + C[1]) / 2)
    return dist(A, M)


@check("ge-03")
def _():
    # C = (0,0), A = (5,0), B = (0,12); incentre (r, r)
    r = (5 + 12 - 13) / 2
    return math.hypot(r, r)


@check("ge-04")
def _():
    A, B = (0.0, 0.0), (8.0, 0.0)
    C = (6 * cos(radians(60)), 6 * sin(radians(60)))
    D = ((6 * B[0] + 8 * C[0]) / 14, (6 * B[1] + 8 * C[1]) / 14)  # BD : DC = AB : AC
    return dist(A, D)


@check("ge-05")
def _():
    d = sqrt(13 ** 2 - 12 ** 2)
    return 13 ** 2 / d


@check("ge-06")
def _():
    v = [(2 * cos(radians(60 * k)), 2 * sin(radians(60 * k))) for k in range(6)]
    A, B, C, D = v[0], v[1], v[2], v[3]
    return dist(A, meet(A, C, B, D))


@check("ge-07")
def _():
    # AB = AC = 1, apex 36°; BD bisects angle B, so AD : DC = AB : BC
    bc = 2 * sin(radians(18))
    return 1 / bc


@check("ge-08")
def _():
    A, B = (0.0, 0.0), (1.0, 0.0)
    C = (cos(radians(100)), sin(radians(100)))
    D = (dist(B, C), 0.0)
    return angle_deg(B, C, D)


@check("ge-09")
def _():
    D, C, E = (0.0, 1.0), (1.0, 1.0), (0.5, sqrt(3) / 2)
    return angle_deg(D, E, C)


@check("ge-10")
def _():
    g = random.Random(10)
    for _ in range(200):
        a, b = g.uniform(0.5, 9), g.uniform(0.5, 9)
        C, A, B = (0.0, 0.0), (a, 0.0), (0.0, b)
        t = ((C[0] - A[0]) * (B[0] - A[0]) + (C[1] - A[1]) * (B[1] - A[1])) / dist(A, B) ** 2
        D = (A[0] + t * (B[0] - A[0]), A[1] + t * (B[1] - A[1]))
        if abs(dist(C, D) ** 2 - dist(A, D) * dist(D, B)) > 1e-9:
            return False
    return True


@check("ge-11")
def _():
    for k in range(200):
        A, B, C = rnd_points(3, k)
        D, E, F = [((p[0] + q[0]) / 2, (p[1] + q[1]) / 2) for p, q in ((B, C), (C, A), (A, B))]
        if abs(area(D, E, F) - area(A, B, C) / 4) > 1e-9:
            return False
    return True


@check("ge-12")
def _():
    A, B, C = triangle(13, 14, 15)  # AB = 13, BC = 14, CA = 15
    # orthocentre: altitude from C is x = C.x; altitude from B is perpendicular to AC
    hx = C[0]
    hy = -(C[0] / C[1]) * (hx - B[0])
    return dist(A, (hx, hy))


@check("ge-13")
def _():
    # |PF1| + |PF2| = 10, |F1F2| = 8, angle 60°: 64 = m² + n² − mn
    mn = (100 - 64) / 3
    return 0.5 * mn * sin(radians(60))


@check("ge-14")
def _():
    # y = √3 (x − 1), y² = 4x
    k = sqrt(3)
    a, b, c = k * k, -(2 * k * k + 4), k * k
    x1, x2 = (-b + sqrt(b * b - 4 * a * c)) / (2 * a), (-b - sqrt(b * b - 4 * a * c)) / (2 * a)
    return dist((x1, k * (x1 - 1)), (x2, k * (x2 - 1)))


@check("ge-15")
def _():
    d = 15 / 5
    return 2 * sqrt(25 - d * d)


@check("ge-16")
def _():
    # focus (5, 0), asymptote 4x − 3y = 0
    return abs(4 * 5) / 5


@check("ge-17")
def _():
    d = math.hypot(3, 4)
    return sqrt(d * d - (3 - 2) ** 2)


@check("ge-18")
def _():
    a = (2.0, 0.0)
    b = (3 * cos(radians(60)), 3 * sin(radians(60)))
    return math.hypot(2 * a[0] - b[0], 2 * a[1] - b[1])


@check("ge-19")
def _():
    return sqrt(49 + 64 - 2 * 7 * 8 * cos(radians(120)))


@check("ge-20")
def _():
    return 6 * sin(radians(45)) / sin(radians(60))


@check("ge-21")
def _():
    # regular tetrahedron with edge 6 from alternate vertices of a cube of edge 6/√2
    s = 6 / sqrt(2)
    return sqrt(3) * s / 2


@check("ge-22")
def _():
    return sqrt(3 * 3 + 4 * 4 + 12 * 12)


@check("ge-23")
def _():
    A1, B, B1, C = (0, 0, 1), (1, 0, 0), (1, 0, 1), (1, 1, 0)
    u = [B[i] - A1[i] for i in range(3)]
    v = [C[i] - B1[i] for i in range(3)]
    c = abs(sum(u[i] * v[i] for i in range(3))) / (sqrt(sum(x * x for x in u)) * sqrt(sum(x * x for x in v)))
    return math.degrees(math.acos(c))


@check("ge-24")
def _():
    a, b, c, d = 3, 4, 5, 6
    s = (a + b + c + d) / 2
    return sqrt((s - a) * (s - b) * (s - c) * (s - d))


@check("ge-25")
def _():
    A, B, C = (0.3, 3.1), (0.0, 0.0), (3.0, 0.0)
    D = (B[0] + 2 / 3 * (C[0] - B[0]), B[1] + 2 / 3 * (C[1] - B[1]))
    E = (C[0] + 3 / 4 * (A[0] - C[0]), C[1] + 3 / 4 * (A[1] - C[1]))
    P = meet(A, D, B, E)
    return dist(A, P) / dist(P, D)


@check("ge-26")
def _():
    for k in range(200):
        A, B, D = rnd_points(3, 100 + k)
        C = (B[0] + D[0] - A[0], B[1] + D[1] - A[1])
        if abs(dist(A, C) ** 2 + dist(B, D) ** 2 - 2 * (dist(A, B) ** 2 + dist(B, C) ** 2)) > 1e-8:
            return False
    return True


@check("ge-27")
def _():
    g = random.Random(27)
    for _ in range(200):
        w, h = g.uniform(1, 9), g.uniform(1, 9)
        A, B, C, D = (0, 0), (w, 0), (w, h), (0, h)
        P = (g.uniform(-9, 9), g.uniform(-9, 9))
        if abs(dist(P, A) ** 2 + dist(P, C) ** 2 - dist(P, B) ** 2 - dist(P, D) ** 2) > 1e-8:
            return False
    return True


@check("ge-28")
def _():
    for k in range(200):
        A, B, C = rnd_points(3, 300 + k)
        G = ((A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3)
        lhs = dist(G, A) ** 2 + dist(G, B) ** 2 + dist(G, C) ** 2
        if abs(lhs - (dist(A, B) ** 2 + dist(B, C) ** 2 + dist(C, A) ** 2) / 3) > 1e-8:
            return False
    return True


@check("ge-29")
def _():
    A, B = (1.0, 0.0), (0.0, 2.0)
    return min(dist(A, (t, 4 - t)) + dist(B, (t, 4 - t)) for t in [i / 100000 for i in range(-200000, 600001)])


@check("ge-30")
def _():
    power = 13 ** 2 - 5 ** 2
    return power / 9 - 9


# ── algebra ──────────────────────────────────────────────────────────────────────────────────

@check("al-01")
def _():
    roots = (-1, 2, 3)
    assert sum(roots) == 4 and sum(r * r for r in roots) == 14 and sum(r ** 3 for r in roots) == 34
    return sum(r ** 4 for r in roots)


@check("al-02")
def _():
    return min(a + 4 * 9 / a for a in [i / 10000 for i in range(1, 400000)])


@check("al-03")
def _():
    return max(3 * cos(t) + 4 * sin(t) for t in [2 * pi * i / 1000000 for i in range(1000000)])


@check("al-04")
def _():
    # x + y + z = 6, xy + yz + zx = 9: x, y, z are the roots of t³ − 6t² + 9t − p, real iff 0 ≤ p ≤ 4
    best = None
    for i in range(0, 400001):
        x = i / 100000
        # y, z roots of u² − (6 − x)u + (9 − x(6 − x))
        s, q = 6 - x, 9 - x * (6 - x)
        if s * s - 4 * q < 0:
            continue
        best = x * q if best is None else max(best, x * q)
    return best


@check("al-05")
def _():
    best = None
    for i in range(1, 300):
        for j in range(1, 300 - i):
            a, b = i / 100, j / 100
            c = 3 - a - b
            v = 1 / a + 1 / b + 1 / c
            best = v if best is None else min(best, v)
    return best


@check("al-06")
def _():
    g = random.Random(6)
    return all(a * a + b * b + c * c - a * b - b * c - c * a >= -1e-9 for a, b, c in ([g.uniform(-9, 9) for _ in range(3)] for _ in range(5000)))


@check("al-07")
def _():
    g = random.Random(7)
    return all((a + b) * (1 / a + 1 / b) >= 4 - 1e-9 for a, b in ([g.uniform(0.01, 9) for _ in range(2)] for _ in range(5000)))


@check("al-08")
def _():
    return all(sum(k ** 3 for k in range(1, n + 1)) == (n * (n + 1) // 2) ** 2 for n in range(1, 300))


@check("al-09")
def _():
    return all(2 ** n >= n * n for n in range(4, 500))


@check("al-10")
def _():
    P = lambda x: x * x + 3
    assert all(P(x + 1) - P(x) == 2 * x + 1 for x in range(-20, 20)) and P(0) == 3
    return P(10)


@check("al-11")
def _():
    # a + b + c = 0, a² + b² + c² = 1: a = t, then b, c from b + c = −t, bc = t² − 1/2
    t = 0.3
    s, q = -t, t * t - 0.5
    d = sqrt(s * s - 4 * q)
    b, c = (s + d) / 2, (s - d) / 2
    return t ** 4 + b ** 4 + c ** 4


@check("al-12")
def _():
    return min(x + 4 / (x - 1) for x in [1 + i / 100000 for i in range(1, 1000000)])


@check("al-13")
def _():
    sols = [x / 1000 for x in range(3000, 100000) if abs(sqrt(x / 1000 + 5) + sqrt(x / 1000 - 3) - 4) < 1e-9]
    assert sols == [4.0], sols
    return 4


@check("al-14")
def _():
    d = Fraction(19 - 7, 4)
    a1 = 7 - 2 * d
    return sum(a1 + k * d for k in range(20))


@check("al-15")
def _():
    a = 1
    for _ in range(9):
        a = 2 * a + 3
    return a


@check("al-16")
def _():
    return sum(Fraction(1, k * (k + 1)) for k in range(1, 100))


@check("al-17")
def _():
    # f(2) + 2 f(1/2) = 6, f(1/2) + 2 f(2) = 3/2
    half = Fraction(6 * 2 - Fraction(3, 2), 3)
    return 6 - 2 * half


@check("al-18")
def _():
    z = (1 + 1j) / (1 - 1j)
    w = z ** 2026
    assert abs(w.imag) < 1e-6
    return round(w.real)


@check("al-19")
def _():
    sols = [x for x in range(3, 1000) if x * (x - 2) == 8]
    assert sols == [4]
    return 4


@check("al-20")
def _():
    r = sqrt(25 - 12)
    return ((5 + r) / 2) ** 3 + ((5 - r) / 2) ** 3


@check("al-21")
def _():
    # (2x − 1/x)^6: the term with x^(6 − 2k) = x^0
    return comb(6, 3) * 2 ** 3 * (-1) ** 3


@check("al-22")
def _():
    return sum(comb(10, k) for k in range(1, 11, 2))


@check("al-23")
def _():
    return sum(1 for x in range(-100, 100) if abs(2 * x - 5) < 9)


@check("al-24")
def _():
    return cos(radians(20)) * cos(radians(40)) * cos(radians(80))


@check("al-25")
def _():
    return sum(sin(radians(d)) ** 2 for d in (10, 50, 70))


@check("al-26")
def _():
    return max(sin(t) + sqrt(3) * cos(t) for t in [2 * pi * i / 1000000 for i in range(1000000)])


@check("al-27")
def _():
    return all(x ** 4 - 4 * x + 3 >= -1e-9 for x in [i / 1000 for i in range(-20000, 20001)])


@check("al-28")
def _():
    g = random.Random(28)
    return all((a * a + b * b) * (c * c + d * d) - (a * c + b * d) ** 2 >= -1e-8 for a, b, c, d in ([g.uniform(-9, 9) for _ in range(4)] for _ in range(5000)))


@check("al-29")
def _():
    # r(x) = a x + b with r(1) = 3, r(2) = 5
    a = 5 - 3
    return 3 - a


@check("al-30")
def _():
    return sum(k * (k + 1) for k in range(1, 21))


# ── run ──────────────────────────────────────────────────────────────────────────────────────

def close(x, y):
    if isinstance(x, Fraction):
        x = float(x)
    return abs(x - y) <= 1e-4 * max(1.0, abs(y)) if not float(y).is_integer() else abs(x - y) <= 1e-4


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    path = args[0] if args else "bench/heldout.json"
    show = "--values" in sys.argv
    problems = json.load(open(path, encoding="utf8"))["problems"]
    bad = 0
    for p in problems:
        fn = CHECKS.get(p["id"])
        if fn is None:
            print(f"{p['id']}: no check")
            bad += 1
            continue
        got = fn()
        note = ""
        if isinstance(got, tuple) and got and got[0] == "theorem":
            got, note = got[1], " (theorem)"
        if show:
            print(f"{p['id']}: {got}{note}")
        if p["kind"] == "prove":
            ok = got is True and "value" not in p and "values" not in p
        elif isinstance(got, list):
            # every solution found: a set (`values`), or the single one (`value`)
            ok = sorted(got) == sorted(p["values"]) if "values" in p else len(got) == 1 and "value" in p and close(got[0], p["value"])
        else:
            ok = "value" in p and close(got, p["value"])
        if not ok:
            print(f"{p['id']}: MISMATCH — computed {got}, the set says {p.get('value', p.get('values'))}")
            bad += 1
    extra = sorted(set(CHECKS) - {p["id"] for p in problems})
    if extra:
        print("checks without a problem:", ", ".join(extra))
    print(f"{len(problems)} problems, {bad} problem(s) to fix" if bad else f"{len(problems)} problems: every answer recomputed")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
