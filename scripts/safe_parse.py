"""
Hardened wrappers around SymPy parsing for untrusted input.

`sympy.sympify` / `sympy.parsing.sympy_parser.parse_expr` compile the input
string to Python and run it through `eval` with the full builtins available.
The expressions this service receives come from LLM output that is derived
from user-supplied problem text, so an expression such as

    __import__('os').system('...')

would execute on the compute server. This module makes parsing safe by:

1. Rejecting any input outside a small character whitelist (no quotes,
   brackets, backslashes, `#`, `;`, `:`, `@`, ...) and any attribute access
   (`.` followed by a letter or underscore), keyword or dunder name.
2. Only allowing identifiers that are short variable names (`x`, `a1`,
   `x_2`, ...) or names from an explicit list of SymPy functions/constants.
3. Evaluating with a `global_dict` that contains ONLY those names and an
   empty `__builtins__`, so even a bypass of (1)/(2) has nothing to call.
4. Bounding input length, and (optionally) wall-clock time per computation
   via `time_limit`, so a single request cannot pin the server.

Usage:
    from safe_parse import safe_parse_expr, safe_sympify, time_limit
"""

from __future__ import annotations

import contextlib
import keyword
import re
import signal
from typing import Any, Iterator, Mapping, Optional

import sympy
from sympy.parsing.sympy_parser import (
    parse_expr,
    standard_transformations,
    implicit_multiplication,
    convert_xor,
)

MAX_EXPRESSION_LENGTH = 500

# `convert_xor` makes `^` mean exponentiation (as `sympify` does by default);
# without it `(n+1)^2` is a Python XOR and fails to evaluate.
SYMPIFY_TRANSFORMATIONS = standard_transformations + (convert_xor,)
DEFAULT_TRANSFORMATIONS = SYMPIFY_TRANSFORMATIONS + (implicit_multiplication,)

# Characters an arithmetic/algebraic expression may contain. Anything else
# (quotes, brackets, braces, backslash, `#`, `;`, `:`, `@`, `$`, ...) is
# rejected before SymPy ever sees the string.
_ALLOWED_CHARS = re.compile(r"^[0-9A-Za-z_\s+\-*/^().,=<>!%]*$")

# Attribute access (`x.__class__`, `a.b`) — decimals like `3.14` or `.5`
# are still allowed because they are followed by a digit.
_ATTRIBUTE_ACCESS = re.compile(r"\.\s*[A-Za-z_]")

_IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")

# Short variable names: `x`, `n`, `a1`, `x_2`, `theta`-style greek names.
_VARIABLE_NAME = re.compile(r"^(?:[A-Za-z](?:_?\d{0,3})|alpha|beta|gamma|delta|theta|phi|omega|mu|sigma|tau)$")

# SymPy names an expression may reference (functions, constants, relations).
_ALLOWED_SYMPY_NAMES = {
    # arithmetic / number theory
    "sqrt", "cbrt", "root", "Abs", "abs", "sign", "floor", "ceiling",
    "factorial", "binomial", "gcd", "lcm", "Mod", "mod", "isprime",
    "Rational", "Integer", "Float", "S", "Symbol", "Function", "Number",
    # elementary functions
    "exp", "log", "ln", "sin", "cos", "tan", "cot", "sec", "csc",
    "asin", "acos", "atan", "atan2", "sinh", "cosh", "tanh",
    # constants
    "pi", "E", "I", "oo", "zoo", "nan",
    # relations / logic
    "Eq", "Ne", "Lt", "Le", "Gt", "Ge", "And", "Or", "Not",
    # sums, products, extrema
    "Sum", "Product", "summation", "product", "Max", "Min", "max", "min",
    # misc
    "Piecewise", "re", "im", "Pow", "Add", "Mul", "expand", "simplify", "factor",
}

# Names sympy's tokenizer transformations emit into the generated code.
_INTERNAL_NAMES = {"Symbol", "Function", "Integer", "Float", "Rational", "factorial"}


