"""
Expression and equation parser with NL support.
Handles Chinese and English math notation.
"""

import os
import re
import sys
from typing import Optional, Tuple
from sympy import (
    Symbol, Eq, Add, Mul, Pow, Rational,
    sqrt, sin, cos, tan, log, exp, Abs, pi, E, oo
)
from sympy.core.expr import Expr

# `sympify` is eval-based and the strings parsed here come from LLM / user
# input, so use the hardened wrapper from scripts/safe_parse.py instead.
_SCRIPTS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)
from safe_parse import safe_sympify  # noqa: E402


# Variable mapping (Chinese/English)
VAR_MAP = {
    'x': Symbol('x'),
    'y': Symbol('y'),
    'z': Symbol('z'),
    'a': Symbol('a'),
    'b': Symbol('b'),
    'n': Symbol('n', integer=True),
    'k': Symbol('k', integer=True),
}


def parse_expression(expr_str: str) -> Expr:
    """Parse a mathematical expression string into SymPy expression."""
    cleaned = _preprocess(expr_str)
    try:
        return safe_sympify(cleaned, locals=VAR_MAP)
    except Exception as e:
        raise ValueError(f"Cannot parse expression: {expr_str} ({e})")


def parse_equation(eq_str: str) -> Tuple[Expr, Expr]:
    """
    Parse an equation string into (lhs, rhs) tuple.
    Supports: =, ==, 等于, ≥, ≤, >, <
    Returns (lhs, rhs) where equation is lhs = rhs
    """
    cleaned = _preprocess(eq_str)

    # Handle inequalities by converting to equation form
    for sep in ['==', '=', '等于']:
        if sep in cleaned:
            parts = cleaned.split(sep, 1)
            lhs = safe_sympify(parts[0].strip(), locals=VAR_MAP)
            rhs = safe_sympify(parts[1].strip(), locals=VAR_MAP)
            return (lhs, rhs)

    raise ValueError(f"No equation separator found in: {eq_str}")


def parse_system(equations: list[str]) -> list[Tuple[Expr, Expr]]:
    """Parse a system of equations."""
    return [parse_equation(eq) for eq in equations]


def extract_variables(expr: Expr) -> list[Symbol]:
    """Extract all free symbols from an expression."""
    return sorted(expr.free_symbols, key=lambda s: s.name)


def _preprocess(s: str) -> str:
    """Clean up input string for parsing."""
    # Remove spaces around operators
    s = re.sub(r'\s*([+\-*/^=<>])\s*', r'\1', s)
    # Chinese to English
    s = s.replace('加', '+').replace('减', '-').replace('乘', '*').replace('除', '/')
    s = s.replace('等于', '=').replace('的', '*')
    s = s.replace('平方', '**2').replace('立方', '**3')
    s = s.replace('根号', 'sqrt').replace('√', 'sqrt')
    # Notation
    s = s.replace('^', '**').replace('×', '*').replace('÷', '/')
    s = s.replace('（', '(').replace('）', ')')
    # Implicit multiplication: 2x -> 2*x
    s = re.sub(r'(\d)([a-zA-Z])', r'\1*\2', s)
    s = re.sub(r'\)(\d)', r')*\1', s)
    s = re.sub(r'\)([a-zA-Z])', r')*\1', s)
    return s
