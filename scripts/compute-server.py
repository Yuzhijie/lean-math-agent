"""
Lightweight SymPy computation server for lean-math-agent.
Run with: python scripts/compute-server.py [--port 5001]

Endpoints:
  POST /evaluate       { "expression": "sum(k, k, 1, n)" }  → { "result": "n*(n+1)/2" }
  POST /simplify       { "expression": "(n+1)^2 - n^2" }    → { "result": "2*n + 1" }
  POST /verify         { "claim": "n + 0 = n" }              → { "result": true }
  POST /solve          { "equations": [...], "variables": [...], "domain": "real" }
                       → { "solutions": [{x: "2"}, {x: "4/5"}] }
  POST /substitute     { "expression": "x**2 + 1", "values": {"x": "2"} }
                       → { "result": "5", "result_decimal": "5.0" }
  POST /validate-root  { "root": {"x": "2"}, "original_equations": [...], "constraints": [...] }
                       → { "is_valid": true, "equation_residuals": [...], "constraint_checks": [...] }
  POST /vieta          { "polynomial": "5*x**2 - 14*x + 8", "variable": "x" }
                       → { "degree": 2, "sum_of_roots": "14/5", "product_of_roots": "8/5", "coefficients": [...] }
"""

import json
import os
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler

try:
    import sympy
    from sympy import (
        sympify, simplify, symbols, N, solve, Eq, Poly, Rational,
        sqrt, oo, zoo, S,
    )
except ImportError:
    print("ERROR: sympy is required. Install with: pip install sympy")
    sys.exit(1)

# All expression strings reach this server from LLM output (ultimately from
# user-supplied problem text). `parse_expr`/`sympify` are eval-based, so the
# hardened wrappers in safe_parse.py are used everywhere instead.
from safe_parse import (  # noqa: E402
    DEFAULT_TRANSFORMATIONS,
    ComputationTimeout,
    UnsafeExpressionError,
    safe_parse_expr,
    time_limit,
)

TRANSFORMATIONS = DEFAULT_TRANSFORMATIONS

# Limits per request: body size and wall-clock time for the SymPy work.
MAX_BODY_BYTES = 256 * 1024
COMPUTE_TIMEOUT_SECONDS = float(os.environ.get("COMPUTE_TIMEOUT_SECONDS", "15"))


class ComputeHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            self._respond(400, {"error": "invalid Content-Length"})
            return
        if content_length < 0 or content_length > MAX_BODY_BYTES:
            self._respond(413, {"error": f"request body larger than {MAX_BODY_BYTES} bytes"})
            return
        try:
            body = json.loads(self.rfile.read(content_length) or b"{}")
        except (ValueError, UnicodeDecodeError):
            self._respond(400, {"error": "request body is not valid JSON"})
            return
        if not isinstance(body, dict):
            self._respond(400, {"error": "request body must be a JSON object"})
            return

        routes = {
            "/evaluate": lambda: self._evaluate(body.get("expression", "")),
            "/simplify": lambda: self._simplify(body.get("expression", "")),
            "/verify": lambda: self._verify(body.get("claim", "")),
            "/solve": lambda: self._solve(body),
            "/substitute": lambda: self._substitute(body),
            "/validate-root": lambda: self._validate_root(body),
            "/vieta": lambda: self._vieta(body),
            "/recurrence": lambda: self._recurrence(body),
            "/check-perfect-squares": lambda: self._check_perfect_squares(body),
        }

        handler = routes.get(self.path)
        if handler is None:
            self._respond(404, {"error": "not found"})
            return

        try:
            with time_limit(COMPUTE_TIMEOUT_SECONDS):
                result = handler()
        except UnsafeExpressionError as e:
            self._respond(400, {"error": f"rejected expression: {e}"})
            return
        except ComputationTimeout:
            self._respond(408, {"error": f"computation exceeded {COMPUTE_TIMEOUT_SECONDS}s"})
            return
        except Exception as e:  # never leak a traceback / kill the connection
            self._respond(500, {"error": f"{type(e).__name__}: {e}"})
            return

        self._respond(200, result)

    # ── Existing endpoints ────────────────────────────────────────────

    def _evaluate(self, expression: str) -> dict:
        try:
            expr = safe_parse_expr(expression, transformations=TRANSFORMATIONS)
            result = str(expr)
            return {"result": result}
        except Exception as e:
            return {"result": f"error: {e}"}

    def _simplify(self, expression: str) -> dict:
        try:
            expr = safe_parse_expr(expression, transformations=TRANSFORMATIONS)
            simplified = simplify(expr)
            return {"result": str(simplified)}
        except Exception as e:
            return {"result": f"error: {e}"}

    def _verify(self, claim: str) -> dict:
        try:
            parts = claim.split("=")
            if len(parts) == 2:
                lhs = safe_parse_expr(parts[0].strip(), transformations=TRANSFORMATIONS)
                rhs = safe_parse_expr(parts[1].strip(), transformations=TRANSFORMATIONS)
                diff = simplify(lhs - rhs)
                result = diff == 0
            else:
                expr = safe_parse_expr(claim, transformations=TRANSFORMATIONS)
                result = bool(expr)
            return {"result": result}
        except Exception:
            return {"result": False}

    # ── New endpoints ─────────────────────────────────────────────────

    def _solve(self, body: dict) -> dict:
        """Solve equations symbolically.

        Input:  { "equations": ["x/3 + sqrt((3-x)**2 + 3)/2 - Rational(5,3)"],
                  "variables": ["x"],
                  "domain": "positive_real" }  (optional)
        Output: { "solutions": [{"x": "2"}, {"x": "4/5"}] }
        """
        try:
            eq_strings = body.get("equations", [])
            var_names = body.get("variables", [])
            domain = body.get("domain", "real")

            if not eq_strings or not var_names:
                return {"error": "equations and variables are required"}

            # Create symbols
            sym_objs = symbols(" ".join(var_names))
            if not isinstance(sym_objs, tuple):
                sym_objs = (sym_objs,)
            sym_map = dict(zip(var_names, sym_objs))

            # Parse equations: support "lhs=rhs" and bare "expr" (=0)
            parsed_eqs = []
            for eq_str in eq_strings:
                if "=" in eq_str:
                    parts = eq_str.split("=", 1)
                    lhs = safe_parse_expr(parts[0].strip(), transformations=TRANSFORMATIONS,
                                     local_dict=sym_map)
                    rhs = safe_parse_expr(parts[1].strip(), transformations=TRANSFORMATIONS,
                                     local_dict=sym_map)
                    parsed_eqs.append(Eq(lhs, rhs))
                else:
                    parsed_eqs.append(
                        safe_parse_expr(eq_str.strip(), transformations=TRANSFORMATIONS,
                                   local_dict=sym_map)
                    )

            # Solve
            raw_solutions = solve(parsed_eqs, sym_objs, dict=True)

            # Domain filtering
            solutions = []
            for sol in raw_solutions:
                if domain in ("positive_real", "positive"):
                    if not all(v.is_real and v.is_positive for v in sol.values()):
                        continue
                elif domain == "real":
                    if not all(v.is_real for v in sol.values()):
                        continue
                elif domain == "integer":
                    if not all(v.is_integer for v in sol.values()):
                        continue
                elif domain == "positive_integer":
                    if not all(v.is_integer and v.is_positive for v in sol.values()):
                        continue
                solutions.append({str(k): str(v) for k, v in sol.items()})

            return {"solutions": solutions}
        except Exception as e:
            return {"error": str(e), "solutions": []}

    def _substitute(self, body: dict) -> dict:
        """Substitute values into an expression.

        Input:  { "expression": "x**2 + 1", "values": {"x": "2"} }
        Output: { "result": "5", "result_decimal": "5.00000000000000" }
        """
        try:
            expr_str = body.get("expression", "")
            values = body.get("values", {})

            # Parse expression
            expr = safe_parse_expr(expr_str, transformations=TRANSFORMATIONS)

            # Build substitution map
            subs = {}
            for k, v in values.items():
                sym = symbols(k)
                val = safe_parse_expr(str(v), transformations=TRANSFORMATIONS)
                subs[sym] = val

            result = expr.subs(subs)
            result = simplify(result)

            # Compute decimal approximation
            try:
                decimal = str(N(result, 15))
            except Exception:
                decimal = str(result)

            return {"result": str(result), "result_decimal": decimal}
        except Exception as e:
            return {"error": str(e)}

    def _validate_root(self, body: dict) -> dict:
        """Validate a root by substituting into original equations + constraints.

        Input:  { "root": {"x": "2"},
                  "original_equations": ["x/3 + sqrt((3-x)**2 + 3)/2 = Rational(5,3)"],
                  "constraints": ["x > 0", "x < 3"] }
        Output: { "is_valid": true,
                  "equation_residuals": ["0"],
                  "constraint_checks": [{"constraint": "x > 0", "satisfied": true}] }
        """
        try:
            root = body.get("root", {})
            eq_strings = body.get("original_equations", [])
            constraints = body.get("constraints", [])

            # Build substitution map from root
            subs = {}
            for k, v in root.items():
                sym = symbols(k)
                val = safe_parse_expr(str(v), transformations=TRANSFORMATIONS)
                subs[sym] = val

            # Check each equation
            equation_residuals = []
            all_eqs_valid = True
            for eq_str in eq_strings:
                try:
                    if "=" in eq_str:
                        parts = eq_str.split("=", 1)
                        lhs = safe_parse_expr(parts[0].strip(), transformations=TRANSFORMATIONS)
                        rhs = safe_parse_expr(parts[1].strip(), transformations=TRANSFORMATIONS)
                        residual = simplify(lhs.subs(subs) - rhs.subs(subs))
                    else:
                        expr = safe_parse_expr(eq_str.strip(), transformations=TRANSFORMATIONS)
                        residual = simplify(expr.subs(subs))

                    is_zero = residual == 0
                    equation_residuals.append(str(residual))
                    if not is_zero:
                        all_eqs_valid = False
                except Exception as e:
                    equation_residuals.append(f"error: {e}")
                    all_eqs_valid = False

            # Check constraints
            constraint_checks = []
            all_constraints_ok = True
            for c_str in constraints:
                try:
                    c_expr = safe_parse_expr(c_str.strip(), transformations=TRANSFORMATIONS)
                    c_val = c_expr.subs(subs)
                    satisfied = bool(c_val)
                    constraint_checks.append({
                        "constraint": c_str,
                        "satisfied": satisfied,
                    })
                    if not satisfied:
                        all_constraints_ok = False
                except Exception as e:
                    constraint_checks.append({
                        "constraint": c_str,
                        "satisfied": False,
                        "error": str(e),
                    })
                    all_constraints_ok = False

            is_valid = all_eqs_valid and all_constraints_ok
            return {
                "is_valid": is_valid,
                "equation_residuals": equation_residuals,
                "constraint_checks": constraint_checks,
            }
        except Exception as e:
            return {
                "is_valid": False,
                "equation_residuals": [],
                "constraint_checks": [],
                "error": str(e),
            }

    def _vieta(self, body: dict) -> dict:
        """Apply Vieta's formulas to a polynomial.

        Input:  { "polynomial": "5*x**2 - 14*x + 8", "variable": "x" }
        Output: { "degree": 2,
                  "sum_of_roots": "14/5",
                  "product_of_roots": "8/5",
                  "coefficients": ["5", "-14", "8"] }
        """
        try:
            poly_str = body.get("polynomial", "")
            var_name = body.get("variable", "x")

            sym = symbols(var_name)
            expr = safe_parse_expr(poly_str, transformations=TRANSFORMATIONS,
                              local_dict={var_name: sym})
            poly = Poly(expr, sym)

            degree = poly.degree()
            coeffs = poly.all_coeffs()  # [a_n, a_{n-1}, ..., a_0]

            # Vieta's formulas:
            # sum_of_roots = -a_{n-1} / a_n
            # product_of_roots = (-1)^n * a_0 / a_n
            a_n = coeffs[0]
            a_n_minus_1 = coeffs[1] if len(coeffs) > 1 else S.Zero
            a_0 = coeffs[-1]

            sum_of_roots = -a_n_minus_1 / a_n
            product_of_roots = ((-1) ** degree) * a_0 / a_n

            result = {
                "degree": degree,
                "sum_of_roots": str(sum_of_roots),
                "product_of_roots": str(product_of_roots),
                "coefficients": [str(c) for c in coeffs],
            }

            # For quadratics, also compute sum of valid roots
            # (the caller decides which roots are valid)
            if degree == 2:
                # Also provide explicit roots for cross-checking
                roots = solve(expr, sym)
                result["roots"] = [str(r) for r in roots]

            return result
        except Exception as e:
            return {"error": str(e)}

    # ── Recurrence and sequence endpoints ──────────────────────────────

    def _recurrence(self, body: dict) -> dict:
        """Compute terms of a linear recurrence relation.

        Input:  {
            "recurrence": "m*(a[n-1] + a[n-2]) - a[n-3]",  # expression for a[n] in terms of previous terms
            "initial_values": [1, 1, 4],                     # a[0], a[1], a[2] (or a[1], a[2], a[3] depending on indexing)
            "num_terms": 20,                                  # how many terms to compute
            "parameters": {"m": 2}                            # parameter values (optional)
        }
        Output: { "terms": ["1", "1", "4", "9", "25", ...], "all_integers": true }
        """
        try:
            recurrence_str = body.get("recurrence", "")
            initial_values = body.get("initial_values", [])
            num_terms = body.get("num_terms", 20)
            parameters = body.get("parameters", {})

            if not recurrence_str or not initial_values:
                return {"error": "recurrence and initial_values are required"}

            # Create symbols for parameters and the index
            param_symbols = {}
            for k, v in parameters.items():
                param_symbols[k] = safe_parse_expr(str(v), transformations=TRANSFORMATIONS)

            # Build the sequence by iterating
            # We interpret recurrence as an expression in terms of a[n-1], a[n-2], etc.
            # Use a list to store computed terms
            terms = []
            for v in initial_values:
                terms.append(safe_parse_expr(str(v), transformations=TRANSFORMATIONS))

            order = len(initial_values)

            for i in range(order, num_terms):
                # Build substitution map: a[n-1] -> terms[i-1], a[n-2] -> terms[i-2], etc.
                subs = dict(param_symbols)
                for j in range(order):
                    # a[n-1] is the most recent, a[n-order] is the oldest
                    sym_name = f"a_n_minus_{j+1}"
                    subs[symbols(sym_name)] = terms[i - 1 - j]

                # Also support a[n-1], a[n-2] style naming
                for j in range(order):
                    subs[symbols(f"a_{j+1}")] = terms[i - order + j]

                try:
                    expr = safe_parse_expr(recurrence_str, transformations=TRANSFORMATIONS,
                                      local_dict=subs)
                    result = simplify(expr)
                    terms.append(result)
                except Exception as e:
                    terms.append(symbols(f"error_{i}"))
                    return {
                        "terms": [str(t) for t in terms],
                        "error": f"Failed at term {i}: {e}",
                        "all_integers": False,
                    }

            # Check if all terms are integers
            all_integers = True
            for t in terms:
                try:
                    if not t.is_integer and not t.is_Integer:
                        # Check if it simplifies to an integer
                        val = N(t)
                        if abs(val - round(float(val))) > 1e-10:
                            all_integers = False
                            break
                except Exception:
                    all_integers = False
                    break

            return {
                "terms": [str(t) for t in terms],
                "num_computed": len(terms),
                "all_integers": all_integers,
            }
        except Exception as e:
            return {"error": str(e), "terms": [], "all_integers": False}

    def _check_perfect_squares(self, body: dict) -> dict:
        """Check if a list of numbers are all perfect squares.

        Input:  { "values": [1, 4, 9, 16, 25, 59], "parameter": "m", "parameter_value": "2" }
        Output: {
            "all_perfect_squares": false,
            "results": [{"value": "1", "is_square": true, "sqrt": "1"}, ...],
            "non_squares": ["59"],
            "first_failure_index": 5
        }
        """
        try:
            values = body.get("values", [])
            results = []
            non_squares = []
            first_failure = None

            for i, v in enumerate(values):
                try:
                    val = safe_parse_expr(str(v), transformations=TRANSFORMATIONS)
                    val_float = float(N(val))

                    if val_float < 0 or abs(val_float - round(val_float)) > 1e-10:
                        # Not a non-negative integer
                        is_square = False
                        sqrt_val = "N/A"
                    else:
                        n = int(round(val_float))
                        root = int(round(n ** 0.5))
                        if root * root == n:
                            is_square = True
                            sqrt_val = str(root)
                        else:
                            is_square = False
                            sqrt_val = f"≈{n ** 0.5:.6f}"

                    results.append({
                        "index": i,
                        "value": str(v),
                        "is_square": is_square,
                        "sqrt": sqrt_val,
                    })

                    if not is_square:
                        non_squares.append(str(v))
                        if first_failure is None:
                            first_failure = i

                except Exception as e:
                    results.append({
                        "index": i,
                        "value": str(v),
                        "is_square": False,
                        "sqrt": f"error: {e}",
                    })
                    non_squares.append(str(v))
                    if first_failure is None:
                        first_failure = i

            return {
                "all_perfect_squares": len(non_squares) == 0,
                "results": results,
                "non_squares": non_squares,
                "first_failure_index": first_failure,
                "total_checked": len(values),
            }
        except Exception as e:
            return {
                "all_perfect_squares": False,
                "results": [],
                "non_squares": [],
                "error": str(e),
            }

    # ── Shared utilities ──────────────────────────────────────────────

    def _respond(self, status: int, data: dict):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def log_message(self, format, *args):
        # Suppress default logging
        pass


def main():
    port = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 5001
    # Bind to loopback by default; pass --host 0.0.0.0 (or COMPUTE_HOST) inside
    # Docker so the web container can reach it.
    host = sys.argv[sys.argv.index("--host") + 1] if "--host" in sys.argv else os.environ.get("COMPUTE_HOST", "127.0.0.1")
    server = HTTPServer((host, port), ComputeHandler)
    print(f"SymPy compute server listening on http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