def _build_safe_globals() -> dict[str, Any]:
    g: dict[str, Any] = {"__builtins__": {}}
    for name in _ALLOWED_SYMPY_NAMES | _INTERNAL_NAMES:
        obj = getattr(sympy, name, None)
        if obj is not None:
            g[name] = obj
    # aliases sympify users commonly rely on
    g.setdefault("ln", sympy.log)
    g.setdefault("abs", sympy.Abs)
    g.setdefault("mod", sympy.Mod)
    g.setdefault("max", sympy.Max)
    g.setdefault("min", sympy.Min)
    return g


SAFE_GLOBALS: dict[str, Any] = _build_safe_globals()


class UnsafeExpressionError(ValueError):
    """Raised when an input string is rejected before parsing."""


def validate_expression(expr: Any, *, extra_names: Optional[Mapping[str, Any]] = None) -> str:
    """Return `expr` as a str if it passes the whitelist, else raise."""
    if not isinstance(expr, str):
        raise UnsafeExpressionError("expression must be a string")
    if len(expr) > MAX_EXPRESSION_LENGTH:
        raise UnsafeExpressionError(
            f"expression longer than {MAX_EXPRESSION_LENGTH} characters"
        )
    if not _ALLOWED_CHARS.match(expr):
        bad = sorted({c for c in expr if not _ALLOWED_CHARS.match(c)})
        raise UnsafeExpressionError(f"expression contains disallowed characters: {bad!r}")
    if "__" in expr:
        raise UnsafeExpressionError("expression contains '__'")
    if _ATTRIBUTE_ACCESS.search(expr):
        raise UnsafeExpressionError("attribute access is not allowed")

    allowed_extra = set(extra_names or {})
    for name in _IDENTIFIER.findall(expr):
        if keyword.iskeyword(name) or name in ("True", "False", "None"):
            raise UnsafeExpressionError(f"keyword {name!r} is not allowed")
        if (
            name in _ALLOWED_SYMPY_NAMES
            or name in allowed_extra
            or _VARIABLE_NAME.match(name)
        ):
            continue
        raise UnsafeExpressionError(f"unknown identifier {name!r}")
    return expr


def safe_parse_expr(
    expr: Any,
    *,
    local_dict: Optional[Mapping[str, Any]] = None,
    transformations=DEFAULT_TRANSFORMATIONS,
    evaluate: bool = True,
) -> Any:
    """Drop-in replacement for `parse_expr` for untrusted strings."""
    text = validate_expression(expr, extra_names=local_dict)
    return parse_expr(
        text,
        local_dict=dict(local_dict) if local_dict else None,
        global_dict=dict(SAFE_GLOBALS),
        transformations=transformations,
        evaluate=evaluate,
    )


def safe_sympify(expr: Any, *, locals: Optional[Mapping[str, Any]] = None) -> Any:
    """Drop-in replacement for `sympify(str, locals=...)` for untrusted strings.

    Non-string inputs (numbers, existing SymPy objects) are passed through
    `sympy.sympify` unchanged, as they cannot carry code.
    """
    if not isinstance(expr, str):
        return sympy.sympify(expr)
    # Mirror `sympify`'s defaults (standard transformations + `^` as power),
    # without implicit multiplication.
    return safe_parse_expr(expr, local_dict=locals, transformations=SYMPIFY_TRANSFORMATIONS)


class ComputationTimeout(TimeoutError):
    """Raised when a computation exceeds its wall-clock budget."""


@contextlib.contextmanager
def time_limit(seconds: float) -> Iterator[None]:
    """Abort the enclosed block after `seconds` (main thread, Unix only).

    Uses SIGALRM, so it only works in the main thread of a process. On
    platforms without SIGALRM (Windows) or in worker threads it degrades to
    a no-op rather than failing.
    """
    if seconds <= 0 or not hasattr(signal, "SIGALRM"):
        yield
        return
    try:
        previous = signal.getsignal(signal.SIGALRM)

        def _handler(signum, frame):  # noqa: ARG001
            raise ComputationTimeout(f"computation exceeded {seconds}s")

        signal.signal(signal.SIGALRM, _handler)
    except ValueError:
        # Not in the main thread — signals unavailable.
        yield
        return
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)
