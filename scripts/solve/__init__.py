"""
Algebra Solver Module
Dedicated Python package for algebraic problem solving.
Provides step-by-step equation solving, simplification, and verification.
"""

from .solver import AlgebraSolver
from .parser import parse_equation, parse_expression
from .steps import StepRecorder

__version__ = '1.0.0'
__all__ = ['AlgebraSolver', 'parse_equation', 'parse_expression', 'StepRecorder']
