"""
Algebra solver HTTP endpoints.
Add to compute-server.py routes.
"""

from flask import Blueprint, request, jsonify
from .solver import AlgebraSolver

algebra_bp = Blueprint('algebra', __name__, url_prefix='/algebra')

solver = AlgebraSolver()


@algebra_bp.route('/solve', methods=['POST'])
def solve_equation():
    """Solve a single equation."""
    data = request.get_json()
    equation = data.get('equation')
    variable = data.get('variable')

    if not equation:
        return jsonify({'error': 'equation required'}), 400

    try:
        result = solver.solve_equation(equation, variable)
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 400


@algebra_bp.route('/solve-system', methods=['POST'])
def solve_system():
    """Solve a system of equations."""
    data = request.get_json()
    equations = data.get('equations', [])
    variables = data.get('variables')

    if not equations:
        return jsonify({'error': 'equations required'}), 400

    try:
        result = solver.solve_system(equations, variables)
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 400


@algebra_bp.route('/simplify', methods=['POST'])
def simplify_expr():
    """Simplify an expression."""
    data = request.get_json()
    expression = data.get('expression')

    if not expression:
        return jsonify({'error': 'expression required'}), 400

    try:
        result = solver.simplify_expression(expression)
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 400


@algebra_bp.route('/solve-inequality', methods=['POST'])
def solve_inequality():
    """Solve an inequality."""
    data = request.get_json()
    inequality = data.get('inequality')
    variable = data.get('variable')

    if not inequality:
        return jsonify({'error': 'inequality required'}), 400

    try:
        result = solver.solve_inequality(inequality, variable)
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 400


@algebra_bp.route('/factor', methods=['POST'])
def factor_expr():
    """Factor an expression."""
    data = request.get_json()
    expression = data.get('expression')

    if not expression:
        return jsonify({'error': 'expression required'}), 400

    try:
        from sympy import factor, latex
        from .parser import parse_expression
        expr = parse_expression(expression)
        factored = factor(expr)
        return jsonify({
            'original': latex(expr),
            'factored': latex(factored),
            'is_factored': expr != factored,
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 400
