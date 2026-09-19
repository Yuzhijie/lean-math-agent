"""
Smoke tests for scripts/safe_parse.py. Run with:  python scripts/test_safe_parse.py
(No pytest dependency so it can run anywhere sympy is installed.)
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sympy import Symbol  # noqa: E402

from safe_parse import (  # noqa: E402
    SAFE_GLOBALS,
    ComputationTimeout,
    UnsafeExpressionError,
    safe_parse_expr,
    safe_sympify,
    time_limit,
)

ACCEPTED = {
    "2*x + 3": "2*x + 3",
    "(n+1)^2 - n^2": "-n**2 + (n + 1)**2",
    "2x + 3y": "2*x + 3*y",
    "3!": "6",
    "Eq(x, 2)": "Eq(x, 2)",
    "Rational(14,5)": "14/5",
    "n*(n+1)/2": "n*(n + 1)/2",
    "x_1 + x_2": "x_1 + x_2",
    "m*(a1+a2)-a3": "-a3 + m*(a1 + a2)",
    "x % 3": "Mod(x, 3)",
    "gcd(12, 18) + lcm(4,6)": "18",
    "sqrt(16) + Abs(-2)": "6",
}

REJECTED = [
    "__import__('os').system('id')",
    "().__class__.__bases__[0].__subclasses__()",
    "x.__class__",
    "open('/etc/passwd')",
    "lambda: 1",
    "[1,2,3][0]",
    "{'a': 1}",
    "x; y",
    "import os",
    "exec('1')",
    "getattr(x, 'y')",
    "a.b",
    "print(1)",
    "os",
    "somefunc(x)",
    '"s"',
    "x`y`",
    "# comment",
    "True",
    "a" * 501,
]


def main() -> int:
    failures = 0
    for src, expected in ACCEPTED.items():
        got = str(safe_parse_expr(src))
        if got != expected:
            failures += 1
            print(f"FAIL accept {src!r}: got {got!r}, expected {expected!r}")
    for src in REJECTED:
        try:
            safe_parse_expr(src)
        except UnsafeExpressionError:
            continue
        except Exception as e:  # rejected, but by SymPy rather than the whitelist
            failures += 1
            print(f"FAIL reject {src!r}: unexpected {type(e).__name__}: {e}")
            continue
        failures += 1
        print(f"FAIL reject {src!r}: was accepted")

    # sympify replacement honours locals and passes non-strings through
    n = Symbol("n", integer=True)
    if str(safe_sympify("n^2 + 1", locals={"n": n})) != "n**2 + 1" or safe_sympify(3) != 3:
        failures += 1
        print("FAIL safe_sympify")

    # the restricted globals really have no builtins
    try:
        eval("__import__('os')", dict(SAFE_GLOBALS), {})  # noqa: S307 — intentional
        failures += 1
        print("FAIL builtins reachable through SAFE_GLOBALS")
    except NameError:
        pass

    # wall-clock guard (Unix main thread)
    if hasattr(__import__("signal"), "SIGALRM"):
        start = time.time()
        try:
            with time_limit(0.3):
                while True:
                    pass
        except ComputationTimeout:
            if time.time() - start > 2:
                failures += 1
                print("FAIL time_limit fired too late")
        else:
            failures += 1
            print("FAIL time_limit did not fire")

    if failures:
        print(f"{failures} failure(s)")
        return 1
    print(f"safe_parse OK: {len(ACCEPTED)} accepted, {len(REJECTED)} rejected, guards work")
    return 0


if __name__ == "__main__":
    sys.exit(main())
