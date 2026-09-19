/**
 * HTTP bridge to a SymPy/SageMath computation server.
 * The server is a lightweight Python Flask/FastAPI app that exposes:
 *   POST /evaluate  { expression } → { result }
 *   POST /simplify  { expression } → { result }
 *   POST /verify    { claim }      → { result: boolean }
 *   POST /solve     { equations, variables, domain? } → { solutions }
 *   POST /substitute { expression, values } → { result, result_decimal }
 *   POST /validate-root { root, original_equations, constraints? } → { is_valid, ... }
 *   POST /vieta     { polynomial, variable } → { degree, sum_of_roots, ... }
 *   POST /recurrence { recurrence, initial_values, num_terms, parameters? } → { terms, ... }
 *   POST /check-perfect-squares { values } → { all_perfect_squares, results, ... }
 */

// ── Response types ────────────────────────────────────────────────────

export interface SolveResponse {
  solutions: Record<string, string>[];
  error?: string;
}

export interface SubstituteResponse {
  result: string;
  result_decimal: string;
  error?: string;
}

export interface ValidateRootResponse {
  is_valid: boolean;
  equation_residuals: string[];
  constraint_checks: Array<{
    constraint: string;
    satisfied: boolean;
    error?: string;
  }>;
  error?: string;
}

export interface VietaResponse {
  degree: number;
  sum_of_roots: string;
  product_of_roots: string;
  coefficients: string[];
  roots?: string[];
  error?: string;
}

export interface RecurrenceResponse {
  terms: string[];
  num_computed: number;
  all_integers: boolean;
  error?: string;
}

export interface CheckPerfectSquaresResponse {
  all_perfect_squares: boolean;
  results: Array<{
    index: number;
    value: string;
    is_square: boolean;
    sqrt: string;
  }>;
  non_squares: string[];
  first_failure_index: number | null;
  total_checked: number;
  error?: string;
}

export class SymPyBridge {
  constructor(private baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async evaluate(expression: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expression }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`SymPy evaluate HTTP ${res.status}`);
    const data = (await res.json()) as { result: string };
    return data.result;
  }

  async simplify(expression: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/simplify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expression }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`SymPy simplify HTTP ${res.status}`);
    const data = (await res.json()) as { result: string };
    return data.result;
  }

  async verify(claim: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claim }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`SymPy verify HTTP ${res.status}`);
    const data = (await res.json()) as { result: boolean };
    return data.result;
  }

  // ── New endpoints ─────────────────────────────────────────────────

  async solve(args: {
    equations: string[];
    variables: string[];
    domain?: string;
  }): Promise<SolveResponse> {
    const res = await fetch(`${this.baseUrl}/solve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`SymPy solve HTTP ${res.status}`);
    return (await res.json()) as SolveResponse;
  }

  async substitute(args: {
    expression: string;
    values: Record<string, string>;
  }): Promise<SubstituteResponse> {
    const res = await fetch(`${this.baseUrl}/substitute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`SymPy substitute HTTP ${res.status}`);
    return (await res.json()) as SubstituteResponse;
  }

  async validateRoot(args: {
    root: Record<string, string>;
    original_equations: string[];
    constraints?: string[];
  }): Promise<ValidateRootResponse> {
    const res = await fetch(`${this.baseUrl}/validate-root`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`SymPy validate-root HTTP ${res.status}`);
    return (await res.json()) as ValidateRootResponse;
  }

  async vieta(args: {
    polynomial: string;
    variable: string;
  }): Promise<VietaResponse> {
    const res = await fetch(`${this.baseUrl}/vieta`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`SymPy vieta HTTP ${res.status}`);
    return (await res.json()) as VietaResponse;
  }

  // ── Recurrence and sequence endpoints ─────────────────────────────

  async recurrence(args: {
    recurrence: string;
    initial_values: string[];
    num_terms: number;
    parameters?: Record<string, string>;
  }): Promise<RecurrenceResponse> {
    const res = await fetch(`${this.baseUrl}/recurrence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`SymPy recurrence HTTP ${res.status}`);
    return (await res.json()) as RecurrenceResponse;
  }

  async checkPerfectSquares(args: {
    values: string[];
    parameter?: string;
    parameter_value?: string;
  }): Promise<CheckPerfectSquaresResponse> {
    const res = await fetch(`${this.baseUrl}/check-perfect-squares`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`SymPy check-perfect-squares HTTP ${res.status}`);
    return (await res.json()) as CheckPerfectSquaresResponse;
  }
}
