"""
Step-by-step solution recorder.
Records each algebraic transformation for display.
"""

from dataclasses import dataclass, field
from typing import Optional
from sympy import Expr, Eq, latex


@dataclass
class SolveStep:
    """A single step in the solution process."""
    description: str          # What this step does (Chinese)
    expression: str           # LaTeX representation
    operation: str            # Operation type: "expand", "simplify", "substitute", etc.
    detail: Optional[str] = None  # Additional explanation


@dataclass
class StepRecorder:
    """Records solution steps for display."""
    steps: list[SolveStep] = field(default_factory=list)

    def add(self, description: str, expr: Expr, operation: str, detail: Optional[str] = None):
        """Record a step."""
        self.steps.append(SolveStep(
            description=description,
            expression=latex(expr),
            operation=operation,
            detail=detail,
        ))

    def add_equation(self, description: str, lhs: Expr, rhs: Expr, operation: str,
                     detail: Optional[str] = None):
        """Record an equation step."""
        eq = Eq(lhs, rhs)
        self.steps.append(SolveStep(
            description=description,
            expression=latex(eq),
            operation=operation,
            detail=detail,
        ))

    def add_text(self, description: str, detail: Optional[str] = None):
        """Record a text-only step (no expression)."""
        self.steps.append(SolveStep(
            description=description,
            expression='',
            operation='note',
            detail=detail,
        ))

    def to_dict(self) -> list[dict]:
        """Convert steps to serializable dict."""
        return [
            {
                'description': s.description,
                'expression': s.expression,
                'operation': s.operation,
                'detail': s.detail,
            }
            for s in self.steps
        ]

    def clear(self):
        """Clear all recorded steps."""
        self.steps.clear()

    def __len__(self) -> int:
        return len(self.steps)

    def __iter__(self):
        return iter(self.steps)
