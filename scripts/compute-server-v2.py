"""
Compute server with algebra solver endpoints.
Extended version of compute-server.py with P3 algebra module.
"""

import sys
import os

# Add scripts directory to path for solve module
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from flask import Flask
from flask_cors import CORS

# Import algebra endpoints
from solve.endpoints import algebra_bp

app = Flask(__name__)
CORS(app)

# Register algebra blueprint
app.register_blueprint(algebra_bp)


# ─── Original endpoints (from compute-server.py) ──────────────
# These are kept as-is from the original server

@app.route('/health', methods=['GET'])
def health():
    return {'status': 'ok', 'version': '2.0.0', 'modules': ['sympy', 'algebra']}


# Import and register original routes
# (In production, import from compute-server.py)
try:
    from sympy import (
        symbols, sympify, solve, simplify, expand, factor,
        latex, Eq, Rational, sqrt, pi, E, oo,
        sin, cos, tan, log, exp, Abs,
        diff, integrate, limit, series,
        Matrix, det, inv, eigenvals, eigenvects,
        Sum, Product, factorial, binomial,
        gcd, lcm, isprime, factorint,
    )
    HAS_SYMPY = True
except ImportError:
    HAS_SYMPY = False
    print("Warning: SymPy not installed. Run: pip install sympy")


if HAS_SYMPY:
    from flask import request, jsonify

    @app.route('/solve', methods=['POST'])
    def solve_endpoint():
        data = request.get_json()
        expr = data.get('expression', '')
        try:
            result = solve(sympify(expr))
            return jsonify({
                'solutions': [str(s) for s in result],
                'latex': [latex(s) for s in result],
            })
        except Exception as e:
            return jsonify({'error': str(e)}), 400

    @app.route('/simplify', methods=['POST'])
    def simplify_endpoint():
        data = request.get_json()
        expr = data.get('expression', '')
        try:
            result = simplify(sympify(expr))
            return jsonify({'result': str(result), 'latex': latex(result)})
        except Exception as e:
            return jsonify({'error': str(e)}), 400

    @app.route('/expand', methods=['POST'])
    def expand_endpoint():
        data = request.get_json()
        expr = data.get('expression', '')
        try:
            result = expand(sympify(expr))
            return jsonify({'result': str(result), 'latex': latex(result)})
        except Exception as e:
            return jsonify({'error': str(e)}), 400

    @app.route('/factor', methods=['POST'])
    def factor_endpoint():
        data = request.get_json()
        expr = data.get('expression', '')
        try:
            result = factor(sympify(expr))
            return jsonify({'result': str(result), 'latex': latex(result)})
        except Exception as e:
            return jsonify({'error': str(e)}), 400

    @app.route('/derivative', methods=['POST'])
    def derivative_endpoint():
        data = request.get_json()
        expr = data.get('expression', '')
        var = data.get('variable', 'x')
        try:
            result = diff(sympify(expr), symbols(var))
            return jsonify({'result': str(result), 'latex': latex(result)})
        except Exception as e:
            return jsonify({'error': str(e)}), 400

    @app.route('/integrate', methods=['POST'])
    def integrate_endpoint():
        data = request.get_json()
        expr = data.get('expression', '')
        var = data.get('variable', 'x')
        try:
            result = integrate(sympify(expr), symbols(var))
            return jsonify({'result': str(result), 'latex': latex(result)})
        except Exception as e:
            return jsonify({'error': str(e)}), 400

    @app.route('/matrix', methods=['POST'])
    def matrix_endpoint():
        data = request.get_json()
        matrix_data = data.get('matrix', [])
        try:
            m = Matrix(matrix_data)
            return jsonify({
                'det': str(det(m)),
                'inverse': str(inv(m)) if m.det() != 0 else None,
                'eigenvalues': {str(k): v for k, v in m.eigenvals().items()},
            })
        except Exception as e:
            return jsonify({'error': str(e)}), 400

    @app.route('/evaluate', methods=['POST'])
    def evaluate_endpoint():
        data = request.get_json()
        expr = data.get('expression', '')
        subs = data.get('substitutions', {})
        try:
            result = sympify(expr).subs(subs)
            return jsonify({'result': str(result), 'latex': latex(result)})
        except Exception as e:
            return jsonify({'error': str(e)}), 400

    @app.route('/parse', methods=['POST'])
    def parse_endpoint():
        data = request.get_json()
        expr = data.get('expression', '')
        try:
            parsed = sympify(expr)
            return jsonify({
                'parsed': str(parsed),
                'latex': latex(parsed),
                'free_symbols': [str(s) for s in parsed.free_symbols],
            })
        except Exception as e:
            return jsonify({'error': str(e)}), 400


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--host', default='0.0.0.0')
    args = parser.parse_args()

    print(f"Starting compute server v2.0 on {args.host}:{args.port}")
    print(f"Modules: SymPy={HAS_SYMPY}, Algebra=True")
    app.run(host=args.host, port=args.port, debug=False)
