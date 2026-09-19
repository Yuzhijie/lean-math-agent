"""
Main algebraic solver with step-by-step recording.
Supports: linear, quadratic, polynomial, systems, inequalities.
"""

from typing import Optional, Union
from sympy import (
    Symbol, symbols, solve, solveset, S, Eq,
    simplify, expand, factor, collect, cancel, apart,
    sqrt, Rational, Poly, degree, discriminant,
    solve_univariate_inequality, reduce_inequalities,
    latex, oo, Interval, FiniteSet, Union as SymUnion,
    Complement, EmptySet
)
from sympy.core.expr import Expr
from sympy.solvers.solveset import NonlinearError

from .parser import parse_expression, parse_equation, extract_variables
from .steps import StepRecorder, SolveStep


class AlgebraSolver:
    """
    Step-by-step algebraic solver.
    Records each transformation for educational display.
    """

    def __init__(self):
        self.recorder = StepRecorder()

    def solve_equation(self, equation_str: str, variable: Optional[str] = None) -> dict:
        """
        Solve a single equation with step recording.
        Returns dict with solutions, steps, and verification.
        """
        self.recorder.clear()
        lhs, rhs = parse_equation(equation_str)
        expr = lhs - rhs  # Move everything to one side

        # Determine variable
        free_vars = extract_variables(expr)
        if variable:
            var = Symbol(variable)
        elif len(free_vars) == 1:
            var = free_vars[0]
        else:
            raise ValueError(f"Multiple variables found: {free_vars}. Please specify one.")

        self.recorder.add_equation("原方程", lhs, rhs, "parse")

        # Check equation type and solve accordingly
        poly = Poly(expr, var)
        deg = poly.degree()

        self.recorder.add("移项化简", expr, "simplify",
                         f"将所有项移到一边，得到 {deg} 次多项式")

        if deg == 1:
            return self._solve_linear(expr, var)
        elif deg == 2:
            return self._solve_quadratic(expr, var, poly)
        elif deg <= 4:
            return self._solve_polynomial(expr, var, poly)
        else:
            return self._solve_general(expr, var)

    def solve_system(self, equations: list[str],
                     variables: Optional[list[str]] = None) -> dict:
        """Solve a system of equations."""
        self.recorder.clear()

        eqs = []
        for eq_str in equations:
            lhs, rhs = parse_equation(eq_str)
            eqs.append(Eq(lhs, rhs))
            self.recorder.add_equation("方程", lhs, rhs, "parse")

        if variables:
            vars_ = [Symbol(v) for v in variables]
        else:
            all_vars = set()
            for eq in eqs:
                all_vars.update(eq.free_symbols)
            vars_ = sorted(all_vars, key=lambda s: s.name)

        self.recorder.add_text("求解方程组", f"变量: {', '.join(str(v) for v in vars_)}")

        solutions = solve(eqs, vars_, dict=True)

        if not solutions:
            self.recorder.add_text("方程组无解")
            return {
                'solutions': [],
                'steps': self.recorder.to_dict(),
                'type': 'system',
                'variables': [str(v) for v in vars_],
                'verified': False,
            }

        for i, sol in enumerate(solutions):
            sol_parts = [f"{k} = {v}" for k, v in sol.items()]
            self.recorder.add(f"解 {i+1}", sol[list(sol.keys())[0]], "solution",
                            ", ".join(sol_parts))

        return {
            'solutions': [{str(k): str(v) for k, v in sol.items()} for sol in solutions],
            'steps': self.recorder.to_dict(),
            'type': 'system',
            'variables': [str(v) for v in vars_],
            'verified': self._verify_system(eqs, solutions, vars_),
        }

    def simplify_expression(self, expr_str: str) -> dict:
        """Simplify an expression with step recording."""
        self.recorder.clear()
        expr = parse_expression(expr_str)
        self.recorder.add("原式", expr, "parse")

        # Try various simplifications
        simplified = simplify(expr)
        if simplified != expr:
            self.recorder.add("化简", simplified, "simplify")

        factored = factor(expr)
        if factored != simplified:
            self.recorder.add("因式分解", factored, "factor")

        expanded = expand(expr)
        if expanded != simplified and expanded != expr:
            self.recorder.add("展开", expanded, "expand")

        return {
            'original': latex(expr),
            'simplified': latex(simplified),
            'factored': latex(factored),
            'steps': self.recorder.to_dict(),
        }

    def solve_inequality(self, ineq_str: str, variable: Optional[str] = None) -> dict:
        """Solve an inequality."""
        self.recorder.clear()

        # Parse inequality
        import re
        cleaned = re.sub(r'\s+', '', ineq_str)

        for sep, rel in [('>=', '>='), ('<=', '<='), ('>', '>'), ('<', '<'),
                          ('≥', '>='), ('≤', '<=')]:
            if sep in cleaned:
                parts = cleaned.split(sep, 1)
                lhs = parse_expression(parts[0])
                rhs = parse_expression(parts[1])
                expr = lhs - rhs
                break
        else:
            raise ValueError(f"Cannot parse inequality: {ineq_str}")

        free_vars = extract_variables(expr)
        var = Symbol(variable) if variable else free_vars[0]

        self.recorder.add("原不等式", expr, "parse", f"变量: {var}")

        solution_set = solve_univariate_inequality(expr >= 0 if rel in ('>=', '>') else expr <= 0,
                                                    var, relational=False)

        self.recorder.add("解集", solution_set, "solution")

        return {
            'solution_set': str(solution_set),
            'latex': latex(solution_set),
            'steps': self.recorder.to_dict(),
            'variable': str(var),
        }

    # ─── Private Methods ────────────────────────────────────────

    def _solve_linear(self, expr: Expr, var: Symbol) -> dict:
        """Solve linear equation ax + b = 0."""
        poly = Poly(expr, var)
        coeffs = poly.all_coeffs()
        a, b = coeffs[0], coeffs[1] if len(coeffs) > 1 else 0

        self.recorder.add_equation(
            "标准形式",
            a * var, -b,
            "standard_form",
            f"即 {latex(a)}·{var} = {latex(-b)}"
        )

        solution = -b / a
        self.recorder.add_equation(
            "两边除以系数",
            var, solution,
            "divide",
            f"两边除以 {latex(a)}"
        )

        verified = expr.subs(var, solution) == 0
        self.recorder.add("验证", solution, "verify",
                         f"代入验证: {latex(expr.subs(var, solution))} = 0 ✓" if verified else "验证失败")

        return {
            'solutions': [str(solution)],
            'latex_solutions': [latex(solution)],
            'steps': self.recorder.to_dict(),
            'type': 'linear',
            'variable': str(var),
            'verified': verified,
        }

    def _solve_quadratic(self, expr: Expr, var: Symbol, poly: Poly) -> dict:
        """Solve quadratic equation ax² + bx + c = 0."""
        coeffs = poly.all_coeffs()
        a = coeffs[0]
        b = coeffs[1] if len(coeffs) > 1 else 0
        c = coeffs[2] if len(coeffs) > 2 else 0

        self.recorder.add_equation(
            "标准形式",
            a * var**2 + b * var, -c,
            "standard_form",
            f"a={a}, b={b}, c={c}"
        )

        disc = b**2 - 4*a*c
        self.recorder.add("计算判别式", disc, "discriminant",
                         f"Δ = b² - 4ac = {b}² - 4·{a}·{c} = {disc}")

        if disc > 0:
            self.recorder.add_text("判别式 > 0，有两个不等实根")
            x1 = (-b + sqrt(disc)) / (2*a)
            x2 = (-b - sqrt(disc)) / (2*a)
            solutions = [simplify(x1), simplify(x2)]
        elif disc == 0:
            self.recorder.add_text("判别式 = 0，有两个相等实根")
            x1 = -b / (2*a)
            solutions = [simplify(x1)]
        else:
            self.recorder.add_text("判别式 < 0，有两个共轭复根")
            x1 = (-b + sqrt(disc)) / (2*a)
            x2 = (-b - sqrt(disc)) / (2*a)
            solutions = [simplify(x1), simplify(x2)]

        for i, sol in enumerate(solutions):
            self.recorder.add(f"解 {i+1}", sol, "quadratic_formula",
                            "使用求根公式: x = (-b ± √Δ) / 2a")

        verified = all(expr.subs(var, sol).simplify() == 0 for sol in solutions)

        return {
            'solutions': [str(s) for s in solutions],
            'latex_solutions': [latex(s) for s in solutions],
            'discriminant': str(disc),
            'steps': self.recorder.to_dict(),
            'type': 'quadratic',
            'variable': str(var),
            'verified': verified,
        }

    def _solve_polynomial(self, expr: Expr, var: Symbol, poly: Poly) -> dict:
        """Solve polynomial equation of degree 3-4."""
        self.recorder.add("因式分解尝试", factor(expr), "factor")

        solutions = solve(expr, var)
        for i, sol in enumerate(solutions):
            self.recorder.add(f"根 {i+1}", sol, "root")

        verified = all(expr.subs(var, sol).simplify() == 0 for sol in solutions)

        return {
            'solutions': [str(s) for s in solutions],
            'latex_solutions': [latex(s) for s in solutions],
            'steps': self.recorder.to_dict(),
            'type': f'polynomial_degree_{poly.degree()}',
            'variable': str(var),
            'verified': verified,
        }

    def _solve_general(self, expr: Expr, var: Symbol) -> dict:
        """General equation solving for degree > 4."""
        self.recorder.add_text("高次方程，使用数值方法")

        try:
            solutions = solveset(expr, var, domain=S.Reals)
            if isinstance(solutions, FiniteSet):
                sol_list = list(solutions)
            elif isinstance(solutions, EmptySet):
                sol_list = []
            else:
                sol_list = [solutions]

            for sol in sol_list:
                self.recorder.add("解", sol, "numerical")

            return {
                'solutions': [str(s) for s in sol_list],
                'steps': self.recorder.to_dict(),
                'type': 'general',
                'variable': str(var),
                'verified': False,  # Numerical, skip exact verification
            }
        except Exception as e:
            self.recorder.add_text(f"求解失败: {str(e)}")
            return {
                'solutions': [],
                'steps': self.recorder.to_dict(),
                'type': 'general',
                'variable': str(var),
                'error': str(e),
                'verified': False,
            }

    def _verify_system(self, eqs, solutions, vars_) -> bool:
        """Verify system solutions."""
        for sol in solutions:
            for eq in eqs:
                substituted = eq.subs(sol)
                if not substituted.lhs.equals(substituted.rhs):
                    return False
        return True
